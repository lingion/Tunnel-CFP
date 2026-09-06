// src/subscription/cidr.ts
// /sub/all 优选节点命名：vendor 旧实现把 request.cf.country 写到节点名上当"国家"，
// 但 CF edge IP 是 anycast，根本无国家级归属——这是误导信息。
// 现改成：内置 CF 公开 CIDR + 按 CF PoP 数量加权分桶，按"region"诚实标注。
// Region 定义参考 cloudflarestatus.com/api/v2/components.json 351 PoP 分布（截止 2026-09）：
//   2026-09-04 改为家宽实测落地 colo:HKG(104.x 大段+172.66) / LAX(8.35/8.39/91.193) / SEA(188.164/104.26/172.67)
// 不做实时探测/外网请求——确定性、可缓存、可测试。
// 命名 = {大区}-{落地机房}-{序号},如 APAC-HKG-01 / NA-LAX-46
export type Region = 'APAC' | 'NA';
export type Colo = 'HKG' | 'LAX' | 'SEA';
export type Bucket = 'APAC-HKG' | 'NA-LAX' | 'NA-SEA';

export interface CidrEntry {
  cidr: string;
}

export interface OptimizedNode {
  name: string;       // {大区}-{COLO}-{idx},如 APAC-HKG-01
  server: string;     // IPv4
  port: number;
  uuid: string;
  tls: boolean;
  network: 'ws';
  sni: string;        // 默认 worker.example.com(部署时经 opts.sni 传入真实域)
  'client-fingerprint': string;
  'ws-opts': {
    path: string;
    headers: { Host: string };
  };
}

export interface OptimizeOpts {
  uuid?: string;             // 默认 '00000000-0000-4000-8000-000000000000'（vendor 占位符）
  sni?: string;              // 默认 'worker.example.com'
  count?: number;            // 默认 64（实测落地加权 HKG40/LAX12/SEA12）
  path?: string;             // 默认 '/'
  cidrText?: string;         // 自定义 CIDR 文本（测试用）
}

// 默认 CIDR：直接从 cmliu/CF-CIDR.txt 同步（2026-09 拉取，24 段）。
// 内置以便离线/可缓存；如需更新见 cmliu/cmliu 的 main 分支。
const DEFAULT_CF_CIDR = `8.35.211.0/24
8.39.125.0/24
188.164.248.0/24
91.193.58.0/23
172.66.0.0/22
104.16.144.0/20
104.16.240.0/20
104.17.16.0/20
104.17.48.0/20
104.17.96.0/20
104.17.112.0/20
104.17.144.0/20
104.17.160.0/20
104.17.176.0/20
104.17.208.0/20
104.18.33.0/24
104.19.32.0/22
104.19.48.0/21
104.19.144.0/21
104.26.0.0/20
172.67.64.0/20`;

// 桶权重(实测落地占比:HKG 段总空间最大占大头;LAX 3 段;SEA 3 段)= 64 节点
const DEFAULT_WEIGHTS: Record<Bucket, number> = {
  'APAC-HKG': 40, 'NA-LAX': 12, 'NA-SEA': 12,
};

// CF 公开端口池（vendor 一致：[443, 2053, 2083, 2087, 2096, 8443]）
const CF_PORTS = [443, 2053, 2083, 2087, 2096, 8443] as const;

// 把 CIDR 段按"已知 region 标签"分配——CF 公开段大部分 anycast，
// 但通过手工划分（参照 CF PoP 实际所在 + 公开 IP 段公开归属文档），足够"不骗人"。
// 没匹配到的段归 HKG（104.x 主力段所在）。
// 废段(对自用 host 报 1034)不入池:162.159.32/20 · 162.159.38/23 · 108.162.198/24 · 198.41.208/23
export const CIDR_BUCKETS: Record<string, Bucket> = {
  // 2026-09-04 家宽(111.43.134.102, China Mobile)实测落地 colo,curl --resolve + /cdn-cgi/trace
  // APAC-HKG:104.x 大段 + 172.66/22 全部落香港
  '104.16.144.0/20': 'APAC-HKG',
  '104.16.240.0/20': 'APAC-HKG',
  '104.17.16.0/20': 'APAC-HKG',
  '104.17.48.0/20': 'APAC-HKG',
  '104.17.96.0/20': 'APAC-HKG',
  '104.17.112.0/20': 'APAC-HKG',
  '104.17.144.0/20': 'APAC-HKG',
  '104.17.160.0/20': 'APAC-HKG',
  '104.17.176.0/20': 'APAC-HKG',
  '104.17.208.0/20': 'APAC-HKG',
  '104.18.33.0/24': 'APAC-HKG',
  '104.19.32.0/22': 'APAC-HKG',
  '104.19.48.0/21': 'APAC-HKG',
  '104.19.144.0/21': 'APAC-HKG',
  '172.66.0.0/22': 'APAC-HKG',
  // NA-LAX:这三个段落洛杉矶
  '8.35.211.0/24': 'NA-LAX',
  '8.39.125.0/24': 'NA-LAX',
  '91.193.58.0/23': 'NA-LAX',
  // NA-SEA:这三个段落西雅图
  '188.164.248.0/24': 'NA-SEA',
  '104.26.0.0/20': 'NA-SEA',
  '172.67.64.0/20': 'NA-SEA',
};

// 解析 CIDR 文本为 CidrEntry[]
export function parseCidrText(text: string): CidrEntry[] {
  if (!text) return [];
  const out: CidrEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(line)) continue;
    out.push({ cidr: line });
  }
  return out;
}

// 解析 cidr → { baseInt, mask }
function parseCidrOne(cidr: string): { base: number; len: number } | null {
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) return null;
  const ip = cidr.slice(0, slashIdx);
  const plen = cidr.slice(slashIdx + 1);
  const prefix = parseInt(plen, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let base = 0;
  for (let i = 0; i < 4; i++) {
    const o = parseInt(parts[i]!, 10);
    if (!Number.isFinite(o) || o < 0 || o > 255) return null;
    base = (base * 256) + o;
  }
  return { base: base >>> 0, len: prefix };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const o = parseInt(parts[i]!, 10);
    if (!Number.isFinite(o) || o < 0 || o > 255) return null;
    v = (v * 256) + o;
  }
  return v >>> 0;
}

export function ipInCidr(ip: string, entries: CidrEntry[]): boolean {
  const v = ipv4ToInt(ip);
  if (v === null) return false;
  for (const e of entries) {
    const p = parseCidrOne(e.cidr);
    if (!p) continue;
    const mask = p.len === 0 ? 0 : (0xffffffff << (32 - p.len)) >>> 0;
    if ((v & mask) === (p.base & mask)) return true;
  }
  return false;
}

// 在指定 cidr 中随机抽一个 IP
function randomIpFromCidr(cidr: string): string {
  const p = parseCidrOne(cidr);
  if (!p) return '0.0.0.0';
  const hostBits = 32 - p.len;
  const offset = Math.floor(Math.random() * Math.pow(2, hostBits));
  const ipInt = (p.base + offset) >>> 0;
  return [
    (ipInt >>> 24) & 0xff,
    (ipInt >>> 16) & 0xff,
    (ipInt >>> 8) & 0xff,
    ipInt & 0xff,
  ].join('.');
}

// 主入口：按权重分桶 + 抽 IP + 命名
export function generateOptimizedNodes(opts: OptimizeOpts = {}): OptimizedNode[] {
  const uuid = opts.uuid ?? '00000000-0000-4000-8000-000000000000';
  const sni = opts.sni ?? 'worker.example.com';
  const path = opts.path ?? '/';
  const totalCount = opts.count ?? 64;

  const text = opts.cidrText ?? DEFAULT_CF_CIDR;
  const all = parseCidrText(text);
  if (all.length === 0) return [];

  // 按 region 桶分组
  const byRegion: Record<Bucket, string[]> = {
    'APAC-HKG': [], 'NA-LAX': [], 'NA-SEA': [],
  };
  for (const e of all) {
    const bucket = CIDR_BUCKETS[e.cidr] ?? 'APAC-HKG';
    byRegion[bucket].push(e.cidr);
  }

  const regions: Bucket[] = ['APAC-HKG', 'NA-LAX', 'NA-SEA'];
  // 总权重
  const totalWeight = regions.reduce((s, r) => s + DEFAULT_WEIGHTS[r], 0);

  const nodes: OptimizedNode[] = [];
  const seen = new Set<string>();
  let idx = 0;
  for (const region of regions) {
    const weight = DEFAULT_WEIGHTS[region];
    const regionCount = Math.round((weight / totalWeight) * totalCount);
    const pool = byRegion[region];
    if (pool.length === 0) continue;
    for (let i = 0; i < regionCount; i++) {
      const cidr = pool[Math.floor(Math.random() * pool.length)]!;
      // 去重抽样：IP + 端口组合唯一
      let ip = '';
      let port: number = 0;
      let key = '';
      for (let tries = 0; tries < 20; tries++) {
        ip = randomIpFromCidr(cidr);
        port = CF_PORTS[Math.floor(Math.random() * CF_PORTS.length)]!;
        key = `${ip}:${port}`;
        if (!seen.has(key)) {
          seen.add(key);
          break;
        }
        // 最后一次尝试也撞上就接受（CF IP 池 24 段 ×6 端口空间大，几乎不会撞）
        if (tries === 19) seen.add(key);
      }
      nodes.push({
        name: `${region}-${(idx + 1).toString().padStart(2, '0')}`,
        server: key.split(':')[0]!,
        port,
        uuid,
        tls: true,
        network: 'ws',
        sni,
        'client-fingerprint': 'chrome',
        'ws-opts': {
          path,
          headers: { Host: sni },
        },
      });
      idx++;
    }
  }

  return nodes;
}