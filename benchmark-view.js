import { getBenchmarkPrices, saveBenchmarkPrices, getForwardBenchmarks, saveForwardBenchmarks } from './storage.js';
import { calculatePortfolio } from './domain.js';
import { compareBenchmark, readBenchmarkPrices } from './benchmark.js';
import { checkFinnhubHistory, refreshAllQuotes, searchStock, TICKER_PATTERN } from './api.js';

const field = id => document.getElementById('benchmark-' + id);
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const signedMoney = value => (value > 0 ? '+' : '') + currency.format(value);
const percent = value => value == null ? 'N/A' : (value > 0 ? '+' : '') + value.toFixed(2) + '%';
const colors = ['#10b981', '#60a5fa', '#f59e0b', '#c084fc', '#f472b6', '#22d3ee'];
const QQQ = { name: 'QQQ 100%', weights: [{ ticker: 'QQQ', weight: 100 }] };
let strategies = [QQQ];
let prices;
let result;
let chartMode = 'return';
let chartIndex = -1;
const hidden = new Set();
let lookupVersion = 0;

function addStrategy(name, weights) {
  if (strategies.length >= 5) throw new Error('가상 포트폴리오는 QQQ를 포함해 5개까지 비교할 수 있습니다.');
  if (strategies.some(item => item.name === name)) throw new Error('이미 추가한 포트폴리오입니다.');
  strategies = [...strategies, { name, weights }];
}

function parseWeights(input) {
  const entries = input.trim().split(/[,\n]+/).map(piece => {
    const [symbol, value, ...rest] = piece.trim().split(/\s+/);
    const ticker = symbol.toUpperCase();
    const weight = Number(value?.replace(/%$/, ''));
    if (!TICKER_PATTERN.test(ticker) || !Number.isFinite(weight) || weight <= 0 || rest.length) {
      throw new Error('종목과 비중을 입력해주세요. 예: QQQ 50, NVDA 30, CASH 20');
    }
    return { ticker, weight };
  });
  if (new Set(entries.map(entry => entry.ticker)).size !== entries.length ||
      Math.abs(entries.reduce((sum, entry) => sum + entry.weight, 0) - 100) > 1e-8) {
    throw new Error('티커는 한 번씩 입력하고 비중 합계를 100%로 맞춰주세요.');
  }
  return entries;
}

function make(tag, text) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

function writeCsv() {
  const rows = [['date', 'portfolio', 'nav_usd', 'twr_percent']];
  for (const item of result.series) {
    for (const point of item.points) rows.push([point.date, item.name, point.nav.toFixed(2), point.cumulative?.toFixed(4) ?? '']);
  }
  download(new Blob(['\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }), 'hanriver-benchmark.csv');
}

function download(blob, name) {
  const link = make('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function paintChart() {
  if (!result || field('result').hidden || !field('chart').parentElement.clientWidth) return;
  const canvas = field('chart');
  const width = canvas.parentElement.clientWidth;
  const height = 275;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const navMode = chartMode === 'nav';
  const valueOf = point => navMode ? point.nav : point.cumulative;
  const values = result.series.filter((_, index) => !hidden.has(index))
    .flatMap(item => item.points.map(valueOf).filter(Number.isFinite));
  if (!values.length) return;
  const floor = Math.min(...values);
  const ceil = Math.max(...values);
  const minimum = floor === ceil ? floor - 1 : floor;
  const maximum = floor === ceil ? ceil + 1 : ceil;
  const left = navMode ? 76 : 57;
  const right = width - 12;
  const top = 14;
  const bottom = height - 25;
  const count = result.series[0].points.length;
  const x = index => left + index / (count - 1) * (right - left);
  const y = value => bottom - (value - minimum) / (maximum - minimum) * (bottom - top);
  const format = navMode ? currency.format : percent;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let index = 0; index <= 4; index++) {
    const value = maximum - (maximum - minimum) * index / 4;
    const line = y(value);
    ctx.fillStyle = '#a0afc3';
    ctx.fillText(format(value), left - 6, line + 4, left - 8);
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(left, line);
    ctx.lineTo(right, line);
    ctx.stroke();
  }
  ctx.textAlign = 'left';
  ctx.fillText(result.baseline, left, height - 5);
  ctx.textAlign = 'right';
  ctx.fillText(result.end, right, height - 5);
  result.series.forEach((item, index) => {
    if (hidden.has(index)) return;
    ctx.strokeStyle = colors[index];
    ctx.lineWidth = 2;
    ctx.beginPath();
    let drawing = false;
    item.points.forEach((point, offset) => {
      const value = valueOf(point);
      if (!Number.isFinite(value)) {
        drawing = false;
        return;
      }
      if (drawing) ctx.lineTo(x(offset), y(value));
      else ctx.moveTo(x(offset), y(value));
      drawing = true;
    });
    ctx.stroke();
  });
  if (chartIndex >= 0) {
    ctx.strokeStyle = '#94a3b8';
    ctx.beginPath();
    ctx.moveTo(x(chartIndex), top);
    ctx.lineTo(x(chartIndex), bottom);
    ctx.stroke();
  }
}

function drawResult() {
  const [actual, qqq] = result.series.map(item => item.metrics);
  const gap = actual.nav - qqq.nav;
  const twrGap = actual.twr === null || qqq.twr === null ? null : actual.twr - qqq.twr;
  field('headline').textContent = Math.abs(gap) < .005 ? '실제 계좌와 QQQ의 최종 평가금액이 같아요.' :
    gap < 0 ? `같은 자금으로 QQQ에 투자했다면 ${currency.format(-gap)} 더 남았어요.` :
      `실제 계좌가 QQQ보다 ${currency.format(gap)} 더 남았어요.`;
  field('comparison').textContent = `QQQ 대비 수익률 차이 ${twrGap === null ? 'N/A' : percent(twrGap).replace('%', '%p')} · 최종 자산 차이 ${signedMoney(gap)} · 투자손익 차이 ${signedMoney(actual.profit - qqq.profit)}`;
  field('dates').textContent = `기준 평가일 ${result.baseline} · 최초 가상 매수일 ${result.firstInvestment} · 종료 평가일 ${result.end} · 시작 자산 ${currency.format(result.startNav)} · 순입금 ${signedMoney(result.netFlow)}`;
  field('analysis').textContent = actual.mdd === null || qqq.mdd === null ? '' :
    `실제 계좌 최대 낙폭 ${percent(actual.mdd)} · QQQ 최대 낙폭 ${percent(qqq.mdd)}`;
  const table = field('metrics');
  const header = make('tr');
  for (const name of ['성과 지표', ...result.series.map(item => item.name)]) {
    const cell = make('th', name);
    cell.scope = 'col';
    header.append(cell);
  }
  table.tHead.replaceChildren(header);
  const day = point => point ? `${point.date} · ${percent(point.daily * 100)}` : 'N/A';
  const metrics = [
    ['기간 수익률 (TWR)', m => percent(m.twr)],
    ['투자손익', m => signedMoney(m.profit)],
    ['최종 평가금액', m => currency.format(m.nav)],
    ['최대 낙폭 (MDD)', m => percent(m.mdd)],
    ['연환산 변동성', m => percent(m.volatility)],
    ['샤프지수', m => m.sharpe == null ? 'N/A' : m.sharpe.toFixed(2)],
    ['최고 수익일', m => day(m.best)],
    ['최악 손실일', m => day(m.worst)]
  ];
  table.tBodies[0].replaceChildren(...metrics.map(([name, format]) => {
    const row = make('tr');
    const label = make('th', name);
    label.scope = 'row';
    row.append(label, ...result.series.map(item => make('td', format(item.metrics))));
    return row;
  }));
  hidden.clear();
  chartIndex = -1;
  field('point').textContent = '';
  field('legend').replaceChildren(...result.series.map((item, index) => {
    const button = make('button', item.name);
    button.type = 'button';
    button.className = 'btn-secondary';
    button.style.borderColor = colors[index];
    button.setAttribute('aria-pressed', 'true');
    button.onclick = () => {
      if (hidden.has(index)) hidden.delete(index);
      else hidden.add(index);
      button.setAttribute('aria-pressed', String(!hidden.has(index)));
      paintChart();
    };
    return button;
  }));
  field('result').hidden = false;
  paintChart();
}

export function initBenchmark(getAccount, getSettings, onQuotes) {
  const tracking = initTracking(getAccount, getSettings, onQuotes);
  field('check-finnhub').addEventListener('click', async () => {
    const button = field('check-finnhub');
    button.disabled = true;
    field('finnhub-status').textContent = 'QQQ 과거 일봉 권한 확인 중…';
    try {
      field('finnhub-status').textContent = await checkFinnhubHistory(getSettings().apiKeyFinnhub);
    } finally {
      button.disabled = false;
    }
  });
  const drawCurrentPortfolio = () => {
    const { name, portfolio } = getAccount();
    if (!portfolio) return;
    field('account-name').textContent = name;
    field('current-nav').textContent = currency.format(portfolio.totalNav);
    field('current-cash').textContent = currency.format(portfolio.cash);
    const rows = [...portfolio.holdings].sort((a, b) => Math.abs(b.evalValue) - Math.abs(a.evalValue));
    field('current-holdings').replaceChildren(...rows.map(holding => {
      const side = holding.side === 'SHORT' ? ' 숏' : '';
      return make('li', `${holding.ticker}${side} · ${currency.format(holding.evalValue)}`);
    }));
    field('current-quote-note').textContent = rows.some(holding => !holding.quote?.price) ?
      '시세가 없는 종목은 평단으로 추정했습니다.' : '';
    field('current-holdings').hidden = !rows.length;
    field('use-current').disabled = portfolio.totalNav <= 0 || portfolio.cash < 0 ||
      !rows.length || rows.some(holding => holding.side === 'SHORT');
  };
  const run = () => {
    field('result').hidden = true;
    result = undefined;
    if (!prices) {
      field('status').textContent = '과거 가격 CSV를 불러오면 비교할 수 있습니다.';
      return;
    }
    try {
      const account = getAccount();
      result = compareBenchmark({
        transactions: account.transactions, accountName: account.name + ' (실제)', prices, strategies,
        start: field('start').value, end: field('end').value,
        interval: field('rebalance').value, feeRate: Number(field('fee').value) / 100,
        openingCash: Number(field('opening').value)
      });
      field('status').textContent = '';
      drawResult();
    } catch (error) {
      field('status').textContent = error.message;
    }
  };
  const drawStrategies = () => {
    field('strategies').replaceChildren(...strategies.map((item, index) => {
      const row = make('li', item.name);
      if (index) {
        const remove = make('button', '삭제');
        remove.type = 'button';
        remove.className = 'btn-secondary';
        remove.setAttribute('aria-label', item.name + ' 삭제');
        remove.onclick = () => {
          strategies = strategies.filter(strategy => strategy !== item);
          drawStrategies();
          if (prices) run();
        };
        row.append(remove);
      }
      return row;
    }));
  };
  const add = (name, weights) => {
    addStrategy(name, weights);
    drawStrategies();
    if (prices) run();
  };
  field('use-current').addEventListener('click', () => {
    const { portfolio } = getAccount();
    const weights = portfolio.holdings.map(holding => ({
      ticker: holding.ticker,
      weight: holding.evalValue / portfolio.totalNav * 100
    }));
    if (portfolio.cash > 0) weights.push({ ticker: 'CASH', weight: portfolio.cash / portfolio.totalNav * 100 });
    try {
      add('현재 보유 비중으로 가상 투자', weights);
    } catch (error) {
      field('status').textContent = error.message;
    }
  });
  field('presets').addEventListener('click', event => {
    const ticker = event.target.dataset.preset;
    if (!ticker) return;
    try {
      add(ticker === 'CASH' ? '현금 100%' : ticker + ' 100%', [{ ticker, weight: 100 }]);
    } catch (error) {
      field('status').textContent = error.message;
    }
  });
  field('add').onclick = () => {
    try {
      const weights = parseWeights(field('weights').value);
      add(weights.map(({ ticker, weight }) => `${ticker} ${weight}%`).join(' · '), weights);
      field('weights').value = '';
    } catch (error) {
      field('status').textContent = error.message;
    }
  };
  field('lookup').addEventListener('input', async event => {
    const version = ++lookupVersion;
    const query = event.target.value.trim();
    field('matches').replaceChildren();
    if (!query) return;
    const { matches } = await searchStock(query, 5);
    if (version !== lookupVersion) return;
    for (const stock of matches) {
      const button = make('button', stock.ticker + ' ' + stock.name);
      button.type = 'button';
      button.className = 'btn-secondary';
      button.onclick = () => {
        field('weights').value += (field('weights').value.trim() ? ', ' : '') + stock.ticker + ' ';
        field('weights').focus();
      };
      field('matches').append(button);
    }
  });
  const showPrices = next => {
    const days = Object.entries(next.QQQ || {}).filter(([, row]) => row.adjusted)
      .map(([date]) => date).sort();
    if (days.length < 2) throw new Error('QQQ의 배당·분할 조정 종가가 2거래일 이상 필요합니다.');
    prices = next;
    field('source').textContent = `${days[0]} ~ ${days.at(-1)} · ${Object.keys(prices).length}개 티커`;
    field('end').value = days.at(-1);
    const yearStart = days.at(-1).slice(0, 4) + '-01-01';
    field('start').value = days[0] > yearStart ? days[0] : yearStart;
  };
  field('file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      const next = readBenchmarkPrices(await file.text());
      showPrices(next);
      run();
      try {
        await saveBenchmarkPrices(next);
      } catch {
        field('source').textContent += ' · 현재 탭에서 사용 가능';
      }
    } catch (error) {
      field('status').textContent = error.message;
    }
    event.target.value = '';
  });
  field('ranges').addEventListener('click', event => {
    const range = event.target.dataset.range;
    if (!range || !prices) return;
    const first = Object.keys(prices.QQQ).sort()[0];
    const date = new Date(field('end').value);
    if (!Number.isFinite(date.getTime())) return;
    if (range === 'year') date.setUTCMonth(0, 1);
    else if (range !== 'all') {
      const day = date.getUTCDate();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - Number(range));
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, last));
    }
    const requested = date.toISOString().slice(0, 10);
    field('start').value = range === 'all' || requested < first ? first : requested;
    run();
  });
  field('form').addEventListener('submit', event => {
    event.preventDefault();
    run();
  });
  for (const name of ['start', 'end', 'rebalance', 'fee', 'opening']) {
    field(name).addEventListener('change', () => {
      if (prices && field('form').checkValidity()) run();
    });
  }
  field('mode').onchange = event => {
    chartMode = event.target.value;
    paintChart();
  };
  field('chart').addEventListener('pointermove', event => {
    if (!result) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const left = chartMode === 'nav' ? 76 : 57;
    const ratio = (event.clientX - bounds.left - left) / (bounds.width - left - 12);
    const count = result.series[0].points.length;
    chartIndex = Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
    field('point').textContent = [result.series[0].points[chartIndex].date,
      ...result.series.filter((_, index) => !hidden.has(index)).map(item => {
        const point = item.points[chartIndex];
        return `${item.name} ${percent(point.cumulative)} · ${currency.format(point.nav)}`;
      })
    ].join(' | ');
    paintChart();
  });
  field('csv').onclick = writeCsv;
  field('image').onclick = () => field('chart').toBlob(blob => { if (blob) download(blob, 'hanriver-benchmark.png'); });
  field('save').onclick = () => {
    try {
      localStorage.setItem('hanriver_benchmark_strategies', JSON.stringify(strategies.slice(1)));
      field('status').textContent = '비교 포트폴리오를 이 브라우저에 저장했습니다.';
    } catch {
      field('status').textContent = '포트폴리오를 저장하지 못했습니다.';
    }
  };
  field('load').onclick = () => {
    try {
      const saved = JSON.parse(localStorage.getItem('hanriver_benchmark_strategies') || '[]');
      strategies = [QQQ, ...saved.slice(0, 4)];
      drawStrategies();
      if (prices) run();
    } catch {
      field('status').textContent = '저장한 포트폴리오를 불러오지 못했습니다.';
    }
  };
  window.addEventListener('resize', paintChart);
  drawStrategies();
  let restored = false;
  const render = async () => {
    tracking.render();
    drawCurrentPortfolio();
    if (!restored) {
      restored = true;
      try {
        const cached = await getBenchmarkPrices();
        if (!prices && cached) showPrices(cached);
      } catch {
        field('source').textContent = '이전에 불러온 가격을 읽을 수 없습니다.';
      }
    }
    if (prices) run();
  };
  render.refreshTracking = tracking.refresh;
  return render;
}
const trackingDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' });
const trackingTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short'
});

function hasTrackingGap(from, to) {
  const next = new Date(from + 'T00:00:00Z');
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next.toISOString().slice(0, 10) < to;
}

function drawTrackingChart(history) {
  const chart = field('track-chart');
  chart.replaceChildren();
  chart.hidden = history.length < 2;
  if (history.length < 2) return;
  const values = history.flatMap(p => [p.actualReturn, p.comparisonReturn]).filter(Number.isFinite);
  const min = Math.min(-.1, ...values), max = Math.max(.1, ...values);
  const first = Date.parse(history[0].at), last = Date.parse(history.at(-1).at);
  const x = point => 48 + 302 * (Date.parse(point.at) - first) / (last - first || 1);
  const y = value => 12 + 118 * (max - value) / (max - min);
  const add = (tag, attrs, label) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    if (label) el.textContent = label;
    chart.append(el);
  };
  for (const value of [max, 0, min]) {
    add('line', { x1: 48, x2: 350, y1: y(value), y2: y(value), stroke: 'currentColor', opacity: .25 });
    add('text', { x: 45, y: y(value) + 3, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, percent(value));
  }
  for (const [key, color] of [['actualReturn', colors[0]], ['comparisonReturn', colors[1]]]) {
    let drawing = false;
    const path = history.map((point, index) => {
      if (!Number.isFinite(point[key])) {
        drawing = false;
        return '';
      }
      const connected = drawing && !hasTrackingGap(history[index - 1].day, point.day);
      add('circle', { cx: x(point), cy: y(point[key]), r: 2, fill: color });
      const part = (connected ? 'L' : 'M') + x(point) + ' ' + y(point[key]);
      drawing = true;
      return part;
    }).join(' ');
    add('path', { d: path, stroke: color, 'stroke-width': 2, fill: 'none' });
  }
  add('text', { x: 48, y: 151, 'font-size': 10, fill: 'currentColor' }, history[0].day);
  add('text', { x: 350, y: 151, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor' }, history.at(-1).day);
}

function initTracking(getAccount, getSettings, onQuotes) {
  const select = field('track-select');
  const form = field('track-form');
  const status = field('track-status');
  const picked = new Map();
  const attempted = new Set();
  let busy = false;
  let activeAccount;
  const rows = field('track-rows');
  const addButton = field('track-add');
  const read = getForwardBenchmarks;
  function updateTotal() {
    const total = [...rows.querySelectorAll('input[type=number]')]
      .reduce((sum, input) => sum + (input.valueAsNumber || 0), 0);
    const remaining = Math.round((100 - total) * 1e8) / 1e8;
    field('track-total').textContent = (100 - remaining).toFixed(2).replace(/\.?0+$/, '') + '% 합계' +
      (remaining > 0 ? ' · ' + remaining + '% 남음' : remaining < 0 ? ' · ' + -remaining + '% 초과' : '');
    addButton.disabled = busy || rows.children.length >= 20;
  }

  function addRow(ticker = '', weight = '') {
    const row = make('div');
    row.className = 'benchmark-track-row';
    const symbol = make('input');
    symbol.className = 'form-input';
    symbol.placeholder = '티커 또는 종목명';
    symbol.setAttribute('aria-label', '티커 또는 종목명');
    symbol.autocomplete = 'off';
    symbol.required = true;
    symbol.value = ticker;
    const share = make('input');
    share.className = 'form-input';
    share.type = 'number';
    share.min = '0.00000001';
    share.max = '100';
    share.step = 'any';
    share.placeholder = '비중 %';
    share.setAttribute('aria-label', '비중 (%)');
    share.required = true;
    share.value = weight;
    const remove = make('button', '빼기');
    remove.type = 'button';
    remove.className = 'btn-secondary';
    const matches = make('div');
    matches.className = 'benchmark-controls benchmark-track-matches';
    let timer;
    let version = 0;
    symbol.oninput = () => {
      const query = symbol.value.trim();
      const request = ++version;
      clearTimeout(timer);
      matches.replaceChildren();
      if (!query) return;
      timer = setTimeout(async () => {
        const found = query.toUpperCase() === 'CASH' ? [{ ticker: 'CASH', name: '현금' }] :
          (await searchStock(query, 4).catch(() => ({ matches: [] }))).matches;
        if (request !== version || !row.isConnected) return;
        matches.replaceChildren(...found.map(stock => {
          const choice = make('button', stock.ticker + ' · ' + stock.name);
          choice.type = 'button';
          choice.className = 'btn-secondary';
          choice.onclick = () => {
            symbol.value = stock.ticker;
            matches.replaceChildren();
            share.focus();
          };
          return choice;
        }));
      }, 180);
    };
    share.oninput = updateTotal;
    remove.onclick = () => {
      row.remove();
      if (!rows.children.length) addRow().focus();
      else addButton.focus();
      updateTotal();
    };
    row.append(symbol, share, remove, matches);
    rows.append(row);
    updateTotal();
    return symbol;
  }

  function resetRows(ticker = '', weight = '') {
    rows.replaceChildren();
    addRow(ticker, weight);
  }
  addButton.onclick = () => addRow().focus();
  const current = (id, comparisons) => comparisons.find(item => item.id === picked.get(id));

  function render() {
    const { id, name } = getAccount();
    if (id !== activeAccount) {
      status.textContent = '';
      resetRows();
      activeAccount = id;
    }
    let comparisons;
    try {
      comparisons = read(id);
    } catch {
      status.textContent = '이 브라우저에 저장된 비교를 읽지 못했습니다.';
      return;
    }
    if (!picked.has(id)) picked.set(id, comparisons.at(-1)?.id || '');
    const item = current(id, comparisons);
    select.replaceChildren(new Option('새 비교 만들기', ''), ...comparisons.map(saved =>
      new Option(saved.name + ' · ' + trackingTime.format(new Date(saved.history[0].at)), saved.id)));
    select.value = item?.id || '';
    form.hidden = Boolean(item);
    field('track-result').hidden = !item;
    select.disabled = busy;
    field('track-start').disabled = busy;
    field('track-refresh').disabled = busy;
    updateTotal();
    if (!item) return;

    const start = item.history[0], latest = item.history.at(-1);
    field('track-summary').textContent =
      '시작 ' + trackingTime.format(new Date(start.at)) + ' · 시작 금액 ' + currency.format(start.actualNav) +
      ' · 마지막 기록 ' + trackingTime.format(new Date(latest.at));
    field('track-allocation').textContent = '비교 구성: ' + item.name;
    field('track-values').replaceChildren(...[
      [name, latest.actualNav, latest.actualReturn, colors[0]],
      ['비교 포트폴리오', latest.comparisonNav, latest.comparisonReturn, colors[1]]
    ].map(([label, nav, gain, color]) => {
      const row = make('div');
      const title = make('dt', label);
      title.style.color = color;
      row.append(title, make('dd', percent(gain) + ' · ' + currency.format(nav)));
      return row;
    }));
    const today = trackingDate.format(new Date());
    field('track-gap').textContent = hasTrackingGap(latest.day, today)
      ? '마지막 기록 이후 기록이 없는 평일이 있어요. 시세를 갱신해 최신 값을 저장하세요.'
      : item.history.some((point, index) => index && hasTrackingGap(item.history[index - 1].day, point.day))
        ? '그래프가 끊긴 구간은 기록이 없는 기간이에요.' : '';
    drawTrackingChart(item.history);

    const attempt = id + '/' + item.id + '/' + trackingDate.format(new Date());
    if (!busy && !attempted.has(attempt)) {
      attempted.add(attempt);
      const weekday = new Date(today + 'T00:00:00Z').getUTCDay();
      if (latest.day !== today && weekday !== 0 && weekday !== 6) void record();
    }
  }

  async function record(weights) {
    const { id, portfolio } = getAccount();
    if (busy) return true;
    let comparisons;
    try {
      comparisons = read(id);
    } catch {
      status.textContent = '저장된 비교를 읽지 못했습니다.';
      return true;
    }
    const item = weights ? null : current(id, comparisons);
    if (!weights && !item) return false;
    const settings = getSettings();
    busy = true;
    status.textContent = '실제 계좌와 비교 포트폴리오의 시세를 조회 중…';
    render();
    try {
      const allocation = item?.allocation || weights;
      const tickers = [...new Set([...portfolio.holdings.map(h => h.ticker),
        ...allocation.filter(row => row.ticker !== 'CASH').map(row => row.ticker)])];
      if (tickers.length && !settings.apiKeyFinnhub && !settings.apiKeyTwelveData) {
        throw new Error('설정에서 시세 API 키를 연결해주세요.');
      }
      const quotes = await refreshAllQuotes(tickers, settings);
      const latestAccount = getAccount();
      if (latestAccount.id !== id) return true;
      const required = [...new Set([...tickers, ...latestAccount.portfolio.holdings.map(h => h.ticker)])];
      const missing = required.filter(ticker => !quotes[ticker]?.refreshed ||
        !Number.isFinite(quotes[ticker].price) || quotes[ticker].price <= 0);
      if (missing.length) throw new Error('시세를 받지 못해 기록하지 않았어요: ' + missing.join(', '));
      const actual = calculatePortfolio(latestAccount.transactions, quotes, settings.fxRate);
      if (!Number.isFinite(actual.totalNav) || (!item && actual.totalNav <= 0)) {
        throw new Error('순자산이 0보다 커야 비교를 시작할 수 있어요.');
      }
      const now = new Date();
      const at = now.toISOString(), day = trackingDate.format(now);
      if (!item) {
        const positions = weights.map(row => {
          const amount = actual.totalNav * row.weight / 100;
          return { ...row, units: row.ticker === 'CASH' ? amount : amount / quotes[row.ticker].price };
        });
        const created = {
          id: crypto.randomUUID(),
          name: weights.map(row => row.ticker + ' ' + row.weight + '%').join(', '),
          allocation: positions,
          history: [{ at, day, actualNav: actual.totalNav, comparisonNav: actual.totalNav,
            principal: actual.netPrincipal, actualReturn: 0, comparisonReturn: 0 }]
        };
        saveForwardBenchmarks(id, [...read(id), created]);
        picked.set(id, created.id);
        resetRows();
        status.textContent = '같은 금액으로 비교를 시작했어요.';
      } else {
        const latest = item.history.at(-1);
        const comparisonNav = allocation.reduce((total, row) =>
          total + row.units * (row.ticker === 'CASH' ? 1 : quotes[row.ticker].price), 0);
        const principal = actual.netPrincipal, actualNav = actual.totalNav;
        if (latest.day === day && actualNav === latest.actualNav &&
            comparisonNav === latest.comparisonNav && principal === latest.principal) {
          status.textContent = '마지막 기록 이후 평가금액이 같아요.';
        } else {
          const history = [...item.history];
          if (history.length > 1 && latest.day === day) history.pop();
          const previous = history.at(-1);
          // Treat net external flows as arriving at the end of the observation interval.
          const adjusted = actualNav - (principal - previous.principal);
          const actualReturn = previous.actualNav > 0 && adjusted >= 0 && previous.actualReturn != null
            ? ((1 + previous.actualReturn / 100) * adjusted / previous.actualNav - 1) * 100 : null;
          const comparisonReturn = (comparisonNav / history[0].comparisonNav - 1) * 100;
          history.push({ at, day, actualNav, comparisonNav, principal, actualReturn, comparisonReturn });
          saveForwardBenchmarks(id, read(id).map(saved =>
            saved.id === item.id ? { ...saved, history } : saved));
          status.textContent = '최신 평가금액을 기록했어요.';
        }
      }
      await onQuotes();
    } catch (error) {
      if (getAccount().id === id) status.textContent = error.message || '비교 기록을 저장하지 못했습니다.';
    } finally {
      busy = false;
      render();
    }
    return true;
  }

  for (const button of form.querySelectorAll('[data-track-preset]')) {
    button.onclick = () => resetRows(button.dataset.trackPreset, 100);
  }
  select.onchange = () => {
    picked.set(getAccount().id, select.value);
    status.textContent = '';
    render();
  };
  form.onsubmit = event => {
    event.preventDefault();
    try {
      const weights = parseWeights([...rows.children].map(row =>
        row.children[0].value.trim() + ' ' + row.children[1].value).join(', '));
      if (weights.length > 20) throw new Error('비교 종목은 20개까지 넣을 수 있어요.');
      void record(weights);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  field('track-refresh').onclick = () => record();
  return { render, refresh: () => record() };
}
