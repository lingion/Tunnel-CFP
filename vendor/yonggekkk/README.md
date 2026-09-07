# yonggekkk vendor

VLESS / Reality / Trojan / Shadowsocks Worker 实现。

支持协议：VLESS over WebSocket + TLS，Trojan over WebSocket + TLS，Shadowsocks。
可选 ECH (Encrypted Client Hello) + uTLS fingerprint。

默认 UUID 已重置为空字符串（`env.uuid` 必填），所有 proxyIP 默认列表保留。