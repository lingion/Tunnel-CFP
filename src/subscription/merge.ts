// src/subscription/merge.ts
// 合并多个订阅载荷，保留 proxies / rules
// proxy-groups 一律丢弃，cfp 统一接管分组命名（cfpStandardGroups）
// 输入按形态自动识别：Clash YAML · base64(vless:// 列表) · 明文节点列表
import * as yaml from 'js-yaml';
import type { ClashConfig, ProxyDef, ProxyGroup } from './types';
import { regionGroupName } from './geoip';

// 全部 28 个地区分组（7 PRIMARY + 21 SECONDARY），必须全部出现在 proxy-groups
// 即便没节点也要占位（用户用例："分组里面可以没有东西 但不能没有这个分组"）
// 顺序：高频使用场景优先（巴哈 TW / Gemini HK / Play JP / 兜底 US）
export const ALL_REGION_GROUPS: ReadonlyArray<string> = [
  // PRIMARY（用户主场景）
  '🇹🇼 台湾',
  '🇭🇰 香港',
  '🇯🇵 日本',
  '🇺🇸 美国',
  '🇨🇳 中国大陆',
  '🇰🇷 韩国',
  '🇸🇬 新加坡',
  // SECONDARY（流量较大但非主要场景）
  '🇬🇧 英国',
  '🇩🇪 德国',
  '🇫🇷 法国',
  '🇦🇺 澳大利亚',
  '🇨🇦 加拿大',
  '🇮🇳 印度',
  '🇹🇭 泰国',
  '🇻🇳 越南',
  '🇲🇾 马来西亚',
  '🇵🇭 菲律宾',
  '🇮🇩 印度尼西亚',
  '🇧🇷 巴西',
  '🇳🇱 荷兰',
  '🇮🇹 意大利',
  '🇪🇸 西班牙',
  '🇸🇪 瑞典',
  '🇳🇴 挪威',
  '🇫🇮 芬兰',
  '🇨🇭 瑞士',
  '🇵🇱 波兰',
  '🇷🇺 俄罗斯',
  '🇹🇷 土耳其',
];

export function mergeYaml(yamls: string[], lookupCountry: (ip: string) => string | null = () => null): string {
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

  // cfp 标准分组：vendor 全丢，cfp 标准 4 件套接管 + 按 IP 真实 country code 分桶
  merged['proxy-groups'] = cfpStandardGroups(merged.proxies as ProxyDef[], lookupCountry);
  merged.rules = cfpRules();

  return yaml.dump(merged, { lineWidth: -1, noRefs: true });
}

// cfp 标准分流规则（固定两条兜底，vendor 自带规则全部丢弃）
export function cfpRules(): string[] {
  return ['GEOIP,CN,DIRECT', 'MATCH,PROXY'];
}

// 按 IP 真实 country code 分桶（vendor 节点 + 自研节点统一处理）
// lookupCountry(ip) → country code 字符串 or null（geoip 失败/未知）
// 返回 Map<groupName, name[]>：groupName 来自 geoip.regionGroupName()，
// 未命中（如未知 CC / lookup 失败）落入 🌐其他
// 🌐其他 永远存在但空桶时不发射到 proxy-groups（cfpStandardGroups 控制）
const FALLBACK_GROUP = '🌐其他';

export function bucketNodesByGeo(
  proxies: ProxyDef[],
  lookupCountry: (ip: string) => string | null,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const p of proxies) {
    const ip = typeof p.server === 'string' ? p.server : '';
    if (!p.name || !ip) continue; // 没名字/IP 不进任何桶
    const cc = lookupCountry(ip);
    const group = (cc ? regionGroupName(cc) : null) ?? FALLBACK_GROUP;
    const arr = buckets.get(group);
    if (arr) arr.push(p.name);
    else buckets.set(group, [p.name]);
  }
  return buckets;
}

// cfp 标准四件套分组（A1 = Clash-Butler 风格 PROXY / Auto / Fallback / 手动选择）
// + 按 IP 真实 country code 分桶的 url-test 地区分组（🇹🇼 台湾 / 🇭🇰 香港 / 🇯🇵 日本 / ...）
// lookupCountry 由 caller 注入（merge.ts 不接 KV/env，单测易 mock）
// 假 CN 节点（CF移动优选-CN-…）由 handler.stripFakeCountryNodes 在 merge 前剥
//
// 设计：28 个地区分组**永远发射**（即便空桶），用 type=select 兜底
// 原因：url-test 空 proxies 必崩（Clash 客户端报错）；用户需要"分组占位"以便后续切换
// 切换语义：把"🇯🇵 日本"分组拖到客户端某条规则的 proxy 里，如果当前没节点也只会显示"无节点"
export function cfpStandardGroups(
  proxies: ProxyDef[],
  lookupCountry: (ip: string) => string | null,
): ProxyGroup[] {
  const allNames = proxies.map((p) => p.name).filter(Boolean);
  if (allNames.length === 0) return [];

  const buckets = bucketNodesByGeo(proxies, lookupCountry);
  // 按 ALL_REGION_GROUPS 顺序发射（高频场景在前），不在 ALL_REGION_GROUPS 内的桶不发射
  const regionGroups: ProxyGroup[] = [];
  for (const name of ALL_REGION_GROUPS) {
    const members = buckets.get(name) ?? [];
    if (members.length > 0) {
      // 有节点 → url-test 自动选最优
      regionGroups.push({
        name,
        type: 'url-test',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        timeout: 3000,
        proxies: members,
      });
    } else {
      // 空桶 → select 占位（用户后续可手动选节点进此组）
      regionGroups.push({
        name,
        type: 'select',
        proxies: [],
      });
    }
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
export function mergeSubscriptionPayloads(
  payloads: string[],
  lookupCountry: (ip: string) => string | null = () => null,
): string {
  return mergeYaml(payloads.map(normalizePayload), lookupCountry);
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