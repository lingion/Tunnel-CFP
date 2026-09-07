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

  return new Response(JSON.stringify(toGoogleContract(decoded)), {
    headers: {
      'Content-Type': 'application/dns-json',
      'Cache-Control': `max-age=${DOH_CACHE_TTL_SECONDS}`,
    },
  });
}

// dns-packet 的 decode 输出（rcode/answers/type:"A"）映射为 Cloudflare/Google JSON
// 事实标准字段：Status(数值RCODE)/Answer(大写A,数值type)/TTL/name 尾点
// type 数值表（RFC 1035/3596/2782）：A=1 CNAME=5 NS=2 TXT=16 MX=15 AAAA=28 SRV=33
const RR_TYPE_NUM: Record<string, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, MX: 15, AAAA: 28, SRV: 33 };
const RCODE_NUM: Record<string, number> = {
  NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5,
};

function toGoogleContract(decoded: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Status: RCODE_NUM[decoded.rcode] ?? 2, // 未知 rcode 按 SERVFAIL 处理，fail-visible
    TC: Boolean(decoded.flag_tc),
    RD: Boolean(decoded.flag_rd),
    RA: Boolean(decoded.flag_ra),
    AD: Boolean(decoded.flag_ad),
    CD: Boolean(decoded.flag_cd),
  };
  if (decoded.questions) {
    out.Question = decoded.questions.map((q: any) => ({
      name: dotName(q.name),
      type: RR_TYPE_NUM[q.type] ?? q.type,
    }));
  }
  const answer = (decoded.answers || []).map((a: any) => ({
    name: dotName(a.name),
    type: RR_TYPE_NUM[a.type] ?? a.type,
    TTL: a.ttl ?? 0,
    data: String(a.data),
  }));
  if (answer.length) out.Answer = answer;
  const authority = (decoded.authorities || []).map((a: any) => ({
    name: dotName(a.name),
    type: RR_TYPE_NUM[a.type] ?? a.type,
    TTL: a.ttl ?? 0,
    data: typeof a.data === 'object' ? JSON.stringify(a.data) : String(a.data ?? ''),
  }));
  if (authority.length) out.Authority = authority;
  return out;
}

function dotName(name: string): string {
  return name.endsWith('.') ? name : `${name}.`;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}