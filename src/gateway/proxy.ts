const HOP_BY_HOP_STRIP = [
  "host", "content-length", "accept-encoding",
];

export class BadTargetError extends Error {
  constructor(message: string) { super(message); this.name = "BadTargetError"; }
}

/** 值级擦除: 值命中 redactValues（网关鉴权值）的头被剔除, 其余照传。 */
export function sanitizeRequestHeaders(h: Headers, redactValues: string[] = []): Headers {
  const out = new Headers();
  for (const [k, v] of h.entries()) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_STRIP.includes(lower)) continue;
    if (lower.startsWith("cf-")) continue;
    if (lower.startsWith("x-forwarded-")) continue;
    if (v !== "" && redactValues.includes(v)) continue;
    out.set(k, v);
  }
  return out;
}

/** pathAfterPrefix 形如 "/https://api.target.com/v1/chat?x=1"（可能是百分号编码后的） */
export function buildTargetUrl(pathAfterPrefix: string, incomingUrl: string): URL {
  let raw = pathAfterPrefix.slice(1); // 去掉开头 /
  try { raw = decodeURIComponent(raw); } catch { /* 原样使用 */ }
  // 目标自身 query 可能已被 CF 侧 encodeURIComponent 进路径；先尝试整体解析
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new BadTargetError(`invalid target url: ${raw.slice(0, 100)}`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new BadTargetError(`unsupported scheme: ${target.protocol}`);
  }
  // 合并入口 URL 的 query（排除 key）
  const incoming = new URL(incomingUrl);
  for (const [k, v] of incoming.searchParams) {
    if (k === "key") continue;
    target.searchParams.set(k, v);
  }
  return target;
}

export async function forward(req: Request, target: URL, redactValues: string[] = []): Promise<Response> {
  const headers = sanitizeRequestHeaders(req.headers, redactValues);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const res = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? req.body : undefined,
    redirect: "manual",
  });
  // 流式直通：不 await res.text()/arrayBuffer()，body 原样移交
  const out = new Response(res.body, res);
  return out;
}
