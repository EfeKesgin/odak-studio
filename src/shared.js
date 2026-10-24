'use strict';

// Ana süreç ve arayüzün birlikte kullandığı sabitler ve saf yardımcılar.
// Aynı listenin iki yerde ayrı ayrı tutulup zamanla birbirinden ayrışmaması
// için tek kaynak burasıdır. DOM'a dokunmaz; Node'da require ile, tarayıcıda
// window.OdakShared olarak yüklenir.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OdakShared = api;
}(typeof window !== 'undefined' ? window : null, function () {
  const VIDEO_EXTENSIONS = [
    'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv',
    'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'ogv', 'vob',
  ];

  const IMAGE_EXTENSIONS = [
    'jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif',
    // Sharp'ın Windows paketi bu formatları çözemiyor (BMP/JXL hiç desteklenmiyor,
    // HEIC/HEIF ise HEVC kod çözücü olmadığı için açılamıyor). Yine de listede
    // tutuluyorlar ki sürükle-bırakta video sanılmasınlar ve anlaşılır bir hata
    // gösterilsin. Dosya seçici bunları önermez.
    'bmp', 'jxl', 'heic', 'heif',
  ];

  const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'];

  const MEDIA_EXTENSION = new RegExp(
    `\\.(${[...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS].join('|')})$`,
    'i',
  );

  function sanitizeBaseName(value, fallback = 'odak-cikti') {
    let name = String(value ?? '')
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Kullanıcı ad alanına "klip.mp4" yazarsa çıktı "klip.mp4.mp4" olmasın.
    name = name.replace(MEDIA_EXTENSION, '');
    name = name
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120)
      .trim();
    // Windows'ta ayrılmış aygıt adları dosya olarak yazılamaz.
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
      name = `${name}-odak`;
    }
    if (!name) name = fallback;
    return name;
  }

  const GIF_MAX_ITEMS = 80;
  const GIF_MAX_DURATION = 60;
  const GIF_MAX_FRAMES = 900;
  const GIF_FPS_VALUES = [8, 10, 12, 15, 20, 24];
  const GIF_RATIOS = {
    '1': 1,
    '1:1': 1,
    '4:3': 4 / 3,
    '16:9': 16 / 9,
    '9:16': 9 / 16,
    '4:5': 4 / 5,
  };

  function gifRatioValue(value) {
    return GIF_RATIOS[String(value ?? '').trim()] || 0;
  }

  // Hedef dosya boyutu modu. 1 MB = 1 000 000 bayt alınır: "25 MB" sınırı
  // koyan servislerin çoğu ondalık MB kullanır, ikili MiB'den küçüktür.
  // VP9'un hız denetimi x264/x265 kadar isabetli olmadığı için payı geniştir.
  const SIZE_SAFETY = { h264: 0.96, h265: 0.96, vp9: 0.9 };
  const SIZE_MIN_VIDEO_KBPS = 50;
  const SIZE_MAX_MB = 100000;

  function sizeAudioKbps(totalKbps) {
    if (totalKbps >= 1500) return 160;
    if (totalKbps >= 600) return 128;
    if (totalKbps >= 300) return 96;
    return 64;
  }

  // Akıllı kesim: kesim noktasından ilk anahtar kareye kadarki kısa bölüm
  // kaynağa uygun ayarlarla yeniden kodlanır, gerisi olduğu gibi kopyalanır.
  // HEVC'nin MP4'teki "hvc1" etiketi parametre setlerinin akış içinde
  // değişmesine izin vermediği için yalnızca H.264 ve VP9 desteklenir.
  const SMART_CUT_CODECS = ['h264', 'vp9'];
  const SMART_CUT_PIX_FMTS = ['yuv420p', 'yuvj420p', 'yuv420p10le'];

  function smartCutSupported(meta) {
    if (!meta) return false;
    return SMART_CUT_CODECS.includes(String(meta.videoCodec || '').toLowerCase()) &&
      SMART_CUT_PIX_FMTS.includes(String(meta.pixFmt || '').toLowerCase());
  }

  // Kesim türü: hem arayüz hem ana süreç aynı kuralı kullanır.
  // Başlangıçtaki anahtar kare: başlangıca yarım kareden yakın olan ilk kare.
  function smartCutSplit(keyframes, start, end, frameDuration = 1 / 30) {
    const half = Math.max(0.001, frameDuration / 2);
    const key = (Array.isArray(keyframes) ? keyframes : [])
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b)
      .find((time) => time >= start - half);
    if (key === undefined || key >= end - half) return { head: [start, end], tail: null };
    if (key <= start + half) return { head: null, tail: [key, end] };
    return { head: [start, key], tail: [key, end] };
  }

  // Sessiz kısımları çıkarma. Ortam seçimi FFmpeg silencedetect eşiğidir:
  // gürültülü kayıtta eşik yükselir, sessiz odada düşer.
  const SILENCE_LEVELS = { quiet: -45, normal: -35, noisy: -25 };
  const SILENCE_MIN_SECONDS = 0.6;

  // Sessizliklerden kalan (konuşulan) aralıklar. Her sessizliğin iki
  // yanında "padding" kadar pay bırakılır ki kelimeler kesilmesin; çok kısa
  // kalan parçalar atılır. Sonuç [from, to] içindedir.
  function keepRangesFromSilences(silences, from, to, { padding = 0.15, minKeep = 0.25 } = {}) {
    const start = Math.max(0, Number(from) || 0);
    const end = Math.max(start, Number(to) || 0);
    const gaps = (Array.isArray(silences) ? silences : [])
      .map((item) => ({ start: Number(item.start), end: Number(item.end) }))
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end))
      .map((item) => ({ start: item.start + padding, end: item.end - padding }))
      .filter((item) => item.end - item.start > 0.05)
      .sort((a, b) => a.start - b.start);
    const keep = [];
    let cursor = start;
    for (const gap of gaps) {
      if (gap.end <= cursor || gap.start >= end) continue;
      if (gap.start > cursor) keep.push({ start: cursor, end: Math.min(gap.start, end) });
      cursor = Math.max(cursor, gap.end);
    }
    if (cursor < end) keep.push({ start: cursor, end });
    return keep
      .filter((range) => range.end - range.start >= minKeep)
      .map((range) => ({ start: Math.round(range.start * 1000) / 1000, end: Math.round(range.end * 1000) / 1000 }));
  }

  // Kesim kutularına yazılan zaman: "1:05.5", "01:02:03,25", "65" veya
  // "65,5". Saniyeye çevrilir; anlaşılmazsa NaN döner.
  function parseTimecode(value) {
    const text = String(value ?? '').trim().replace(/,/g, '.');
    if (!text) return NaN;
    const parts = text.split(':');
    if (parts.length > 3 || parts.some((part) => !/^\d*\.?\d*$/.test(part) || part === '' || part === '.')) return NaN;
    if (parts.slice(0, -1).some((part) => part.includes('.'))) return NaN;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  // Hedef bir üst sınırdır: sourceVideoKbps verilirse video bit hızı kaynağın
  // üzerine çıkmaz, kısa veya düşük bit hızlı videolar şişirilmez.
  function sizeModeBitrates({ targetMB, duration, codec = 'h264', audioTracks = 0, sourceVideoKbps = 0, sourceAudioKbps = 0 } = {}) {
    const targetBytes = Math.max(0, Number(targetMB) || 0) * 1e6;
    const seconds = Math.max(0.001, Number(duration) || 0);
    const safety = SIZE_SAFETY[codec] || 0.95;
    const tracks = Math.max(0, Math.round(Number(audioTracks) || 0));
    const totalKbps = (targetBytes * 8 * safety) / seconds / 1000;
    let audioKbps = tracks ? sizeAudioKbps(totalKbps) : 0;
    // Ses de kaynaktan yüksek kodlanmaz (64 kbps altına inilmez).
    const sourceAudio = Math.round(Number(sourceAudioKbps) || 0);
    if (audioKbps && sourceAudio > 0) audioKbps = Math.min(audioKbps, Math.max(64, Math.ceil(sourceAudio / 16) * 16));
    let videoKbps = Math.floor(totalKbps - audioKbps * tracks);
    const sourceCap = Math.round(Number(sourceVideoKbps) || 0);
    const capped = sourceCap >= SIZE_MIN_VIDEO_KBPS && videoKbps > sourceCap;
    if (capped) videoKbps = sourceCap;
    // En düşük ses kademesiyle hedefe sığmak için gereken boyut.
    const minAudio = tracks ? 64 * tracks : 0;
    const minMB = ((SIZE_MIN_VIDEO_KBPS + minAudio) * 1000 * seconds) / 8 / safety / 1e6;
    return {
      targetBytes,
      totalKbps,
      audioKbps,
      videoKbps: Math.max(0, videoKbps),
      capped,
      feasible: videoKbps >= SIZE_MIN_VIDEO_KBPS,
      minMB: Math.ceil(minMB * 10) / 10,
    };
  }

  // Hazır video ayarları. maxEdge uzun kenar için üst sınırdır, yalnızca
  // küçültür. Kullanıcının kaydettiği ayarlar da aynı alanlarla tutulur.
  const VIDEO_CODECS = ['h264', 'h265', 'vp9', 'prores'];
  const VIDEO_QUALITY_MODES = ['copy', 'crf', 'bitrate', 'size'];
  const VIDEO_ENCODER_PRESETS = ['fast', 'medium', 'slow'];
  const VIDEO_MAX_EDGES = [0, 3840, 2560, 1920, 1280, 854, 640];
  const VIDEO_PRESETS = [
    { id: 'lossless', name: 'Kayıpsız kopya', settings: { quality: 'copy' } },
    // Çözünürlük aynı kalır; şişkin (gereğinden yüksek bit hızlı) videolar
    // gözle ayırt edilemeyecek kalitede verimli sıkıştırılır (SSIM ~0,99).
    { id: 'quality', name: 'Kaliteyi koru · küçült', settings: { codec: 'h264', quality: 'crf', crf: 20, preset: 'medium' } },
    { id: 'youtube', name: 'YouTube · 1080p', settings: { codec: 'h264', quality: 'crf', crf: 18, preset: 'slow', maxEdge: 1920 } },
    { id: 'social', name: 'Instagram / TikTok · 1080p', settings: { codec: 'h264', quality: 'crf', crf: 20, preset: 'medium', maxEdge: 1920 } },
    { id: 'whatsapp', name: 'WhatsApp · 16 MB', settings: { codec: 'h264', quality: 'size', targetMB: 15.5, preset: 'medium', maxEdge: 1280 } },
    { id: 'discord', name: 'Discord · 10 MB', settings: { codec: 'h264', quality: 'size', targetMB: 9.5, preset: 'medium', maxEdge: 1280 } },
    { id: 'email', name: 'E-posta · 25 MB', settings: { codec: 'h264', quality: 'size', targetMB: 24, preset: 'medium' } },
    { id: 'small', name: 'Küçük dosya · H.265', settings: { codec: 'h265', quality: 'crf', crf: 26, preset: 'medium' } },
    { id: 'archive', name: 'Arşiv · ProRes 422 HQ', settings: { codec: 'prores', quality: 'crf' } },
  ];
  const MAX_USER_PRESETS = 30;

  // Kayıtlı veya hazır bir ayarın yalnızca bilinen, geçerli alanlarını bırakır.
  function cleanVideoPresetSettings(settings = {}) {
    const clean = {};
    if (VIDEO_CODECS.includes(settings.codec)) clean.codec = settings.codec;
    if (VIDEO_QUALITY_MODES.includes(settings.quality)) clean.quality = settings.quality;
    if (clean.codec === 'prores' && (clean.quality === 'bitrate' || clean.quality === 'size')) clean.quality = 'crf';
    const crf = Math.round(Number(settings.crf));
    if (crf >= 10 && crf <= 30) clean.crf = crf;
    if (VIDEO_ENCODER_PRESETS.includes(settings.preset)) clean.preset = settings.preset;
    const bitrate = Math.round(Number(settings.bitrateKbps));
    if (bitrate >= 100 && bitrate <= 200000) clean.bitrateKbps = bitrate;
    const target = Number(settings.targetMB);
    if (target > 0) clean.targetMB = Math.round(Math.min(target, SIZE_MAX_MB) * 10) / 10;
    if (VIDEO_MAX_EDGES.includes(Number(settings.maxEdge)) && Number(settings.maxEdge) > 0) {
      clean.maxEdge = Number(settings.maxEdge);
    }
    return clean;
  }

  function cleanUserPresets(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id || '');
      const name = String(entry.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!/^user-[\w-]{1,40}$/.test(id) || !name || seen.has(id)) continue;
      const settings = cleanVideoPresetSettings(entry.settings);
      if (!settings.quality) continue;
      seen.add(id);
      result.push({ id, name, settings });
      if (result.length >= MAX_USER_PRESETS) break;
    }
    return result;
  }

  // ── Metin katmanları ──────────────────────────────────────────────────
  // Bir katman son çıktının üzerine çizilir. Konum (x, y) metnin merkezidir
  // ve çıktıya göre 0–1 arasıdır; boyut çıktı yüksekliğinin yüzdesidir.
  // Aynı model arayüz önizlemesinde (CSS), fotoğrafta (SVG) ve video/GIF'te
  // (libass) kullanılır.
  const TEXT_FONTS = ['Arial', 'Segoe UI', 'Impact', 'Georgia', 'Verdana', 'Times New Roman', 'Consolas', 'Comic Sans MS'];
  const TEXT_STYLES = ['outline', 'shadow', 'box', 'plain'];
  const MAX_TEXT_LAYERS = 8;
  // libass yazı tipi boyutunu tarayıcıdaki "em" boyutundan farklı ölçer
  // (yükselen + alçalan yükseklik). Bu oranlar Windows yazı tipleriyle
  // FFmpeg 8.1 + libass ve Chromium/librsvg karşılaştırılarak ölçüldü.
  const ASS_FONT_SCALE = {
    'Segoe UI': 1.091,
    Arial: 1.121,
    Impact: 1.211,
    Georgia: 1.133,
    Verdana: 1.211,
    'Times New Roman': 1.108,
    Consolas: 1.171,
    'Comic Sans MS': 1.39,
  };

  function defaultTextLayer(overrides = {}) {
    return cleanTextLayer({
      id: `text-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: 'Metin',
      font: 'Arial',
      size: 8,
      color: '#ffffff',
      bold: true,
      italic: false,
      style: 'outline',
      x: 0.5,
      y: 0.85,
      start: 0,
      end: null,
      ...overrides,
    });
  }

  function cleanTextLayer(layer = {}) {
    const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    const clamp01 = (value, fallback) => Math.min(1, Math.max(0, number(value, fallback)));
    const color = /^#[0-9a-f]{6}$/i.test(String(layer.color || '')) ? String(layer.color).toLowerCase() : '#ffffff';
    const start = Math.max(0, number(layer.start, 0));
    const endValue = layer.end === null || layer.end === undefined || layer.end === '' ? null : number(layer.end, null);
    return {
      id: /^[\w-]{1,40}$/.test(String(layer.id || '')) ? String(layer.id) : `text-${Math.random().toString(36).slice(2, 10)}`,
      text: String(layer.text ?? '').replace(/\r\n?/g, '\n').slice(0, 500),
      font: TEXT_FONTS.includes(layer.font) ? layer.font : 'Arial',
      size: Math.min(30, Math.max(1, number(layer.size, 8))),
      color,
      bold: Boolean(layer.bold),
      italic: Boolean(layer.italic),
      style: TEXT_STYLES.includes(layer.style) ? layer.style : 'outline',
      x: clamp01(layer.x, 0.5),
      y: clamp01(layer.y, 0.85),
      start,
      end: endValue !== null && endValue > start ? endValue : null,
    };
  }

  function cleanTextLayers(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, MAX_TEXT_LAYERS).map(cleanTextLayer).filter((layer) => layer.text.trim());
  }

  // Piksel ölçüleri: yazı boyutu ("em") ve stile göre kenarlık/gölge/kutu.
  function textLayerMetrics(layer, outputHeight) {
    const fontPx = (layer.size / 100) * Math.max(1, Number(outputHeight) || 1);
    return {
      fontPx,
      outlinePx: layer.style === 'outline' ? Math.max(1, fontPx * 0.07) : layer.style === 'shadow' ? Math.max(0.5, fontPx * 0.025) : 0,
      shadowPx: layer.style === 'shadow' ? Math.max(1, fontPx * 0.06) : 0,
      boxPadPx: layer.style === 'box' ? Math.max(2, fontPx * 0.22) : 0,
      boxAlpha: 0.62,
    };
  }

  // #rrggbb + saydamlık (0 opak, 1 görünmez) → ASS &HAABBGGRR
  function assColor(hex, transparency = 0) {
    const value = String(hex || '#ffffff').replace('#', '');
    const r = value.slice(0, 2);
    const g = value.slice(2, 4);
    const b = value.slice(4, 6);
    const a = Math.round(Math.min(1, Math.max(0, transparency)) * 255).toString(16).padStart(2, '0');
    return `&H${a}${b}${g}${r}`.toUpperCase();
  }

  function assTime(seconds) {
    const total = Math.max(0, Math.round((Number(seconds) || 0) * 100));
    const cs = total % 100;
    const s = Math.floor(total / 100) % 60;
    const m = Math.floor(total / 6000) % 60;
    const h = Math.floor(total / 360000);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  // ASS'te { } biçim bloğu, \ ise kaçış başlatır; kullanıcı metni bunları
  // görünür benzerleriyle değiştirerek olduğu gibi gösterilir.
  function assText(text) {
    return String(text)
      .replace(/\\/g, '⧵')
      .replace(/\{/g, '｛')
      .replace(/\}/g, '｝')
      .replace(/\n/g, '\\N');
  }

  // width/height: metnin çizileceği çıktı boyutu. defaultEnd: bitişi boş
  // katmanların bitiş zamanı (kaynak zaman çizelgesinde).
  function buildAssDocument({ width, height, layers, defaultEnd = 360000 }) {
    const W = Math.max(2, Math.round(Number(width) || 2));
    const H = Math.max(2, Math.round(Number(height) || 2));
    const clean = cleanTextLayers(layers);
    const styles = [];
    const events = [];
    clean.forEach((layer, index) => {
      const metrics = textLayerMetrics(layer, H);
      const fontSize = (metrics.fontPx * (ASS_FONT_SCALE[layer.font] || 1.15)).toFixed(2);
      const box = layer.style === 'box';
      // BorderStyle 3: opak kutu; libass kutu rengi olarak OutlineColour kullanır.
      const outlineColour = box ? assColor('#000000', 1 - metrics.boxAlpha) : assColor('#000000');
      const outline = box ? metrics.boxPadPx : metrics.outlinePx;
      styles.push([
        `L${index}`, layer.font, fontSize,
        assColor(layer.color), assColor(layer.color), outlineColour, assColor('#000000', 0.45),
        layer.bold ? -1 : 0, layer.italic ? -1 : 0, 0, 0, 100, 100, 0, 0,
        box ? 3 : 1, outline.toFixed(2), metrics.shadowPx.toFixed(2), 5, 0, 0, 0, 1,
      ].join(','));
      const x = (layer.x * W).toFixed(1);
      const y = (layer.y * H).toFixed(1);
      const end = layer.end === null ? defaultEnd : layer.end;
      events.push(`Dialogue: ${index},${assTime(layer.start)},${assTime(end)},L${index},,0,0,0,,{\\pos(${x},${y})}${assText(layer.text)}`);
    });
    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${W}`,
      `PlayResY: ${H}`,
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      'YCbCr Matrix: None',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      ...styles.map((style) => `Style: ${style}`),
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...events,
      '',
    ].join('\n');
  }

  // ── Video birleştirme ──────────────────────────────────────────────────
  // Videolar ancak aynı codec, çözünürlük, piksel biçimi, kare hızı ve ses
  // biçimindeyse yeniden kodlanmadan (concat okuyucusuyla) uç uca eklenebilir.
  function mergeCompatibility(metas) {
    const list = (Array.isArray(metas) ? metas : []).filter(Boolean);
    if (list.length < 2) return { compatible: list.length === 1, reasons: [] };
    const first = list[0];
    const same = (a, b) => String(a ?? '') === String(b ?? '');
    const reasons = new Set();
    for (const meta of list.slice(1)) {
      if (!same(meta.videoCodec, first.videoCodec)) reasons.add('codec');
      if (!same(meta.profile, first.profile)) reasons.add('codec profili');
      if (Number(meta.width) !== Number(first.width) || Number(meta.height) !== Number(first.height)) reasons.add('çözünürlük');
      if (!same(meta.pixFmt, first.pixFmt)) reasons.add('renk biçimi');
      if (Math.abs((Number(meta.fps) || 0) - (Number(first.fps) || 0)) > 0.01) reasons.add('kare hızı');
      if ((Number(meta.rotation) || 0) !== (Number(first.rotation) || 0)) reasons.add('yönlendirme');
      if (Boolean(meta.hasAudio) !== Boolean(first.hasAudio)) {
        reasons.add('ses varlığı');
      } else if (first.hasAudio && (!same(meta.audioCodec, first.audioCodec) ||
        Number(meta.audioSampleRate) !== Number(first.audioSampleRate) ||
        Number(meta.audioChannels) !== Number(first.audioChannels))) {
        reasons.add('ses biçimi');
      }
    }
    return { compatible: reasons.size === 0, reasons: [...reasons] };
  }

  return {
    mergeCompatibility,
    TEXT_FONTS,
    TEXT_STYLES,
    MAX_TEXT_LAYERS,
    defaultTextLayer,
    cleanTextLayer,
    cleanTextLayers,
    textLayerMetrics,
    assColor,
    buildAssDocument,
    VIDEO_CODECS,
    VIDEO_QUALITY_MODES,
    VIDEO_ENCODER_PRESETS,
    VIDEO_MAX_EDGES,
    VIDEO_PRESETS,
    MAX_USER_PRESETS,
    cleanVideoPresetSettings,
    cleanUserPresets,
    SIZE_MIN_VIDEO_KBPS,
    SIZE_MAX_MB,
    sizeModeBitrates,
    parseTimecode,
    SILENCE_LEVELS,
    SILENCE_MIN_SECONDS,
    keepRangesFromSilences,
    SMART_CUT_CODECS,
    smartCutSupported,
    smartCutSplit,
    VIDEO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    AUDIO_EXTENSIONS,
    MEDIA_EXTENSION,
    sanitizeBaseName,
    GIF_MAX_ITEMS,
    GIF_MAX_DURATION,
    GIF_MAX_FRAMES,
    GIF_FPS_VALUES,
    GIF_RATIOS,
    gifRatioValue,
  };
}));
