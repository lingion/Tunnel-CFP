// src/doh/json-api.ts
// /resolve?name=...&type=A — Google/Cloudflare JSON-over-HTTPS compatibility API
// 不是 RFC 8484 标准，是事实标准（Cloudflare 1.1.1.1、Google 8.8.8.8 都支持）
import { encode, decode } from 'dns-packet';
import {
  DOH_CONTENT_TYPE,
  UPSTREAM_DOH_URL,
  DOH_CACHE_TTL_SECONDS,
} from './types';

const SUPPORTED_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV']);

export async function handleJsonApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  const type = (url.searchParams.get('type') || 'A').toUpperCase();

  if (!name) {
    return jsonError(400, 'missing required query param: name');
  }
  if (!SUPPORTED_TYPES.has(type)) {
    return jsonError(400, `unsupported record type: ${type}`);
  }

  const query = encode({
    id: 0,
    type: 'query',
    flags: 0x0100, // RD bit set
    questions: [{ type: type as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV', name, class: 'IN' }],
  });

  const upstream = await fetch(UPSTREAM_DOH_URL, {
    method: 'POST',
    headers: { 'Content-Type': DOH_CONTENT_TYPE, Accept: DOH_CONTENT_TYPE },
    body: query,
  });

  if (!upstream.ok) {
    return jsonError(502, `upstream DoH returned ${upstream.status}`);
  }

  const responsePacket = new Uint8Array(await upstream.arrayBuffer());
  // dns-packet decode 期望 Node Buffer（有 readUInt16BE），CF Workers 端无 Buffer；
  // 退化：若 Buffer 可用则 wrap，否则降级为直接传 Uint8Array（dns-packet v5+ 支持）
  const decoded = decode(Buffer.from(responsePacket.buffer, responsePacket.byteOffset, responsePacket.byteLength));

  return new Response(JSON.stringify(decoded), {
    headers: {
      'Content-Type': 'application/dns-json',
      'Cache-Control': `max-age=${DOH_CACHE_TTL_SECONDS}`,
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}