import { calculatePortfolio } from './domain.js';

const EPSILON = 1e-8;
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

export function readBenchmarkPrices(csv) {
  const [header, ...lines] = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (!header || header.trim().toLowerCase() !== 'date,ticker,close,adjusted_close') {
    throw new Error('CSV 첫 줄은 date,ticker,close,adjusted_close 형식이어야 합니다.');
  }
  const prices = {};
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const fields = line.split(',').map(field => field.trim().replace(/^"|"$/g, ''));
    const [date, symbol, raw, adjusted] = fields;
    const ticker = symbol?.toUpperCase() || '';
    if (fields.length !== 4 || !validDate(date) || !/^[A-Z0-9][A-Z0-9.:-]{0,24}$/.test(ticker) ||
        (!raw && !adjusted) || [raw, adjusted].some(value => value && (!Number.isFinite(Number(value)) || Number(value) <= 0))) {
      throw new Error(`CSV ${index + 2}행의 날짜, 티커 또는 가격을 확인해주세요.`);
    }
    prices[ticker] ??= {};
    if (prices[ticker][date]) throw new Error(`${ticker} ${date} 가격이 중복됩니다.`);
    prices[ticker][date] = { close: raw ? Number(raw) : null, adjusted: adjusted ? Number(adjusted) : null };
  });
  if (!Object.keys(prices).length) throw new Error('CSV에 가격 데이터가 없습니다.');
  return prices;
}

const tradeDay = trade => trade.date.slice(0, 10);
const external = trade => Number(trade.amount || trade.price) || 0;
const externalType = trade => trade.type === 'DEPOSIT' || trade.type === 'WITHDRAW';

function priceAt(prices, ticker, date, field) {
  const value = prices[ticker]?.[date]?.[field];
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${ticker}의 ${date} ${field === 'close' ? '비조정 종가' : '배당·분할 조정 종가'}가 없습니다.`);
  }
  return value;
}

function actualAt(ledger, prices, date) {
  const portfolio = calculatePortfolio(ledger);
  if (portfolio.invalidCloseIds.length) throw new Error(`${date}까지의 거래에 보유 수량을 초과하는 매도 또는 숏커버가 있습니다.`);
  if (portfolio.cash < -EPSILON) throw new Error(`${date} 장부의 현금이 음수입니다. 입출금과 개시 현금을 확인해주세요.`);
  return portfolio.holdings.reduce((nav, holding) =>
    nav + holding.qty * priceAt(prices, holding.ticker, date, 'close') * (holding.side === 'SHORT' ? -1 : 1),
  portfolio.cash);
}

function allocate(book, strategy, amount, prices, date, feeRate) {
  if (amount <= EPSILON) return;
  for (const { ticker, weight } of strategy.weights) {
    if (!weight) continue;
    const portion = amount * weight / 100;
    if (ticker === 'CASH') book.cash += portion;
    else book.units[ticker] = (book.units[ticker] || 0) +
      portion * (1 - feeRate) / priceAt(prices, ticker, date, 'adjusted');
  }
}

function virtualValue(book, prices, date) {
  return book.cash + Object.entries(book.units).reduce((value, [ticker, units]) =>
    units <= EPSILON ? value : value + units * priceAt(prices, ticker, date, 'adjusted'), 0);
}

function withdraw(book, amount, nav, feeRate, date) {
  const invested = nav - book.cash;
  const available = book.cash + invested * (1 - feeRate);
  if (amount > available + EPSILON) throw new Error(`${date} 가상 계좌에 출금할 자금이 부족합니다.`);
  if (available <= EPSILON) return;
  const fraction = Math.min(1, amount / available);
  book.cash *= 1 - fraction;
  for (const ticker of Object.keys(book.units)) book.units[ticker] *= 1 - fraction;
}

function periodKey(date, interval) {
  if (interval === 'monthly') return date.slice(0, 7);
  if (interval === 'quarterly') return date.slice(0, 4) + '-' + Math.ceil(Number(date.slice(5, 7)) / 3);
  return date.slice(0, 4);
}

function rebalance(book, strategy, prices, date, feeRate) {
  const nav = virtualValue(book, prices, date);
  let fees = 0;
  for (const { ticker, weight } of strategy.weights) {
    if (ticker === 'CASH' || !weight) continue;
    const price = priceAt(prices, ticker, date, 'adjusted');
    fees += Math.abs(nav * weight / 100 - (book.units[ticker] || 0) * price) * feeRate;
  }
  book.cash = 0;
  book.units = {};
  allocate(book, strategy, Math.max(0, nav - fees), prices, date, 0);
}

export function compareBenchmark({ transactions, prices, start, end, strategies, interval, feeRate, openingCash = 0 }) {
  if (!validDate(start) || !validDate(end) || start >= end) throw new Error('시작일과 종료일을 확인해주세요.');
  const marketDays = Object.entries(prices.QQQ || {}).filter(([, row]) => row.adjusted).map(([date]) => date).sort();
  const baseline = marketDays.findLast(date => date <= start);
  if (!baseline || !marketDays.some(date => date >= end)) throw new Error('시작일 직전부터 종료일까지의 QQQ 거래일 데이터가 필요합니다.');
  const dates = marketDays.filter(date => date >= baseline && date <= end);
  if (dates.length < 2) throw new Error('비교에 필요한 거래일이 2일 이상이어야 합니다.');
  const ledger = transactions.filter(trade => tradeDay(trade) <= dates.at(-1))
    .sort((a, b) => a.date.replace('T', ' ').localeCompare(b.date.replace('T', ' ')) ||
      (a.createdAt || '').localeCompare(b.createdAt || ''));
  if (!ledger.length) throw new Error('선택한 계좌에 이 기간까지 기록된 거래가 없습니다.');
  if (openingCash > 0) ledger.unshift({ id: 'benchmark-opening-cash', type: 'DEPOSIT', amount: openingCash, date: '1900-01-01 00:00' });
  if (!ledger.some(trade => trade.type === 'DEPOSIT')) throw new Error('입금 기록이나 장부 시작 전 현금을 입력해주세요.');
  const startNav = actualAt(ledger.filter(trade => tradeDay(trade) <= baseline), prices, baseline);
  if (startNav < -EPSILON) throw new Error('시작일 순자산이 음수인 계좌는 비교할 수 없습니다.');

  const series = [{ name: '실제 계좌', points: [], factor: 1, validReturn: true }];
  for (const strategy of strategies) {
    series.push({ name: strategy.name, points: [], factor: 1, validReturn: true,
      strategy, cash: startNav, units: {}, invested: false });
  }
  const firstInvestment = dates.find(date => date >= start);
  let netFlow = 0;
  for (const [index, date] of dates.entries()) {
    const priorDate = dates[index - 1];
    const flows = index ? ledger.filter(trade => externalType(trade) && tradeDay(trade) > priorDate && tradeDay(trade) <= date) : [];
    const flow = flows.reduce((sum, trade) => sum + (trade.type === 'DEPOSIT' ? external(trade) : -external(trade)), 0);
    netFlow += flow;
    const actual = actualAt(ledger.filter(trade => tradeDay(trade) <= date), prices, date);
    for (const [seriesIndex, item] of series.entries()) {
      let nav = actual;
      if (seriesIndex) {
        if (!item.invested && date >= firstInvestment) {
          const initial = item.cash;
          item.cash = 0;
          allocate(item, item.strategy, initial, prices, date, feeRate);
          item.invested = true;
        }
        if (item.invested) {
          if (index && date !== firstInvestment && interval !== 'hold' &&
              periodKey(priorDate, interval) !== periodKey(date, interval)) {
            rebalance(item, item.strategy, prices, date, feeRate);
          }
          for (const trade of flows) {
            if (trade.type === 'DEPOSIT') allocate(item, item.strategy, external(trade), prices, date, feeRate);
            else withdraw(item, external(trade), virtualValue(item, prices, date), feeRate, date);
          }
        }
        nav = index === 0 ? startNav : virtualValue(item, prices, date);
      }
      const priorNav = item.points.at(-1)?.nav;
      let daily = null;
      if (index && priorNav > EPSILON) {
        daily = (nav - flow) / priorNav - 1;
        item.factor *= 1 + daily;
      } else if (index && Math.abs(priorNav) <= EPSILON && flow > EPSILON && nav >= 0) {
        daily = nav / flow - 1;
        item.factor *= 1 + daily;
      } else if (index && Math.abs(nav - flow) > EPSILON) {
        item.validReturn = false;
      }
      item.points.push({ date, nav, daily, cumulative: item.validReturn ? (item.factor - 1) * 100 : null });
    }
  }

  for (const item of series) {
    const last = item.points.at(-1);
    const daily = item.points.filter(point => point.daily !== null);
    const mean = daily.length ? daily.reduce((sum, point) => sum + point.daily, 0) / daily.length : 0;
    const sd = daily.length > 1 ? Math.sqrt(daily.reduce((sum, point) => sum + (point.daily - mean) ** 2, 0) / (daily.length - 1)) : null;
    let peak = 1;
    let drawdown = 0;
    for (const point of item.points) {
      if (point.cumulative === null) continue;
      const index = 1 + point.cumulative / 100;
      peak = Math.max(peak, index);
      drawdown = Math.min(drawdown, (index / peak - 1) * 100);
    }
    const best = daily.reduce((top, point) => !top || point.daily > top.daily ? point : top, null);
    const worst = daily.reduce((bottom, point) => !bottom || point.daily < bottom.daily ? point : bottom, null);
    item.metrics = {
      twr: daily.length ? last.cumulative : null,
      nav: last.nav,
      profit: last.nav - startNav - netFlow,
      mdd: item.validReturn && daily.length ? drawdown : null,
      volatility: sd === null ? null : sd * Math.sqrt(252) * 100,
      sharpe: sd > EPSILON ? mean / sd * Math.sqrt(252) : null,
      best, worst
    };
  }
  return { series, baseline, firstInvestment, end: dates.at(-1), startNav, netFlow };
}
