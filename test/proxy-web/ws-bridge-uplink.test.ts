// 上行接线回归锁(2026-10-31)
// 背景: round6 重构(7e4ce5c)引入 sendToOrigin 串行写链时删掉了
// server.addEventListener('message', …), 全文件 sendToOrigin 唯一调用点
// 剩 ping→pong —— 浏览器→源站每帧静默丢弃, 且无测试覆盖, 带伤上线近两个月
// (workflow 红队 + 对抗验证双确认)。本文件锁两层:
// ① wireBrowserToOrigin 行为: message 事件 → 正确 opcode 的掩码客户端帧进链
// ② 源码级: handleWsBridge 函数体内必须存在对 wireBrowserToOrigin 的调用
//    (防止再次"重构删线")
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wireBrowserToOrigin, encodeClientFrame } from '../../src/proxy-web/ws-bridge';

function fakeServer() {
  const handlers: Record<string, Array<(ev: any) => void>> = {};
  return {
    addEventListener: (t: string, fn: (ev: any) => void) => {
      (handlers[t] ||= []).push(fn);
    },
    emit: (t: string, ev: any) => { handlers[t]?.forEach((h) => h(ev)); },
    has: (t: string) => (handlers[t] || []).length > 0,
  };
}

describe('wireBrowserToOrigin 上行接线', () => {
  it('注册了 message 监听器(上行链路的唯一入口)', () => {
    const srv = fakeServer();
    wireBrowserToOrigin(srv as any, () => {});
    expect(srv.has('message')).toBe(true);
  });

  it('文本消息封 opcode 0x1 掩码客户端帧进写链', () => {
    const srv = fakeServer();
    const sent: Uint8Array[] = [];
    wireBrowserToOrigin(srv as any, (f) => sent.push(f));
    srv.emit('message', { data: 'hello' });
    expect(sent.length).toBe(1);
    const frame = sent[0]!;
    expect(frame[0]).toBe(0x81); // FIN + text
    expect(frame[1]! & 0x80).toBe(0x80); // 掩码位(RFC 6455 客户端义务)
    expect(frame[1]! & 0x7f).toBe(5);
    const expectFrame = encodeClientFrame(new TextEncoder().encode('hello'), 0x1);
    // 掩码随机,只断结构头两字节与长度(payload 不可逐字节比对)
    expect(Array.from(frame.slice(0, 2))).toEqual(Array.from(expectFrame.slice(0, 2)));
  });

  it('二进制消息封 opcode 0x2', () => {
    const srv = fakeServer();
    const sent: Uint8Array[] = [];
    wireBrowserToOrigin(srv as any, (f) => sent.push(f));
    srv.emit('message', { data: new Uint8Array([1, 2, 3]).buffer });
    expect(sent[0]![0]).toBe(0x82);
    expect(sent[0]![1]! & 0x7f).toBe(3);
  });

  it('文本 roundtrip: 解掩码还原原文(帧对严格服务端可用)', () => {
    const srv = fakeServer();
    const sent: Uint8Array[] = [];
    wireBrowserToOrigin(srv as any, (f) => sent.push(f));
    srv.emit('message', { data: 'ping-payload' });
    const f = sent[0]!;
    const mask = f.slice(2, 6);
    const payload = f.slice(6);
    const out = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ mask[i & 3]!;
    expect(new TextDecoder().decode(out)).toBe('ping-payload');
  });
});

describe('handleWsBridge 接线完整性(防再次重构删线)', () => {
  it('源码函数体内存在 wireBrowserToOrigin 调用', () => {
    const src = readFileSync(join(__dirname, '../../src/proxy-web/ws-bridge.ts'), 'utf8');
    const fnBody = src.slice(src.indexOf('export async function handleWsBridge'));
    const upToPump = fnBody.slice(0, fnBody.indexOf('void pumpSocketToWs') >= 0 ? fnBody.indexOf('void pumpSocketToWs') + 60 : fnBody.length);
    expect(upToPump).toMatch(/wireBrowserToOrigin\s*\(/);
  });
});
