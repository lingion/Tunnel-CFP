// 出站头指纹一致性测试(2026-10-31 纯净度加固)
// 背景: httpbingo 实测证实旧行为把 Sec-Fetch-* 全删而 sec-ch-ua 透传 →
// "带 CH 无 Fetch 元数据"是自动化脚本教科书指纹,Google 判人机的直接触发器。
// 规范: ①Sec-Fetch-* 透传(浏览器 forbidden headers 不可伪造,可信)
//      ②缺失时按资源类型补一致默认值 ③UA↔sec-ch-ua 版本矛盾时以 UA 为准重写
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebProxy } from '../../src/proxy-web/handler';

const SELF = 'https://your-worker.your-subdomain.workers.dev';

function proxyReq(target: string, headers: Record<string, string>): Request {
  return new Request(`${SELF}/proxy/${encodeURIComponent(target)}`, { headers });
}

/** 运行代理并返回发给源站的出站请求头 */
async function outgoingHeaders(req: Request): Promise<Headers> {
  const mock = vi.fn(async (_url: any, _init: any): Promise<Response> =>
    new Response('<html><head></head><body>hi</body></html>', {
      headers: { 'Content-Type': 'text/html' },
    })
  );
  vi.stubGlobal('fetch', mock as any);
  const res = await handleWebProxy(req);
  await res.text();
  // 只取对 https://target.com 的 fetch(排除 HTML 管线里的其他调用)
  const call = mock.mock.calls.find(
    (c) => String(c[0]).includes('target.com')
  );
  if (!call) throw new Error('no fetch call to target.com; calls=' + mock.mock.calls.map((c) => String(c[0])).join(','));
  const init = call[1] as RequestInit;
  return new Headers(init.headers as HeadersInit);
}

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeOutgoingHeaders 指纹一致性', () => {
  it('透传入站的 Sec-Fetch-* 头(不再删除)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA,
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'cross-site',
      })
    );
    expect(h.get('sec-fetch-mode')).toBe('navigate');
    expect(h.get('sec-fetch-dest')).toBe('document');
    expect(h.get('sec-fetch-site')).toBe('cross-site');
  });

  it('UA 是 Chrome 导航请求但缺 Sec-Fetch 时,补齐 navigate/document/none', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      })
    );
    expect(h.get('sec-fetch-mode')).toBe('navigate');
    expect(h.get('sec-fetch-dest')).toBe('document');
    expect(h.get('sec-fetch-site')).toBe('none');
  });

  it('子资源请求(带 Referer)缺失时补 cors/空值/cross-site', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/style.css', {
        'User-Agent': CHROME_UA,
        Accept: 'text/css,*/*;q=0.1',
        Referer: `${SELF}/proxy/https%3A%2F%2Ftarget.com%2Fpage`,
      })
    );
    expect(h.get('sec-fetch-mode')).toBe('no-cors'); // css/img 类子资源走 no-cors
    expect(h.get('sec-fetch-dest')).toBe('style');
    expect(h.get('sec-fetch-site')).toBe('same-origin'); // Referer 已改写为目标站语境
  });

  it('XHR/fetch 类(Accept */* 带 Referer)补 cors/empty/cross-site', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/api/data', {
        'User-Agent': CHROME_UA,
        Accept: '*/*',
        Referer: `${SELF}/proxy/https%3A%2F%2Ftarget.com%2Fpage`,
      })
    );
    expect(h.get('sec-fetch-mode')).toBe('cors');
    expect(h.get('sec-fetch-dest')).toBe('empty');
    expect(h.get('sec-fetch-site')).toBe('same-origin'); // Referer 已改写为目标站语境
  });

  it('UA 与 sec-ch-ua 大版本矛盾时以 UA 为准重写 sec-ch-ua', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA, // Chrome/142
        'Sec-CH-UA': '"Chromium";v="99", "Google Chrome";v="99", "Not_A Brand";v="8"', // 矛盾
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
      })
    );
    expect(h.get('sec-ch-ua')).toContain('v="142"');
    expect(h.get('sec-ch-ua')).not.toContain('v="99"');
  });

  it('非 Chromium UA(Firefox)不补造 sec-ch-ua', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
        Accept: 'text/html',
      })
    );
    expect(h.get('sec-ch-ua')).toBeNull();
    expect(h.get('sec-fetch-mode')).toBe('navigate'); // Fetch 元数据 Firefox 也发,照补
  });

  it('curl 默认 UA 且无 Accept 时不伪装浏览器(不补 Sec-Fetch)', async () => {
    const h = await outgoingHeaders(proxyReq('https://target.com/', {}));
    // 无 UA/浏览器特征 → 保持裸奔,补了反而与 curl UA 自相矛盾
    expect(h.get('sec-fetch-mode')).toBeNull();
  });
});
