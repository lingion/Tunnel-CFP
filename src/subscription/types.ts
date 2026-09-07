// src/subscription/types.ts
export interface ProxyDef {
  name: string;
  [key: string]: unknown;
}

export interface ProxyGroup {
  name: string;
  type: string;
  proxies: string[];
  [key: string]: unknown;
}

export interface ClashConfig {
  proxies?: ProxyDef[];
  'proxy-groups'?: ProxyGroup[];
  rules?: string[];
  [key: string]: unknown;
}