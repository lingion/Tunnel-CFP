// src/subscription/merge.ts
// 合并多个订阅载荷，保留 proxies / rules
// proxy-groups 一律丢弃，cfp 统一接管分组命名（cfpStandardGroups）
// 输入按形态自动识别：Clash YAML · base64(vless:// 列表) · 明文节点列表
import * as yaml from 'js-yaml';
import type { ClashConfig, ProxyDef, ProxyGroup } from './types';
import type { Bucket } from './cidr';
import { SELF_NAMED_BUCKETS } from './cidr';
export { SELF_NAMED_BUCKETS };

export function mergeYaml(yamls: string[]): string {
  const merged: ClashConfig = {
    proxies: [],
    'proxy-groups': [],
    rules: [],
  };

  for (const y of yamls) {
    if (!y || !y.trim()) continue;
    const parsed = (yaml.load(y) as ClashConfig) || {};

    if (parsed.proxies) {
      for (const p of parsed.proxies) {
        merged.proxies!.push({ ...(p as ProxyDef) });
      }
    }

    // proxy-groups 故意不合并：vendor 自带分组命名五花八门（中文 / emoji / 英文），
    // 全部丢弃，由 cfpStandardGroups 统一接管
    // rules 同样丢弃（vendor 带不带规则不归我们管），由 cfpRules() 固定两条兜底
  }

  // cfp 标准分组：vendor 全丢，cfp 标准 4 件套接管（不分地区组）
  merged['proxy-groups'] = cfpStandardGroups(merged.proxies as ProxyDef[]);
  merged.rules = cfpRules();

  return yaml.dump(merged, { lineWidth: -1, noRefs: true });
}

// cfp 标准分流规则（固定两条兜底，vendor 自带规则全部丢弃）
export function cfpRules(): string[] {
  return ['GEOIP,CN,DIRECT', 'MATCH,PROXY'];
}

// cfp 自研命名节点（cidr.ts 实测 colo 落地）→ 按 region bucket 拆组
// vendor 命名（CF-HKG-/🇭🇰xxx/自由名）不命中，统一挂 4 件套兜底
export function bucketSelfNamedNodes(names: string[]): Map<Bucket, string[]> {
  const map = new Map<Bucket, string[]>();
  for (const { name } of SELF_NAMED_BUCKETS) map.set(name, []);
  for (const n of names) {
    for (const { name, prefix } of SELF_NAMED_BUCKETS) {
      if (n.startsWith(prefix)) {
        map.get(name)!.push(n);
        break;
      }
    }
  }
  return map;
}

// cfp 标准四件套分组（A1 = Clash-Butler 风格 PROXY / Auto / Fallback / 手动选择）
// + 自研命名节点（APAC-HKG-/NA-LAX-/NA-SEA- 前缀）的地区 url-test 分组
// vendor 命名节点不可信（名称骗不了用户），只挂 4 件套兜底
// 假 CN 节点（CF移动优选-CN-…）由 handler.stripFakeCountryNodes 在 merge 后剥，
// 本函数只看 proxies.name，不重复判定
export function cfpStandardGroups(proxies: ProxyDef[]): ProxyGroup[] {
  const allNames = proxies.map((p) => p.name).filter(Boolean);
  if (allNames.length === 0) return [];

  const buckets = bucketSelfNamedNodes(allNames);
  const regionGroups: ProxyGroup[] = [];
  for (const { name } of SELF_NAMED_BUCKETS) {
    const members = buckets.get(name) ?? [];
    if (members.length === 0) continue; // 桶为空不发射，避免客户端一堆 0 节点组
    regionGroups.push({
      name,
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      timeout: 3000,
      proxies: members,
    });
  }

  // 4 件套在前，PROXY 永远是客户端最外层入口
  const stdGroups: ProxyGroup[] = [
    {
      name: 'PROXY',
      type: 'select',
      proxies: ['Auto', 'Fallback', 'DIRECT', '手动选择', ...allNames],
    },
    {
      name: 'Auto',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      timeout: 3000,
      proxies: allNames,
    },
    {
      name: 'Fallback',
      type: 'fallback',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      timeout: 3000,
      proxies: allNames,
    },
    {
      name: '手动选择',
      type: 'select',
      proxies: allNames,
    },
  ];

  return [...stdGroups, ...regionGroups];
}

// /sub/all 入口：先按载荷形态规范化（vless 列表 → Clash proxies），再走统一合并
export function mergeSubscriptionPayloads(payloads: string[]): string {
  return mergeYaml(payloads.map(normalizePayload));
}

// 单个载荷规范化：base64 解码（若可行且解码后像节点列表）→ 保持/转成 Clash YAML 文本
function normalizePayload(payload: string): string {
  const trimmed = (payload || '').trim();
  if (!trimmed) return '';

  // 形态1：base64 —— 解码后按行看是否节点列表（vless:// 等）
  if (!trimmed.includes('\n') && /^[A-Za-z0-9+/_=-]+$/.test(trimmed)) {
    try {
      const bin = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'));
      const binPadded = bin + '='.repeat((4 - (bin.length % 4)) % 4);
      const decoded = atob(trimmed); // 双保险：直接解码
      const text = decoded;
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => /^(vless|vmess|trojan|ss|hysteria2?):\/\//.test(l))) {
        return shareLinksToClashYaml(lines);
      }
    } catch {
      // 不是合法 base64，按原文处理
    }
  }

  // 形态2：明文节点列表（每行 share-link）
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^(vless|vmess|trojan|ss|hysteria2?):\/\//.test(l))) {
    return shareLinksToClashYaml(lines);
  }

  // 形态3：Clash YAML（含 proxies 键）——原样
  return trimmed;
}

// share-link 行 → 最小 Clash config YAML（仅 proxies）
// proxy-groups / rules 由 mergeYaml 的 cfpStandardGroups / cfpRules 统一接管
// 当前仅解析 vless://（cfp 自家协议），其他 scheme 在 normalizePayload 形态识别处被吞掉
function shareLinksToClashYaml(links: string[]): string {
  const proxies: ProxyDef[] = [];
  for (const link of links) {
    const p = parseShareLink(link);
    if (!p) continue;
    proxies.push(p);
  }
  return yaml.dump({ proxies }, { lineWidth: -1, noRefs: true });
}

// vless://uuid@host:port?params#name → Clash ProxyDef
// 其他 scheme（vmess/trojan/ss/hysteria2）按需扩展；当前 normalizePayload 也只接 vless:// 列表
export function parseShareLink(link: string): ProxyDef | null {
  const m = link.match(/^(vless|vmess|trojan|ss|hysteria2?):\/\//);
  if (!m) return null;
  const scheme = m[1];
  if (scheme !== 'vless') return null; // 仅 vless；其他 scheme 暂不解析
  try {
    const hashIdx = link.indexOf('#');
    const name = hashIdx >= 0 ? decodeURIComponent(link.slice(hashIdx + 1)) : `node-${Math.abs(hash(link)) % 10000}`;
    const body = (hashIdx >= 0 ? link.slice(0, hashIdx) : link).slice(`${scheme}://`.length);
    const qIdx = body.indexOf('?');
    const userInfo = qIdx >= 0 ? body.slice(0, qIdx) : body;
    const query = new URLSearchParams(qIdx >= 0 ? body.slice(qIdx + 1) : '');
    const at = userInfo.lastIndexOf('@');
    if (at < 0) return null;
    const uuid = userInfo.slice(0, at);
    const hostPort = userInfo.slice(at + 1);
    const colon = hostPort.lastIndexOf(':');
    if (colon < 0) return null;
    const server = hostPort.slice(0, colon).replace(/^\[|\]$/g, '');
    const port = parseInt(hostPort.slice(colon + 1), 10);
    if (!server || !Number.isFinite(port)) return null;

    const network = (query.get('type') || 'tcp').toLowerCase();
    const security = (query.get('security') || '').toLowerCase();
    const def: ProxyDef = {
      name,
      type: scheme,
      server,
      port,
      udp: query.get('udp') === 'true',
      tls: security === 'tls' || security === 'reality',
      network,
    };
    def.uuid = uuid;
    if (security === 'reality') {
      def['reality-opts'] = {
        'public-key': query.get('pbk') || '',
        'short-id': query.get('sid') || '',
      };
    }
    if (security === 'tls' || security === 'reality') {
      def['server-name'] = query.get('sni') || server;
      if (query.get('fp')) def['client-fingerprint'] = query.get('fp');
      if (query.get('allowInsecure') === '1' || query.get('insecure') === '1') def['skip-cert-verify'] = true;
    }
    if (network === 'ws') {
      const wsOpts: Record<string, unknown> = {
        path: query.get('path') ? decodeURIComponent(query.get('path')!) : '/',
      };
      const wsHost = query.get('host');
      if (wsHost) wsOpts.headers = { Host: wsHost };
      def['ws-opts'] = wsOpts;
    }
    return def;
  } catch {
    return null;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}