// src/doh/cache.ts
// Worker Cache API helper for DoH responses (30s TTL)
// RFC 8484 §4.2: HTTP Cache-Control applies; we use Worker Cache for hot path
import { DOH_CACHE_TTL_SECONDS, DOH_CONTENT_TYPE } from './types';

export async function getCachedResponse(queryBytes: Uint8Array): Promise<Response | null> {
  if (typeof caches === 'undefined') return null;
  const cache = caches.default;
  const key = buildCacheKey(queryBytes);
  return (await cache.match(key)) ?? null;
}

export async function putCachedResponse(
  ctx: ExecutionContext,
  queryBytes: Uint8Array,
  responseBytes: Uint8Array
): Promise<void> {
  if (typeof caches === 'undefined') return;
  const cache = caches.default;
  const key = buildCacheKey(queryBytes);
  const response = new Response(responseBytes, {
    headers: {
      'Content-Type': DOH_CONTENT_TYPE,
      'Cache-Control': `max-age=${DOH_CACHE_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
}

function buildCacheKey(queryBytes: Uint8Array): Request {
  // Use hex of the query as the cache key URL
  const hex = Array.from(queryBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(`https://cfp-cache.invalid/doh/${hex}`);
}