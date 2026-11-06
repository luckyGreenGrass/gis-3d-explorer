/* console-capture.js —— 把控制台错误/警告直接显示在页面上
 * 必须在其他脚本之前加载，才能捕获页面初始化期间的错误。
 */
(function () {
  'use strict';

  const MAX = 60;
  const entries = []; // { level, text, count, time }
  window.__APP_LOGS__ = entries;

  function hostOf(url) {
    try { return new URL(url, location.href).host; }
    catch (_) { return String(url).slice(0, 60); }
  }

  function fmt(a) {
    if (a instanceof Error) return a.message;
    if (a && typeof a === 'object') {
      try { return JSON.stringify(a).slice(0, 300); }
      catch (_) { return String(a); }
    }
    return String(a);
  }

  function add(level, text) {
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
    const hit = entries.find((e) => e.level === level && e.text === clean);
    if (hit) hit.count += 1;
    else {
      entries.push({
        level,
        text: clean,
        count: 1,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      });
    }
    if (entries.length > MAX) entries.shift();
    render();
  }

  // 1) console.error / console.warn
  ['error', 'warn'].forEach((level) => {
    const orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      try {
        add(level, Array.prototype.map.call(arguments, fmt).join(' '));
      } catch (_) { /* 忽略捕获器自身异常 */ }
      return orig.apply(console, arguments);
    };
  });

  // 2) 未捕获异常 / Promise 异常 / 资源加载失败（图片、脚本、样式）
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      add('error', '资源加载失败 · ' + hostOf(t.src || t.href));
    } else if (e.message) {
      add('error', e.message + (e.filename ? ' @ ' + hostOf(e.filename) + ':' + e.lineno : ''));
    }
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    add('error', '未处理的 Promise 异常：' + fmt(r && r.message ? r.message : r));
  });

  // 3) 动态创建的 <img>（Cesium 影像瓦片可能走这条路），错误事件不会冒泡到 window
  const OrigImage = window.Image;
  if (typeof OrigImage === 'function') {
    window.Image = function () {
      const img = new OrigImage(...arguments);
      img.addEventListener('error', () => {
        add('error', '图片/影像瓦片加载失败 · ' + hostOf(img.src));
      });
      return img;
    };
    window.Image.prototype = OrigImage.prototype;
  }

  // 4) fetch 失败 / 非 2xx（按域名+状态码合并，避免瓦片刷屏）
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      const args = arguments;
      const url = typeof args[0] === 'string'
        ? args[0]
        : (args[0] && args[0].url) || '';
      return origFetch.apply(this, args).then(
        (resp) => {
          if (resp && !resp.ok) {
            add('error', 'HTTP ' + resp.status + ' · ' + hostOf(url));
          }
          return resp;
        },
        (err) => {
          add('error', '请求失败 · ' + hostOf(url) + ' · ' + fmt(err && err.message ? err.message : err));
          throw err;
        }
      );
    };
  }

  function render() {
    const panel = document.getElementById('logBody');
    const btn = document.getElementById('logBtn');
    if (!panel || !btn) return;

    const errors = entries
      .filter((e) => e.level === 'error')
      .reduce((n, e) => n + e.count, 0);
    const warns = entries
      .filter((e) => e.level === 'warn')
      .reduce((n, e) => n + e.count, 0);
    btn.textContent = '日志 ' + errors + '/' + warns;

    panel.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'log-line';
      empty.textContent = '暂无错误或警告';
      panel.appendChild(empty);
      return;
    }
    entries.slice().reverse().forEach((e) => {
      const line = document.createElement('div');
      line.className = 'log-line ' + e.level;
      line.textContent =
        (e.level === 'error' ? '❌ ' : '⚠️ ') +
        '[' + e.time + '] ' + e.text +
        (e.count > 1 ? '（×' + e.count + '）' : '');
      panel.appendChild(line);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('logBtn');
    const panel = document.getElementById('logPanel');
    const close = document.getElementById('logClose');
    const clear = document.getElementById('logClear');
    if (btn && panel) {
      btn.addEventListener('click', () => {
        panel.classList.toggle('hidden');
        render();
      });
    }
    if (close && panel) {
      close.addEventListener('click', () => panel.classList.add('hidden'));
    }
    if (clear) {
      clear.addEventListener('click', () => {
        entries.length = 0;
        render();
      });
    }
    render();
  });
})();
