// src/doh/rfc8484.ts
// RFC 8484 DoH wire format handler (application/dns-message)
// GET ?dns=<base64url-no-pad> · POST body=binary wire · Response 2xx=valid DNS
import { encode, decode } from 'dns-packet';
import {
  DOH_CONTENT_TYPE,
  DOH_DNS_ID,
  DOH_CACHE_TTL_SECONDS,
  UPSTREAM_DOH_URL,
} from './types';
import { getCachedResponse, putCachedResponse } from './cache';

// RFC 4648 §5: base64url alphabet (no padding)
function base64urlEncode(data: Uint8Array): string {
  let b64 = btoa(String.fromCharCode(...data));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str: string): Uint8Array {
  // Add padding back
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded2 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(padded2);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

export async function handleRfc8484(request: Request, ctx: ExecutionContext): Promise<Response> {
  let wireQuery: Uint8Array;

  if (request.method === 'POST') {
    // RFC 8484 §4.1: POST body = wire format, Content-Type = application/dns-message
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.includes(DOH_CONTENT_TYPE)) {
      return new Response('Unsupported Media Type', { status: 415 });
    }
    wireQuery = new Uint8Array(await request.arrayBuffer());
  } else if (request.method === 'GET') {
    // RFC 8484 §4.1: GET ?dns=base64url, no padding
    const dnsParam = new URL(request.url).searchParams.get('dns');
    if (!dnsParam) {
      return new Response('Bad Request: missing dns param', { status: 400 });
    }
    try {
      wireQuery = base64urlDecode(dnsParam);
    } catch {
      return new Response('Bad Request: invalid base64url', { status: 400 });
    }
  } else {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // Enforce DNS query size limit (§6: max 65,535 bytes)
  if (wireQuery.length > 65535) {
    return new Response('Payload Too Large', { status: 413 });
  }

  // Check cache
  const cached = await getCachedResponse(wireQuery);
  if (cached) return cached;

  // Forward to upstream
  const upstream = await fetch(UPSTREAM_DOH_URL, {
    method: 'POST',
    headers: { 'Content-Type': DOH_CONTENT_TYPE, Accept: DOH_CONTENT_TYPE },
    body: wireQuery,
  });

  // RFC 8484 §4.2: any 2xx = valid DNS response (even SERVFAIL/NXDOMAIN)
  const responseBytes = new Uint8Array(await upstream.arrayBuffer());
  // Return as-is (wire format is binary)

  // Cache result（真实 ctx —— {} 冒充会在 cache.put 的 waitUntil 上炸 1101）
  await putCachedResponse(ctx, wireQuery, responseBytes);

  return new Response(responseBytes, {
    status: upstream.status,
    headers: { 'Content-Type': DOH_CONTENT_TYPE },
  });
}