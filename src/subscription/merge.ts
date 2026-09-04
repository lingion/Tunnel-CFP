// src/subscription/merge.ts
// 合并多个 Clash YAML 订阅，保留 proxies / proxy-groups / rules
// proxy-groups 同名时合并 proxies 列表去重
import * as yaml from 'js-yaml';
import type { ClashConfig, ProxyDef, ProxyGroup } from './types';

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