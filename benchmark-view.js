import { getBenchmarkPrices, saveBenchmarkPrices } from './storage.js';
import { compareBenchmark, readBenchmarkPrices } from './benchmark.js';
import { checkFinnhubHistory, searchStock, TICKER_PATTERN } from './api.js';

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

export function initBenchmark(getAccount, getFinnhubKey) {
  field('check-finnhub').addEventListener('click', async () => {
    const button = field('check-finnhub');
    button.disabled = true;
    field('finnhub-status').textContent = 'QQQ 과거 일봉 권한 확인 중…';
    try {
      field('finnhub-status').textContent = await checkFinnhubHistory(getFinnhubKey());
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
  return async () => {
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
}
