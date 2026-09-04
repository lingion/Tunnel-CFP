// src/proxy-web/handler.ts — Web Proxy stub
// TODO: 实装见 Task 6 (HTMLRewriter + url-resolver + security)
export async function handleWebProxy(request: Request): Promise<Response> {
  return new Response('Web Proxy stub', { status: 501 });
}