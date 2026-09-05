// src/proxy-web/inject-shim.ts
// 注入到代理页面的运行时 shim:
// 把 JS 动态发出的请求(fetch / XHR / WebSocket / EventSource / Worker / history / window.open)
// 重定向到 /proxy/ 路径。只钩"按相对/绝对 URL 发请求"的入口,不碰响应。
//
// 设计约束:
// - 不用 eval/Function 构造器包一层函数体(有 CSP 的站会挂;我们剥了 CSP 但用户可能关)
// - 相对 URL 无法在 shim 层解析(拿不到目标 origin)→ 由 handler 通过
//   window.__PROXY_BASE__ 告诉 shim 目标站 origin
// - data:/blob:/javascript:/about: 等一律放行

function shimSource(): string {
  return `
(function() {
  if (window.__PROXY_SHIM__) return;
  window.__PROXY_SHIM__ = true;
  var BASE = window.__PROXY_BASE__ || '';  // 目标站 origin,由服务端注入
  var SKIP_RE = /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i;
  function toProxy(url) {
    if (url == null) return url;
    try {
      if (typeof Request !== 'undefined' && url instanceof Request) {
        var ru = new URL(url.url, BASE || location.href);
        return new Request('/proxy/' + ru.href, url);
      }
      var s = String(url);
      if (SKIP_RE.test(s)) return url;
      if (s.indexOf('/proxy/') === 0 || s.indexOf('/proxy-ws/') === 0) return url;
      var abs = new URL(s, BASE || location.href);
      if (abs.href.indexOf(location.origin + '/proxy/') === 0) return url;
      return '/proxy/' + abs.href;
    } catch (e) { return url; }
  }
  // fetch
  var _fetch = window.fetch && window.fetch.bind(window);
  if (_fetch) {
    window.fetch = function(input, init) {
      if (typeof input === 'string' || input instanceof URL) return _fetch(toProxy(String(input)), init);
      if (typeof Request !== 'undefined' && input instanceof Request) return _fetch(toProxy(input), init);
      return _fetch(input, init);
    };
  }
  // XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = toProxy(url);
    return _open.apply(this, args);
  };
  // WebSocket → /proxy-ws/ 桥(未实现时保持原样降级)
  var _WS = window.WebSocket;
  if (_WS) {
    function ProxiedWebSocket(url, protocols) {
      var s = String(url);
      var m = s.match(/^(wss?):\\/\\/([^/]+)(.*)$/i);
      var target = m ? '/proxy-ws/' + m[1] + '/' + m[2] + (m[3] || '') : toProxy(s);
      try {
        return new _WS(target, protocols);
      } catch (e) {
        return new _WS(s, protocols);
      }
    }
    ProxiedWebSocket.prototype = _WS.prototype;
    ProxiedWebSocket.CONNECTING = _WS.CONNECTING;
    ProxiedWebSocket.OPEN = _WS.OPEN;
    ProxiedWebSocket.CLOSING = _WS.CLOSING;
    ProxiedWebSocket.CLOSED = _WS.CLOSED;
    try { window.WebSocket = ProxiedWebSocket; } catch (e) {}
  }
  // EventSource
  var _ES = window.EventSource;
  if (_ES) {
    function ProxiedEventSource(url, cfg) { return new _ES(toProxy(url), cfg); }
    ProxiedEventSource.prototype = _ES.prototype;
    try { window.EventSource = ProxiedEventSource; } catch (e) {}
  }
  // Worker / SharedWorker — 同源加载走 /proxy/
  var _Worker = window.Worker;
  if (_Worker) {
    function ProxiedWorker(url, opts) { return new _Worker(toProxy(url), opts); }
    ProxiedWorker.prototype = _Worker.prototype;
    try { window.Worker = ProxiedWorker; } catch (e) {}
  }
  // history.pushState/replaceState — 站内导航路径保持浏览器可回退
  var _push = history.pushState && history.pushState.bind(history);
  var _replace = history.replaceState && history.replaceState.bind(history);
  function rewriteStateUrl(u) { return u == null || u === '' ? u : toProxy(String(u)); }
  if (_push) history.pushState = function(state, title, url) { return _push(state, title, rewriteStateUrl(url)); };
  if (_replace) history.replaceState = function(state, title, url) { return _replace(state, title, rewriteStateUrl(url)); };
  // window.open
  var _open2 = window.open;
  if (_open2) {
    window.open = function(url, name, specs) {
      if (url == null) return _open2.call(window, undefined, name, specs);
      return _open2.call(window, toProxy(url), name, specs);
    };
  }
  // 导航兜底:点击/表单之外的 JS 赋值 location.href(不能直接劫持赋值,退而求其次监听 beforeunload 前不做处理 — 留白)
})();
`;
}

// 直接内联源码(rewriter 以 { html: true } prepend,已是脚本标签包装)
export const SHIM_SCRIPT = `<script>${shimSource()}</script>`;
