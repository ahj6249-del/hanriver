// Cloudflare Pages Function: GET /api/market-cap
// 브라우저는 Nasdaq API를 직접 부를 수 없어(CORS) 서버에서 조회한다.
// 같은 결과를 10분 동안 Cloudflare 캐시에 두어 Nasdaq 호출을 줄인다.
import { fetchNasdaqTop100 } from '../../scripts/market-cap-source.mjs';

const MAX_AGE_SECONDS = 600;

export async function onRequestGet(context) {
  const cache = caches.default;
  const key = new Request(new URL('/api/market-cap', context.request.url).toString());
  const cached = await cache.match(key);
  if (cached) return cached;

  try {
    const snapshot = await fetchNasdaqTop100();
    const response = new Response(JSON.stringify({ ...snapshot, source: 'live' }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${MAX_AGE_SECONDS}`
      }
    });
    context.waitUntil(cache.put(key, response.clone()));
    return response;
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Nasdaq ranking unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
}
