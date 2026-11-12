import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCashBuffer, transactionsToCSV } from '../domain.js';

test('short-sale cash does not imply a safe cash buffer', () => {
  const risk = assessCashBuffer({ cash: 11000, totalNav: 1000, holdings: [{ evalValue: -10000 }] });
  assert.deepEqual(risk, { status: 'short', cashRatio: 1100, shortLiability: 10000, cashAfterCover: 1000 });
});

test('zero, negative and invalid NAV withhold ratio assessments', () => {
  for (const totalNav of [0, -100, NaN]) {
    const risk = assessCashBuffer({ cash: 500, totalNav });
    assert.equal(risk.status, 'unknown');
    assert.equal(risk.cashRatio, null);
  }
});

test('negative cash is flagged and long-only cash ranges remain distinct', () => {
  for (const [cash, status] of [[-10, 'deficit'], [50, 'low'], [200, 'buffer'], [900, 'high']]) {
    assert.equal(assessCashBuffer({ cash, totalNav: 1000 }).status, status);
  }
});

test('CSV escapes quotes, commas, line breaks and Korean characters in all text fields', () => {
  const csv = transactionsToCSV([{ date: '2026-01-02', type: 'BUY', ticker: 'AAPL',
    name: 'Company "A", Inc.', qty: 5, price: 100, memo: '이유 "확인"\n다음, 조건' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"Company ""A"", Inc."'));
  assert.ok(csv.includes('"이유 ""확인""\n다음, 조건"'));
  assert.ok(csv.endsWith('"default"'));
});

test('CSV retains forward/reverse split ratios and explicit account IDs', () => {
  const csv = transactionsToCSV([{ type: 'SPLIT', ratio: 4, accountId: 'growth' },
    { type: 'SPLIT', ratio: 0.25, accountId: 'dividend' }]);
  assert.ok(csv.includes('"분할비율"'));
  assert.ok(csv.includes('"4","growth"'));
  assert.ok(csv.includes('"0.25","dividend"'));
});

test('CSV retains amount-only income/cash records and legacy price-based amounts', () => {
  const csv = transactionsToCSV([{ type: 'DEPOSIT', amount: 123 }, { type: 'WITHDRAW', price: 456 },
    { type: 'DIVIDEND', amount: 20 }, { type: 'FEE', fee: 5 }]);
  for (const value of [123, 456, 20, 5]) assert.ok(csv.includes(`"${value}","","default"`));
});
