// src/doh/handler.ts — DoH stub
// TODO: 实装见 Task 5 (dns-packet + Worker Cache)
export async function handleDoh(request: Request): Promise<Response> {
  return new Response('DoH stub', { status: 501 });
}