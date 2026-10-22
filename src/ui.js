'use strict';

(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size >= 100 ? size.toFixed(0) : size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`;
  }

  function formatTimecode(seconds, forceHours = false) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    const centis = Math.floor((value % 1) * 100);
    const base = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
    if (hours > 0 || forceHours) return `${hours}:${base}`;
    return base;
  }

  function formatClock(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value >= 3600) {
      const h = Math.floor(value / 3600);
      const m = Math.floor((value % 3600) / 60);
      return `${h} sa ${m} dk`;
    }
    if (value >= 60) {
      const m = Math.floor(value / 60);
      const s = Math.round(value % 60);
      return `${m} dk ${s} sn`;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} sn`;
  }

  function formatBitrate(bitsPerSecond) {
    const bps = Number(bitsPerSecond) || 0;
    if (!bps) return '—';
    if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    return `${Math.round(bps / 1000)} kbps`;
  }

  function formatResolution(width, height) {
    if (!width || !height) return '—';
    return `${Math.round(width)} × ${Math.round(height)}`;
  }

  function even(value, min = 2) {
    const rounded = Math.max(min, Math.round(Number(value) || 0));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  const { sanitizeBaseName } = window.OdakShared;

  function fileBaseName(filePath) {
    const parts = String(filePath || '').split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  function fileStem(nameOrPath) {
    const base = fileBaseName(nameOrPath);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  function fileNameExtension(filePath) {
    const base = fileBaseName(filePath);
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot).toLowerCase() : '';
  }

  function shortenPath(target, max = 46) {
    const text = String(target || '');
    if (text.length <= max) return text;
    const parts = text.split(/([\\/])/);
    if (parts.length <= 3) return `…${text.slice(-max + 1)}`;
    return `${parts[0]}…${text.slice(-(max - 4))}`;
  }

  function debounce(fn, wait = 150) {
    let timer = null;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  function setIcon(svg, name) {
    if (!svg) return;
    const use = svg.querySelector('use');
    if (use) use.setAttribute('href', `#i-${name}`);
  }

  function toast(message, options = {}) {
    const stack = document.getElementById('toastStack');
    if (!stack) return () => {};
    const type = ['error', 'warn', 'success'].includes(options.type) ? options.type : 'info';
    const element = document.createElement('div');
    element.className = `toast ${type}`;

    const dot = document.createElement('span');
    dot.className = 'toast-dot';
    element.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'toast-body';
    body.textContent = String(message ?? '');
    element.appendChild(body);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      element.classList.add('out');
      setTimeout(() => element.remove(), 180);
    };

    if (options.action && typeof options.action.onClick === 'function') {
      const action = document.createElement('button');
      action.className = 'toast-action';
      action.type = 'button';
      action.textContent = options.action.label || 'Aç';
      action.addEventListener('click', () => {
        try { options.action.onClick(); } finally { close(); }
      });
      element.appendChild(action);
    }

    const closeButton = document.createElement('button');
    closeButton.className = 'toast-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Kapat');
    closeButton.innerHTML = '<svg class="icon"><use href="#i-close"></use></svg>';
    closeButton.addEventListener('click', close);
    element.appendChild(closeButton);

    stack.appendChild(element);
    while (stack.children.length > 4) stack.firstElementChild.remove();

    const timeout = options.timeout ?? (type === 'error' ? 6500 : 4200);
    if (timeout > 0) setTimeout(close, timeout);
    return close;
  }

  function clearToasts() {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    while (stack.firstElementChild) stack.firstElementChild.remove();
  }

  function parseNumber(value, fallback = 0) {
    const normalized = String(value ?? '').replace(',', '.').trim();
    const number = Number(normalized);
    return Number.isFinite(number) ? number : fallback;
  }

  function toggleClass(element, className, force) {
    if (!element) return;
    if (typeof force === 'boolean') element.classList.toggle(className, force);
    else element.classList.toggle(className);
  }

  window.OdakUI = {
    $,
    $$,
    formatBytes,
    formatTimecode,
    formatClock,
    formatDuration,
    formatBitrate,
    formatResolution,
    even,
    clamp,
    sanitizeBaseName,
    fileBaseName,
    fileStem,
    fileNameExtension,
    shortenPath,
    debounce,
    setIcon,
    toast,
    clearToasts,
    parseNumber,
    toggleClass,
  };
})();
