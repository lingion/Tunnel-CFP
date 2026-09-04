// src/subscription/merge.ts
// 合并多个订阅载荷，保留 proxies / proxy-groups / rules
// 输入按形态自动识别：Clash YAML · base64(vless:// 列表) · 明文节点列表
// proxy-groups 同名时合并 proxies 列表去重
import * as yaml from 'js-yaml';
import type { ClashConfig, ProxyDef, ProxyGroup } from './types';
import { sha224Hex } from './sha224';
export { sha224Hex };

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

    if (parsed['proxy-groups']) {
      for (const pg of parsed['proxy-groups']) {
        const existing = merged['proxy-groups']!.find((g) => g.name === pg.name);
        if (existing) {
          const seen = new Set(existing.proxies);
          for (const name of pg.proxies) {
            if (!seen.has(name)) {
              existing.proxies.push(name);
              seen.add(name);
            }
          }
        } else {
          merged['proxy-groups']!.push({
            ...(pg as ProxyGroup),
            proxies: [...pg.proxies],
          });
        }
      }
    }

    if (parsed.rules) {
      merged.rules!.push(...parsed.rules);
    }
  }

  return yaml.dump(merged, { lineWidth: -1, noRefs: true });
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

// share-link 行 → 最小 Clash config YAML（proxies + selector group + 基础规则）
// vless 节点自动生成 Trojan 孪生节点（密码 sha224(该节点 uuid)）：vendor WS 入站按首包嗅探，
// 同一条 WS 路径 vless/trojan 双协议并存，实测 e2e 通；被封一个切另一个
function shareLinksToClashYaml(links: string[]): string {
  const proxies: ProxyDef[] = [];
  for (const link of links) {
    const p = parseShareLink(link);
    if (!p) continue;
    proxies.push(p);
    if (p.type === 'vless' && typeof p.uuid === 'string') {
      const twin = buildTrojanTwin(p);
      if (twin) proxies.push(twin);
    }
  }
  const config: ClashConfig = {
    proxies,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: proxies.map((p) => p.name),
      },
    ],
    rules: ['GEOIP,CN,DIRECT', 'MATCH,PROXY'],
  };
  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}

// vless Clash 节点 → trojan 孪生（同 server/port/ws/tls，password=sha224(uuid)）
function buildTrojanTwin(v: ProxyDef): ProxyDef | null {
  const uuid = v.uuid;
  if (typeof uuid !== 'string' || !uuid) return null;
  const twin: ProxyDef = {
    name: `${v.name}·Trojan`,
    type: 'trojan',
    server: v.server,
    port: v.port,
    password: sha224Hex(uuid),
    udp: v.udp === true,
    tls: true, // trojan 语义上强制 TLS；无 TLS 的明文节点不出孪生
    network: v.network || 'tcp',
  };
  if (v.network === 'ws' && v['ws-opts'] && typeof v['ws-opts'] === 'object') {
    twin['ws-opts'] = JSON.parse(JSON.stringify(v['ws-opts']));
  }
  if (typeof v.sni === 'string' && v.sni) twin.sni = v.sni;
  else if (typeof v['server-name'] === 'string' && v['server-name']) twin.sni = v['server-name'];
  if (v['skip-cert-verify'] === true) twin['skip-cert-verify'] = true;
  return twin;
}

// vless://uuid@host:port?params#name / trojan://password@host:port?params#name → Clash ProxyDef
export function parseShareLink(link: string): ProxyDef | null {
  const m = link.match(/^(vless|vmess|trojan|ss|hysteria2?):\/\//);
  if (!m) return null;
  const scheme = m[1];
  if (scheme !== 'vless' && scheme !== 'trojan') return null; // vmess(base64主体)/ss/hy2 按需扩展
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
      tls: scheme === 'trojan' || security === 'tls' || security === 'reality',
      network,
    };
    if (scheme === 'vless') {
      def.uuid = uuid;
    } else {
      def.password = query.get('password') ?? uuid; // trojan 密码在 userinfo 位
    }
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