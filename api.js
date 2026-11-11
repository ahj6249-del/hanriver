/**
 * 한강아니면 한강뷰 (Hanriver) - Stock Market API & Price Provider
 * 미국 주식 실시간/지연 시세 조회, API 키 연동 (Twelve Data, Finnhub), 수동 시세 갱신 및 내장 캐시 제공
 */

// 미국 주요 종목 및 ETF 마스터 데이터
export const STOCK_DATABASE = [
  { ticker: 'NVDA', name: 'NVIDIA Corporation', sector: 'Semiconductors', price: 145.20, change: 3.45, changePercent: 2.43, previousClose: 141.75 },
  { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Consumer Electronics', price: 226.50, change: 1.20, changePercent: 0.53, previousClose: 225.30 },
  { ticker: 'MSFT', name: 'Microsoft Corporation', sector: 'Software', price: 422.80, change: -2.10, changePercent: -0.49, previousClose: 424.90 },
  { ticker: 'TSLA', name: 'Tesla, Inc.', sector: 'Automotive / EV', price: 218.40, change: 4.80, changePercent: 2.25, previousClose: 213.60 },
  { ticker: 'GOOGL', name: 'Alphabet Inc. (Class A)', sector: 'Internet Services', price: 178.60, change: 0.90, changePercent: 0.51, previousClose: 177.70 },
  { ticker: 'AMZN', name: 'Amazon.com, Inc.', sector: 'E-Commerce / Cloud', price: 208.30, change: 2.50, changePercent: 1.21, previousClose: 205.80 },
  { ticker: 'META', name: 'Meta Platforms, Inc.', sector: 'Social Media / AI', price: 585.10, change: 6.40, changePercent: 1.11, previousClose: 578.70 },
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', sector: 'Index ETF', price: 596.20, change: 2.10, changePercent: 0.35, previousClose: 594.10 },
  { ticker: 'QQQ', name: 'Invesco QQQ Trust (Nasdaq 100)', sector: 'Index ETF', price: 512.40, change: 3.80, changePercent: 0.75, previousClose: 508.60 },
  { ticker: 'AMD', name: 'Advanced Micro Devices, Inc.', sector: 'Semiconductors', price: 148.50, change: -1.30, changePercent: -0.87, previousClose: 149.80 },
  { ticker: 'PLTR', name: 'Palantir Technologies Inc.', sector: 'Enterprise Software / AI', price: 62.40, change: 2.90, changePercent: 4.87, previousClose: 59.50 },
  { ticker: 'COIN', name: 'Coinbase Global, Inc.', sector: 'Crypto Exchange', price: 315.00, change: 12.50, changePercent: 4.13, previousClose: 302.50 },
  { ticker: 'SOXX', name: 'iShares Semiconductor ETF', sector: 'Semiconductor ETF', price: 228.40, change: 2.60, changePercent: 1.15, previousClose: 225.80 },
  { ticker: 'NFLX', name: 'Netflix, Inc.', sector: 'Entertainment / Streaming', price: 820.00, change: 5.00, changePercent: 0.61, previousClose: 815.00 }
];

const LS_PRICES_CACHE = 'hanriver_prices_cache_v1';
const LS_MANUAL_PRICES = 'hanriver_manual_prices_v1';

// 캐시 불러오기
export function getStoredPrices() {
  const prices = {};
  // 2. 캐시된 API 시세
  try {
    const cached = localStorage.getItem(LS_PRICES_CACHE);
    if (cached) Object.assign(prices, JSON.parse(cached));
  } catch (e) {
    console.warn('Cache read error', e);
  }

  // 3. 사용자가 직접 수동 입력한 시세 (우선순위 최고)
  try {
    const manual = localStorage.getItem(LS_MANUAL_PRICES);
    if (manual) Object.assign(prices, JSON.parse(manual));
  } catch (e) {
    console.warn('Manual prices read error', e);
  }

  return prices;
}

export function saveManualPrice(ticker, price, changePercent = 0) {
  const manual = getManualPrices();
  manual[ticker.toUpperCase()] = {
    price: parseFloat(price),
    changePercent: parseFloat(changePercent) || 0,
    previousClose: parseFloat(price) / (1 + (parseFloat(changePercent) || 0) / 100),
    source: '수동 입력',
    updatedAt: new Date().toISOString()
  };
  localStorage.setItem(LS_MANUAL_PRICES, JSON.stringify(manual));
}

function getManualPrices() {
  try {
    const raw = localStorage.getItem(LS_MANUAL_PRICES);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * Finnhub API Key 유효성 테스트
 */
export async function testFinnhubKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, message: 'API 키를 입력해주세요.' };
  }
  try {
    const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${encodeURIComponent(apiKey.trim())}`);
    if (res.ok) {
      const data = await res.json();
      if (data.c && data.c > 0) {
        return { ok: true, price: data.c, message: `정상 연결되었습니다! (AAPL 실시간 시세: $${data.c.toFixed(2)})` };
      }
      return { ok: false, message: '시세 데이터를 응답받지 못했습니다. 키 권한을 확인해주세요.' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: '유효하지 않은 API 키입니다 (인증 실패).' };
    }
    return { ok: false, message: `연결 실패 (HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, message: `네트워크 오류: ${err.message}` };
  }
}

/**
 * 여러 종목 시세 일괄 갱신
 */
export async function refreshAllQuotes(tickers, settings = {}) {
  const results = {};
  const cleanTickers = Array.from(new Set(tickers.map(t => t.toUpperCase().trim()))).filter(Boolean);
  
  for (const ticker of cleanTickers) {
    try {
      const q = await fetchStockQuote(ticker, settings);
      results[ticker] = q;
    } catch (e) {
      console.warn(`Failed to refresh ${ticker}:`, e);
    }
  }
  return results;
}

/**
 * 실시간/지연 주가 조회 (API 키 있을 경우 Finnhub or Twelve Data 호출, 없을 시 캐시/마스터 반환)
 */
export async function fetchStockQuote(ticker, settings = {}) {
  const cleanTicker = ticker.toUpperCase().trim();
  const stored = getStoredPrices();

  // Finnhub API 연동
  if (settings.apiKeyFinnhub) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${cleanTicker}&token=${settings.apiKeyFinnhub}`);
      if (res.ok) {
        const data = await res.json();
        if (data.c && data.c > 0) {
          const quote = {
            price: data.c,
            changePercent: data.dp || 0,
            previousClose: data.pc || data.c,
            source: 'Finnhub',
            updatedAt: Number(data.t) > 0 ? new Date(Number(data.t) * 1000).toISOString() : null
          };
          updatePriceCache(cleanTicker, quote);
          return { ...quote, refreshed: true };
        }
      }
    } catch (err) {
      console.warn('Finnhub API fetch error:', err);
    }
  }

  // Twelve Data 연동
  if (settings.apiKeyTwelveData) {
    try {
      const res = await fetch(`https://api.twelvedata.com/quote?symbol=${cleanTicker}&apikey=${settings.apiKeyTwelveData}`);
      if (res.ok) {
        const data = await res.json();
        if (data.close && !isNaN(data.close)) {
          const cur = parseFloat(data.close);
          const prev = parseFloat(data.previous_close) || cur;
          const chgPct = parseFloat(data.percent_change) || 0;
          const quote = {
            price: cur,
            changePercent: chgPct,
            previousClose: prev,
            source: 'Twelve Data',
            updatedAt: Number(data.timestamp) > 0 ? new Date(Number(data.timestamp) * 1000).toISOString() : null
          };
          updatePriceCache(cleanTicker, quote);
          return { ...quote, refreshed: true };
        }
      }
    } catch (err) {
      console.warn('Twelve Data fetch error:', err);
    }
  }

  // API 키가 없거나 실패한 경우 저장된 시세 반환
  if (stored[cleanTicker]) {
    return stored[cleanTicker];
  }

  // 아예 없는 종목일 경우 기본 가이드 제공 (임의 생성하지 않고 입력 유도)
  return {
    price: 0,
    changePercent: 0,
    previousClose: 0,
    updatedAt: '시세 필요 (수동 입력 가능)'
  };
}

function updatePriceCache(ticker, quote) {
  try {
    const raw = localStorage.getItem(LS_PRICES_CACHE);
    const cache = raw ? JSON.parse(raw) : {};
    cache[ticker] = quote;
    localStorage.setItem(LS_PRICES_CACHE, JSON.stringify(cache));
  } catch (e) {
    console.warn('Cache update error', e);
  }
}

// Nasdaq Trader symbol directory snapshot, generated from nasdaqlisted.txt and otherlisted.txt.
let directoryRequest;
const koreanNames = {
  NVDA: '엔비디아', AAPL: '애플', TSLA: '테슬라', MSFT: '마이크로소프트',
  AMZN: '아마존', GOOGL: '구글 알파벳', GOOG: '구글 알파벳', META: '메타',
  PLTR: '팔란티어', AMD: '에이엠디', AVGO: '브로드컴', NFLX: '넷플릭스',
  COIN: '코인베이스', HOOD: '로빈후드', TSM: '티에스엠씨 대만반도체',
  'BRK.B': '버크셔 해서웨이', COST: '코스트코', WMT: '월마트', DIS: '디즈니',
  SOFI: '소파이', UBER: '우버', ORCL: '오라클', INTC: '인텔', SMCI: '슈퍼마이크로',
  IONQ: '아이온큐', MSTR: '마이크로스트래티지 스트래티지', RDDT: '레딧', VOO: '뱅가드',
  GLD: '금 골드', SOXL: '반도체 레버리지', TQQQ: '나스닥 레버리지'
};
export const TICKER_PATTERN = /^[A-Z0-9][A-Z0-9.:-]{0,24}$/;

function loadDirectory() {
  directoryRequest ??= fetch('./us-symbols.json').then(response => {
    if (!response.ok) throw new Error('종목 목록을 불러오지 못했습니다.');
    return response.json();
  }).catch(() => {
    directoryRequest = undefined;
    return null;
  });
  return directoryRequest;
}

export async function searchStock(query, limit = 20) {
  const q = query.trim().toUpperCase();
  if (!q) return { matches: [], directoryAvailable: true };
  const directory = await loadDirectory();
  const stocks = directory ? directory.map(([ticker, name, exchange, etf]) => ({
    ticker, name, exchange, etf
  })) : STOCK_DATABASE;
  const compact = q.replace(/\s+/g, '');
  const ranked = [];
  for (const stock of stocks) {
    const { ticker, name } = stock;
    const symbol = ticker.replaceAll('.', '-');
    const alias = koreanNames[ticker]?.replace(/\s+/g, '') || '';
    const upperName = name.toUpperCase();
    const score = ticker === q || symbol === q ? 0 :
      ticker.startsWith(q) ? 1 :
      alias && alias.includes(compact) ? 2 :
      upperName.startsWith(q) ? 3 :
      ticker.includes(q) || upperName.includes(q) ? 4 : -1;
    if (score >= 0) ranked.push({ stock, score });
  }
  ranked.sort((a, b) => a.score - b.score || a.stock.ticker.length - b.stock.ticker.length ||
    a.stock.ticker.localeCompare(b.stock.ticker));
  return { matches: ranked.slice(0, limit).map(row => row.stock), directoryAvailable: Boolean(directory) };
}
