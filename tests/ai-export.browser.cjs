// Requires Playwright and Chromium. Start a static server at BASE_URL first.
// node tests/ai-export.browser.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const deposit = { id: 'deposit', type: 'DEPOSIT', date: '2026-01-01', amount: 1000 };
const buy = { id: 'buy', type: 'BUY', date: '2026-01-02', ticker: 'AAPL', qty: 5, price: 100 };
const short = { id: 'short', type: 'SHORT', date: '2026-01-02', ticker: 'TSLA', qty: 5, price: 100 };
const cases = [
  { name: 'long', rows: [deposit, buy], nav: '$1,100.00',
    lines: ['주식 평가액: $600.00 (비중 54.5%)', '현금 잔고: $500.00 (비중 45.5%)',
      '총 미실현 손익: +$100.00 (+20.00%)'] },
  { name: 'short', rows: [deposit, short], nav: '$1,100.00',
    lines: ['주식 평가액 (롱 − 숏): -$400.00 (비중 -36.4%)',
      '공매도 상환 의무: $400.00', '현금 잔고: $1,500.00 (비중 136.4%)',
      '총 미실현 손익: +$100.00 (+20.00%)'] },
  { name: 'long and short', rows: [deposit, buy, short], nav: '$1,200.00',
    lines: ['주식 평가액 (롱 − 숏): $200.00 (비중 16.7%)',
      '현금 잔고: $1,000.00 (비중 83.3%)', '총 미실현 손익: +$200.00 (+20.00%)'] },
  { name: 'cash only', rows: [deposit], nav: '$1,000.00',
    lines: ['주식 평가액: $0.00 (비중 0.0%)', '현금 잔고: $1,000.00 (비중 100.0%)'] },
  { name: 'empty', rows: [], nav: '$0.00', lines: ['현재 보유 중인 주식 포지션이 없습니다.'] },
  { name: 'missing deposit preserves ledger', rows: [buy], nav: '$100.00',
    lines: ['현금 잔고: -$500.00 (비중 -500.0%)'] },
  { name: 'other account excluded', rows: [deposit, { ...buy, accountId: 'growth' }],
    nav: '$1,000.00', lines: ['현재 보유 중인 주식 포지션이 없습니다.'] },
  { name: 'future trade excluded', rows: [deposit, { ...buy, date: '2026-11-12 13:00' }],
    nav: '$1,000.00', lines: ['현재 보유 중인 주식 포지션이 없습니다.'], absent: '2026-11-12 13:00' }
];

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    for (const item of cases) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-11-12T12:00:00Z'));
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const base = process.env.BASE_URL || 'http://127.0.0.1:8000';
      await page.route('https://**/*', route => new URL(route.request().url()).origin === new URL(base).origin ?
        route.continue() : route.abort());
      // Allows the same tests to demonstrate the failure against a prior app.js.
      if (process.env.APP_JS_OVERRIDE) {
        await page.route('**/app.js', route => route.fulfill({
          contentType: 'text/javascript', body: readFileSync(process.env.APP_JS_OVERRIDE, 'utf8')
        }));
      }
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#m-stock-count').textContent.includes('보유 중'));
      await page.evaluate(async rows => {
        const { saveTransaction } = await import('/storage.js');
        for (const row of rows) await saveTransaction(row);
        localStorage.setItem('hanriver_prices_cache_v1', JSON.stringify({
          AAPL: { price: 120, source: 'test' }, TSLA: { price: 80, source: 'test' }
        }));
      }, item.rows);
      await page.reload();
      await page.waitForFunction(nav => document.querySelector('#m-total-nav').textContent === nav, item.nav);
      await page.locator('.nav-menu [data-view="portfolio"]').click();
      await page.locator('#btn-open-ai-export').click();
      await page.locator('[data-period="all"]').click();
      const report = await page.locator('#ai-export-textarea').inputValue();
      assert.ok(report.includes(`총 순자산: ${item.nav}`), `${item.name}: NAV mismatch\n${report}`);
      for (const line of item.lines) assert.ok(report.includes(line), `${item.name}: missing ${line}`);
      if (item.absent) assert.ok(!report.includes(item.absent), `${item.name}: future trade exported`);
      assert.doesNotMatch(report, /NaN|Infinity/);
      if (item.name === 'long') {
        const downloaded = page.waitForEvent('download');
        await page.locator('#btn-download-ai-export').click();
        const stream = await (await downloaded).createReadStream();
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString('utf8'), report, 'Downloaded report must match the modal');
      }
      assert.deepEqual(errors, [], `${item.name}: browser errors`);
      console.log(`PASS ${item.name}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
