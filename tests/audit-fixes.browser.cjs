const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://127.0.0.1:8123';
const origin = new URL(base).origin;
const ledger = [{ id: 'dep', date: '2026-01-01', type: 'DEPOSIT', amount: 1000, price: 1000 },
  { id: 'buy', date: '2026-01-02', type: 'BUY', ticker: 'AAPL', qty: 5, price: 100 }];
const prices = { QQQ: { '2026-01-01': { close: 100, adjusted: 100 },
  '2026-01-02': { close: 101, adjusted: 101 } } };

async function loaded(page) {
  await page.route('https://**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#m-stock-count').textContent.includes('보유 중'));
}
async function fallback(page) {
  await page.evaluate(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    globalThis.auditFallback = await import('/storage.js?audit-fallback');
    await auditFallback.initDB();
    if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
    else delete window.indexedDB;
  });
}
async function downloadText(page, button) {
  const done = page.waitForEvent('download');
  await page.locator(button).click();
  const stream = await (await done).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  let passed = 0;
  async function check(name, fn) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try { await loaded(page); await fn(page, context); assert.deepEqual(errors, []); passed++; console.log('PASS ' + name); }
    finally { await context.close(); }
  }
  try {
    await check('concurrent fallback creates, edits and deletes with and without Web Locks', async page => {
      await fallback(page);
      for (const withoutLocks of [false, true]) {
        const result = await page.evaluate(async withoutLocks => {
          if (withoutLocks) Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
          try {
            const ids = Array.from({ length: 20 }, (_, i) => `${withoutLocks}-${i}`);
            await Promise.all(ids.map(id => auditFallback.saveTransaction({ id, date: '2026-01-01', type: 'DEPOSIT', amount: 1 })));
            const count = (await auditFallback.getAllTransactions()).filter(row => ids.includes(row.id)).length;
            await Promise.all(ids.slice(0, 10).map(id => auditFallback.deleteTransaction(id)));
            await Promise.all(ids.slice(10).map(id => auditFallback.saveTransaction({ id, date: '2026-01-01', type: 'DEPOSIT', amount: 2 })));
            const rows = (await auditFallback.getAllTransactions()).filter(row => ids.includes(row.id));
            return { count, remaining: rows.length, total: rows.reduce((sum, row) => sum + row.amount, 0) };
          } finally { if (withoutLocks) delete navigator.locks; }
        }, withoutLocks);
        assert.deepEqual(result, { count: 20, remaining: 10, total: 20 });
      }
    });

    await check('fallback tabs and a primary tab retain concurrent writes and recovery', async (page, context) => {
      const second = await context.newPage();
      const primary = await context.newPage();
      await loaded(second); await loaded(primary);
      await fallback(page); await fallback(second);
      for (let attempt = 0; attempt < 10; attempt++) {
        await primary.evaluate(async () => (await import('/storage.js')).clearAllData());
        await Promise.all([page, second, primary].map((tab, group) => tab.evaluate(async group => {
          const s = group === 2 ? await import('/storage.js') : auditFallback;
          await Promise.all(Array.from({ length: 8 }, (_, i) => s.saveTransaction({
            id: `tab-${group}-${i}`, type: 'DEPOSIT', amount: 1, date: '2026-01-01'
          })));
        }, group)));
        const ids = await primary.evaluate(async () => (await (await import('/storage.js')).getAllTransactions()).map(r => r.id));
        assert.equal(ids.length, 24, `attempt ${attempt}: ${JSON.stringify(ids)}`);
      }
      await primary.reload();
      await primary.waitForFunction(() => document.querySelector('#m-total-nav').textContent === '$24.00');
    });

    await check('successful Finnhub refresh replaces manual price in the actual dashboard', async page => {
      await page.route('https://finnhub.io/**', route => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ c: 150, pc: 140, dp: 7.14, t: Math.floor(Date.now() / 1000) }) }));
      await page.evaluate(async rows => {
        const s = await import('/storage.js'); const a = await import('/api.js');
        for (const row of rows) await s.saveTransaction(row);
        a.saveManualPrice('AAPL', 100); s.saveSettings({ ...s.getSettings(), apiKeyFinnhub: 'test-placeholder' });
      }, ledger);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#m-total-nav').textContent === '$1,000.00');
      await page.locator('#btn-header-refresh').click();
      await page.waitForFunction(() => document.querySelector('#m-total-nav').textContent === '$1,250.00');
      const result = await page.evaluate(async () => {
        const a = await import('/api.js'); return { manual: a.getManualPrices().AAPL, price: a.getStoredPrices().AAPL.price };
      });
      assert.deepEqual(result, { manual: undefined, price: 150 });
    });

    await check('failed API retains manual quote; Twelve Data success replaces it', async page => {
      await page.route('https://finnhub.io/**', route => route.fulfill({ status: 401, body: '{}' }));
      await page.route('https://api.twelvedata.com/**', route => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ close: '180', previous_close: '170', timestamp: Math.floor(Date.now() / 1000) }) }));
      const result = await page.evaluate(async () => {
        const a = await import('/api.js'); a.saveManualPrice('AAPL', 120);
        const failed = await a.fetchStockQuote('AAPL', { apiKeyFinnhub: 'test-placeholder' });
        const kept = a.getManualPrices().AAPL.price;
        const success = await a.fetchStockQuote('AAPL', { apiKeyFinnhub: 'test-placeholder', apiKeyTwelveData: 'test-placeholder' });
        return { failed: failed.price, refreshed: Boolean(failed.refreshed), kept,
          success: success.price, source: a.getStoredPrices().AAPL.source, manual: a.getManualPrices().AAPL };
      });
      assert.deepEqual(result, { failed: 120, refreshed: false, kept: 120, success: 180, source: 'Twelve Data', manual: undefined });
    });

    await check('failed quote persistence is not counted as a successful refresh', async page => {
      const result = await page.evaluate(async () => {
        const a = await import('/api.js'); a.saveManualPrice('AAPL', 120);
        const originalFetch = window.fetch; const setItem = Storage.prototype.setItem;
        window.fetch = async () => new Response(JSON.stringify({ c: 150, pc: 140 }));
        Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
        try {
          const quote = await a.fetchStockQuote('AAPL', { apiKeyFinnhub: 'test-placeholder' });
          return { price: quote.price, refreshed: Boolean(quote.refreshed) };
        } finally { window.fetch = originalFetch; Storage.prototype.setItem = setItem; }
      });
      assert.deepEqual(result, { price: 120, refreshed: false });
    });

    await check('downloaded JSON restores manual prices, historical CSV and the same NAV', async page => {
      await page.evaluate(async ({ ledger, prices }) => {
        const s = await import('/storage.js'); const a = await import('/api.js');
        for (const row of ledger) await s.saveTransaction(row);
        a.saveManualPrice('AAPL', 120); await s.saveBenchmarkPrices(prices);
        s.saveSettings({ ...s.getSettings(), apiKeyFinnhub: 'private-test-key' });
      }, { ledger, prices });
      await page.reload(); await page.waitForFunction(() => document.querySelector('#m-total-nav').textContent === '$1,100.00');
      await page.locator('.nav-menu [data-view="settings"]').click();
      const backup = JSON.parse(await downloadText(page, '#btn-export-json'));
      assert.equal(backup.version, '1.2'); assert.equal(backup.manualPrices.AAPL.price, 120);
      assert.deepEqual(backup.benchmarkPrices, prices); assert.equal(backup.settings.apiKeyFinnhub, undefined);
      const restored = await page.evaluate(async backup => {
        const s = await import('/storage.js'); const a = await import('/api.js');
        await s.clearAllData(); await s.importAllData(backup); sessionStorage.clear();
        return { price: a.getManualPrices().AAPL.price, prices: await s.getBenchmarkPrices() };
      }, backup);
      assert.deepEqual(restored, { price: 120, prices });
      await page.reload(); await page.waitForFunction(() => document.querySelector('#m-total-nav').textContent === '$1,100.00');
    });

    await check('legacy backup compatibility and invalid price rejection before ledger writes', async page => {
      const result = await page.evaluate(async rows => {
        const s = await import('/storage.js');
        await s.importAllData({ version: '1.1', transactions: rows });
        const count = (await s.getAllTransactions()).length;
        const rejected = [];
        for (const extra of [{ manualPrices: { AAPL: { price: -1 } } },
          { benchmarkPrices: { QQQ: { '2026-02-31': { close: 10, adjusted: 10 } } } },
          { benchmarkPrices: { QQQ: { '2026-01-01': { close: 0, adjusted: 0 } } } }]) {
          try { await s.importAllData({ transactions: [{ id: 'must-not-save', type: 'DEPOSIT', date: '2026-01-01', amount: 1 }], ...extra }); rejected.push(false); }
          catch { rejected.push(true); }
        }
        return { count, rejected, after: (await s.getAllTransactions()).length };
      }, ledger);
      assert.deepEqual(result, { count: 2, rejected: [true, true, true], after: 2 });
    });

    await check('historical CSV persists without IndexedDB and recovers to primary storage', async page => {
      await fallback(page);
      const result = await page.evaluate(async prices => {
        const primary = await import('/storage.js');
        await primary.saveBenchmarkPrices({ QQQ: { '2025-01-01': { close: 1, adjusted: 1 } } });
        await auditFallback.importAllData({ transactions: [], benchmarkPrices: prices, manualPrices: { AAPL: { price: 120 } } });
        const fallback = await auditFallback.getBenchmarkPrices();
        const recovered = await primary.getBenchmarkPrices();
        localStorage.removeItem('hanriver_benchmark_prices_v1');
        const persisted = await primary.getBenchmarkPrices();
        return { fallback, recovered, persisted };
      }, prices);
      assert.deepEqual(result, { fallback: prices, recovered: prices, persisted: prices });
    });

    await check('CSV download is strict-parseable and retains split ratios and amounts', async page => {
      await page.evaluate(async rows => {
        const s = await import('/storage.js');
        for (const row of rows) await s.saveTransaction(row);
        await s.saveTransaction({ id: 'split', date: '2026-01-03', type: 'SPLIT', ticker: 'AAPL', ratio: 4, qty: 0, price: 0 });
      }, [ledger[0], { ...ledger[1], name: 'Company "A", Inc.', memo: '이유 "확인"\n다음, 조건' }]);
      await page.reload(); await page.waitForFunction(() => document.querySelector('#m-stock-count').textContent.includes('보유 중'));
      await page.locator('.nav-menu [data-view="transactions"]').click();
      const csv = await downloadText(page, '#btn-export-csv');
      const rows = JSON.parse(execFileSync('python3', ['-c',
        'import sys,csv,io,json; print(json.dumps(list(csv.DictReader(io.StringIO(sys.stdin.read().lstrip("\\ufeff")),strict=True)),ensure_ascii=False))'], { input: csv, encoding: 'utf8' }));
      assert.equal(rows.length, 3);
      assert.equal(rows.find(r => r['유형'] === 'BUY')['종목명'], 'Company "A", Inc.');
      assert.equal(rows.find(r => r['유형'] === 'BUY')['메모'], '이유 "확인"\n다음, 조건');
      assert.equal(rows.find(r => r['유형'] === 'SPLIT')['분할비율'], '4');
      assert.equal(rows.find(r => r['유형'] === 'DEPOSIT')['금액'], '1000');
      assert.ok(rows.every(r => r['계좌ID'] === 'default'));
    });

    await check('short exposure UI shows encumbered cash without a false stability claim', async page => {
      await page.evaluate(async () => {
        const s = await import('/storage.js');
        await s.saveTransaction({ id: 'dep', date: '2026-01-01', type: 'DEPOSIT', amount: 1000 });
        await s.saveTransaction({ id: 'short', date: '2026-01-02', type: 'SHORT', ticker: 'AAPL', qty: 100, price: 100 });
      });
      await page.reload(); await page.waitForFunction(() => document.querySelector('#m-cash').textContent === '$11,000.00');
      await page.locator('.nav-menu [data-view="habits"]').click();
      const text = await page.locator('#habits-diagnosis-content').innerText();
      assert.ok(text.includes('공매도 상환 의무는 $10,000.00'));
      assert.ok(text.includes('이를 차감한 현금은 $1,000.00'));
      assert.ok(text.includes('안정성을 판단할 수 없습니다'));
      assert.ok(!text.includes('현금 비중이 충분하여 안정적입니다'));
    });
    console.log(`${passed} audit regression scenarios passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
