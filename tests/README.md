# Regression checks

Holding-period checks use only Node.js:

```sh
node tests/holding-period.test.mjs
node tests/export-risk.test.mjs
```

Install Playwright in your development environment and its Chromium browser:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
```

From the repository root, start a static server in a separate terminal:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Run:

```sh
node tests/ai-export.browser.cjs
node tests/storage.browser.cjs
node tests/audit-fixes.browser.cjs
```

Optional environment variables: `BASE_URL`, `CHROMIUM_EXECUTABLE` (system Chromium),
`PLAYWRIGHT_MODULE` (module path), and `APP_JS_OVERRIDE` (prior app.js for regression reproduction).
Tests use isolated browser contexts and synthetic data; external HTTPS requests and
service workers are blocked. Eight scenarios check dashboard/report agreement,
short liabilities, returns, account filtering, future trades, and downloaded text.
Storage checks cover transaction/journal fallback recovery, legacy backups,
edit conflicts, deletion markers, immediate backups, parallel writes, quota errors,
durable recovery, and clearing/reloading. Holding-period checks cover independent
long/short cycles, reentries, partial closes, additions, splits and calendar days.

The audit regressions check fallback creation/edit/deletion with and without Web
Locks, mixed primary/fallback writes from three tabs (10 rounds), successful and
failed quote refreshes, backup version 1.2 round trips and legacy compatibility,
input validation, historical-price fallback recovery, strict CSV parsing using
Python's standard library, and short-sale cash warnings. API responses are mocked;
no real API key is needed. New JSON backups retain manual quotes and historical
CSV prices; API keys remain excluded. CSV adds amount, split ratio and account ID
after its original columns.
