'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, screen,
} = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {
  detectEngine,
  probeMedia,
  probeVideo,
  probeImage,
  makeFilmstrip,
  makePoster,
  planVideo,
  exportVideo,
  saveFrame,
  detectHardwareEncoders,
  resolveHardwareVendor,
  planMerge,
  exportMerge,
} = require('./media');
const {
  previewPhoto,
  exportPhoto,
  formatToExtension,
  normalizeFormat,
} = require('./photos');
const {
  buildGifPlan,
  exportGif,
} = require('./gif');
const {
  ensureDir,
  sanitizeBaseName,
  uniquePath,
} = require('./util');
const { MEDIA_EXTENSION } = require('../src/shared.js');
// Ana süreçte yalnızca işletim sistemi pencerelerinin (dosya seçici)
// metinleri çevrilir; hata mesajları arayüzde çevrilir.
const { t, setLanguage, languageForLocale } = require('../src/i18n.js');

const log = require('./logger');

function applyLanguage() {
  setLanguage(config.preferences?.ui?.language || languageForLocale(app.getLocale()));
}

// Her IPC işleyicisi sarılır: fırlatılan hatalar ve { ok: false } sonuçları
// (FFmpeg ayrıntısıyla) hata kaydına yazılır. İptaller hata sayılmaz.
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, async (...args) => {
  try {
    const result = await handler(...args);
    if (result && result.ok === false && !result.canceled) {
      log.error(`${channel}: ${result.message || 'failed'}`, result.details);
    }
    return result;
  } catch (error) {
    log.error(`${channel}: ${error?.message || error}`, error?.details || error?.stack);
    throw error;
  }
});

process.on('uncaughtException', (error) => log.error(`Uncaught exception: ${error?.message || error}`, error?.stack));
process.on('unhandledRejection', (error) => log.error(`Unhandled rejection: ${error?.message || error}`, error?.stack));

const isDev = process.argv.includes('--dev');
const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jxl': 'image/jxl',
};
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.vob': 'video/mpeg',
};
const AUDIO_MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

let mainWindow = null;
let engine = { available: false, ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: null };
// GPU kodlayıcı tespiti birkaç saniye sürebilir; pencere beklemeden açılır,
// arayüz sonucu 'system:hardware' ile ister.
let hardwarePromise = Promise.resolve({ h264: [], h265: [] });
let mediaServer = null;
let mediaBaseUrl = '';
let sessionDir = '';
let lastGifPreviewPath = '';
let configPath = '';
let config = {};
const mediaTokens = new Map();
const mediaTokenByFile = new Map();
const jobs = new Map();
// Arayüz yalnızca bu oturumda üretilen dosyaları açabilir veya klasörde
// gösterebilir; rastgele bir yol (ör. .exe) shell üzerinden çalıştırılamaz.
const producedOutputs = new Set();

function outputKey(file) {
  return path.resolve(String(file || '')).toLowerCase();
}

function rememberOutput(file) {
  producedOutputs.add(outputKey(file));
}

function isProducedOutput(file) {
  return Boolean(file) && producedOutputs.has(outputKey(file)) && fs.existsSync(file);
}

// "Birlikte aç" / dosyayı simgeye bırakma: Windows dosya yolunu komut satırı
// argümanı olarak verir. Yalnızca var olan ve desteklenen bir medya dosyası
// kabul edilir; seçenekler (--dev gibi) ve proje klasörü yok sayılır.
function mediaFileFromArgs(argv) {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-') || !MEDIA_EXTENSION.test(arg)) continue;
    try {
      const file = path.resolve(arg);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Var olmayan yol: sonraki argümana bak.
    }
  }
  return null;
}

let pendingOpenFile = mediaFileFromArgs(process.argv);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', (event, argv) => {
  if (!hasSingleInstanceLock) return;
  const file = mediaFileFromArgs(argv);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    if (file) mainWindow.webContents.send('app:open-file', file);
  } else if (file) {
    pendingOpenFile = file;
  }
});

function defaultConfig() {
  return {
    videoOutputDir: app.getPath('videos'),
    photoOutputDir: app.getPath('pictures'),
    gifOutputDir: app.getPath('videos'),
    windowBounds: null,
  };
}

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'config.json');
  try {
    // Harici bir düzenleyici BOM eklemiş olabilir; JSON.parse BOM'u kabul etmez.
    const rawText = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const raw = JSON.parse(rawText);
    config = {
      ...defaultConfig(),
      ...(raw && typeof raw === 'object' ? raw : {}),
    };
  } catch {
    config = defaultConfig();
  }
}

async function saveConfig() {
  try {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // Config persistence is best-effort.
  }
}

// Kaydedilmiş pencere boyutunu geri yükler. Monitör kaldırılmış veya çözünürlük
// değişmiş olabileceği için pencere en az bir ekranın görünür alanına denk
// gelmiyorsa konum atlanır.
function restoreWindowBounds() {
  const saved = config.windowBounds;
  if (!saved || typeof saved !== 'object') return null;
  const rawWidth = Number(saved.width);
  const rawHeight = Number(saved.height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 400 || rawHeight < 300) {
    return null;
  }
  const width = Math.min(10000, Math.max(1120, Math.round(rawWidth)));
  const height = Math.min(8000, Math.max(720, Math.round(rawHeight)));
  const x = Math.round(Number(saved.x));
  const y = Math.round(Number(saved.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x + width > area.x + 80 &&
      x < area.x + area.width - 80 &&
      y + height > area.y + 60 &&
      y < area.y + area.height - 60
    );
  });
  return visible ? { x, y, width, height } : { width, height };
}

function cleanupStaleSessions(base) {
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const cutoff = Date.now() - 2 * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
      const full = path.join(base, entry.name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        // Ignore stale session cleanup failures.
      }
    }
  } catch {
    // Temp directory may not exist yet.
  }
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return IMAGE_MIME[ext] || VIDEO_MIME[ext] || AUDIO_MIME[ext] || 'application/octet-stream';
}

function serveMedia(req, res, file) {
  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Dosya bulunamadı');
      return;
    }
    const total = stat.size;
    const headers = {
      'Content-Type': contentTypeFor(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': total });
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { ...headers, 'Content-Length': total });
      fs.createReadStream(file).pipe(res);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    let start;
    let end;
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      start = Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? total - 1 : Number(match[2]);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

function startMediaServer() {
  return new Promise((resolve, reject) => {
    mediaServer = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const prefix = '/m/';
        if (!parsed.pathname.startsWith(prefix)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bulunamadı');
          return;
        }
        const token = parsed.pathname.slice(prefix.length);
        const file = mediaTokens.get(token);
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Bulunamadı');
          return;
        }
        serveMedia(req, res, file);
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    mediaServer.on('error', reject);
    mediaServer.listen(0, '127.0.0.1', () => {
      const address = mediaServer.address();
      mediaBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

function registerMedia(file) {
  const resolved = path.resolve(String(file || ''));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('Dosya bulunamadı.');
  }
  // Aynı dosya için tek anahtar: önizleme ve küçük resimler tekrar tekrar
  // istendiğinde harita sınırsız büyümesin.
  let token = mediaTokenByFile.get(resolved);
  if (!token) {
    token = crypto.randomUUID();
    mediaTokens.set(token, resolved);
    mediaTokenByFile.set(resolved, token);
  }
  return `${mediaBaseUrl}/m/${token}`;
}

function forgetMedia(file) {
  const resolved = path.resolve(String(file || ''));
  const token = mediaTokenByFile.get(resolved);
  if (!token) return;
  mediaTokens.delete(token);
  mediaTokenByFile.delete(resolved);
}

function createWindow() {
  const restored = restoreWindowBounds();
  mainWindow = new BrowserWindow({
    width: restored?.width || 1480,
    height: restored?.height || 930,
    ...(restored && Number.isFinite(restored.x) ? { x: restored.x, y: restored.y } : {}),
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0c0e',
    show: false,
    title: 'Odak Studio',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow.on('close', () => {
    if (!mainWindow) return;
    config.windowBounds = mainWindow.getNormalBounds();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch {
      // Best-effort: konum kaydı başarısız olsa da uygulama kapanmalı.
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!isDev) return;
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function fileDialogFilters(kind) {
  if (kind === 'video') {
    return [
      { name: t('Video'), extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts', '3gp', 'ogv'] },
      { name: t('Tüm dosyalar'), extensions: ['*'] },
    ];
  }
  if (kind === 'image') {
    return [
      { name: t('Görsel'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif'] },
      { name: t('Tüm dosyalar'), extensions: ['*'] },
    ];
  }
  return [
    { name: t('Medya'), extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mts', 'm2ts', 'ts', '3gp', 'jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif'] },
    { name: t('Tüm dosyalar'), extensions: ['*'] },
  ];
}

function frameDefaultName(meta, time) {
  const base = sanitizeBaseName(path.parse(meta.path || meta.name || 'kare').name);
  const seconds = Math.max(0, Number(time) || 0);
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  const cs = String(Math.floor((seconds % 1) * 100)).padStart(2, '0');
  return `${base}-kare-${mm}-${ss}-${cs}.png`;
}

async function ensureOutputDir(dir, fallback) {
  const target = path.resolve(String(dir || fallback));
  await ensureDir(target);
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new Error('Geçerli bir çıktı klasörü seçin.');
  return target;
}

async function prepareGifItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('GIF oluşturmak için en az bir video veya fotoğraf ekleyin.');
  }
  const prepared = [];
  for (const raw of rawItems) {
    const file = path.resolve(String(raw?.path || ''));
    if (!file || !fs.existsSync(file)) throw new Error('GIF kaynağı bulunamadı.');
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('GIF kaynağı bir dosya değil.');
    const meta = await probeMedia(engine, file);
    if (meta.kind !== 'video' && meta.kind !== 'image') {
      throw new Error(`${path.basename(file)} GIF kaynağı olarak kullanılamıyor.`);
    }
    prepared.push({
      ...raw,
      path: file,
      meta,
    });
  }
  return prepared;
}

ipcMain.handle('system:info', async () => ({
  appVersion: app.getVersion(),
  platform: process.platform,
  locale: app.getLocale(),
  engine,
  config,
  paths: {
    videos: app.getPath('videos'),
    pictures: app.getPath('pictures'),
    temp: sessionDir,
  },
}));

ipcMain.handle('system:hardware', async () => hardwarePromise);

ipcMain.handle('config:get', async () => config);
ipcMain.handle('config:set', async (event, patch) => {
  if (patch && typeof patch === 'object') {
    for (const key of ['videoOutputDir', 'photoOutputDir', 'gifOutputDir']) {
      if (typeof patch[key] === 'string' && patch[key].trim()) {
        config[key] = patch[key];
      }
    }
    // Arayüz tercihleri (son ayarlar, kayıtlı hazır ayarlar) bölüm bölüm
    // birleştirilir. İçerik arayüzde doğrulanır; burada yalnızca biçim ve
    // boyut sınırlanır ki bozuk bir istek ayar dosyasını şişirmesin.
    const prefs = patch.preferences;
    if (prefs && typeof prefs === 'object' && !Array.isArray(prefs)) {
      const merged = { ...(config.preferences && typeof config.preferences === 'object' ? config.preferences : {}) };
      for (const [section, value] of Object.entries(prefs)) {
        if (!/^[a-zA-Z]{1,32}$/.test(section)) continue;
        if (value === null) {
          delete merged[section];
          continue;
        }
        if (typeof value !== 'object') continue;
        if (JSON.stringify(value).length > 64 * 1024) continue;
        merged[section] = value;
      }
      config.preferences = merged;
      applyLanguage();
    }
    await saveConfig();
  }
  return config;
});

ipcMain.handle('dialog:open-files', async (event, payload = {}) => {
  const kind = ['video', 'image', 'media'].includes(payload.kind) ? payload.kind : 'media';
  const multiple = Boolean(payload.multiple);
  const properties = multiple ? ['openFile', 'multiSelections'] : ['openFile'];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t(kind === 'image' ? 'Fotoğraf aç' : kind === 'video' ? 'Video aç' : 'Medya aç'),
    properties,
    filters: fileDialogFilters(kind),
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('dialog:open-folder', async (event, payload = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('Çıktı klasörü seç'),
    defaultPath: payload.defaultPath || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle('media:probe', async (event, file) => {
  if (!file || typeof file !== 'string') throw new Error('Geçersiz dosya.');
  if (!fs.existsSync(file)) throw new Error('Dosya bulunamadı.');
  return probeMedia(engine, file);
});

ipcMain.handle('media:url', async (event, file) => registerMedia(file));

ipcMain.handle('media:poster', async (event, payload = {}) => {
  if (!engine.available) return null;
  const file = payload.path;
  if (!file || !fs.existsSync(file)) return null;
  const duration = Number(payload.duration) || 0;
  const time = Math.min(Math.max(0, duration * 0.08), Math.max(0, duration - 0.05), 1.5);
  const output = path.join(sessionDir, `poster-${crypto.randomUUID()}.jpg`);
  try {
    await makePoster(engine, file, time, output);
    return registerMedia(output);
  } catch {
    return null;
  }
});

ipcMain.handle('media:filmstrip', async (event, payload = {}) => {
  if (!engine.available) return null;
  const file = payload.path;
  if (!file || !fs.existsSync(file)) return null;
  const output = path.join(sessionDir, `film-${crypto.randomUUID()}.jpg`);
  try {
    await makeFilmstrip(engine, file, Number(payload.duration) || 0, output);
    return registerMedia(output);
  } catch {
    return null;
  }
});

ipcMain.handle('video:export', async (event, payload = {}) => {
  if (!engine.available) throw new Error('FFmpeg bulunamadı. Video dışa aktarma kullanılamıyor.');
  const input = payload.input;
  if (!input || !fs.existsSync(input)) throw new Error('Kaynak video bulunamadı.');
  const sender = event.sender;
  const jobId = String(payload.jobId || crypto.randomUUID());

  const meta = await probeVideo(engine, input);
  if (meta.duration <= 0) throw new Error('Videonun süresi okunamadı.');
  const options = { ...(payload.options || {}) };
  // GPU istendiyse bu makinede çalışan üretici seçilir; yoksa işlemciyle kodlanır.
  options.hwVendor = resolveHardwareVendor(options, await hardwarePromise);
  const plan = planVideo(meta, options);
  const outputDir = await ensureOutputDir(payload.outputDir, config.videoOutputDir);
  const baseName = sanitizeBaseName(payload.baseName || path.parse(input).name);
  const outputPath = await uniquePath(outputDir, baseName, plan.ext);
  const tempPath = path.join(outputDir, `.odak-${crypto.randomUUID()}${plan.ext}`);
  const controller = new AbortController();
  const job = { controller, tempPath, outputPath, sender, startedAt: Date.now() };
  jobs.set(jobId, job);

  const sendProgress = (data) => {
    if (sender.isDestroyed()) return;
    sender.send('job:progress', { jobId, ...data });
  };

  try {
    const result = await exportVideo(engine, input, meta, options, tempPath, plan, {
      signal: controller.signal,
      onProgress: (data) => sendProgress(data),
    });
    await fsp.rename(tempPath, outputPath);
    rememberOutput(outputPath);
    const stat = await fsp.stat(outputPath);
    let outputMeta = null;
    try {
      outputMeta = await probeVideo(engine, outputPath);
    } catch {
      // Output probing is informational only.
    }
    sendProgress({ percent: 100, done: true, path: outputPath });
    return {
      ok: true,
      path: outputPath,
      name: path.basename(outputPath),
      size: stat.size,
      duration: outputMeta?.duration || plan.duration,
      width: outputMeta?.width || null,
      height: outputMeta?.height || null,
      bitrate: outputMeta?.overallBitrate || null,
      elapsedMs: Date.now() - job.startedAt,
      copied: options.mode === 'copy' || Boolean(result.keptSource),
      hwVendor: options.hwVendor || null,
      targetBytes: result.targetBytes || null,
      overTarget: Boolean(result.overTarget),
      plan,
    };
  } catch (error) {
    try { await fsp.rm(tempPath, { force: true }); } catch { /* ignore */ }
    if (error.cancelled) {
      return { ok: false, canceled: true, message: 'Dışa aktarma iptal edildi.' };
    }
    // Hata ve FFmpeg ayrıntısını tek bir nesnede döndür: Error nesnesinin özel
    // alanları IPC sınırından geçmez.
    return {
      ok: false,
      message: error?.message || 'Dışa aktarma tamamlanamadı.',
      details: error?.details || error?.stderr || '',
    };
  } finally {
    jobs.delete(jobId);
  }
});

ipcMain.handle('video:merge', async (event, payload = {}) => {
  if (!engine.available) throw new Error('FFmpeg bulunamadı. Birleştirme kullanılamıyor.');
  const inputs = Array.isArray(payload.inputs) ? payload.inputs.map((file) => path.resolve(String(file || ''))) : [];
  if (inputs.length < 2) throw new Error('Birleştirmek için en az iki video ekleyin.');
  if (inputs.length > 200) throw new Error('En fazla 200 video birleştirilebilir.');
  const metas = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`${path.basename(input)} bulunamadı.`);
    metas.push(await probeVideo(engine, input));
  }
  const settings = payload.settings || {};
  const plan = planMerge(metas, settings);
  const hwVendor = plan.lossless ? null : resolveHardwareVendor({ ...settings, mode: 'crf', codec: plan.codec }, await hardwarePromise);
  const outputDir = await ensureOutputDir(payload.outputDir, config.videoOutputDir);
  const baseName = sanitizeBaseName(payload.baseName || `${path.parse(inputs[0]).name}-birlesik`);
  const outputPath = await uniquePath(outputDir, baseName, plan.ext);
  const tempPath = path.join(outputDir, `.odak-${crypto.randomUUID()}${plan.ext}`);
  const sender = event.sender;
  const jobId = String(payload.jobId || crypto.randomUUID());
  const controller = new AbortController();
  const job = { controller, tempPath, outputPath, sender, startedAt: Date.now() };
  jobs.set(jobId, job);
  const sendProgress = (data) => {
    if (!sender.isDestroyed()) sender.send('job:progress', { jobId, ...data });
  };
  try {
    await exportMerge(engine, inputs, metas, settings, tempPath, {
      signal: controller.signal,
      onProgress: sendProgress,
      hwVendor,
    });
    await fsp.rename(tempPath, outputPath);
    rememberOutput(outputPath);
    const stat = await fsp.stat(outputPath);
    sendProgress({ percent: 100, done: true, path: outputPath });
    return {
      ok: true,
      path: outputPath,
      name: path.basename(outputPath),
      size: stat.size,
      duration: plan.duration,
      width: plan.lossless ? metas[0].width : plan.width,
      height: plan.lossless ? metas[0].height : plan.height,
      lossless: plan.lossless,
      reasons: plan.compat.reasons,
      hwVendor,
      elapsedMs: Date.now() - job.startedAt,
    };
  } catch (error) {
    try { await fsp.rm(tempPath, { force: true }); } catch { /* ignore */ }
    if (error.cancelled) return { ok: false, canceled: true, message: 'Birleştirme iptal edildi.' };
    return { ok: false, message: error?.message || 'Videolar birleştirilemedi.', details: error?.details || '' };
  } finally {
    jobs.delete(jobId);
  }
});

ipcMain.handle('gif:export', async (event, payload = {}) => {
  if (!engine.available) throw new Error('FFmpeg bulunamadı. GIF oluşturma kullanılamıyor.');
  const items = await prepareGifItems(payload.items);
  const plan = buildGifPlan(items, payload.settings || {});
  const outputDir = await ensureOutputDir(payload.outputDir, config.gifOutputDir);
  const baseName = sanitizeBaseName(payload.baseName || 'odak-gif', 'odak-gif');
  const outputPath = await uniquePath(outputDir, baseName, '.gif');
  const tempPath = path.join(outputDir, `.odak-${crypto.randomUUID()}.gif`);
  const sender = event.sender;
  const jobId = String(payload.jobId || crypto.randomUUID());
  const controller = new AbortController();
  const job = { controller, tempPath, outputPath, sender, startedAt: Date.now() };
  jobs.set(jobId, job);

  const sendProgress = (data) => {
    if (sender.isDestroyed()) return;
    sender.send('job:progress', { jobId, ...data });
  };

  try {
    const result = await exportGif(engine, plan, tempPath, {
      signal: controller.signal,
      onProgress: (data) => sendProgress(data),
    });
    await fsp.rename(tempPath, outputPath);
    rememberOutput(outputPath);
    const stat = await fsp.stat(outputPath);
    sendProgress({ percent: 100, done: true, path: outputPath });
    return {
      ok: true,
      path: outputPath,
      name: path.basename(outputPath),
      size: stat.size,
      width: plan.width,
      height: plan.height,
      duration: plan.duration,
      frames: plan.frames,
      bitrate: plan.duration > 0 ? (stat.size * 8) / plan.duration : null,
      elapsedMs: Date.now() - job.startedAt,
      plan,
      ...result,
    };
  } catch (error) {
    try { await fsp.rm(tempPath, { force: true }); } catch { /* ignore */ }
    if (error.cancelled) {
      return { ok: false, canceled: true, message: 'GIF oluşturma iptal edildi.' };
    }
    return {
      ok: false,
      message: error?.message || 'GIF oluşturulamadı.',
      details: error?.details || error?.stderr || '',
    };
  } finally {
    jobs.delete(jobId);
  }
});

ipcMain.handle('gif:preview', async (event, payload = {}) => {
  if (!engine.available) throw new Error('FFmpeg bulunamadı. GIF önizlemesi kullanılamıyor.');
  const items = await prepareGifItems(payload.items);
  const settings = { ...(payload.settings || {}) };
  const requestedWidth = Number(settings.width) || 480;
  settings.width = Math.max(160, Math.min(320, requestedWidth));
  const plan = buildGifPlan(items, settings);
  const output = path.join(sessionDir, `gif-preview-${crypto.randomUUID()}.gif`);
  // Önizleme de iş listesine girer: arayüz ayar değişince eskisini iptal eder,
  // uygulama kapanırken de FFmpeg süreci durdurulur.
  const jobId = String(payload.jobId || crypto.randomUUID());
  const controller = new AbortController();
  jobs.set(jobId, { controller, tempPath: output, sender: event.sender, startedAt: Date.now() });
  try {
    await exportGif(engine, plan, output, { signal: controller.signal });
  } catch (error) {
    try { await fsp.rm(output, { force: true }); } catch { /* ignore */ }
    if (error.cancelled) {
      return { ok: false, canceled: true, message: 'GIF önizlemesi iptal edildi.' };
    }
    throw error;
  } finally {
    jobs.delete(jobId);
  }
  if (lastGifPreviewPath) {
    forgetMedia(lastGifPreviewPath);
    fsp.rm(lastGifPreviewPath, { force: true }).catch(() => {});
  }
  lastGifPreviewPath = output;
  return {
    ok: true,
    url: registerMedia(output),
    width: plan.width,
    height: plan.height,
    duration: plan.duration,
    frames: plan.frames,
  };
});

ipcMain.handle('job:cancel', async (event, jobId) => {
  const job = jobs.get(String(jobId));
  if (!job) return false;
  job.controller.abort();
  return true;
});

ipcMain.handle('video:save-frame', async (event, payload = {}) => {
  if (!engine.available) throw new Error('FFmpeg bulunamadı. Kare kaydetme kullanılamıyor.');
  const input = payload.input;
  if (!input || !fs.existsSync(input)) throw new Error('Video bulunamadı.');
  const meta = await probeVideo(engine, input);
  const dir = payload.defaultDir || config.photoOutputDir || app.getPath('pictures');
  await ensureDir(dir);
  const suggested = frameDefaultName({ ...meta, path: input }, payload.time);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('Kareyi kaydet'),
    defaultPath: path.join(dir, suggested),
    filters: [{ name: t('PNG görsel'), extensions: ['png'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  let outputPath = result.filePath;
  if (!/\.png$/i.test(outputPath)) outputPath = `${outputPath.replace(/\.[^.\\/]+$/, '')}.png`;
  // Doğrudan hedefe yazmak yerine aynı klasörde geçici dosyaya yaz; FFmpeg
  // yarıda kalırsa kullanıcının mevcut dosyası bozulmasın.
  const tempFrame = path.join(path.dirname(outputPath), `.odak-frame-${crypto.randomUUID()}.png`);
  try {
    await saveFrame(engine, input, meta, Number(payload.time) || 0, tempFrame, payload.options || {});
    await fsp.rename(tempFrame, outputPath);
    rememberOutput(outputPath);
  } catch (error) {
    try { await fsp.rm(tempFrame, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return { ok: true, path: outputPath, name: path.basename(outputPath) };
});

ipcMain.handle('photo:preview', async (event, payload = {}) => {
  const file = payload.path;
  if (!file || !fs.existsSync(file)) throw new Error('Görsel bulunamadı.');
  const meta = await probeImage(file);
  return previewPhoto(file, meta, payload.ops || []);
});

ipcMain.handle('photo:export', async (event, payload = {}) => {
  const file = payload.path;
  if (!file || !fs.existsSync(file)) throw new Error('Görsel bulunamadı.');
  const meta = await probeImage(file);
  const options = payload.options || {};
  const requested = options.format || 'original';
  const targetFormat = requested === 'original' ? normalizeFormat(meta) : requested;
  const outputDir = await ensureOutputDir(payload.outputDir, config.photoOutputDir);
  const baseName = sanitizeBaseName(payload.baseName || path.parse(file).name);
  const ext = formatToExtension(targetFormat);
  const outputPath = await uniquePath(outputDir, baseName, ext);
  const tempPath = path.join(outputDir, `.odak-${crypto.randomUUID()}${ext}`);
  let result;
  try {
    result = await exportPhoto(file, meta, payload.ops || [], options, tempPath);
    await fsp.rename(tempPath, outputPath);
    rememberOutput(outputPath);
  } catch (error) {
    try { await fsp.rm(tempPath, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  return {
    ok: true,
    ...result,
    path: outputPath,
    name: path.basename(outputPath),
  };
});

ipcMain.handle('shell:show-item', async (event, file) => {
  if (!isProducedOutput(file)) return false;
  shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('shell:open-path', async (event, file) => {
  if (!isProducedOutput(file)) return false;
  const error = await shell.openPath(file);
  return !error;
});

// ── Otomatik güncelleme ─────────────────────────────────────────────────
// Yeni sürümler GitHub Releases'tan (latest.yml) denetlenir, arka planda
// indirilir; uygulama kapanırken ya da kullanıcı isteyince kurulur. İndirme
// .blockmap ile farka dayalıdır: değişmeyen bloklar (ör. FFmpeg) yeniden
// indirilmez. Geliştirme modunda (paketlenmemiş) çalışmaz.
let autoUpdater = null;
let updateStatus = { state: 'disabled' };

function sendUpdateStatus(status) {
  updateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus({
    state: 'downloading',
    version: updateStatus.version,
    percent: Math.round(progress.percent || 0),
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'downloaded', version: info.version }));
  // Çevrimdışıyken veya sunucu yanıt vermezken uygulama sessizce çalışmaya devam eder.
  autoUpdater.on('error', (error) => sendUpdateStatus({ state: 'error', message: String(error?.message || error).split('\n')[0] }));
  updateStatus = { state: 'idle' };
  // Açılışı yavaşlatmamak için biraz sonra denetle.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 8000);
}

ipcMain.handle('update:status', async () => updateStatus);

ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return updateStatus;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    sendUpdateStatus({ state: 'error', message: String(error?.message || error).split('\n')[0] });
  }
  return updateStatus;
});

ipcMain.handle('update:install', async () => {
  if (!autoUpdater || updateStatus.state !== 'downloaded') return false;
  // Süren dışa aktarmalar kapanırken iptal edilir (before-quit).
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});

// Arayüzdeki hatalar (JavaScript hataları, hata bildirimleri) da aynı kayda yazılır.
ipcMain.handle('log:write', async (event, entry = {}) => {
  const level = ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'error';
  log[level](`renderer: ${String(entry.message || '').slice(0, 1000)}`, entry.details ? String(entry.details) : undefined);
  return true;
});

ipcMain.handle('log:open', async () => {
  if (!log.file) return false;
  if (!fs.existsSync(log.file)) log.info('Log opened (no entries yet).');
  return !(await shell.openPath(log.file));
});

ipcMain.handle('log:show', async () => {
  if (!log.file) return false;
  if (!fs.existsSync(log.file)) log.info('Log opened (no entries yet).');
  shell.showItemInFolder(log.file);
  return true;
});

// Lisans metinleri: paketlenmiş uygulamada resources/licenses (Odak Studio
// GPL metni, FFmpeg lisansı ve kaynak bilgisi), geliştirmede proje LICENSE dosyası.
ipcMain.handle('app:open-licenses', async () => {
  const target = app.isPackaged
    ? path.join(process.resourcesPath, 'licenses')
    : path.join(__dirname, '..', 'LICENSE');
  if (!fs.existsSync(target)) return false;
  return !(await shell.openPath(target));
});

// Yalnızca projenin sabit adresi açılır; arayüzden gelen bir adres değil.
// Arayüz hazır olunca açılışta verilen dosyayı bir kez alır.
ipcMain.handle('app:take-open-file', async () => {
  const file = pendingOpenFile;
  pendingOpenFile = null;
  return file;
});

ipcMain.handle('app:open-website', async () => {
  await shell.openExternal('https://github.com/EfeKesgin/odak-studio');
  return true;
});

// Dil değişikliğinde arayüzü yeniden kurar. will-navigate engeli renderer'ın
// kendi başlattığı yeniden yüklemeyi de durdurduğu için ana süreç yapar.
ipcMain.handle('app:reload', async (event) => {
  event.sender.reload();
  return true;
});

ipcMain.handle('app:about', async () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  chromium: process.versions.chrome,
}));

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  app.setAppUserModelId('com.odak.studio');
  const baseTemp = path.join(app.getPath('temp'), 'odak-studio');
  fs.mkdirSync(baseTemp, { recursive: true });
  cleanupStaleSessions(baseTemp);
  sessionDir = await fsp.mkdtemp(path.join(baseTemp, 'run-'));
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info(`Odak Studio ${app.getVersion()} started`, `Electron ${process.versions.electron} · ${process.platform} ${process.getSystemVersion?.() || ''} · ${app.isPackaged ? 'packaged' : 'development'}`);
  loadConfig();
  applyLanguage();
  engine = await detectEngine();
  if (engine.available) log.info(`FFmpeg ${engine.version}`, engine.ffmpeg);
  else log.warn('FFmpeg not found.');
  app.on('render-process-gone', (event, contents, details) => log.error(`Renderer process gone: ${details.reason}`, details));
  app.on('child-process-gone', (event, details) => log.error(`Child process gone: ${details.type} ${details.reason}`));
  await startMediaServer();
  createWindow();
  hardwarePromise = detectHardwareEncoders(engine).catch(() => ({ h264: [], h265: [] }));
  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const job of jobs.values()) {
    try { job.controller.abort(); } catch { /* ignore */ }
  }
  jobs.clear();
  try { mediaServer?.close(); } catch { /* ignore */ }
  try {
    if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Temp cleanup is best-effort; stale sessions are removed on next launch.
  }
});
