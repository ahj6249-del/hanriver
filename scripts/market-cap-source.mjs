// Nasdaq 시가총액 TOP 100 조회·검증. 갱신 스크립트와 Cloudflare 함수가 함께 사용한다.
export const NASDAQ_ENDPOINT = 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=100&offset=0&sortColumn=marketCap&sortOrder=desc';

export const NASDAQ_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://www.nasdaq.com/market-activity/stocks/screener',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
};

function numberFrom(value) {
  const clean = String(value ?? '').replace(/[$,%\s]/g, '');
  return clean && Number.isFinite(Number(clean)) ? Number(clean) : null;
}

export function parseNasdaqScreener(payload) {
  const data = payload?.data;
  const sourceDate = String(data?.asof ?? data?.asOf ?? '').replace(/^Last price as of /i, '');
  const timestamp = Date.parse(sourceDate + ' UTC');
  if (!Number.isFinite(timestamp)) throw new Error('Nasdaq did not provide a market date.');
  const asOf = new Date(timestamp).toISOString().slice(0, 10);
  const rows = (data?.table?.rows ?? data?.rows ?? []).map(row => ({
    ticker: row.symbol,
    name: row.name?.replace(/\s+Common Stock$/i, '').trim(),
    marketCap: numberFrom(row.marketCap),
    price: numberFrom(row.lastsale),
    changePercent: numberFrom(row.pctchange)
  })).filter(row => row.ticker && row.name && row.marketCap > 0);
  // 시가총액 내림차순. 시가총액이 정확히 같은 종목은 티커 오름차순으로 고정해,
  // Nasdaq이 같은 값을 다른 순서로 돌려줘도 순위가 흔들리지 않게 한다.
  const byTicker = (a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
  rows.sort((a, b) => b.marketCap - a.marketCap || byTicker(a, b));
  if (rows.length !== 100 || new Set(rows.map(row => row.ticker)).size !== 100) {
    throw new Error('Expected 100 distinct ranked listings.');
  }
  return { asOf, rows };
}

export async function fetchNasdaqTop100(fetchImpl = fetch) {
  const response = await fetchImpl(NASDAQ_ENDPOINT, {
    headers: NASDAQ_HEADERS,
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error('Nasdaq returned HTTP ' + response.status);
  return parseNasdaqScreener(await response.json());
}
