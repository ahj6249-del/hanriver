// Nasdaq 시가총액 파서와 /api/market-cap 함수 검사 (네트워크 없이 모의 응답 사용)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNasdaqScreener } from '../scripts/market-cap-source.mjs';

const saved = JSON.parse(await readFile(new URL('../market-cap-top100.json', import.meta.url), 'utf8'));
const nasdaqPayload = {
  data: {
    asof: 'Last price as of Nov 14, 2026',
    table: {
      rows: [...saved.rows].reverse().map(row => ({
        symbol: row.ticker,
        name: row.name + ' Common Stock',
        marketCap: row.marketCap.toLocaleString('en-US'),
        lastsale: row.price > 0 ? '$' + row.price : 'NA',
        pctchange: row.changePercent === null ? '' : row.changePercent + '%'
      }))
    }
  }
};

// 파서: 날짜, 정렬, 숫자 변환, 이름 정리
const parsed = parseNasdaqScreener(nasdaqPayload);
assert.equal(parsed.asOf, '2026-11-14');
assert.equal(parsed.rows.length, 100);
assert.deepEqual(parsed.rows.map(row => row.ticker), saved.rows.map(row => row.ticker));
assert.equal(parsed.rows[0].name, saved.rows[0].name);
assert.equal(parsed.rows[0].marketCap, saved.rows[0].marketCap);
assert.equal(parsed.rows[0].price, saved.rows[0].price);

// 불완전한 응답은 거부
assert.throws(() => parseNasdaqScreener({ data: { asof: 'Nov 14, 2026', table: { rows: nasdaqPayload.data.table.rows.slice(1) } } }), /100 distinct/);
assert.throws(() => parseNasdaqScreener({ data: { table: { rows: nasdaqPayload.data.table.rows } } }), /market date/);

// Pages Function: 성공 시 캐시 저장, 다음 요청은 캐시 사용, Nasdaq 실패 시 502
const store = new Map();
globalThis.caches = { default: {
  match: async request => store.get(request.url)?.clone(),
  put: async (request, response) => { store.set(request.url, response); }
} };
let nasdaqCalls = 0;
let nasdaqResponse = () => new Response(JSON.stringify(nasdaqPayload), { status: 200 });
const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.match(String(url), /^https:\/\/api\.nasdaq\.com\//);
  nasdaqCalls += 1;
  return nasdaqResponse();
};
const { onRequestGet } = await import('../functions/api/market-cap.js');
const pending = [];
const context = url => ({ request: new Request(url), waitUntil: promise => pending.push(promise) });

let response = await onRequestGet(context('https://hanriver-dmm.pages.dev/api/market-cap'));
assert.equal(response.status, 200);
assert.match(response.headers.get('Cache-Control'), /max-age=600/);
let body = await response.json();
assert.equal(body.asOf, '2026-11-14');
assert.equal(body.rows.length, 100);
await Promise.all(pending);

response = await onRequestGet(context('https://hanriver-dmm.pages.dev/api/market-cap?x=1'));
assert.equal((await response.json()).asOf, '2026-11-14');
assert.equal(nasdaqCalls, 1, 'second request should be served from cache');

store.clear();
nasdaqResponse = () => new Response('blocked', { status: 403 });
response = await onRequestGet(context('https://hanriver-dmm.pages.dev/api/market-cap'));
assert.equal(response.status, 502);
assert.equal(response.headers.get('Cache-Control'), 'no-store');
assert.equal(store.size, 0, 'failures must not be cached');

globalThis.fetch = realFetch;
console.log('market-cap checks passed');
