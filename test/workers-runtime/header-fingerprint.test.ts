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
  // 取发往本用例目标 host 的 fetch(排除 HTML 管线里的其他调用)
  const wantHost = new URL(req.url).pathname.split('/proxy/')[1]?.split('/')[0] ?? '';
  const host = decodeURIComponent(wantHost).split('/')[0]?.replace(/^https?:\/\//, '') ?? wantHost;
  const call = mock.mock.calls.find(
    (c) => String(c[0]).includes(host)
  );
  if (!call) throw new Error(`no fetch call to ${host}; calls=` + mock.mock.calls.map((c) => String(c[0])).join(','));
  const init = call[1] as RequestInit;
  return new Headers(init.headers as HeadersInit);
}

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('sanitizeOutgoingHeaders 指纹一致性', () => {
  it('Sec-Fetch-Site 按目标站语境重算,不盲透传 cfp 视角值', async () => {
    // 代理页在 cfp 域,浏览器对 cfp→cfp 子资源恒发 same-origin——该值描述的是
    // 浏览器↔cfp 关系,原样带给 B.com 会与改写后的外域 Referer 构成不可能组合
    // (workflow deploy-regression 确认项)。新契约:重算,不采信入站 site。
    const h = await outgoingHeaders(
      proxyReq('https://cdn.other.com/logo.png', {
        'User-Agent': CHROME_UA,
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Site': 'same-origin', // 入站是 cfp 视角真值
        Referer: `${SELF}/proxy/https://a.com/page`, // 改写后 = https://a.com/page
      })
    );
    expect(h.get('sec-fetch-site')).toBe('cross-site'); // a.com → cdn.other.com
    expect(h.get('sec-fetch-mode')).toBe('no-cors'); // dest/mode 照旧透传
    expect(h.get('sec-fetch-dest')).toBe('image');
  });

  it('无 Referer 顶级导航:入站 site 一律重写为 none', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': CHROME_UA,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      })
    );
    expect(h.get('sec-fetch-site')).toBe('none');
  });

  it('同主域不同子域补发 same-site(真实浏览器值域)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/page', {
        'User-Agent': CHROME_UA,
        Referer: `${SELF}/proxy/https%3A%2F%2Fcdn.target.com%2Fapp.js`, // 改写后 cdn.target.com
      })
    );
    expect(h.get('sec-fetch-site')).toBe('same-site'); // 补齐路径同样走新算法
  });

  it('scheme 降级 https referer → http target 判 same-site', async () => {
    // fetch spec: same-origin 比 tuple origin(scheme/host/port),scheme 不同即否定;
    // same-site 比 site for web = registrable domain,与 scheme 无关。
    // (红队 finding 建议值 cross-site 不符规范,验证层按规范修正)
    const h = await outgoingHeaders(
      proxyReq('http://target.com/page', {
        'User-Agent': CHROME_UA,
        Referer: `${SELF}/proxy/https://target.com/secure`, // 改写后同 host https
      })
    );
    expect(h.get('sec-fetch-site')).toBe('same-site');
  });

  it('port 差异同主域判 same-site', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/api', {
        'User-Agent': CHROME_UA,
        Referer: `${SELF}/proxy/https://target.com:8443/page`,
      })
    );
    expect(h.get('sec-fetch-site')).toBe('same-site');
  });

  it('FQDN 尾点归一:target.com. 与 target.com 判 same-origin', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/page', {
        'User-Agent': CHROME_UA,
        Referer: `${SELF}/proxy/https://target.com./page`,
      })
    );
    expect(h.get('sec-fetch-site')).toBe('same-origin');
  });

  it('iOS15 Safari UA 不补 Sec-Fetch(该内核从不发)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      })
    );
    expect(h.get('sec-fetch-mode')).toBeNull(); // 补了反而与 UA 能力矛盾
    expect(h.get('sec-fetch-dest')).toBeNull();
  });

  it('iOS17 Safari UA 正常补齐', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      })
    );
    expect(h.get('sec-fetch-mode')).toBe('navigate');
  });

  it('CriOS(WebKit 内核,UA 却含 Chrome/)不补', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
        Accept: 'text/html',
      })
    );
    expect(h.get('sec-fetch-mode')).toBeNull();
  });

  it('Android 微信内置浏览器(MicroMessenger)不补', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.105 MQQBrowser/13.2 MicroMessenger/8.0.20 XWEB/4283 MMWEBSDK/20221011 Mobile Safari/537.36 MMWEBID/6543',
        Accept: 'text/html',
      })
    );
    expect(h.get('sec-fetch-mode')).toBeNull();
  });

  it('Firefox rv/120 补,rv/88 不补(90 前无 Fetch 元数据)', async () => {
    const hNew = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:120.0) Gecko/20100101 Firefox/120.0',
        Accept: 'text/html',
      })
    );
    expect(hNew.get('sec-fetch-mode')).toBe('navigate');
    const hOld = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:88.0) Gecko/20100101 Firefox/88.0',
        Accept: 'text/html',
      })
    );
    expect(hOld.get('sec-fetch-mode')).toBeNull();
  });

  it('门控只管补齐:入站带值就照重算透传(有值即事实)', async () => {
    // iOS15 内核理论上不发,但入站真带了(未来内核升级/中间层注入)——不否定事实
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Mobile/15E148 Safari/604.1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      })
    );
    expect(h.get('sec-fetch-dest')).toBe('document');
    expect(h.get('sec-fetch-mode')).toBe('navigate');
    expect(h.get('sec-fetch-site')).toBe('none'); // 重算路径仍生效
  });

  it('Referer 改写剥掉 cfp 侧 ?key= 凭证(对齐 merged.delete(key) 不变量)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/a.css', {
        'User-Agent': CHROME_UA,
        Referer: `${SELF}/proxy/https://target.com/page?key=SECRET9x&x=1`,
      })
    );
    const ref = h.get('referer')!;
    expect(ref).toBe('https://target.com/page?x=1');
    expect(ref).not.toContain('SECRET9x');
  });

  it('decodedPath 形态的 Referer 输出纯 ASCII(非 ASCII 重转义)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/item/next', {
        'User-Agent': CHROME_UA,
        // 全编码形态含 percent-CJK:decodedPath 命中,旧实现把解码后的裸中文写头
        Referer: `${SELF}/proxy/https%3A%2F%2Ftarget.com%2Fitem%2F%E4%B8%AD%E5%9B%BD`,
      })
    );
    const ref = h.get('referer')!;
    expect(ref).toBe('https://target.com/item/%E4%B8%AD%E5%9B%BD');
    // RFC 9110:头值只允许 ASCII/latin1
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(ref)).toBe(false);
  });

  it('非浏览器 UA 流量不干预 Sec-Fetch 透传(伪造者自担)', async () => {
    const h = await outgoingHeaders(
      proxyReq('https://target.com/', {
        'Sec-Fetch-Site': 'same-origin', // curl 伪造,无 Mozilla UA
      })
    );
    expect(h.get('sec-fetch-site')).toBe('same-origin'); // 不重算不重写
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
