// src/proxy-web/handler.ts
// /proxy/<encoded target url> 完整 HTML 重写代理
import { createRewriter } from './rewriter';
import { validateTargetUrl, SecurityError } from './security';
import type { WebProxyContext } from './types';

export async function handleWebProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // path = /proxy/<encoded target url> (URI-encoded)
  const encoded = url.pathname.slice('/proxy/'.length);
  if (!encoded) {
    return new Response('Missing target URL after /proxy/', { status: 400 });
  }

  let target: string;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response('Invalid URL encoding', { status: 400 });
  }

  try {
    validateTargetUrl(target);
  } catch (e) {
    if (e instanceof SecurityError) {
      return new Response(`Security error: ${e.message}`, { status: 400 });
    }
    throw e;
  }

  // 转发请求到目标，透传 method/headers/body
  const targetRes = await fetch(target, {
    method: request.method,
    headers: sanitizeOutgoingHeaders(request.headers),
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
    redirect: 'follow',
  });

  const contentType = targetRes.headers.get('Content-Type') || '';
  const newHeaders = new Headers(targetRes.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  // 去掉目标站点的 CSP/X-Frame-Options，否则代理页面被自身规则锁住
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('Content-Security-Policy-Report-Only');
  newHeaders.delete('X-Frame-Options');

  // HTML → 重写
  if (contentType.includes('text/html')) {
    const targetUrl = new URL(target);
    const ctx: WebProxyContext = {
      currentOrigin: `${targetUrl.protocol}//${targetUrl.host}`,
    };
    const rewriter = createRewriter(ctx);
    // CF API: rewriter.transform(response) → Response (consumes response.body internally)
    const transformed = await rewriter.transform(targetRes);
    return new Response(transformed.body, {
      status: targetRes.status,
      headers: newHeaders,
    });
  }

  // 其他资源（CSS/JS/图片/字体等）→ 透传
  return new Response(targetRes.body, {
    status: targetRes.status,
    headers: newHeaders,
  });
}

function sanitizeOutgoingHeaders(headers: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of headers.entries()) {
    const lower = k.toLowerCase();
    // 去掉代理相关头，避免跳回原站
    if (
      lower === 'host' ||
      lower.startsWith('cf-') ||
      lower.startsWith('x-forwarded-') ||
      lower === 'content-length'
    ) {
      continue;
    }
    out.set(k, v);
  }
  return out;
}