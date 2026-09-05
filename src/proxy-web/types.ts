// src/proxy-web/types.ts
export interface WebProxyContext {
  currentOrigin: string;
  /** 当前页面路径(含 query 前的 pathname),相对 URL 的解析基准 */
  currentPath?: string;
}