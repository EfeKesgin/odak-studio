'use strict';

(function () {
  const ui = window.OdakUI;
  const {
    $, $$, toast, shortenPath, formatBytes, formatBitrate, formatTimecode,
    formatDuration, formatResolution, fileNameExtension, clearToasts,
  } = ui;

  if (!window.odak) {
    const title = document.getElementById('emptyTitle');
    const description = document.getElementById('emptyDescription');
    const openButton = document.getElementById('emptyOpenBtn');
    if (title) title.textContent = 'Uygulama bağlantısı kurulamadı.';
    if (description) description.textContent = 'Odak Studio yeniden başlatılmalı. Sorun devam ederse uygulamayı klasöründen çalıştırın.';
    if (openButton) openButton.disabled = true;
    return;
  }

  const api = window.odak;
  const i18n = window.OdakI18n;

  // Arayüzde yakalanmayan hatalar hata kaydına yazılır.
  window.addEventListener('error', (event) => {
    api.writeLog({ level: 'error', message: event.message || 'Renderer error', details: event.error?.stack || `${event.filename}:${event.lineno}` }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    api.writeLog({ level: 'error', message: reason?.message || String(reason), details: reason?.stack }).catch(() => {});
  });
  const { t } = i18n;

  const VIDEO_EXTENSIONS = new Set(window.OdakShared.VIDEO_EXTENSIONS);
  const IMAGE_EXTENSIONS = new Set(window.OdakShared.IMAGE_EXTENSIONS);

  const appState = {
    ready: false,
    mode: 'video',
    config: { videoOutputDir: '', photoOutputDir: '', gifOutputDir: '' },
    system: null,
    engine: null,
    about: null,
    opening: false,
    openingKind: null,
    exportRunning: false,
    exportKind: null,
    exportJobId: null,
    exportCanceling: false,
    batchRunning: false,
    lastOutput: null,
  };

  let videoEditor = null;
  let photoEditor = null;
  let gifEditor = null;
  let batchEditor = null;
  let dragDepth = 0;

  const els = {
    modeButtons: $$('.mode'),
    modeLabel: document.getElementById('modeLabel'),
    openBtn: document.getElementById('openBtn'),
    emptyState: document.getElementById('emptyState'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyDescription: document.getElementById('emptyDescription'),
    emptyFormats: document.getElementById('emptyFormats'),
    emptyOpenBtn: document.getElementById('emptyOpenBtn'),
    emptyOpenLabel: document.getElementById('emptyOpenLabel'),
    videoEditor: document.getElementById('videoEditor'),
    photoEditor: document.getElementById('photoEditor'),
    gifEditor: document.getElementById('gifEditor'),
    batchEditor: document.getElementById('batchEditor'),
    engineBadge: document.getElementById('engineBadge'),
    engineText: document.getElementById('engineText'),
    helpBtn: document.getElementById('helpBtn'),
    dropOverlay: document.getElementById('dropOverlay'),
    dropOverlayHint: document.getElementById('dropOverlayHint'),
    helpDialog: document.getElementById('helpDialog'),
    helpCloseX: document.getElementById('helpCloseX'),
    helpCloseBtn: document.getElementById('helpCloseBtn'),
    helpFfmpeg: document.getElementById('helpFfmpeg'),
    helpFfmpegHint: document.getElementById('helpFfmpegHint'),
    helpElectron: document.getElementById('helpElectron'),
    helpVersion: document.getElementById('helpVersion'),
    exportDialog: document.getElementById('exportDialog'),
    exportEyebrow: document.getElementById('exportEyebrow'),
    exportTitle: document.getElementById('exportTitle'),
    exportRunning: document.getElementById('exportRunning'),
    exportBar: document.getElementById('exportBar'),
    exportPercent: document.getElementById('exportPercent'),
    exportStats: document.getElementById('exportStats'),
    exportDetail: document.getElementById('exportDetail'),
    cancelExportBtn: document.getElementById('cancelExportBtn'),
    exportCloseX: document.getElementById('exportCloseX'),
    exportDone: document.getElementById('exportDone'),
    exportDoneTitle: document.getElementById('exportDoneTitle'),
    exportDoneDesc: document.getElementById('exportDoneDesc'),
    exportDoneMeta: document.getElementById('exportDoneMeta'),
    exportShowBtn: document.getElementById('exportShowBtn'),
    exportOpenBtn: document.getElementById('exportOpenBtn'),
    exportDoneClose: document.getElementById('exportDoneClose'),
    exportError: document.getElementById('exportError'),
    exportErrorTitle: document.getElementById('exportErrorTitle'),
    exportErrorMessage: document.getElementById('exportErrorMessage'),
    exportErrorDetails: document.getElementById('exportErrorDetails'),
    exportErrorClose: document.getElementById('exportErrorClose'),
  };

  boot();

  async function boot() {
    bindShell();
    try {
      api.onJobProgress(handleJobProgress);
    } catch {
      // Progress is optional; export still resolves with a final result.
    }

    let info = null;
    try {
      info = await api.systemInfo();
    } catch (error) {
      console.error('Sistem bilgisi alınamadı:', error);
    }
    appState.system = info;
    appState.config = { ...(info?.config || {}) };
    appState.engine = info?.engine || null;
    // Dil: kayıtlı tercih, yoksa sistem dili. Belge ve sonradan eklenen tüm
    // metinler bu noktadan itibaren çevrilir.
    const savedLanguage = appState.config.preferences?.ui?.language;
    i18n.setLanguage(savedLanguage || i18n.languageForLocale(info?.locale || navigator.language));
    i18n.observeDocument(document);
    setupLanguagePicker();
    updateEngineBadge();

    try {
      videoEditor = new window.VideoEditor({
        api,
        config: appState.config,
        onConfigChange: handleConfigChange,
        onExportRequest: beginVideoExport,
      });
      photoEditor = new window.PhotoEditor({
        api,
        config: appState.config,
        onConfigChange: handleConfigChange,
        onExportRequest: beginPhotoExport,
      });
      gifEditor = new window.GifEditor({
        api,
        config: appState.config,
        onConfigChange: handleConfigChange,
        onExportRequest: beginGifExport,
        onChange: () => renderMode(),
      });
      batchEditor = new window.BatchEditor({
        api,
        config: appState.config,
        getEngine: () => appState.engine,
        onConfigChange: handleConfigChange,
        onChange: () => renderMode(),
        onRunningChange: (running) => {
          appState.batchRunning = Boolean(running);
          document.body.classList.toggle('batch-running', appState.batchRunning);
        },
      });
      appState.ready = true;
      setMode('video');
      renderMode();
      setupUpdates();
      setupOpenWith();
      // GPU kodlayıcı tespiti ana süreçte arka planda sürer.
      api.hardware().then((hardware) => {
        appState.hardware = hardware;
        videoEditor.setHardware(hardware);
        batchEditor.setHardware(hardware);
      }).catch(() => {});
      if (!info?.engine?.available) {
        toast('FFmpeg bulunamadı. Video ve GIF işlemleri çalışmaz; fotoğraf düzenleme kullanılabilir.', {
          type: 'warn',
          timeout: 7500,
        });
      }
    } catch (error) {
      console.error('Arayüz başlatılamadı:', error);
      toast(`Arayüz başlatılamadı: ${error.message || error}`, { type: 'error', timeout: 8000 });
    }
  }

  function bindShell() {
    els.modeButtons.forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.mode));
    });
    els.openBtn.addEventListener('click', () => openActive());
    els.emptyOpenBtn.addEventListener('click', () => openActive());
    els.helpBtn.addEventListener('click', () => openHelp());
    els.engineBadge.addEventListener('click', () => openHelp());
    els.helpCloseX.addEventListener('click', () => closeHelp());
    els.helpCloseBtn.addEventListener('click', () => closeHelp());
    els.helpDialog.addEventListener('click', (event) => {
      if (event.target === els.helpDialog) closeHelp();
    });

    els.exportCloseX.addEventListener('click', () => {
      if (!appState.exportRunning) els.exportDialog.close();
    });
    els.cancelExportBtn.addEventListener('click', () => cancelCurrentExport());
    els.exportDoneClose.addEventListener('click', () => els.exportDialog.close());
    els.exportErrorClose.addEventListener('click', () => els.exportDialog.close());
    els.exportShowBtn.addEventListener('click', () => {
      if (appState.lastOutput) api.showItem(appState.lastOutput).catch(() => {});
    });
    els.exportOpenBtn.addEventListener('click', () => {
      if (appState.lastOutput) api.openPath(appState.lastOutput).catch(() => {});
    });
    els.exportDialog.addEventListener('cancel', (event) => {
      if (appState.exportRunning) {
        event.preventDefault();
        if (appState.exportKind === 'video' || appState.exportKind === 'gif') cancelCurrentExport();
      }
    });
    els.exportDialog.addEventListener('click', (event) => {
      if (event.target === els.exportDialog && !appState.exportRunning) {
        els.exportDialog.close();
      }
    });
    els.exportDialog.addEventListener('close', resetExportDialog);

    bindDragAndDrop();
    document.addEventListener('keydown', handleKeyDown);
  }

  function editorFor(mode) {
    if (mode === 'video') return videoEditor;
    if (mode === 'photo') return photoEditor;
    if (mode === 'gif') return gifEditor;
    if (mode === 'batch') return batchEditor;
    return null;
  }

  function modeName(mode) {
    if (mode === 'video') return 'Video';
    if (mode === 'photo') return 'Fotoğraf';
    if (mode === 'gif') return 'GIF';
    return 'Toplu';
  }

  function setMode(mode) {
    if (!['video', 'photo', 'gif', 'batch'].includes(mode)) return;
    if (appState.batchRunning && mode !== 'batch') {
      toast('Toplu işlem sürerken başka bir moda geçilemez. Önce bitmesini bekle veya iptal et.', {
        type: 'warn',
        timeout: 5000,
      });
      return;
    }
    if (appState.ready && appState.mode !== mode) {
      const previous = editorFor(appState.mode);
      try { previous?.cancelCrop?.(); } catch { /* ignore */ }
      try { previous?.pause?.(); } catch { /* ignore */ }
      clearToasts();
    }
    appState.mode = mode;
    els.modeButtons.forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    els.modeLabel.textContent = modeName(mode);
    document.title = `Odak Studio · ${t(modeName(mode))}`;
    updateEmptyCopy();
    renderMode();
  }

  function renderMode() {
    if (!appState.ready) return;
    const activeEditor = editorFor(appState.mode);
    const hasMedia = Boolean(activeEditor?.hasMedia());
    const openingHere = appState.openingKind === appState.mode;
    const showEditor = hasMedia || openingHere;
    els.emptyState.hidden = showEditor;
    els.videoEditor.hidden = !(appState.mode === 'video' && showEditor);
    els.photoEditor.hidden = !(appState.mode === 'photo' && showEditor);
    els.gifEditor.hidden = !(appState.mode === 'gif' && showEditor);
    els.batchEditor.hidden = !(appState.mode === 'batch' && showEditor);
  }

  function updateEmptyCopy() {
    const mode = appState.mode;
    if (mode === 'batch') {
      els.emptyTitle.innerHTML = t('Toplu işle, <em>zamandan</em><br>kazan.');
      els.emptyDescription.textContent = 'Videoları, fotoğrafları veya GIF kaynaklarını kuyruğa al; aynı ayarlarla sırayla işle. Hata olan dosya sonrakileri durdurmaz.';
      els.emptyFormats.textContent = 'MP4 · MOV · WEBM · JPG · PNG · WEBP · AVIF';
      els.emptyOpenLabel.textContent = 'Dosyaları seç';
      els.dropOverlayHint.textContent = 'Video veya fotoğraf bırak';
      return;
    }
    if (mode === 'gif') {
      els.emptyTitle.innerHTML = t('GIF’te <em>ritmi</em><br>yakala.');
      els.emptyDescription.textContent = 'Video ve fotoğrafları uç uca ekle; kırp, hızlandır, döngüye al. Her şey bu bilgisayarda hazırlanır.';
      els.emptyFormats.textContent = 'MP4 · MOV · WEBM · JPG · PNG · WEBP';
      els.emptyOpenLabel.textContent = 'Medya ekle';
      els.dropOverlayHint.textContent = 'Video veya fotoğraf bırak';
      return;
    }
    const isVideo = mode === 'video';
    els.emptyTitle.innerHTML = t(isVideo
      ? 'Videoda <em>kaliteyi</em><br>koru.'
      : 'Fotoğrafta <em>pikseli</em><br>koru.');
    els.emptyDescription.textContent = isVideo
      ? 'Kes, kırp, döndür; bit hızını ve çözünürlüğü sen kontrol et. Dosyan cihazından ayrılmaz.'
      : 'Döndür, kırp, boyutlandır. PNG veya WebP ile kayıpsız kal; hiçbir kare internete gitmez.';
    els.emptyFormats.textContent = isVideo
      ? 'MP4 · MOV · MKV · WEBM · M4V · AVI'
      : 'JPG · PNG · WEBP · AVIF · TIFF · GIF';
    els.emptyOpenLabel.textContent = isVideo ? 'Video seç' : 'Fotoğraf seç';
    els.dropOverlayHint.textContent = isVideo ? 'Bir video bırak' : 'Bir fotoğraf bırak';
  }

  async function openActive() {
    if (!appState.ready) return;
    if (appState.opening) {
      toast('Bir dosya zaten açılıyor.', { type: 'warn' });
      return;
    }
    if (appState.batchRunning) {
      toast('Toplu işlem sürerken yeni dosya eklenemez.', { type: 'warn' });
      return;
    }
    if (isDialogOpen()) return;
    let paths;
    try {
      const activeKind = appState.mode === 'batch' ? batchEditor?.kind : appState.mode;
      const kind = activeKind === 'video' ? 'video' : activeKind === 'photo' ? 'image' : 'media';
      paths = await api.openFiles({
        kind,
        multiple: appState.mode === 'gif' || appState.mode === 'batch',
      });
    } catch (error) {
      toast(error.message || 'Dosya seçilemedi.', { type: 'error' });
      return;
    }
    if (!paths || !paths[0]) return;
    if (appState.mode === 'gif') {
      await openGifFiles(paths);
      return;
    }
    if (appState.mode === 'batch') {
      await openBatchFiles(paths);
      return;
    }
    // Mod filtresi "Tüm dosyalar" ile delinebilir; türü uzantıdan/araştırmadan
    // belirle ki yanlış editörde açılmaya çalışılmasın.
    await routeFile(paths[0]);
  }

  async function openGifFiles(paths) {
    if (!appState.ready || !paths || !paths[0]) return;
    if (appState.opening) {
      toast('Bir dosya zaten açılıyor; bitmesini bekle.', { type: 'warn' });
      return;
    }
    if (appState.batchRunning) {
      toast('Toplu işlem sürerken GIF kuyruğu değiştirilemez.', { type: 'warn' });
      return;
    }
    if (isDialogOpen() || appState.exportRunning) return;
    appState.opening = true;
    appState.openingKind = 'gif';
    setMode('gif');
    renderMode();
    try {
      await gifEditor.addFiles(paths);
    } finally {
      appState.opening = false;
      appState.openingKind = null;
      renderMode();
    }
  }

  async function openBatchFiles(paths) {
    if (!appState.ready || !paths || !paths[0]) return;
    if (appState.opening) {
      toast('Bir dosya zaten açılıyor; bitmesini bekle.', { type: 'warn' });
      return;
    }
    if (appState.batchRunning) {
      toast('Toplu işlem sürerken kuyruğa dosya eklenemez.', { type: 'warn' });
      return;
    }
    if (isDialogOpen() || appState.exportRunning) return;
    appState.opening = true;
    appState.openingKind = 'batch';
    setMode('batch');
    renderMode();
    try {
      await batchEditor.addFiles(paths);
    } finally {
      appState.opening = false;
      appState.openingKind = null;
      renderMode();
    }
  }

  // Gezginde "Birlikte aç" ile seçilen dosya: açılışta verilen ve uygulama
  // açıkken gelenler aynı yoldan editöre yönlendirilir.
  function setupOpenWith() {
    try {
      api.onOpenFile((file) => routeFile(file));
      api.takeOpenFile().then((file) => { if (file) routeFile(file); }).catch(() => {});
    } catch {
      // Eski önyükleme betiği: özellik yok sayılır.
    }
  }

  async function routeFile(file, knownKind = null) {
    if (!appState.ready || !file) return;
    if (appState.opening) {
      toast('Bir dosya zaten açılıyor; bitmesini bekle.', { type: 'warn' });
      return;
    }
    if (appState.batchRunning) {
      toast('Toplu işlem sürerken yeni dosya açılamaz.', { type: 'warn' });
      return;
    }
    if (isDialogOpen() || appState.exportRunning) return;
    if (appState.mode === 'batch') {
      await openBatchFiles([file]);
      return;
    }
    if (appState.mode === 'gif') {
      await openGifFiles([file]);
      return;
    }

    let kind = knownKind;
    if (!kind) {
      kind = kindFromExtension(file);
      if (!kind) {
        try {
          const meta = await api.probe(file);
          kind = meta.kind === 'video' ? 'video' : 'photo';
        } catch (error) {
          toast(error.message || 'Dosya türü belirlenemedi.', { type: 'error' });
          return;
        }
      }
    }

    appState.opening = true;
    appState.openingKind = kind;
    setMode(kind);
    renderMode();
    try {
      const editor = kind === 'video' ? videoEditor : photoEditor;
      await editor.load(file);
    } finally {
      appState.opening = false;
      appState.openingKind = null;
      renderMode();
    }
  }

  function kindFromExtension(file) {
    const ext = fileNameExtension(file).replace(/^\./, '').toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (IMAGE_EXTENSIONS.has(ext)) return 'photo';
    return null;
  }

  // Tercihler (preferences) bölüm bölüm birleştirilir; sık değişen ayarlar
  // (kaydırıcılar vb.) diske kısa bir gecikmeyle toplu yazılır.
  let pendingConfig = {};
  const flushConfig = ui.debounce(() => {
    const patch = pendingConfig;
    pendingConfig = {};
    api.setConfig(patch).catch(() => {});
  }, 400);

  function handleConfigChange(patch) {
    if (!patch || typeof patch !== 'object') return;
    const { preferences, ...rest } = patch;
    Object.assign(appState.config, rest);
    Object.assign(pendingConfig, rest);
    if (preferences && typeof preferences === 'object') {
      appState.config.preferences = { ...(appState.config.preferences || {}), ...preferences };
      pendingConfig.preferences = { ...(pendingConfig.preferences || {}), ...preferences };
    }
    flushConfig();
  }

  // Pencere kapanırken bekleyen tercihleri gecikmesiz gönder.
  window.addEventListener('beforeunload', () => {
    if (!Object.keys(pendingConfig).length) return;
    flushConfig.cancel();
    api.setConfig(pendingConfig).catch(() => {});
    pendingConfig = {};
  });

  function updateEngineBadge() {
    const engine = appState.engine;
    els.engineBadge.classList.remove('ok', 'bad');
    if (engine?.available) {
      els.engineBadge.classList.add('ok');
      // Rozette yalnızca sürüm numarası: "8.1.2-essentials_build-www.gyan.dev" → "8.1.2".
      const short = String(engine.version || '').match(/^n?(\d+(?:\.\d+)*)/);
      els.engineText.textContent = short ? short[1] : (engine.version || 'hazır');
      els.engineBadge.title = `FFmpeg ${engine.version || ''} · hazır`;
    } else {
      els.engineBadge.classList.add('bad');
      els.engineText.textContent = 'bulunamadı';
      els.engineBadge.title = 'FFmpeg bulunamadı. Yardım için tıklayın.';
    }
  }

  function bindDragAndDrop() {
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (isDialogOpen() || appState.exportRunning || appState.batchRunning) return;
      dragDepth += 1;
      els.dropOverlay.hidden = false;
      els.dropOverlay.classList.remove('hidden');
    });
    window.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideDropOverlay();
    });
    window.addEventListener('dragend', hideDropOverlay);
    window.addEventListener('blur', hideDropOverlay);
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      hideDropOverlay();
      if (isDialogOpen() || appState.exportRunning || appState.batchRunning) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      const paths = [];
      for (const file of files) {
        try {
          const filePath = api.getPathForFile(file);
          if (filePath) paths.push(filePath);
        } catch {
          // A file without a local path is ignored; other dropped files can continue.
        }
      }
      if (!paths.length) {
        toast('Dosya yolu alınamadı. Dosyayı “Dosya aç” ile seçmeyi dene.', { type: 'error' });
        return;
      }
      if (appState.mode === 'gif') {
        openGifFiles(paths);
        return;
      }
      if (appState.mode === 'batch') {
        openBatchFiles(paths);
        return;
      }
      routeFile(paths[0], kindFromExtension(paths[0]));
    });
  }

  function hasFiles(event) {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes('Files');
  }

  function hideDropOverlay() {
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    els.dropOverlay.classList.add('hidden');
  }

  function isDialogOpen() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function handleKeyDown(event) {
    if (!appState.ready) return;
    if (isDialogOpen()) return;
    const target = event.target;
    const isForm = target instanceof Element && (
      target.matches('input, select, textarea') || target.isContentEditable
    );

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      openActive();
      return;
    }
    if (event.key === 'F1') {
      event.preventDefault();
      openHelp();
      return;
    }
    if (isForm) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && appState.mode === 'photo') {
      event.preventDefault();
      photoEditor?.undo();
      return;
    }
    // Videoda geri al (Ctrl+Z) ve yinele (Ctrl+Y veya Ctrl+Shift+Z).
    if ((event.ctrlKey || event.metaKey) && appState.mode === 'video' && videoEditor) {
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        videoEditor.undo();
        return;
      }
      if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        videoEditor.redo();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (appState.mode === 'batch' && batchEditor?.isRunning()) {
        batchEditor.cancel();
        return;
      }
      if (appState.mode === 'gif') {
        gifEditor?.clearPreview?.();
      } else {
        const active = editorFor(appState.mode);
        active?.cancelCrop?.();
      }
      return;
    }
    // Videoda giriş (I) / çıkış (O) noktası ve seçimi bölüm olarak ekleme (B).
    if (appState.mode === 'video' && videoEditor && !videoEditor.state.cropActive &&
      !event.ctrlKey && !event.metaKey && !event.altKey) {
      const key = event.key.toLocaleLowerCase('tr-TR');
      const action = { i: 'markIn', 'ı': 'markIn', o: 'markOut', b: 'addSegment' }[key];
      if (action) {
        event.preventDefault();
        videoEditor[action]();
        return;
      }
    }
    if (event.code === 'Space') {
      if (target instanceof Element && target.closest('button')) return;
      if (appState.mode === 'gif') {
        event.preventDefault();
        gifEditor?.togglePlay?.();
        return;
      }
      if (appState.mode !== 'video' || !videoEditor) return;
      if (videoEditor.state.cropActive) return;
      event.preventDefault();
      videoEditor.togglePlay();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (appState.mode === 'gif') {
        event.preventDefault();
        gifEditor?.stepSelection?.(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (appState.mode !== 'video' || !videoEditor) return;
      if (videoEditor.state.cropActive) return;
      event.preventDefault();
      videoEditor.stepFrame(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }

  async function openHelp() {
    if (appState.exportRunning || appState.batchRunning) return;
    fillHelp();
    if (!els.helpDialog.open) els.helpDialog.showModal();
    try {
      const about = appState.about || await api.about();
      appState.about = about;
      els.helpElectron.textContent = about.electron
        ? `${about.electron} · Chromium ${about.chromium}`
        : '—';
      els.helpVersion.textContent = about.version || appState.system?.appVersion || '1.0.0';
    } catch {
      // System information is informational only.
    }
  }

  function fillHelp() {
    const engine = appState.engine;
    if (engine?.available) {
      els.helpFfmpeg.textContent = engine.version || 'hazır';
      const hardware = appState.hardware;
      const vendors = [...new Set([...(hardware?.h264 || []), ...(hardware?.h265 || [])])]
        .map((vendor) => hardware.labels?.[vendor] || vendor);
      const gpu = vendors.length ? ` · Ekran kartı: ${vendors.join(', ')}` : ' · Ekran kartı kodlayıcısı yok';
      els.helpFfmpegHint.textContent = `Yerel FFmpeg: ${engine.ffmpeg}${gpu}`;
    } else {
      els.helpFfmpeg.textContent = 'Bulunamadı';
      els.helpFfmpegHint.textContent = 'FFmpeg bulunamadı. Video ve GIF işlemleri çalışmaz; fotoğraf düzenleme kullanılabilir.';
    }
    els.helpVersion.textContent = appState.system?.appVersion || '1.0.0';
    els.helpElectron.textContent = '—';
  }

  // ── Güncellemeler ──
  // Ana süreç yeni sürümü arka planda indirir; hazır olunca kullanıcıya
  // yeniden başlatma seçeneği sunulur. Kapatırken de kendiliğinden kurulur.
  function updateStatusText(status) {
    switch (status?.state) {
      case 'checking': return 'Denetleniyor…';
      case 'available': return `Yeni sürüm ${status.version} indiriliyor`;
      case 'downloading': return `Sürüm ${status.version || ''} indiriliyor · %${status.percent || 0}`.replace('  ', ' ');
      case 'downloaded': return `Sürüm ${status.version} hazır · yeniden başlatınca kurulur`;
      case 'none': return 'Güncel';
      case 'offline': return 'Çevrimdışı · internet gelince kendiliğinden denetlenir';
      case 'error': return 'Denetlenemedi · daha sonra yeniden denenecek';
      case 'idle': return 'Bekleniyor';
      default: return 'Geliştirme sürümünde kapalı';
    }
  }

  function renderUpdateStatus(status) {
    appState.update = status || { state: 'disabled' };
    const label = document.getElementById('helpUpdateStatus');
    const button = document.getElementById('helpUpdateBtn');
    if (label) label.textContent = updateStatusText(appState.update);
    if (!button) return;
    const state = appState.update.state;
    button.hidden = state === 'disabled';
    button.disabled = ['checking', 'available', 'downloading'].includes(state);
    button.textContent = state === 'downloaded' ? 'Yeniden başlat ve güncelle' : 'Güncellemeleri denetle';
  }

  function installUpdate() {
    if (appState.exportRunning || appState.batchRunning) {
      toast('Güncelleme için önce süren işlemin bitmesini bekle.', { type: 'warn' });
      return;
    }
    api.installUpdate().catch(() => {});
  }

  function setupUpdates() {
    document.getElementById('helpLogBtn')?.addEventListener('click', () => {
      api.openLog().then((opened) => {
        // Varsayılan metin düzenleyicisi yoksa dosya klasörde gösterilir.
        if (!opened) api.showLog().catch(() => {});
      }).catch(() => {});
    });
    document.getElementById('helpLicensesBtn')?.addEventListener('click', () => api.openLicenses().catch(() => {}));
    document.getElementById('helpWebsiteBtn')?.addEventListener('click', () => api.openWebsite().catch(() => {}));
    const button = document.getElementById('helpUpdateBtn');
    button?.addEventListener('click', () => {
      if (appState.update?.state === 'downloaded') installUpdate();
      else api.checkForUpdates().then(renderUpdateStatus).catch(() => {});
    });
    api.updateStatus().then(renderUpdateStatus).catch(() => renderUpdateStatus(null));
    api.onUpdateStatus((status) => {
      const previous = appState.update?.state;
      renderUpdateStatus(status);
      if (status.state === 'downloaded' && previous !== 'downloaded') {
        toast(`Odak Studio ${status.version} hazır. Kapatınca kurulur.`, {
          type: 'success',
          timeout: 0,
          action: { label: 'Şimdi yeniden başlat', onClick: installUpdate },
        });
      }
    });
  }

  // Dil seçimi kaydedilir ve arayüz yeniden yüklenir: tüm metinler (statik
  // HTML dahil) baştan, seçilen dilde kurulur.
  function setupLanguagePicker() {
    const select = document.getElementById('helpLanguage');
    if (!select) return;
    select.textContent = '';
    for (const language of i18n.LANGUAGES) {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = language.name;
      option.dataset.i18nSkip = '';
      select.appendChild(option);
    }
    select.value = i18n.getLanguage();
    select.addEventListener('change', () => switchLanguage(select.value));
    // Kenar çubuğundaki düğme diğer dile geçer; adı o dilin kendi adıdır.
    const button = document.getElementById('languageBtn');
    const other = i18n.LANGUAGES.find((language) => language.code !== i18n.getLanguage());
    if (button && other) {
      document.getElementById('languageBtnText').textContent = other.name;
      button.addEventListener('click', () => switchLanguage(other.code));
    }
  }

  async function switchLanguage(language) {
    if (appState.exportRunning || appState.batchRunning) {
      toast('Dil, işlem bitince değiştirilebilir.', { type: 'warn' });
      return;
    }
    const preferences = { ...(appState.config.preferences || {}), ui: { ...(appState.config.preferences?.ui || {}), language } };
    appState.config.preferences = preferences;
    try {
      await api.setConfig({ preferences: { ui: preferences.ui } });
    } finally {
      api.reload().catch(() => {});
    }
  }

  function closeHelp() {
    if (els.helpDialog.open) els.helpDialog.close();
  }

  function beginVideoExport(payload) {
    if (!payload || appState.exportRunning || appState.batchRunning) return;
    appState.exportRunning = true;
    appState.exportKind = 'video';
    appState.exportJobId = payload.jobId || null;
    appState.exportCanceling = false;
    appState.lastOutput = null;
    openExportDialog('video', payload);
    api.exportVideo(payload)
      .then(handleExportSuccess)
      .catch(handleExportFailure);
  }

  function beginPhotoExport(payload) {
    if (!payload || appState.exportRunning || appState.batchRunning) return;
    appState.exportRunning = true;
    appState.exportKind = 'photo';
    appState.exportJobId = null;
    appState.exportCanceling = false;
    appState.lastOutput = null;
    openExportDialog('photo', payload);
    api.photoExport({
      path: payload.path,
      ops: payload.ops,
      options: payload.options,
      outputDir: payload.outputDir,
      baseName: payload.baseName,
    })
      .then(handleExportSuccess)
      .catch(handleExportFailure);
  }

  function beginGifExport(payload) {
    if (!payload || appState.exportRunning || appState.batchRunning) return;
    appState.exportRunning = true;
    appState.exportKind = 'gif';
    appState.exportJobId = payload.jobId || null;
    appState.exportCanceling = false;
    appState.lastOutput = null;
    openExportDialog('gif', payload);
    api.exportGif(payload)
      .then(handleExportSuccess)
      .catch(handleExportFailure);
  }

  function openExportDialog(kind, payload) {
    const display = payload.display || {};
    const isPhoto = kind === 'photo';
    const isGif = kind === 'gif';
    setExportStep('running');
    setExportEyebrow(isPhoto ? 'FOTOĞRAF DIŞA AKTARILIYOR' : isGif ? 'GIF OLUŞTURULUYOR' : 'VİDEO DIŞA AKTARILIYOR');
    els.exportTitle.textContent = isPhoto ? 'Fotoğraf işleniyor' : isGif ? 'GIF hazırlanıyor' : 'Video hazırlanıyor';
    els.exportBar.classList.toggle('indeterminate', isPhoto);
    els.exportBar.style.width = isPhoto ? '' : '0%';
    els.exportPercent.textContent = isPhoto ? '—' : '%0';
    els.exportStats.textContent = isPhoto ? 'Görsel işleniyor…' : isGif ? 'Kareler işleniyor…' : 'Başlıyor…';
    els.exportDetail.textContent = buildExportDetail(display);
    els.exportCloseX.disabled = true;
    els.cancelExportBtn.disabled = isPhoto;
    els.cancelExportBtn.textContent = isPhoto ? 'İptal edilemez' : 'İptal et';
    if (!els.exportDialog.open) els.exportDialog.showModal();
  }

  function buildExportDetail(display) {
    const firstLine = [display.summary, display.outNote].filter(Boolean).join(' · ');
    const file = display.fileName || '—';
    const folder = display.folder ? shortenPath(display.folder, 48) : '';
    return `${firstLine}${firstLine ? '\n' : ''}${file}${folder ? ` · ${folder}` : ''}`;
  }

  function handleJobProgress(data) {
    if (!appState.exportRunning || !['video', 'gif'].includes(appState.exportKind)) return;
    if (!appState.exportJobId || data.jobId !== appState.exportJobId) return;
    if (appState.exportCanceling) return;
    const percent = Math.max(0, Math.min(100, Number(data.percent) || 0));
    els.exportBar.classList.remove('indeterminate');
    els.exportBar.style.width = `${percent}%`;
    els.exportPercent.textContent = data.done ? 'Tamam' : `%${Math.round(percent)}`;
    const stats = [];
    // Hedef boyut modu iki (gerekirse üç) geçişte çalışır.
    if (data.pass === 1) stats.push('1/2 analiz');
    else if (data.pass === 2) stats.push('2/2 kodlama');
    else if (data.pass === 3) stats.push('boyut düzeltmesi');
    if (Number(data.speed) > 0) stats.push(`${Number(data.speed).toFixed(2)}×`);
    if (Number(data.fps) > 0) stats.push(`${Math.round(Number(data.fps))} fps`);
    if (Number(data.outSeconds) > 0) stats.push(formatTimecode(Number(data.outSeconds)));
    if (Number(data.etaSeconds) > 0.7) stats.push(`kalan ~${formatDuration(Number(data.etaSeconds))}`);
    els.exportStats.textContent = stats.join(' · ') || 'İşleniyor…';
  }

  async function cancelCurrentExport() {
    if (!appState.exportRunning) return;
    if (!['video', 'gif'].includes(appState.exportKind) || !appState.exportJobId) {
      toast('Fotoğraf işlemi tamamlanmak üzere; iptal edilemiyor.', { type: 'warn' });
      return;
    }
    appState.exportCanceling = true;
    els.cancelExportBtn.disabled = true;
    els.cancelExportBtn.textContent = 'İptal ediliyor…';
    els.exportStats.textContent = 'FFmpeg durduruluyor…';
    try {
      await api.cancelJob(appState.exportJobId);
    } catch {
      // The job may already have finished.
    }
  }

  function handleExportSuccess(result) {
    if (result && result.ok === false) {
      const error = new Error(result.message || 'Dışa aktarma tamamlanamadı.');
      if (result.details) error.details = result.details;
      if (result.canceled) appState.exportCanceling = true;
      handleExportFailure(error);
      return;
    }
    if (!result) {
      handleExportFailure(new Error('Dışa aktarma sonucu alınamadı.'));
      return;
    }
    const wasPhoto = appState.exportKind === 'photo';
    const wasGif = appState.exportKind === 'gif';
    appState.exportRunning = false;
    appState.lastOutput = result.path || null;
    els.exportCloseX.disabled = false;
    els.cancelExportBtn.disabled = true;
    els.exportBar.classList.remove('indeterminate');
    els.exportBar.style.width = '100%';
    els.exportPercent.textContent = 'Tamam';
    els.exportStats.textContent = 'Dosya kaydedildi';
    setExportStep('done');
    els.exportDoneTitle.textContent = wasPhoto ? 'Fotoğraf kaydedildi' : wasGif ? 'GIF hazır' : 'Video hazır';
    els.exportDoneDesc.textContent = result.path || 'Dosya kaydedildi.';
    els.exportShowBtn.disabled = !result.path;
    els.exportOpenBtn.disabled = !result.path;
    els.exportDoneMeta.textContent = '';
    const meta = [];
    if (result.targetBytes) {
      // Hedef ondalık MB ile girildiği için sonuç da aynı birimle gösterilir.
      const mb = (bytes) => window.OdakUI.formatNumber(bytes / 1e6, { maximumFractionDigits: 2 });
      meta.push(`${mb(result.size)} MB · hedef ${mb(result.targetBytes)} MB`);
    } else if (result.size) {
      meta.push(formatBytes(result.size));
    }
    if (result.overTarget) {
      toast('Çıktı hedef boyutu biraz aştı. Biraz daha küçük bir hedefle tekrar deneyebilirsin.', { type: 'warn', timeout: 7000 });
    }
    if (result.width && result.height) meta.push(formatResolution(result.width, result.height));
    if (result.duration) meta.push(formatTimecode(result.duration));
    if (wasGif && result.frames) meta.push(`${result.frames} kare`);
    if (result.bitrate) meta.push(formatBitrate(result.bitrate));
    if (result.elapsedMs) meta.push(`${(result.elapsedMs / 1000).toFixed(1)} sn`);
    if (result.smartCut) meta.push('Akıllı kesim');
    else if (result.copied) meta.push(wasPhoto ? 'Birebir kopya' : 'Video kopyası');
    for (const text of meta) {
      const span = document.createElement('span');
      span.textContent = text;
      els.exportDoneMeta.appendChild(span);
    }
  }

  function handleExportFailure(error) {
    const canceled = appState.exportCanceling;
    appState.exportRunning = false;
    appState.exportCanceling = false;
    appState.exportJobId = null;
    els.exportCloseX.disabled = false;
    els.cancelExportBtn.disabled = true;
    els.exportBar.classList.remove('indeterminate');
    setExportStep('error');
    if (canceled) setExportEyebrow('İPTAL EDİLDİ');
    els.exportErrorTitle.textContent = canceled ? 'İşlem iptal edildi' : 'Dışa aktarma tamamlanamadı';
    els.exportErrorMessage.textContent = canceled
      ? 'Dışa aktarma iptal edildi; yarım kalan dosya temizlendi.'
      : (error?.message || 'Bilinmeyen bir hata oluştu.');
    const details = !canceled && (error?.details || error?.stack);
    els.exportErrorDetails.textContent = details || '';
    els.exportErrorDetails.hidden = !details;
    els.exportErrorDetails.classList.toggle('hidden', !details);
  }

  // Bitince başlık "hazırlanıyor" demeye devam etmesin: üst başlık yalnızca
  // işlem sürerken görünür, sonuçta altındaki başlık tek başına kalır.
  function setExportStep(step) {
    els.exportTitle.hidden = step !== 'running';
    if (step === 'done') setExportEyebrow('TAMAMLANDI');
    else if (step === 'error') setExportEyebrow(appState.exportCanceling ? 'İPTAL EDİLDİ' : 'HATA');
    els.exportRunning.hidden = step !== 'running';
    els.exportDone.hidden = step !== 'done';
    els.exportError.hidden = step !== 'error';
  }

  function setExportEyebrow(text) {
    els.exportEyebrow.textContent = '';
    const line = document.createElement('span');
    els.exportEyebrow.appendChild(line);
    els.exportEyebrow.appendChild(document.createTextNode(text));
  }

  function resetExportDialog() {
    appState.exportRunning = false;
    appState.exportJobId = null;
    appState.exportKind = null;
    appState.exportCanceling = false;
    appState.lastOutput = null;
    els.exportCloseX.disabled = false;
    els.cancelExportBtn.disabled = false;
    els.cancelExportBtn.textContent = 'İptal et';
    els.exportErrorDetails.hidden = true;
    els.exportErrorDetails.textContent = '';
  }
})();
