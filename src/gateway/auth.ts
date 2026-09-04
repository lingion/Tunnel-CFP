// src/gateway/auth.ts
/** 恒定延迟比较（防 timing attack）。等长才逐字节比；不同长度也走满循环。 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  }
  return diff === 0;
}

/** 从 X-API-Key 头或 ?key= query 提取并校验 Agent key。 */
export async function checkAgentKey(req: Request, env: Env): Promise<boolean> {
  const expected = env.AGENT_KEY;
  if (!expected) return false;
  const provided = req.headers.get("X-API-Key") ?? new URL(req.url).searchParams.get("key");
  if (!provided) return false;
  return timingSafeEqual(provided, expected);
}
