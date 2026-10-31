// 出站头指纹一致性测试(2026-10-31 纯净度加固)
// 背景: httpbingo 实测证实旧行为把 Sec-Fetch-* 全删而 sec-ch-ua 透传 →
// "带 CH 无 Fetch 元数据"是自动化脚本教科书指纹,Google 判人机的直接触发器。
// 规范: ①Sec-Fetch-* 透传(浏览器 forbidden headers 不可伪造,可信)
//      ②缺失时按资源类型补一致默认值 ③UA↔sec-ch-ua 版本矛盾时以 UA 为准重写
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWebProxy } from '../../src/proxy-web/handler';

const SELF = 'https://your-worker.your-subdomain.workers.dev';

function proxyReq(target: string, headers: Record<string, string>, method = 'GET'): Request {
  return new Request(`${SELF}/proxy/${encodeURIComponent(target)}`, { method, headers });
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

  it('UA 与 sec-ch-ua 大版本矛盾时以真实品牌为准重写, GREASE 品牌原样保留', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA, // Chrome/142
        // 真实 Chrome 119+ 品牌序随机, GREASE 项(Not_A Brand;v=8)常排首位——
        // 旧实现取首个 v= 作基准并 g 全局替换, 会把 GREASE 抬成 v=142,
        // 产出任何真实 Chrome 都不发的品牌列表(2026-10-31 workflow 红队实测确认)
        'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="99", "Google Chrome";v="99"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"macOS"',
      })
    );
    const ch = h.get('sec-ch-ua')!;
    expect(ch).toContain('"Chromium";v="142"');
    expect(ch).toContain('"Google Chrome";v="142"');
    expect(ch).toContain('"Not_A Brand";v="8"'); // GREASE 不被改写
    expect(ch).not.toContain('v="99"');
  });

  it('GREASE 排中间/末位的品牌序同样只改真实品牌', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA,
        'Sec-CH-UA': '"Google Chrome";v="140", "Not_A Brand";v="24", "Chromium";v="140"',
      })
    );
    const ch = h.get('sec-ch-ua')!;
    expect(ch).toContain('"Google Chrome";v="142"');
    expect(ch).toContain('"Chromium";v="142"');
    expect(ch).toContain('"Not_A Brand";v="24"'); // 非 8/99/24 之外的真实序值同样保留
  });

  it('OPTIONS 预检不被补成 navigate(浏览器不可能态;带 Referer 复刻红队 P4b)', async () => {
    const h = await outgoingHeaders(
      proxyReq(
        'https://target.com/api/data',
        {
          'User-Agent': CHROME_UA,
          Origin: SELF,
          Referer: `${SELF}/proxy/https://target.com/page`, // 页面脚本发起预检必带 Referer
          'Access-Control-Request-Method': 'POST',
        },
        'OPTIONS'
      )
    );
    expect(h.get('sec-fetch-mode')).toBe('cors');
    expect(h.get('sec-fetch-dest')).toBe('empty');
  });

  it('POST 且 Accept 不含 text/html 时按 XHR 语境补(带 Referer 复刻红队 probe B)', async () => {
    const h = await outgoingHeaders(
      proxyReq(
        'https://target.com/api/submit',
        {
          'User-Agent': CHROME_UA,
          Referer: `${SELF}/proxy/https://target.com/page`,
          'Content-Type': 'application/json',
          // 工具发的裸 POST 无 Accept —— 不得补成导航态
        },
        'POST'
      )
    );
    expect(h.get('sec-fetch-mode')).toBe('cors');
    expect(h.get('sec-fetch-dest')).toBe('empty');
  });

  it('POST 带 text/html Accept(顶级表单提交)保留 navigate/document', async () => {
    const h = await outgoingHeaders(
      proxyReq(
        'https://target.com/login',
        {
          'User-Agent': CHROME_UA,
          Accept: 'text/html,application/xhtml+xml',
          Referer: `${SELF}/proxy/https://target.com/login`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        'POST'
      )
    );
    expect(h.get('sec-fetch-mode')).toBe('navigate');
    expect(h.get('sec-fetch-dest')).toBe('document');
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
