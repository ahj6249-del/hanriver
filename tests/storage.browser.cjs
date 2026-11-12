const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
    await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(base).origin ?
      route.continue() : route.abort());
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#m-stock-count').textContent.includes('보유 중'));
    const result = await page.evaluate(async () => {
      const primary = await import('/storage.js');
      const descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      const fallback = await import('/storage.js?fallback-test');
      await fallback.initDB();
      if (descriptor) Object.defineProperty(window, 'indexedDB', descriptor);
      else delete window.indexedDB;
      const backup = key => JSON.parse(localStorage.getItem(key) || '[]');
      const results = [];
      for (const [read, save, remove, key, sample] of [
        ['getAllTransactions', 'saveTransaction', 'deleteTransaction', 'hanriver_transactions_v1',
          { type: 'DEPOSIT', amount: 1000, date: '2026-01-01' }],
        ['getAllJournalNotes', 'saveJournalNote', 'deleteJournalNote', 'hanriver_journal_v1',
          { ticker: 'AAPL', idea: 'original', date: '2026-01-01' }]
      ]) {
        const id = key + '-record';
        await primary[save]({ ...sample, id });
        results.push([`${key}: primary write immediately mirrored`, backup(key).some(row => row.id === id)]);
        await fallback[save]({ ...sample, id, memo: 'fallback edit' });
        await fallback[save]({ ...sample, id: id + '-new' });
        let recovered = await primary[read]();
        results.push([`${key}: fallback edit and new row recovered`,
          recovered.length === 2 && recovered.find(row => row.id === id).memo === 'fallback edit']);
        // Simulate an older tab restoring a stale backup after a newer primary write.
        const stale = localStorage.getItem(key);
        await primary[save]({ ...sample, id, memo: 'new primary edit' });
        localStorage.setItem(key, stale);
        results.push([`${key}: newer primary wins`, (await primary[read]()).find(row => row.id === id).memo === 'new primary edit']);
        const beforeDelete = localStorage.getItem(key);
        await primary[remove](id);
        results.push([`${key}: primary delete immediately mirrored`, backup(key).some(row => row.id === id && row._deleted)]);
        localStorage.setItem(key, beforeDelete);
        results.push([`${key}: stale backup cannot resurrect deletion`, !(await primary[read]()).some(row => row.id === id)]);
        await fallback[remove](id + '-new');
        results.push([`${key}: fallback deletion recovered`, (await primary[read]()).length === 0]);
        // Legacy arrays have no updatedAt or deletion markers.
        localStorage.setItem(key, JSON.stringify([{ ...sample, id: id + '-legacy' }]));
        results.push([`${key}: legacy backup migrated`, (await primary[read]()).some(row => row.id === id + '-legacy')]);
        localStorage.removeItem(key);
        results.push([`${key}: recovered rows persisted to IndexedDB`, (await primary[read]()).some(row => row.id === id + '-legacy')]);
      }
      await Promise.all(Array.from({ length: 10 }, (_, i) => primary.saveTransaction({
        id: 'parallel-' + i, date: '2026-01-01', type: 'DEPOSIT', amount: i + 1
      })));
      results.push(['parallel writes retained', (await primary.getAllTransactions()).filter(row => row.id.startsWith('parallel-')).length === 10]);
      // Failure to write the sole durable fallback must not report success.
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
      let rejected = false;
      try { await fallback.saveTransaction({ id: 'must-fail', date: '2026-01-01', type: 'DEPOSIT', amount: 1 }); }
      catch { rejected = true; }
      finally { Storage.prototype.setItem = setItem; }
      results.push(['fallback quota failure surfaced', rejected]);
      await primary.clearAllData();
      results.push(['clear removes live data and deletion markers', (await primary.getAllTransactions()).length === 0 &&
        (await primary.getAllJournalNotes()).length === 0 && backup('hanriver_transactions_v1').length === 0]);
      return results;
    });
    for (const [name, passed] of result) { assert.ok(passed, name); console.log('PASS ' + name); }
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#m-stock-count').textContent.includes('보유 중'));
    assert.equal(await page.locator('#m-total-nav').innerText(), '$0.00');
    console.log('PASS reload after clearing');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
