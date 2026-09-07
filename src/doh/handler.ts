// src/doh/handler.ts
// 路由：
//   /dns-query → RFC 8484 wire format (POST + GET)
//   /resolve   → JSON-over-HTTPS 兼容接口
import { handleRfc8484 } from './rfc8484';
import { handleJsonApi } from './json-api';

export async function handleDoh(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/dns-query') return handleRfc8484(request, ctx);
  if (url.pathname === '/resolve') return handleJsonApi(request);
  return new Response('Not Found', { status: 404 });
}