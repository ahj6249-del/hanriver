import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePortfolio, calculateHabits } from '../domain.js';

const tx = (id, date, type, qty = 1, ticker = 'AAPL') => ({ id, date, type, qty, ticker, price: 100 });
const habits = rows => {
  const p = calculatePortfolio(rows);
  return { p, h: calculateHabits(p.closedTrades, rows) };
};

test('full close resets the holding period after reentry, regardless of input order', () => {
  const rows = [tx('a', '2026-01-01', 'BUY'), tx('b', '2026-01-02', 'SELL'),
    tx('c', '2026-02-01', 'BUY'), tx('d', '2026-02-02', 'SELL')];
  for (const ledger of [rows, rows.toReversed()]) {
    const { p, h } = habits(ledger);
    assert.deepEqual(p.closedTrades.map(t => t.entryDate), ['2026-01-01', '2026-02-01']);
    assert.equal(h.holdingPeriods.SHORT_TERM.count, 2);
    assert.equal(h.holdingPeriods.LONG_TERM.count, 0);
  }
});

test('long and short cycles for the same ticker are independent', () => {
  const { p, h } = habits([tx('a', '2026-01-01', 'BUY'), tx('b', '2026-02-01', 'SHORT'),
    tx('c', '2026-02-02', 'COVER'), tx('d', '2026-02-03', 'SELL'),
    tx('e', '2026-02-04', 'SHORT'), tx('f', '2026-02-05', 'COVER')]);
  assert.deepEqual(p.closedTrades.map(t => t.entryDate), ['2026-02-01', '2026-01-01', '2026-02-04']);
  assert.equal(h.holdingPeriods.SHORT_TERM.count, 2);
  assert.equal(h.holdingPeriods.LONG_TERM.count, 1);
});

test('additions, partial closes, and splits retain the continuous cycle start', () => {
  const { p, h } = habits([tx('a', '2026-01-01', 'BUY', 2), tx('b', '2026-01-02', 'SELL'),
    tx('c', '2026-01-10', 'BUY'), { ...tx('d', '2026-01-15', 'SPLIT'), ratio: 2 },
    tx('e', '2026-02-02', 'SELL', 4), tx('f', '2026-02-03', 'BUY'),
    tx('g', '2026-02-03', 'SELL')]);
  assert.deepEqual(p.closedTrades.map(t => t.entryDate), ['2026-01-01', '2026-01-01', '2026-02-03']);
  assert.equal(h.holdingPeriods.DAY.count, 1);
  assert.equal(h.holdingPeriods.SHORT_TERM.count, 1);
  assert.equal(h.holdingPeriods.LONG_TERM.count, 1);
});

test('holding days use calendar dates, including an overnight trade shorter than 12 hours', () => {
  const { h } = habits([tx('a', '2026-01-01 23:55', 'BUY'), tx('b', '2026-01-02 00:05', 'SELL')]);
  assert.equal(h.holdingPeriods.SHORT_TERM.count, 1);
  assert.equal(h.holdingPeriods.DAY.count, 0);
});

test('short additions and partial covers retain the cycle until fully covered', () => {
  const { p } = habits([tx('a', '2026-01-01', 'SHORT', 2), tx('b', '2026-01-02', 'COVER'),
    tx('c', '2026-01-10', 'SHORT'), { ...tx('d', '2026-01-15', 'SPLIT'), ratio: 2 },
    tx('e', '2026-02-02', 'COVER', 4), tx('f', '2026-02-03', 'SHORT'),
    tx('g', '2026-02-03', 'COVER')]);
  assert.deepEqual(p.closedTrades.map(t => t.entryDate), ['2026-01-01', '2026-01-01', '2026-02-03']);
});

test('30 and 31 calendar days belong to distinct buckets', () => {
  const { h } = habits([tx('a', '2026-01-01', 'BUY', 2), tx('b', '2026-01-31', 'SELL'),
    tx('c', '2026-02-01', 'SELL')]);
  assert.equal(h.holdingPeriods.MONTH.count, 1);
  assert.equal(h.holdingPeriods.LONG_TERM.count, 1);
});

test('older closed-trade objects resolve entry dates from the ledger', () => {
  const rows = [tx('a', '2026-01-01', 'BUY'), tx('b', '2026-01-02', 'SELL'),
    tx('c', '2026-02-01', 'BUY'), tx('d', '2026-02-02', 'SELL')];
  const closed = calculatePortfolio(rows).closedTrades.map(({ entryDate, ...trade }) => trade);
  assert.equal(calculateHabits(closed, rows).holdingPeriods.SHORT_TERM.count, 2);
  assert.equal(calculateHabits(closed, []).holdingPeriods.UNKNOWN.count, 2);
});
