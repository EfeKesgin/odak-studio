'use strict';

(function () {
  const ui = window.OdakUI;
  const {
    clamp, even, formatBytes, formatResolution, fileStem, shortenPath, setIcon, toast, parseNumber, clearToasts,
  } = ui;

  const FORMAT_LABELS = {
    jpeg: 'JPEG',
    jpg: 'JPEG',
    png: 'PNG',
    webp: 'WebP',
    avif: 'AVIF',
    tiff: 'TIFF',
    tif: 'TIFF',
    gif: 'GIF',
  };

  const ENCODABLE_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'tiff']);

  function normalizeFormat(format) {
    const value = String(format || '').toLowerCase();
    if (value === 'jpg') return 'jpeg';
    if (value === 'tif') return 'tiff';
    return value;
  }

  function formatLabel(format) {
    const normalized = normalizeFormat(format);
    return FORMAT_LABELS[normalized] || String(format || 'Görsel').toUpperCase();
  }

  function sanitizeClientName(value, fallback = 'odak-fotograf') {
    return window.OdakUI.sanitizeBaseName(value, fallback);
  }

  class PhotoEditor {
    constructor({ api, config, onConfigChange, onExportRequest } = {}) {
      this.api = api;
      this.appConfig = config || {};
      this.onConfigChange = onConfigChange;
      this.onExportRequest = onExportRequest;
      this.loadToken = 0;
      this.workingTimer = null;
      this.cropOverlay = new window.CropOverlay({
        overlay: document.getElementById('photoCropOverlay'),
        box: document.getElementById('photoCropBox'),
        sizeLabel: document.getElementById('photoCropSize'),
      });
      this.els = {
        editor: document.getElementById('photoEditor'),
        fileName: document.getElementById('photoFileName'),
        metaChips: document.getElementById('photoMetaChips'),
        replaceBtn: document.getElementById('photoReplaceBtn'),
        stage: document.getElementById('photoStage'),
        frame: document.getElementById('photoFrame'),
        img: document.getElementById('photoImg'),
        stageBadge: document.getElementById('photoStageBadge'),
        loading: document.getElementById('photoLoading'),
        cropBar: document.getElementById('photoCropBar'),
        cropDims: document.getElementById('photoCropDims'),
        cropApply: document.getElementById('photoCropApply'),
        cropCancel: document.getElementById('photoCropCancel'),
        ratioPills: document.getElementById('photoRatioPills'),
        undo: document.getElementById('photoUndo'),
        reset: document.getElementById('photoReset'),
        rotateLeft: document.getElementById('photoRotateLeft'),
        rotateRight: document.getElementById('photoRotateRight'),
        flipH: document.getElementById('photoFlipH'),
        flipV: document.getElementById('photoFlipV'),
        cropBtn: document.getElementById('photoCropBtn'),
        cropState: document.getElementById('photoCropState'),
        resizeW: document.getElementById('photoResizeW'),
        resizeH: document.getElementById('photoResizeH'),
        resizeLock: document.getElementById('photoResizeLock'),
        resizeApply: document.getElementById('photoResizeApply'),
        scaleChips: document.getElementById('photoScaleChips'),
        format: document.getElementById('photoFormat'),
        qualityField: document.getElementById('photoQualityField'),
        quality: document.getElementById('photoQuality'),
        keepMeta: document.getElementById('photoKeepMeta'),
        baseName: document.getElementById('photoBaseName'),
        ext: document.getElementById('photoExt'),
        folderBtn: document.getElementById('photoFolderBtn'),
        folderPath: document.getElementById('photoFolderPath'),
        summary: document.getElementById('photoSummary'),
        outNote: document.getElementById('photoOutNote'),
        exportBtn: document.getElementById('photoExportBtn'),
        historyCount: document.getElementById('photoHistoryCount'),
        textSection: document.getElementById('photoTextSection'),
        inspectorScroll: document.querySelector('#photoEditor .inspector-scroll'),
      };
      this.state = this.freshState();
      // Metin, tüm dönüştürmelerden sonra son görüntünün üzerine çizilir.
      this.textEditor = new window.TextLayerEditor({
        host: this.els.textSection,
        frame: this.els.frame,
        onChange: (layers) => {
          this.state.textLayers = layers;
          this.renderSummary();
        },
        emptyHint: 'Fotoğrafa yazı, başlık veya filigran ekle. Metin tüm düzenlemelerden sonra uygulanır.',
      });
      this.bind();
      this.resizeObserver = new ResizeObserver(() => this.layoutFrame());
      this.resizeObserver.observe(this.els.stage);
      this.renderAll();
    }

    freshState() {
      return {
        file: null,
        meta: null,
        loaded: false,
        ops: [],
        textLayers: [],
        revision: 0,
        previewRunning: false,
        previewDirty: false,
        fullWidth: 0,
        fullHeight: 0,
        previewWidth: 0,
        previewHeight: 0,
        previewUrl: '',
        hasAlpha: false,
        cropActive: false,
        cropRatio: null,
        outputDir: this.appConfig.photoOutputDir || '',
        baseName: '',
        format: 'original',
        quality: 'max',
        keepMetadata: true,
        aspectLocked: true,
      };
    }

    hasMedia() {
      return Boolean(this.state.loaded && this.state.meta);
    }

    bind() {
      const els = this.els;
      els.replaceBtn.addEventListener('click', () => this.openPhoto());
      els.rotateLeft.addEventListener('click', () => this.rotate(-90));
      els.rotateRight.addEventListener('click', () => this.rotate(90));
      els.flipH.addEventListener('click', () => this.flip('h'));
      els.flipV.addEventListener('click', () => this.flip('v'));
      els.undo.addEventListener('click', () => this.undo());
      els.reset.addEventListener('click', () => this.resetEdits());
      els.cropBtn.addEventListener('click', () => this.openCrop());
      els.cropApply.addEventListener('click', () => this.applyCrop());
      els.cropCancel.addEventListener('click', () => this.cancelCrop());
      els.ratioPills.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-ratio]');
        if (!button) return;
        this.setCropRatio(button.dataset.ratio);
      });

      els.resizeW.addEventListener('input', () => this.onResizeInput('width'));
      els.resizeH.addEventListener('input', () => this.onResizeInput('height'));
      els.resizeW.addEventListener('change', () => this.normalizeResizeInputs());
      els.resizeH.addEventListener('change', () => this.normalizeResizeInputs());
      els.resizeW.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.applyResize(); });
      els.resizeH.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.applyResize(); });
      els.resizeLock.addEventListener('click', () => this.toggleAspectLock());
      els.resizeApply.addEventListener('click', () => this.applyResize());
      els.scaleChips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-scale]');
        if (!button) return;
        this.setScaleFields(Number(button.dataset.scale));
      });

      els.format.addEventListener('change', () => {
        this.state.format = els.format.value;
        this.rememberOutputSettings();
        this.renderFormat();
        this.renderOutput();
        this.renderSummary();
      });
      els.quality.addEventListener('change', () => {
        this.state.quality = els.quality.value;
        this.rememberOutputSettings();
        this.renderSummary();
      });
      els.keepMeta.addEventListener('click', () => {
        this.state.keepMetadata = !this.state.keepMetadata;
        this.rememberOutputSettings();
        this.renderFormat();
        this.renderSummary();
      });

      els.baseName.addEventListener('input', () => {
        this.state.baseName = els.baseName.value;
        this.renderOutput();
      });
      els.folderBtn.addEventListener('click', () => this.chooseFolder());
      els.exportBtn.addEventListener('click', () => this.export());

      els.img.addEventListener('load', () => this.layoutFrame());
      this.els.img.addEventListener('error', () => {
        if (!this.state.loaded) return;
        toast('Önizleme görüntüsü yüklenemedi.', { type: 'error' });
      });
    }

    rememberOutputSettings() {
      const { format, quality, keepMetadata } = this.state;
      this.onConfigChange?.({ preferences: { photo: { format, quality, keepMetadata } } });
    }

    async openPhoto() {
      const paths = await this.api.openFiles({ kind: 'image' });
      if (paths && paths[0]) await this.load(paths[0]);
    }

    async load(file) {
      if (!file) return false;
      clearToasts();
      const token = ++this.loadToken;
      this.beginWorking(true);
      let meta;
      let preview;
      try {
        meta = await this.api.probe(file);
        if (token !== this.loadToken) return false;
        if (meta.kind !== 'image') throw new Error('Bu dosya bir fotoğraf değil.');
        preview = await this.api.photoPreview({ path: file, ops: [] });
        if (token !== this.loadToken) return false;
      } catch (error) {
        if (token === this.loadToken) {
          this.endWorking();
          toast(error.message || 'Fotoğraf açılamadı.', { type: 'error' });
        }
        return false;
      }

      const previousDir = this.state.outputDir || this.appConfig.photoOutputDir || '';
      this.state = this.freshState();
      this.state.outputDir = previousDir;
      this.state.file = file;
      this.state.meta = meta;
      this.state.loaded = true;
      this.state.baseName = `${fileStem(meta.name)}-odak`;
      // Son kullanılan biçim/kalite yeni fotoğrafa da uygulanır.
      const remembered = this.appConfig.preferences?.photo || {};
      this.state.format = ['original', ...ENCODABLE_FORMATS].includes(remembered.format) ? remembered.format : 'original';
      this.state.quality = ['max', 'high', 'balanced'].includes(remembered.quality) ? remembered.quality : 'max';
      this.state.keepMetadata = remembered.keepMetadata !== false;
      this.state.revision = 0;
      this.cropOverlay.close();
      this.els.cropBar.hidden = true;
      this.els.cropBar.classList.add('hidden');
      this.els.cropBtn.classList.remove('active');
      this.textEditor.setLayers([]);
      this.textEditor.setHidden(false);
      this.applyPreview(preview);
      this.els.inspectorScroll.scrollTop = 0;
      this.endWorking();
      if (meta.isAnimated) {
        toast('Animasyonlu görselde yalnızca ilk kare düzenlenir ve düzenleme çıktısı hareketsiz olur.', {
          type: 'warn',
          timeout: 6500,
        });
      }
      requestAnimationFrame(() => this.layoutFrame());
      return true;
    }

    applyPreview(result) {
      if (!result) return;
      this.state.previewUrl = result.dataUrl;
      this.state.fullWidth = Math.max(1, Number(result.fullWidth) || this.state.fullWidth);
      this.state.fullHeight = Math.max(1, Number(result.fullHeight) || this.state.fullHeight);
      this.state.previewWidth = Number(result.previewWidth) || 0;
      this.state.previewHeight = Number(result.previewHeight) || 0;
      this.state.hasAlpha = Boolean(result.hasAlpha);
      this.els.img.src = result.dataUrl;
      this.renderAll();
      requestAnimationFrame(() => this.layoutFrame());
    }

    beginWorking(immediate = false) {
      clearTimeout(this.workingTimer);
      if (immediate) {
        this.showWorking(true);
      } else {
        this.workingTimer = setTimeout(() => this.showWorking(true), 180);
      }
    }

    showWorking(show) {
      this.els.loading.hidden = !show;
      this.els.loading.classList.toggle('hidden', !show);
    }

    endWorking() {
      clearTimeout(this.workingTimer);
      this.showWorking(false);
    }

    queuePreview() {
      if (!this.state.loaded || !this.state.meta) return;
      this.state.revision += 1;
      this.state.previewDirty = true;
      if (this.state.previewRunning) return;
      this.runPreviewQueue();
    }

    async runPreviewQueue() {
      // Kuyruk, başladığı duruma (state) bağlıdır. Bu sırada yeni bir dosya
      // açılırsa eski kuyruk yeni durumun bayraklarını değiştirmemelidir.
      const state = this.state;
      if (state.previewRunning) return;
      state.previewRunning = true;
      this.beginWorking(false);
      while (state.previewDirty) {
        state.previewDirty = false;
        const revision = state.revision;
        const ops = state.ops.map((op) => ({ ...op }));
        let result;
        try {
          result = await this.api.photoPreview({ path: state.file, ops });
        } catch (error) {
          if (this.state !== state) return;
          if (revision === state.revision) {
            toast(error.message || 'Önizleme oluşturulamadı.', { type: 'error' });
            break;
          }
          // Daha yeni bir istek kuyrukta; bu hatayı yut ve devam et.
          continue;
        }
        if (this.state !== state) return;
        if (revision !== state.revision) continue;
        this.applyPreview(result);
      }
      state.previewRunning = false;
      if (this.state === state) this.endWorking();
    }

    layoutFrame() {
      const meta = this.state.meta;
      if (!meta) return;
      const rect = this.els.stage.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      const width = this.state.fullWidth || meta.width;
      const height = this.state.fullHeight || meta.height;
      if (!width || !height) return;
      const padX = Math.min(64, Math.max(30, rect.width * 0.055));
      const padY = Math.min(48, Math.max(22, rect.height * 0.065));
      const availW = Math.max(40, rect.width - padX);
      const availH = Math.max(40, rect.height - padY);
      const scale = Math.min(availW / width, availH / height);
      const frameW = Math.max(30, width * scale);
      const frameH = Math.max(30, height * scale);
      this.els.frame.style.width = `${frameW}px`;
      this.els.frame.style.height = `${frameH}px`;
      if (this.state.cropActive) {
        this.cropOverlay.setSourceSize(width, height);
        this.updateCropReadout(this.cropOverlay.getRect(), { width, height });
      }
    }

    renderAll() {
      const meta = this.state.meta;
      if (!meta) {
        this.els.exportBtn.disabled = true;
        return;
      }
      this.renderMeta();
      this.renderHistory();
      this.renderCropState();
      this.renderResize();
      this.renderFormat();
      this.renderOutput();
      this.renderSummary();
      this.els.exportBtn.disabled = !this.state.loaded;
      requestAnimationFrame(() => this.layoutFrame());
    }

    renderMeta() {
      const meta = this.state.meta;
      if (!meta) return;
      this.els.fileName.textContent = meta.name;
      this.els.fileName.title = meta.name;
      const chips = [
        formatLabel(meta.format || meta.ext),
        formatResolution(this.state.fullWidth || meta.width, this.state.fullHeight || meta.height),
        formatBytes(meta.size),
      ];
      if (meta.bitDepth > 8) chips.push(`${meta.bitDepth}-bit`);
      if (this.state.hasAlpha || meta.hasAlpha) chips.push('Saydamlık');
      if (meta.isAnimated) chips.push('Animasyon');
      this.els.metaChips.textContent = '';
      for (const text of chips) {
        const span = document.createElement('span');
        span.textContent = text;
        this.els.metaChips.appendChild(span);
      }
      this.els.stageBadge.textContent = `${formatResolution(this.state.fullWidth, this.state.fullHeight)} · ${formatLabel(meta.format || meta.ext)}`;
      this.els.stageBadge.title = meta.name;
    }

    renderHistory() {
      const count = this.state.ops.length;
      this.els.historyCount.textContent = count ? `${count} işlem` : 'Orijinal';
      this.els.undo.disabled = !this.state.loaded || count === 0;
      this.els.reset.disabled = !this.state.loaded || count === 0;
    }

    renderCropState() {
      const cropExists = this.state.ops.some((op) => op.type === 'crop');
      this.els.cropBtn.classList.toggle('active', this.state.cropActive);
      if (this.state.cropActive) this.els.cropState.textContent = 'Kırpma modu';
      else this.els.cropState.textContent = cropExists ? 'Kırpıldı' : 'Tam kare';
      this.els.cropBtn.title = cropExists ? 'Yeniden kırp' : 'Kırp';
    }

    renderResize() {
      const width = this.state.fullWidth;
      const height = this.state.fullHeight;
      if (!width || !height) return;
      if (document.activeElement !== this.els.resizeW) this.els.resizeW.value = width;
      if (document.activeElement !== this.els.resizeH) this.els.resizeH.value = height;
      this.els.resizeLock.classList.toggle('active', this.state.aspectLocked);
      this.els.resizeLock.setAttribute('aria-pressed', String(this.state.aspectLocked));
      setIcon(this.els.resizeLock.querySelector('svg'), this.state.aspectLocked ? 'lock' : 'unlock');
      this.updateResizeApply();
    }

    updateResizeApply() {
      const width = Math.round(parseNumber(this.els.resizeW.value, 0));
      const height = Math.round(parseNumber(this.els.resizeH.value, 0));
      const valid = width >= 1 && height >= 1 && width <= 32000 && height <= 32000;
      const changed = width !== Math.round(this.state.fullWidth) || height !== Math.round(this.state.fullHeight);
      this.els.resizeApply.disabled = !this.state.loaded || !valid || !changed;
      const baseW = this.state.fullWidth || 1;
      const baseH = this.state.fullHeight || 1;
      this.els.scaleChips.querySelectorAll('button[data-scale]').forEach((button) => {
        const factor = Number(button.dataset.scale);
        const expectedW = Math.max(1, Math.round(baseW * factor));
        const expectedH = Math.max(1, Math.round(baseH * factor));
        button.classList.toggle('active', Math.abs(width - expectedW) <= 2 && Math.abs(height - expectedH) <= 2);
      });
    }

    renderFormat() {
      const meta = this.state.meta;
      if (!meta) return;
      this.els.format.value = this.state.format;
      this.els.quality.value = this.state.quality;
      const target = this.targetFormat();
      const losslessOnly = target === 'png' || target === 'tiff';
      this.els.quality.disabled = losslessOnly;
      this.els.qualityField.classList.toggle('is-disabled', losslessOnly);
      this.els.keepMeta.classList.toggle('on', this.state.keepMetadata);
      this.els.keepMeta.setAttribute('aria-checked', String(this.state.keepMetadata));
    }

    renderOutput() {
      const meta = this.state.meta;
      if (!meta) return;
      if (document.activeElement !== this.els.baseName) {
        this.els.baseName.value = this.state.baseName;
      }
      this.els.ext.textContent = this.outputExt();
      this.els.folderPath.textContent = this.state.outputDir ? shortenPath(this.state.outputDir, 42) : 'Klasör seç';
      this.els.folderPath.title = this.state.outputDir || '';
      this.els.folderBtn.title = this.state.outputDir || 'Çıktı klasörü seç';
    }

    targetFormat() {
      const meta = this.state.meta;
      if (!meta) return 'png';
      return this.state.format === 'original'
        ? normalizeFormat(meta.format || meta.ext)
        : normalizeFormat(this.state.format);
    }

    outputExt() {
      const meta = this.state.meta;
      if (!meta) return '.png';
      const target = this.targetFormat();
      const map = {
        jpeg: '.jpg',
        png: '.png',
        webp: '.webp',
        avif: '.avif',
        tiff: '.tif',
      };
      if (map[target]) return map[target];
      return `.${String(meta.ext || 'png').replace(/^\./, '')}`;
    }

    copyEligible() {
      return this.state.format === 'original' && this.state.ops.length === 0 && this.state.keepMetadata &&
        !this.state.textLayers.length;
    }

    qualityNote() {
      const target = this.targetFormat();
      if (this.copyEligible()) return 'birebir kopya';
      const deep = Number(this.state.meta && this.state.meta.bitDepth) > 8;
      if (target === 'png') return deep ? 'kayıpsız PNG · 16-bit' : 'kayıpsız PNG';
      if (target === 'tiff') return deep ? 'kayıpsız TIFF · 16-bit' : 'kayıpsız TIFF';
      if (target === 'webp') {
        const base = this.state.quality === 'max' ? 'kayıpsız WebP' : `WebP ${this.state.quality}`;
        return deep ? `${base} · 8-bit` : base;
      }
      if (target === 'jpeg') {
        const base = this.state.quality === 'max' ? 'q100 · 4:4:4' : `JPEG ${this.state.quality}`;
        return deep ? `${base} · 8-bit` : base;
      }
      if (target === 'avif') return deep ? 'AVIF · 10-bit' : 'AVIF';
      return formatLabel(target);
    }

    renderSummary() {
      const meta = this.state.meta;
      if (!meta) {
        this.els.summary.textContent = 'Hazır değil';
        this.els.outNote.textContent = 'Dosya seçin';
        this.els.exportBtn.disabled = true;
        return;
      }
      const width = this.state.fullWidth || meta.width;
      const height = this.state.fullHeight || meta.height;
      const target = this.targetFormat();
      const primary = this.copyEligible() ? 'Orijinal' : formatLabel(target);
      this.els.summary.textContent = `${primary} · ${formatResolution(width, height)}`;
      if (this.copyEligible()) {
        this.els.outNote.textContent = `${formatBytes(meta.size)} · dosya birebir kopyalanır`;
      } else {
        const animatedNote = meta.isAnimated ? ' · ilk kare' : '';
        const textNote = this.state.textLayers.length ? ` · ${this.state.textLayers.length} metin` : '';
        this.els.outNote.textContent = `${this.state.ops.length} işlem${textNote} · ${this.qualityNote()}${animatedNote}`;
      }
      this.els.ext.textContent = this.outputExt();
      this.els.exportBtn.disabled = !this.state.loaded;
    }

    rotate(delta) {
      if (!this.state.loaded) return;
      this.cancelCrop();
      const angle = ((Math.round(delta / 90) * 90) % 360 + 360) % 360;
      if (angle === 0) return;
      const ops = this.state.ops;
      const last = ops[ops.length - 1];
      if (last && last.type === 'rotate') {
        const next = ((last.angle + angle) % 360 + 360) % 360;
        if (next === 0) ops.pop();
        else last.angle = next;
      } else {
        ops.push({ type: 'rotate', angle });
      }
      this.afterOpsChange();
    }

    flip(axis) {
      if (!this.state.loaded) return;
      this.cancelCrop();
      const ops = this.state.ops;
      const last = ops[ops.length - 1];
      if (last && last.type === 'flip' && last.axis === axis) {
        ops.pop();
      } else {
        ops.push({ type: 'flip', axis });
      }
      this.afterOpsChange();
    }

    undo() {
      if (!this.state.loaded || this.state.ops.length === 0) return;
      this.cancelCrop();
      this.state.ops.pop();
      this.afterOpsChange();
    }

    resetEdits() {
      if (!this.state.loaded) return;
      this.cancelCrop();
      if (this.state.ops.length === 0) {
        toast('Görsel zaten orijinal halinde.');
        return;
      }
      this.state.ops = [];
      this.afterOpsChange();
      toast('Tüm düzenlemeler sıfırlandı.');
    }

    afterOpsChange() {
      this.renderHistory();
      this.renderCropState();
      this.renderSummary();
      this.queuePreview();
    }

    openCrop() {
      if (!this.state.loaded) return;
      if (this.state.cropActive) return;
      if (this.state.previewRunning) {
        toast('Önizleme hazırlanıyor; kırpmayı birazdan açabilirsin.', { type: 'warn' });
        return;
      }
      const width = this.state.fullWidth;
      const height = this.state.fullHeight;
      if (!width || !height) return;
      this.state.cropActive = true;
      this.state.cropRatio = null;
      this.textEditor.setHidden(true);
      this.els.cropBar.hidden = false;
      this.els.cropBar.classList.remove('hidden');
      this.els.ratioPills.querySelectorAll('button').forEach((button) => {
        button.classList.toggle('active', button.dataset.ratio === 'free');
      });
      this.cropOverlay.setSourceSize(width, height);
      this.cropOverlay.open({
        rect: { x: 0, y: 0, w: 1, h: 1 },
        sourceWidth: width,
        sourceHeight: height,
        onChange: (rect) => this.updateCropReadout(rect, { width, height }),
      });
      this.updateCropReadout({ x: 0, y: 0, w: 1, h: 1 }, { width, height });
      this.renderCropState();
      requestAnimationFrame(() => {
        this.layoutFrame();
        this.cropOverlay.setSourceSize(this.state.fullWidth, this.state.fullHeight);
      });
    }

    updateCropReadout(rect, dims) {
      const width = Math.max(1, Math.round(rect.w * dims.width));
      const height = Math.max(1, Math.round(rect.h * dims.height));
      this.els.cropDims.textContent = `${width} × ${height}`;
    }

    setCropRatio(value) {
      const ratio = value === 'free' ? null : Number(value);
      this.state.cropRatio = ratio;
      this.els.ratioPills.querySelectorAll('button').forEach((button) => {
        button.classList.toggle('active', button.dataset.ratio === value);
      });
      this.cropOverlay.setRatio(ratio);
    }

    cancelCrop() {
      if (!this.state.cropActive) return;
      this.state.cropActive = false;
      this.textEditor.setHidden(false);
      this.cropOverlay.close();
      this.els.cropBar.hidden = true;
      this.els.cropBar.classList.add('hidden');
      this.renderCropState();
      requestAnimationFrame(() => this.layoutFrame());
    }

    applyCrop() {
      if (!this.state.cropActive) return;
      const width = this.state.fullWidth;
      const height = this.state.fullHeight;
      const rect = this.cropOverlay.getRect();
      let left = clamp(Math.round(rect.x * width), 0, Math.max(0, width - 1));
      let top = clamp(Math.round(rect.y * height), 0, Math.max(0, height - 1));
      let cropWidth = clamp(Math.round(rect.w * width), 1, width - left);
      let cropHeight = clamp(Math.round(rect.h * height), 1, height - top);
      left = Math.min(left, width - 1);
      top = Math.min(top, height - 1);
      cropWidth = Math.max(1, Math.min(cropWidth, width - left));
      cropHeight = Math.max(1, Math.min(cropHeight, height - top));

      this.state.cropActive = false;
      this.textEditor.setHidden(false);
      this.cropOverlay.close();
      this.els.cropBar.hidden = true;
      this.els.cropBar.classList.add('hidden');
      this.els.cropBtn.classList.remove('active');

      if (cropWidth >= width - 1 && cropHeight >= height - 1) {
        this.renderCropState();
        requestAnimationFrame(() => this.layoutFrame());
        toast('Kırpma alanı değişmedi.');
        return;
      }

      this.state.ops.push({
        type: 'crop',
        left,
        top,
        width: cropWidth,
        height: cropHeight,
      });
      this.afterOpsChange();
      toast(`Kırpma uygulandı · ${cropWidth} × ${cropHeight}`, { type: 'success' });
      requestAnimationFrame(() => this.layoutFrame());
    }

    onResizeInput(changed) {
      if (!this.state.loaded) return;
      this.lastResizeField = changed;
      const width = parseNumber(this.els.resizeW.value, 0);
      const height = parseNumber(this.els.resizeH.value, 0);
      const baseW = this.state.fullWidth;
      const baseH = this.state.fullHeight;
      if (this.state.aspectLocked && baseW > 0 && baseH > 0) {
        const aspect = baseW / baseH;
        if (changed === 'width' && width > 0) {
          if (document.activeElement !== this.els.resizeH) {
            this.els.resizeH.value = Math.max(1, Math.round(width / aspect));
          }
        } else if (changed === 'height' && height > 0) {
          if (document.activeElement !== this.els.resizeW) {
            this.els.resizeW.value = Math.max(1, Math.round(height * aspect));
          }
        }
      }
      this.updateResizeApply();
    }

    normalizeResizeInputs() {
      if (!this.state.loaded) return;
      let width = Math.round(parseNumber(this.els.resizeW.value, this.state.fullWidth));
      let height = Math.round(parseNumber(this.els.resizeH.value, this.state.fullHeight));
      width = clamp(width || 1, 1, 32000);
      height = clamp(height || 1, 1, 32000);
      const baseW = this.state.fullWidth;
      const baseH = this.state.fullHeight;
      if (this.state.aspectLocked && baseW > 0 && baseH > 0) {
        const aspect = baseW / baseH;
        if (this.lastResizeField === 'height') width = clamp(Math.round(height * aspect), 1, 32000);
        else height = clamp(Math.round(width / aspect), 1, 32000);
      }
      this.els.resizeW.value = width;
      this.els.resizeH.value = height;
      this.updateResizeApply();
    }

    applyResize() {
      if (!this.state.loaded) return;
      this.cancelCrop();
      const width = clamp(Math.round(parseNumber(this.els.resizeW.value, 0)), 1, 32000);
      const height = clamp(Math.round(parseNumber(this.els.resizeH.value, 0)), 1, 32000);
      if (!width || !height) {
        toast('Geçerli bir genişlik ve yükseklik girin.', { type: 'warn' });
        return;
      }
      if (width === Math.round(this.state.fullWidth) && height === Math.round(this.state.fullHeight)) {
        toast('Boyut zaten bu değerde.');
        return;
      }
      const ops = this.state.ops;
      const last = ops[ops.length - 1];
      if (last && last.type === 'resize') {
        last.width = width;
        last.height = height;
      } else {
        ops.push({ type: 'resize', width, height });
      }
      this.afterOpsChange();
      toast(`Boyut ${width} × ${height} olarak uygulandı.`, { type: 'success' });
    }

    setScaleFields(factor) {
      if (!this.state.loaded) return;
      const clean = clamp(Number(factor) || 1, 0.05, 4);
      this.lastResizeField = 'width';
      this.els.resizeW.value = Math.max(1, Math.round(this.state.fullWidth * clean));
      this.els.resizeH.value = Math.max(1, Math.round(this.state.fullHeight * clean));
      this.updateResizeApply();
    }

    toggleAspectLock() {
      this.state.aspectLocked = !this.state.aspectLocked;
      this.els.resizeLock.classList.toggle('active', this.state.aspectLocked);
      this.els.resizeLock.setAttribute('aria-pressed', String(this.state.aspectLocked));
      setIcon(this.els.resizeLock.querySelector('svg'), this.state.aspectLocked ? 'lock' : 'unlock');
    }

    async chooseFolder() {
      const dir = await this.api.openFolder(this.state.outputDir || this.appConfig.photoOutputDir);
      if (!dir) return null;
      this.state.outputDir = dir;
      this.appConfig.photoOutputDir = dir;
      this.onConfigChange?.({ photoOutputDir: dir });
      if (!this.onConfigChange) this.api.setConfig({ photoOutputDir: dir }).catch(() => {});
      this.renderOutput();
      return dir;
    }

    buildExportPayload() {
      const meta = this.state.meta;
      const ext = this.outputExt();
      const baseName = sanitizeClientName(
        this.state.baseName,
        `${fileStem(meta?.name || 'fotograf')}-odak`,
      );
      const target = this.targetFormat();
      const ops = this.state.ops.map((op) => ({ ...op }));
      return {
        kind: 'photo',
        path: this.state.file,
        ops,
        options: {
          format: this.state.format,
          quality: this.state.quality,
          keepMetadata: this.state.keepMetadata,
          textLayers: this.state.textLayers,
        },
        outputDir: this.state.outputDir,
        baseName,
        display: {
          fileName: `${baseName}${ext}`,
          folder: this.state.outputDir,
          summary: this.els.summary.textContent,
          outNote: this.els.outNote.textContent,
          ext,
          width: this.state.fullWidth,
          height: this.state.fullHeight,
          targetFormat: formatLabel(target),
          copyEligible: this.copyEligible(),
        },
      };
    }

    async export() {
      if (!this.state.loaded || !this.state.meta) return;
      if (!this.state.baseName.trim()) {
        this.state.baseName = `${fileStem(this.state.meta.name)}-odak`;
        this.renderOutput();
      }
      const target = this.targetFormat();
      const copyEligible = this.copyEligible();
      if (!copyEligible && !ENCODABLE_FORMATS.has(target)) {
        toast(`${formatLabel(target)} formatı yeniden kodlanarak kaydedilemiyor. JPEG, PNG, WebP, AVIF veya TIFF seçin.`, { type: 'warn' });
        return;
      }
      if (!this.state.outputDir) {
        const dir = await this.chooseFolder();
        if (!dir) {
          toast('Dışa aktarmak için bir çıktı klasörü seçin.', { type: 'warn' });
          return;
        }
      }
      const payload = this.buildExportPayload();
      if (typeof this.onExportRequest === 'function') this.onExportRequest(payload);
    }
  }

  window.PhotoEditor = PhotoEditor;
})();
