// src/proxy-web/ws-bridge.ts
// /proxy-ws/<scheme>/<host>/<path...> — WebSocket 桥
// 浏览器 shim 把 ws(s)://host/path 改写成 /proxy-ws/<scheme>/<host>/<path>,
// 这里用 cloudflare:sockets 对目标站建立 TCP(TLS 视 scheme),
// 完成 WS 握手后双向泵帧。
//
// 形态参考 edgetunnel vendor 的 vless-over-WS(TCP socket + WS 对接),
// 但这里是纯 TCP 透传,不做任何协议改写 — 目标站看到的就是一条普通 WS 连接。

import { validateBridgeTarget } from './security-bridge';

export async function handleWsBridge(request: Request): Promise<Response> {
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected websocket upgrade', { status: 426 });
  }

  const url = new URL(request.url);
  // /proxy-ws/<scheme>/<host>/<path>
  const m = url.pathname.match(/^\/proxy-ws\/(ws|wss)\/([^/]+)((?:\/.*)?)$/i);
  if (!m) {
    return new Response('Bad bridge path; expected /proxy-ws/<ws|wss>/<host>/<path>', { status: 400 });
  }
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!;
  const path = m[3] || '/';

  try {
    validateBridgeTarget(host);
  } catch (e) {
    return new Response(`Bridge blocked: ${(e as Error).message}`, { status: 400 });
  }

  const port = Number(host.split(':')[1] ?? (scheme === 'wss' ? 443 : 80));
  const hostname = host.split(':')[0]!;

  // 对目标站建 TCP;wss → secureTransport: on(starttls 语义即 TLS 立即握手)
  const { connect } = await import('cloudflare:sockets');
  const socket = connect({ hostname, port }, {
    secureTransport: (scheme === 'wss' ? 'on' : 'off') as 'on' | 'off',
    allowHalfOpen: false,
  });

  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair) as [WebSocket, WebSocket];
  server.accept();

  // 发起 WS 握手(按 RFC 6455,透传 Sec-WebSocket-Key,补一个固定 Version)
  const key = request.headers.get('Sec-WebSocket-Key') ?? btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const handshake =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    (request.headers.get('Sec-WebSocket-Protocol')
      ? `Sec-WebSocket-Protocol: ${request.headers.get('Sec-WebSocket-Protocol')}\r\n`
      : '') +
    `Origin: ${scheme === 'wss' ? 'https' : 'http'}://${host}\r\n` +
    `\r\n`;

  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(handshake));
  writer.releaseLock();

  // TCP → WS:读 origin 响应流,解析 HTTP 头确认 101,之后按 WS 帧透传给浏览器
  pumpSocketToWs(socket, server);

  // WS → TCP:浏览器每帧(base64/binary)写成原始字节泵给 socket
  server.addEventListener('message', async (ev: MessageEvent) => {
    // 浏览器侧 WS 只收发帧;我们作为"中间 WS 服务端"收到的是已解码消息。
    // 但对端是原生 TCP 上的 WS — 需要把消息重新封帧。
    // 这里限制:仅支持 text 帧封帧(浏览器侧 frame 原样是二进制时转 binary 帧)。
    const w = socket.writable.getWriter();
    try {
      if (typeof ev.data === 'string') {
        await w.write(encodeWsFrame(new TextEncoder().encode(ev.data), 0x1));
      } else {
        await w.write(encodeWsFrame(new Uint8Array(ev.data), 0x2));
      }
    } finally {
      w.releaseLock();
    }
  });

  server.addEventListener('close', () => {
    try { socket.close(); } catch { /* already closed */ }
  });
  server.addEventListener('error', () => {
    try { socket.close(); } catch { /* already closed */ }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/** TCP 流 → WS 帧:先等握手响应(101),再把后续字节按 WS 帧解析成消息 */
function pumpSocketToWs(socket: any, ws: WebSocket): void {
  (async () => {
    const reader = socket.readable.getReader();
    let buf: Uint8Array<ArrayBuffer> = new Uint8Array(0);
    let handshakeDone = false;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value: rawValue } = await reader.read();
        const value = rawValue ? new Uint8Array(rawValue) : null;
        if (done) break;
        if (!value) continue;
        if (!handshakeDone) {
          const merged = concat(buf, value);
          const headerEnd = merged.findIndex(
            (_, i) =>
              merged[i] === 0x0d && merged[i + 1] === 0x0a && merged[i + 2] === 0x0d && merged[i + 3] === 0x0a,
          );
          if (headerEnd === -1) {
            buf = merged;
            continue;
          }
          const head = decoder.decode(merged.slice(0, headerEnd));
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            ws.close(1002, 'origin handshake failed');
            reader.releaseLock();
            return;
          }
          handshakeDone = true;
          const rest = merged.slice(headerEnd + 4);
          if (rest.length) deliverFrames(ws, concat(new Uint8Array(0), rest));
        } else {
          deliverFrames(ws, concat(new Uint8Array(0), value));
        }
      }
    } catch {
      try { ws.close(1011, 'bridge read error'); } catch { /* closed */ }
    }
  })();
}

/** 把原始字节流按 RFC6455 帧切成消息送到 ws(支持 masked/unmasked,text/binary) */
function deliverFrames(ws: WebSocket, chunk: Uint8Array): void {
  // 简化实现:大多数场景一 chunk ≥ 一帧;跨 chunk 帧在此桥形态下罕见,
  // 完整状态机成本高 — 遇到不完整帧丢弃并关连接(fail loud)
  let i = 0;
  while (i < chunk.length) {
    const b0 = chunk[i]!;
    const b1 = chunk[i + 1];
    if (b1 === undefined) { try { ws.close(1002, 'short frame'); } catch {} return; }
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = i + 2;
    if (len === 126) {
      len = (chunk[off]! << 8) | chunk[off + 1]!;
      off += 2;
    } else if (len === 127) {
      // 64-bit 长度低 32 位(桥场景够用)
      const hi = (chunk[off]! << 24) | (chunk[off + 1]! << 16) | (chunk[off + 2]! << 8) | chunk[off + 3]!;
      len = ((chunk[off + 4]! << 24) | (chunk[off + 5]! << 16) | (chunk[off + 6]! << 8) | chunk[off + 7]!) >>> 0;
      off += 8;
      if (hi !== 0) { try { ws.close(1009, 'frame too large'); } catch {} return; }
    }
    let mask: Uint8Array | null = null;
    if (masked) {
      mask = chunk.slice(off, off + 4);
      off += 4;
    }
    const payload = chunk.slice(off, off + len);
    if (payload.length < len) { try { ws.close(1002, 'partial frame'); } catch {} return; }
    if (mask) {
      for (let j = 0; j < payload.length; j++) payload[j] = payload[j]! ^ mask[j & 3]!;
    }
    if (opcode === 0x1) {
      ws.send(new TextDecoder().decode(payload));
    } else if (opcode === 0x2) {
      ws.send(payload);
    } else if (opcode === 0x8) {
      ws.close(1000, '');
      return;
    } else if (opcode === 0x9) {
      // ping → 原样回 pong(由我们主动发)
      sendFrame(ws, payload, 0xa);
    }
    i = off + len;
  }
}

function sendFrame(ws: WebSocket, payload: Uint8Array, opcode: number): void {
  if (opcode === 0x1) ws.send(new TextDecoder().decode(payload));
  else ws.send(payload);
}

/** 浏览器消息 → RFC6455 服务端帧(不 mask;服务端→客户端方向规范允许不掩码) */
function encodeWsFrame(payload: Uint8Array, opcode: number): Uint8Array {
  const len = payload.length;
  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = new Uint8Array([0x80 | opcode, 126, len >> 8, len & 0xff]);
  } else {
    header = new Uint8Array([
      0x80 | opcode, 127, 0, 0, 0, 0,
      (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ]);
  }
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

function concat(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
