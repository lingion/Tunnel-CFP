interface Env {
  KV: KVNamespace;
  ADMIN?: string;
  AGENT_KEY?: string;
  UUID?: string;
  KEY?: string;
  PROXY_KEY?: string;
  [key: string]: unknown;
}
