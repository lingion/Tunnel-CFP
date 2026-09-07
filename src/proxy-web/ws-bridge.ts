// src/proxy-web/ws-bridge.ts
// /proxy-ws/<scheme>/<host>/<path...> — WebSocket 桥
// 浏览器 shim 把 ws(s)://host/path 改写成 /proxy-ws/<scheme>/<host>/<path>,
// 这里用 cloudflare:sockets 对目标站建立 TCP(TLS 视 scheme),
// 完成 WS 握手后双向泵帧。
//
// RFC 6455 角色说明(审计修正):我们对目标站是 **客户端** —
// 客户端发出的所有帧 MUST 掩码(RFC 6455 §5.1,严格服务端收到未掩码帧直接断连);
// 对浏览器我们是 **服务端** — 服务端帧不掩码。两侧角色不同,封帧函数分两套。
//
// 分片重组:TCP 字节流不保证一 chunk 一帧,RFC 分片消息(opcode 0x0 continuation)
// 也合法 — 每连接维护跨 chunk 缓冲状态机,FIN=1 才派发(fail-loud 只留给协议违规)。

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
  // CRLF 过滤:Sec-WebSocket-Key/Protocol 是客户端可控头,字面 \r\n 可注入
  // 额外握手头(伪 Host/Origin/Cookie)— strip 后再拼串(审计实锤)
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const key = clean(
    request.headers.get('Sec-WebSocket-Key') ??
      btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
  );
  const proto = request.headers.get('Sec-WebSocket-Protocol');
  const handshake =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    (proto ? `Sec-WebSocket-Protocol: ${clean(proto)}\r\n` : '') +
    `Origin: ${scheme === 'wss' ? 'https' : 'http'}://${host}\r\n` +
    `\r\n`;

  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(handshake));
  writer.releaseLock();

  // RFC 6455: accept = base64(sha1(key + 258EAFA5-E914-47DA-95CA-C5AB0DC85B11))
  const magic = key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(magic));
  const acceptHash = btoa(String.fromCharCode(...new Uint8Array(digest)));

  // WS → TCP:浏览器消息重新封成 **掩码客户端帧**(RFC 6455 §5.1 客户端义务)。
  // writer 串行化:getWriter 有互斥锁,并发 message 事件第二条 getWriter 抛
  // "Writer is locked" 且帧丢失(审计实锤)— 全部排进同一条链。
  let writeChain: Promise<void> = Promise.resolve();
  const sendToOrigin = (frame: Uint8Array): void => {
    writeChain = writeChain.then(async () => {
      const w = socket.writable.getWriter();
      try {
        await w.write(frame);
      } finally {
        w.releaseLock();
      }
    });
    writeChain.catch(() => { /* 泵侧关闭后写入失败,静默 */ });
  };

  // TCP → WS:读 origin 响应流,校验 accept 后按 WS 帧透传给浏览器。
  // 状态机全部收进本连接的闭包(多连接并发安全,无共享单槽)
  void pumpSocketToWs(socket, server, acceptHash, sendToOrigin);

  server.addEventListener('close', () => {
    try { socket.close(); } catch { /* already closed */ }
  });
  server.addEventListener('error', () => {
    try { socket.close(); } catch { /* already closed */ }
  });

  return new Response(null, { status: 101, webSocket: client });
}

/** TCP 流 → WS 帧:等握手响应并校验 Sec-WebSocket-Accept,之后按 WS 帧解析成消息 */
async function pumpSocketToWs(
  socket: any,
  ws: WebSocket,
  acceptHash: string,
  sendToOrigin: (frame: Uint8Array) => void,
): Promise<void> {
  (async () => {
    const reader = socket.readable.getReader();
    let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let handshakeDone = false;
    const decoder = new TextDecoder();
    // 握手头缓冲上限:服务端不发 \r\n\r\n 时防无界增长(审计实锤 DoS 面)
    const HANDSHAKE_CAP = 64 * 1024;

    // -- 帧重组状态(每连接私有) --
    let frameBuf: Uint8Array = new Uint8Array(0);
    let fragOp = 0; // 进行中的分片消息 opcode(0=无)
    let fragParts: Uint8Array[] = [];
    let dead = false;

    const fail = (code: number, reason: string) => {
      dead = true;
      try { ws.close(code, reason); } catch { /* closed */ }
      try { socket.close(); } catch { /* closed */ }
    };

    const dispatch = (opcode: number, payload: Uint8Array, fin: boolean): boolean => {
      if (opcode >= 0x8) {
        // 控制帧:RFC 分片规则只约束数据帧;控制帧可插在分片之间
        if (opcode === 0x8) { fail(1000, ''); return false; }
        if (opcode === 0x9) {
          // ping → pong 必须回**源站 TCP 连接**(审计实锤:回浏览器方向
          // 源站收不到 pong,NAT/空闲心跳超时断连)。掩码客户端帧回写。
          sendToOrigin(encodeClientFrame(payload, 0xa));
        }
        return true; // 0xA pong 或其他未知控制帧:忽略
      }
      if (opcode === 0x0) {
        if (!fragOp) { fail(1002, 'unexpected continuation'); return false; }
        fragParts.push(payload);
        if (fin) {
          const whole = concatAll(fragParts);
          const op = fragOp;
          fragOp = 0;
          fragParts = [];
          sendToBrowser(ws, op, whole);
        }
        return true;
      }
      if (fragOp) { fail(1002, 'new data frame during fragmentation'); return false; }
      if (fin) {
        sendToBrowser(ws, opcode, payload);
      } else {
        fragOp = opcode;
        fragParts = [payload];
      }
      return true;
    };

    /** 返回 true = 全部消费完;false = 剩余挂在 frameBuf 等下一 chunk */
    const consume = (): boolean => {
      for (;;) {
        if (frameBuf.length < 2) return true;
        const b0 = frameBuf[0]!;
        const b1 = frameBuf[1]!;
        const opcode = b0 & 0x0f;
        const fin = (b0 & 0x80) !== 0;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (frameBuf.length < 4) return true;
          len = (frameBuf[2]! << 8) | frameBuf[3]!;
          off = 4;
        } else if (len === 127) {
          if (frameBuf.length < 10) return true;
          const hi = (frameBuf[2]! << 24) | (frameBuf[3]! << 16) | (frameBuf[4]! << 8) | frameBuf[5]!;
          len = ((frameBuf[6]! << 24) | (frameBuf[7]! << 16) | (frameBuf[8]! << 8) | frameBuf[9]!) >>> 0;
          off = 10;
          if (hi !== 0 || len > 16 * 1024 * 1024) { fail(1009, 'frame too large'); return false; }
        }
        let mask: Uint8Array | null = null;
        if (masked) {
          if (frameBuf.length < off + 4) return true;
          mask = frameBuf.slice(off, off + 4);
          off += 4;
        }
        if (frameBuf.length < off + len) return true;
        const payload = frameBuf.slice(off, off + len);
        if (mask) {
          for (let j = 0; j < payload.length; j++) payload[j] = payload[j]! ^ mask[j & 3]!;
        }
        if (!dispatch(opcode, payload, fin)) return false;
        frameBuf = frameBuf.slice(off + len);
      }
    };

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
            if (merged.length > HANDSHAKE_CAP) { fail(1002, 'handshake too large'); return; }
            buf = merged;
            continue;
          }
          const head = decoder.decode(merged.slice(0, headerEnd));
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            fail(1002, 'origin handshake failed');
            reader.releaseLock();
            return;
          }
          // RFC 6455 §4.2.2:必须校验 Sec-WebSocket-Accept,防握手降级/误接非 WS 服务
          const mAccept = head.match(/sec-websocket-accept:\s*(.+)/i);
          if (!mAccept || mAccept[1]!.trim() !== acceptHash) {
            fail(1002, 'bad sec-websocket-accept');
            reader.releaseLock();
            return;
          }
          // 已知限制:Workers WebSocket 侧无法自定义 101 响应头,服务端选定
          // 的 Sec-WebSocket-Protocol 无法回显给浏览器(请求过子协议的客户端
          // 会按规范 fail 连接)。桥对子协议场景不支持,数据帧路径不受影响。
          handshakeDone = true;
          const rest = merged.slice(headerEnd + 4);
          if (rest.length) {
            frameBuf = concat(frameBuf, rest);
            if (!consume() || dead) return;
          }
        } else {
          frameBuf = concat(frameBuf, value);
          if (!consume() || dead) return;
        }
      }
      // 服务端正常关流:完成与浏览器的 close 握手(compat date 2025-09-01 下
      // 不主动 close 的浏览器侧看到 1006;审计实锤)
      try { ws.close(1000, ''); } catch { /* closed */ }
    } catch (e) {
      // 异常消息进 close reason(≤120 字节):桥对源站故障的可观测通道,
      // 免 wrangler tail 依赖(镜像网络下 tail 不可用)
      const msg = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 120) : 'bridge read error';
      try { ws.close(1011, msg || 'bridge read error'); } catch { /* closed */ }
    }
  })();
}

function sendToBrowser(ws: WebSocket, opcode: number, payload: Uint8Array): void {
  if (opcode === 0x1) ws.send(new TextDecoder().decode(payload));
  else ws.send(payload);
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 浏览器消息 → RFC6455 **客户端**帧(必须掩码,RFC 6455 §5.1;审计实锤) */
export function encodeClientFrame(payload: Uint8Array, opcode: number): Uint8Array {
  const len = payload.length;
  let header: Uint8Array;
  if (len < 126) {
    header = new Uint8Array([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = new Uint8Array([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
  } else {
    header = new Uint8Array([
      0x80 | opcode, 0x80 | 127, 0, 0, 0, 0,
      (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ]);
  }
  const mask = crypto.getRandomValues(new Uint8Array(4));
  const out = new Uint8Array(header.length + 4 + len);
  out.set(header);
  out.set(mask, header.length);
  for (let j = 0; j < payload.length; j++) {
    payload[j] = payload[j]! ^ mask[j & 3]!;
  }
  out.set(payload, header.length + 4);
  return out;
}

function concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
