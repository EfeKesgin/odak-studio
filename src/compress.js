'use strict';

// "Odak ile küçült" penceresi: ana süreçteki kuyruğu gösterir. İş ana
// süreçte yürür; bu sayfa yalnızca durumu çizer, iptal ve "Klasörde göster"
// isteklerini iletir.
(function () {
  const api = window.odak;
  const i18n = window.OdakI18n;
  const list = document.getElementById('compressList');
  const title = document.getElementById('compressTitle');

  const PRESET_LABELS = {
    quality: 'Kaliteyi koru',
    discord: 'Discord · 10 MB',
    whatsapp: 'WhatsApp · 16 MB',
    email: 'E-posta · 25 MB',
  };

  function formatSize(bytes) {
    const value = Number(bytes) || 0;
    const locale = i18n.getLanguage() === 'en' ? 'en-US' : 'tr-TR';
    if (value >= 1e6) return `${(value / 1e6).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
    return `${Math.max(1, Math.round(value / 1e3)).toLocaleString(locale)} KB`;
  }

  function iconSvg(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function statusText(item) {
    if (item.status === 'waiting') return 'Sırada';
    if (item.status === 'running') return `%${Math.round(item.percent || 0)}`;
    if (item.status === 'canceled') return 'İptal edildi';
    if (item.status === 'error') return item.error || 'Küçültme tamamlanamadı.';
    if (item.alreadyEfficient) return 'Zaten verimli sıkıştırılmış; daha küçük olmuyor, yeni dosya oluşturulmadı.';
    if (item.keptSource) return `${formatSize(item.size)} · zaten küçüktü, olduğu gibi kopyalandı`;
    return `${formatSize(item.sourceSize)} → ${formatSize(item.size)}`;
  }

  function render(items) {
    list.textContent = '';
    for (const item of items) {
      const row = document.createElement('li');
      row.className = `compress-item ${item.status}`;

      const top = document.createElement('div');
      top.className = 'compress-item-top';
      const name = document.createElement('b');
      name.className = 'compress-name';
      name.dataset.i18nSkip = '';
      name.textContent = item.name;
      name.title = item.file;
      const preset = document.createElement('small');
      preset.textContent = PRESET_LABELS[item.preset] || item.preset;
      top.append(name, preset);

      const bar = document.createElement('div');
      bar.className = 'progress-track';
      const fill = document.createElement('div');
      fill.className = 'progress-bar';
      fill.style.width = `${item.status === 'done' ? 100 : Math.round(item.percent || 0)}%`;
      bar.appendChild(fill);

      const bottom = document.createElement('div');
      bottom.className = 'compress-item-bottom';
      const status = document.createElement('span');
      status.className = 'compress-status';
      if (item.status === 'done') status.appendChild(iconSvg('check'));
      if (item.status === 'error') status.appendChild(iconSvg('alert'));
      status.appendChild(document.createTextNode(statusText(item)));
      bottom.appendChild(status);

      if (item.status === 'done' && item.output) {
        const show = document.createElement('button');
        show.className = 'btn small ghost';
        show.append(iconSvg('folder'), document.createTextNode('Klasörde göster'));
        show.addEventListener('click', () => api.showItem(item.output));
        bottom.appendChild(show);
      } else if (item.status === 'waiting' || item.status === 'running') {
        const cancel = document.createElement('button');
        cancel.className = 'btn small ghost';
        cancel.textContent = 'İptal';
        cancel.addEventListener('click', () => api.compressCancel(item.id));
        bottom.appendChild(cancel);
      }

      row.append(top, bar, bottom);
      list.appendChild(row);
    }
    const busy = items.some((item) => item.status === 'waiting' || item.status === 'running');
    const failed = items.some((item) => item.status === 'error');
    title.textContent = busy
      ? (items.length > 1 ? 'Videolar küçültülüyor' : 'Video küçültülüyor')
      : failed ? 'Bazı dosyalar küçültülemedi' : 'Hazır';
    document.title = i18n.t(title.textContent);
  }

  async function start() {
    try {
      const [config, info] = await Promise.all([api.getConfig(), api.systemInfo().catch(() => null)]);
      const saved = config?.preferences?.ui?.language;
      i18n.setLanguage(saved || i18n.languageForLocale(info?.locale || navigator.language));
    } catch {
      i18n.setLanguage('tr');
    }
    i18n.observeDocument(document);
    document.getElementById('compressCloseBtn').addEventListener('click', () => window.close());
    api.onCompressUpdate(render);
    render(await api.compressState());
  }

  start();
})();
