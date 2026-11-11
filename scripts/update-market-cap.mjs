import { readFile, writeFile } from 'node:fs/promises';

const output = new URL('../market-cap-top100.json', import.meta.url);
const endpoint = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=100&offset=0&sortColumn=marketCap&sortOrder=desc';
const fixture = process.argv[2];
let payload;
if (fixture) {
  payload = JSON.parse((await readFile(fixture, 'utf8')).replace(/^\uFEFF/, ''));
} else {
  const response = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      Referer: 'https://www.nasdaq.com/market-activity/stocks/screener',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error('Nasdaq returned HTTP ' + response.status);
  payload = await response.json();
}

function numberFrom(value) {
  const clean = String(value ?? '').replace(/[$,%\s]/g, '');
  return clean && Number.isFinite(Number(clean)) ? Number(clean) : null;
}

const data = payload.data;
const sourceDate = String(data?.asof ?? data?.asOf ?? '').replace(/^Last price as of /i, '');
const timestamp = Date.parse(sourceDate + ' UTC');
if (!Number.isFinite(timestamp)) throw new Error('Nasdaq did not provide a market date.');
const asOf = new Date(timestamp).toISOString().slice(0, 10);
const rows = (data?.table?.rows ?? data?.rows ?? []).map(row => ({
  ticker: row.symbol,
  name: row.name?.replace(/\s+Common Stock$/i, '').trim(),
  marketCap: numberFrom(row.marketCap),
  changePercent: numberFrom(row.pctchange)
})).filter(row => row.ticker && row.name && row.marketCap > 0);
rows.sort((a, b) => b.marketCap - a.marketCap);
if (rows.length !== 100 || new Set(rows.map(row => row.ticker)).size !== 100) {
  throw new Error('Expected 100 distinct ranked listings.');
}

let previous;
try {
  previous = JSON.parse(await readFile(output, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous?.asOf > asOf) throw new Error('Nasdaq returned an older market date.');
await writeFile(output, JSON.stringify({ asOf, rows }, null, 2) + '\n');
console.log('Nasdaq market date', asOf, 'listings', rows.length);
