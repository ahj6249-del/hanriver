# AI export regression checks

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
```

Optional environment variables: `BASE_URL`, `CHROMIUM_EXECUTABLE` (system Chromium),
`PLAYWRIGHT_MODULE` (module path), and `APP_JS_OVERRIDE` (prior app.js for regression reproduction).
Tests use isolated browser contexts and synthetic data; external HTTPS requests and
service workers are blocked. Eight scenarios check dashboard/report agreement,
short liabilities, returns, account filtering, future trades, and downloaded text.
