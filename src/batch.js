'use strict';

(function () {
  const ui = window.OdakUI;
  const plan = window.OdakBatchPlan;
  const {
    $, $$, toast, shortenPath, formatBytes, formatDuration, formatResolution,
    fileStem, sanitizeBaseName, clearToasts,
  } = ui;

  const KINDS = ['video', 'photo', 'gif', 'merge'];
  const KIND_LABEL = { video: 'Video', photo: 'Fotoğraf', gif: 'GIF', merge: 'Birleştirme' };
  const KIND_ICON = { video: 'video', photo: 'photo', gif: 'gif', merge: 'film' };
  const OUTPUT_KEY = {
    video: 'videoOutputDir',
    photo: 'photoOutputDir',
    gif: 'gifOutputDir',
    merge: 'videoOutputDir',
  };
  const CODE_LABEL = { h264: 'H.264', h265: 'H.265', vp9: 'VP9', prores: 'ProRes' };
  const PHOTO_FORMAT_LABEL = {
    original: 'Orijinal format', jpeg: 'JPEG', png: 'PNG', webp: 'WebP', avif: 'AVIF', tiff: 'TIFF',
  };
  const STATUS_LABEL = {
    pending: 'Bekliyor', running: 'İşleniyor', done: 'Tamam', error: 'Hata',
  };
  const EMPTY_COPY = {
    video: {
      title: 'Video kuyruğu boş',
      text: 'Birden çok videoya aynı codec, kalite ve boyut ayarlarını tek seferde uygula.',
      formats: 'MP4 · MOV · MKV · WEBM · M4V',
    },
    photo: {
      title: 'Fotoğraf kuyruğu boş',
      text: 'Hepsini aynı formatta, aynı kalitede ve istersen aynı uzun kenarda kaydet.',
      formats: 'JPG · PNG · WEBP · AVIF · TIFF · GIF',
    },
    gif: {
      title: 'GIF kuyruğu boş',
      text: 'Her video veya fotoğraf kendi GIF dosyasına dönüşsün; ayarları bir kez seç.',
      formats: 'MP4 · MOV · WEBM · JPG · PNG · WEBP',
    },
    merge: {
      title: 'Birleştirilecek video yok',
      text: 'Videoları sırayla ekle; tek dosyada uç uca birleşsinler. Uyumlu videolar yeniden kodlanmadan birleştirilir.',
      formats: 'MP4 · MOV · MKV · WEBM · M4V',
    },
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function asNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  class BatchEditor {
    constructor(options = {}) {
      this.api = options.api;
      this.config = options.config || {};
      this.onConfigChange = options.onConfigChange;
      this.onChange = options.onChange;
      this.onRunningChange = options.onRunningChange;
      this.getEngine = typeof options.getEngine === 'function' ? options.getEngine : () => null;

      // Son kullanılan sekme ve ayarlar; normalizeSettings bozuk veya eski
      // kayıtları güvenli varsayılana döndürür.
      const remembered = this.config.preferences?.batch || {};
      this.kind = KINDS.includes(remembered.kind) ? remembered.kind : 'video';
      this.queues = { video: [], photo: [], gif: [], merge: [] };
      this.settings = {
        video: plan.normalizeSettings('video', { ...plan.defaultsFor('video'), ...(remembered.video || {}) }),
        photo: plan.normalizeSettings('photo', { ...plan.defaultsFor('photo'), ...(remembered.photo || {}) }),
        gif: plan.normalizeSettings('gif', { ...plan.defaultsFor('gif'), ...(remembered.gif || {}) }),
        merge: plan.normalizeSettings('merge', { ...plan.defaultsFor('merge'), ...(remembered.merge || {}) }),
      };
      this.seq = 0;
      this.running = false;
      this.cancelRequested = false;
      this.activeItem = null;
      this.currentJobId = null;
      this.presetId = '';
      this.hardware = null;
      this.adding = false;
      this.lastSummary = '';

      this.els = {
        editor: document.getElementById('batchEditor'),
        addBtn: document.getElementById('batchAddBtn'),
        clearBtn: document.getElementById('batchClearBtn'),
        emptyAddBtn: document.getElementById('batchEmptyAddBtn'),
        list: document.getElementById('batchList'),
        empty: document.getElementById('batchQueueEmpty'),
        emptyTitle: document.getElementById('batchEmptyTitle'),
        emptyText: document.getElementById('batchEmptyText'),
        emptyFormats: document.getElementById('batchEmptyFormats'),
        metaChips: document.getElementById('batchMetaChips'),
        countVideo: document.getElementById('batchCountVideo'),
        countPhoto: document.getElementById('batchCountPhoto'),
        countGif: document.getElementById('batchCountGif'),
        countMerge: document.getElementById('batchCountMerge'),
        settingsVideo: document.getElementById('batchSettingsVideo'),
        settingsPhoto: document.getElementById('batchSettingsPhoto'),
        settingsGif: document.getElementById('batchSettingsGif'),
        settingsMerge: document.getElementById('batchSettingsMerge'),
        saveNote: document.getElementById('batchSaveNote'),
        mergeStatusTitle: document.getElementById('batchMergeStatusTitle'),
        mergeStatusText: document.getElementById('batchMergeStatusText'),
        mergeMode: document.getElementById('batchMergeMode'),
        mergeCodec: document.getElementById('batchMergeCodec'),
        mergeCrf: document.getElementById('batchMergeCrf'),
        mergeCrfValue: document.getElementById('batchMergeCrfValue'),
        mergePreset: document.getElementById('batchMergePreset'),
        mergeEncoderField: document.getElementById('batchMergeEncoderField'),
        mergeEncoder: document.getElementById('batchMergeEncoder'),
        mergeAudio: document.getElementById('batchMergeAudio'),
        settingsTitle: document.getElementById('batchSettingsTitle'),
        settingsHint: document.getElementById('batchSettingsHint'),
        engineWarn: document.getElementById('batchEngineWarn'),
        folderBtn: document.getElementById('batchFolderBtn'),
        folderPath: document.getElementById('batchFolderPath'),
        summary: document.getElementById('batchSummary'),
        outNote: document.getElementById('batchOutNote'),
        startBtn: document.getElementById('batchStartBtn'),
        cancelBtn: document.getElementById('batchCancelBtn'),
        footCount: document.getElementById('batchFootCount'),
        footPercent: document.getElementById('batchFootPercent'),
        footBar: document.getElementById('batchFootBar'),
        footNote: document.getElementById('batchFootNote'),
        videoPresetSelect: document.getElementById('batchVideoPresetSelect'),
        videoEncoderField: document.getElementById('batchVideoEncoderField'),
        videoEncoder: document.getElementById('batchVideoEncoder'),
        videoCodec: document.getElementById('batchVideoCodec'),
        videoQuality: document.getElementById('batchVideoQuality'),
        videoCrf: document.getElementById('batchVideoCrf'),
        videoCrfValue: document.getElementById('batchVideoCrfValue'),
        videoPreset: document.getElementById('batchVideoPreset'),
        videoBitrate: document.getElementById('batchVideoBitrate'),
        videoWidth: document.getElementById('batchVideoWidth'),
        videoAudio: document.getElementById('batchVideoAudio'),
        videoCrfField: document.getElementById('batchVideoCrfField'),
        videoBitrateField: document.getElementById('batchVideoBitrateField'),
        videoSizeField: document.getElementById('batchVideoSizeField'),
        videoTargetMB: document.getElementById('batchVideoTargetMB'),
        videoCopyHint: document.getElementById('batchVideoCopyHint'),
        photoFormat: document.getElementById('batchPhotoFormat'),
        photoQuality: document.getElementById('batchPhotoQuality'),
        photoQualityField: document.getElementById('batchPhotoQualityField'),
        photoMaxEdge: document.getElementById('batchPhotoMaxEdge'),
        photoMetadata: document.getElementById('batchPhotoMetadata'),
        gifWidth: document.getElementById('batchGifWidth'),
        gifFps: document.getElementById('batchGifFps'),
        gifLoop: document.getElementById('batchGifLoop'),
        gifRatio: document.getElementById('batchGifRatio'),
        gifSeconds: document.getElementById('batchGifSeconds'),
        gifHint: document.getElementById('batchGifHint'),
        tabButtons: $$('.batch-kind-tab'),
      };

      this.bind();
      this.render();
    }

    videoPresets() {
      const shared = window.OdakShared;
      return [...shared.VIDEO_PRESETS, ...shared.cleanUserPresets(this.config.preferences?.videoPresets)];
    }

    // Hazır ayar tüm kuyruğa uygulanır; uzun kenar sınırı toplu boyut
    // seçeneğine dönüşür (hazır ayarda yoksa orijinal boyut).
    applyVideoPreset(id) {
      if (this.running) return;
      const preset = this.videoPresets().find((entry) => entry.id === id);
      this.presetId = preset ? preset.id : '';
      if (!preset) {
        this.renderVideoPresets();
        return;
      }
      const settings = preset.settings;
      this.settings.video = plan.normalizeSettings('video', {
        ...this.settings.video,
        ...settings,
        maxWidth: settings.maxEdge || 0,
      });
      this.rememberSettings();
      this.render();
      toast(`${preset.name} kuyruğa uygulandı.`, { type: 'success' });
    }

    renderVideoPresets() {
      const select = this.els.videoPresetSelect;
      const presets = this.videoPresets();
      const signature = JSON.stringify(presets.map((preset) => [preset.id, preset.name]));
      if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        select.textContent = '';
        const custom = document.createElement('option');
        custom.value = '';
        custom.textContent = 'Özel (elle ayarlandı)';
        select.appendChild(custom);
        const groups = [
          ['Hazır ayarlar', presets.filter((preset) => !preset.id.startsWith('user-'))],
          ['Kaydettiklerim', presets.filter((preset) => preset.id.startsWith('user-'))],
        ];
        for (const [label, list] of groups) {
          if (!list.length) continue;
          const group = document.createElement('optgroup');
          group.label = label;
          for (const preset of list) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            group.appendChild(option);
          }
          select.appendChild(group);
        }
      }
      select.value = presets.some((preset) => preset.id === this.presetId) ? this.presetId : '';
    }

    rememberSettings() {
      this.onConfigChange?.({
        preferences: {
          batch: {
            kind: this.kind,
            video: this.settings.video,
            photo: this.settings.photo,
            gif: this.settings.gif,
            merge: this.settings.merge,
          },
        },
      });
    }

    get kindQueue() {
      return this.queues[this.kind];
    }

    hasMedia() {
      return KINDS.some((kind) => this.queues[kind].length > 0);
    }

    hasQueue(kind = this.kind) {
      return this.queues[kind].length > 0;
    }

    isRunning() {
      return this.running;
    }

    outputDir(kind = this.kind) {
      return String(this.config[OUTPUT_KEY[kind]] || '');
    }

    bind() {
      this.els.tabButtons.forEach((button) => {
        button.addEventListener('click', () => this.setKind(button.dataset.batchKind));
      });
      this.els.addBtn.addEventListener('click', () => this.requestFiles());
      this.els.emptyAddBtn.addEventListener('click', () => this.requestFiles());
      this.els.clearBtn.addEventListener('click', () => this.clearQueue());
      this.els.folderBtn.addEventListener('click', () => this.chooseFolder());
      this.els.startBtn.addEventListener('click', () => this.start());
      this.els.cancelBtn.addEventListener('click', () => this.cancel());

      this.els.list.addEventListener('click', (event) => {
        const action = event.target instanceof Element
          ? event.target.closest('[data-batch-action]')
          : null;
        if (!action) return;
        const row = action.closest('[data-batch-id]');
        if (!row) return;
        const item = this.kindQueue.find((entry) => entry.id === row.dataset.batchId);
        if (!item) return;
        const name = action.dataset.batchAction;
        if (name === 'remove') this.removeItem(item.id);
        else if (name === 'retry') this.retryItem(item.id);
        else if (name === 'show' && item.output?.path) {
          this.api.showItem(item.output.path).catch(() => {});
        } else if (name === 'up' || name === 'down') {
          this.moveItem(item.id, name === 'up' ? -1 : 1);
        }
      });

      this.els.videoPresetSelect.addEventListener('change', () => this.applyVideoPreset(this.els.videoPresetSelect.value));
      this.bindSetting(this.els.videoCodec, 'video', 'codec');
      this.bindSetting(this.els.videoEncoder, 'video', 'encoder');
      this.bindSetting(this.els.videoQuality, 'video', 'quality');
      this.bindSetting(this.els.videoPreset, 'video', 'preset');
      this.bindSetting(this.els.videoWidth, 'video', 'maxWidth', true);
      this.bindSetting(this.els.videoAudio, 'video', 'audioMode');
      this.bindSetting(this.els.videoCrf, 'video', 'crf', true, true);
      this.bindSetting(this.els.videoBitrate, 'video', 'bitrateKbps', true);
      this.bindSetting(this.els.videoTargetMB, 'video', 'targetMB', true);
      this.bindSetting(this.els.photoFormat, 'photo', 'format');
      this.bindSetting(this.els.photoQuality, 'photo', 'quality');
      this.bindSetting(this.els.photoMaxEdge, 'photo', 'maxEdge', true);
      this.els.photoMetadata.addEventListener('click', () => {
        if (this.running) return;
        this.settings.photo = plan.normalizeSettings('photo', {
          ...this.settings.photo,
          keepMetadata: !this.settings.photo.keepMetadata,
        });
        this.rememberSettings();
        this.render();
      });
      this.bindSetting(this.els.gifWidth, 'gif', 'width', true);
      this.bindSetting(this.els.gifFps, 'gif', 'fps', true);
      this.bindSetting(this.els.gifLoop, 'gif', 'loop', true);
      this.bindSetting(this.els.gifRatio, 'gif', 'ratio');
      this.bindSetting(this.els.gifSeconds, 'gif', 'maxSeconds', true);
      this.bindSetting(this.els.mergeMode, 'merge', 'mode');
      this.bindSetting(this.els.mergeCodec, 'merge', 'codec');
      this.bindSetting(this.els.mergeCrf, 'merge', 'crf', true, true);
      this.bindSetting(this.els.mergePreset, 'merge', 'preset');
      this.bindSetting(this.els.mergeEncoder, 'merge', 'encoder');
      this.bindSetting(this.els.mergeAudio, 'merge', 'audioMode');

      try {
        this.api.onJobProgress((data) => this.handleProgress(data));
      } catch {
        // Progress is optional; the export result still updates the queue.
      }
    }

    bindSetting(element, kind, key, numeric = false, live = false) {
      if (!element) return;
      const apply = (event) => {
        if (this.running) return;
        let value = numeric ? asNumber(element.value) : element.value;
        this.settings[kind] = plan.normalizeSettings(kind, {
          ...this.settings[kind],
          [key]: value,
        });
        // "Kopyala" görsel bir değişiklikle birlikte kullanılamaz; boyut
        // seçildiğinde kullanıcıyı sessizce yeniden kodlamaya düşürmek yerine
        // CRF moduna geçir.
        if (kind === 'video' && key === 'maxWidth' && value > 0 && this.settings.video.quality === 'copy') {
          this.settings.video = plan.normalizeSettings('video', {
            ...this.settings.video,
            quality: 'crf',
          });
          toast('Boyut küçültmede yeniden kodlama gerekir; kalite modu CRF oldu.', { type: 'info' });
        }
        if (kind === 'video' && key === 'quality' && value === 'copy' && this.settings.video.maxWidth > 0) {
          this.settings.video.maxWidth = 0;
          toast('Kayıpsız kopya için boyut orijinal kaldı.', { type: 'info' });
        }
        if (kind === 'video' && key === 'codec' && this.settings.video.quality === 'copy') {
          this.settings.video = plan.normalizeSettings('video', {
            ...this.settings.video,
            quality: 'crf',
          });
          toast('Codec değişikliği yeniden kodlama gerektirir; kalite modu CRF oldu.', { type: 'info' });
        }
        if (kind === 'video') this.presetId = '';
        this.rememberSettings();
        if (live && event?.type === 'input') {
          this.els.videoCrfValue.textContent = `CRF ${this.settings.video.crf}`;
          this.els.mergeCrfValue.textContent = `CRF ${this.settings.merge.crf}`;
          this.renderSummary();
          return;
        }
        this.render();
      };
      element.addEventListener(live ? 'input' : 'change', apply);
      if (live) element.addEventListener('change', apply);
    }

    setKind(kind) {
      if (!KINDS.includes(kind) || kind === this.kind) return;
      if (this.running) {
        toast('Toplu işlem sürerken sekme değiştirilemez.', { type: 'warn' });
        return;
      }
      this.kind = kind;
      this.rememberSettings();
      this.render();
      this.onChange?.();
    }

    async requestFiles() {
      if (this.running) return;
      const kind = this.kind === 'photo' ? 'image' : this.kind === 'gif' ? 'media' : 'video';
      let paths = [];
      try {
        paths = await this.api.openFiles({ kind, multiple: true });
      } catch (error) {
        toast(error.message || 'Dosyalar seçilemedi.', { type: 'error' });
        return;
      }
      if (paths && paths.length) await this.addFiles(paths);
    }

    accepts(meta) {
      if (!meta) return false;
      if (this.kind === 'video' || this.kind === 'merge') return meta.kind === 'video';
      if (this.kind === 'photo') return meta.kind === 'image';
      return meta.kind === 'video' || meta.kind === 'image';
    }

    async addFiles(paths) {
      if (this.running) {
        toast('Toplu işlem sürerken yeni dosya eklenemez.', { type: 'warn' });
        return;
      }
      const files = Array.isArray(paths) ? paths.filter(Boolean) : [];
      if (!files.length || this.adding) return;
      this.adding = true;
      const existing = new Set(this.kindQueue.map((item) => String(item.path || '').toLowerCase()));
      const added = [];
      const errors = [];
      let duplicates = 0;

      try {
        for (const file of files) {
          const key = String(file || '').toLowerCase();
          // Birleştirmede aynı video bilerek birden çok kez eklenebilir.
          if (existing.has(key) && this.kind !== 'merge') {
            duplicates += 1;
            continue;
          }
          let meta;
          try {
            meta = await this.api.probe(file);
          } catch (error) {
            errors.push(`${this.baseName(file)}: ${error.message || 'Dosya okunamadı.'}`);
            continue;
          }
          if (!this.accepts(meta)) {
            const expected = this.kind === 'video' || this.kind === 'merge' ? 'video' : this.kind === 'photo' ? 'fotoğraf' : 'video veya fotoğraf';
            errors.push(`${meta.name || this.baseName(file)}: bu sekme için ${expected} gerekli.`);
            continue;
          }
          const item = {
            id: `batch-${++this.seq}`,
            path: meta.path || file,
            name: meta.name || this.baseName(file),
            meta,
            status: 'pending',
            progress: 0,
            error: '',
            details: '',
            output: null,
          };
          this.kindQueue.push(item);
          existing.add(key);
          added.push(item);
        }
      } finally {
        this.adding = false;
      }

      if (added.length) {
        this.render();
        this.els.list.scrollTop = this.els.list.scrollHeight;
        if (added.length === 1) {
          toast(`${added[0].name} kuyruğa eklendi.`, { type: 'success' });
        } else {
          toast(`${added.length} dosya kuyruğa eklendi.`, { type: 'success' });
        }
        this.onChange?.();
      }
      if (duplicates) {
        toast(`${duplicates} dosya kuyrukta zaten var.`, { type: 'warn' });
      }
      if (errors.length) {
        const text = errors.length === 1
          ? errors[0]
          : `${errors.length} dosya eklenemedi. ${errors[0]}`;
        toast(text, { type: 'warn', timeout: 7000 });
      }
      if (!added.length && !errors.length && !duplicates) {
        this.onChange?.();
      }
    }

    baseName(file) {
      const raw = String(file || '').split(/[\\/]/).pop() || 'dosya';
      return raw;
    }

    clearQueue() {
      if (this.running) return;
      if (!this.kindQueue.length) return;
      const count = this.kindQueue.length;
      this.queues[this.kind] = [];
      this.render();
      this.onChange?.();
      toast(`${count} dosya kuyruktan çıkarıldı.`, { type: 'info' });
    }

    removeItem(id) {
      if (this.running) return;
      const index = this.kindQueue.findIndex((item) => item.id === id);
      if (index < 0) return;
      this.kindQueue.splice(index, 1);
      this.render();
      this.onChange?.();
    }

    // Birleştirme sırası; çıktı artık eski sırayı yansıtmadığı için kuyruk
    // yeniden "bekliyor" durumuna döner.
    moveItem(id, direction) {
      if (this.running) return;
      const queue = this.kindQueue;
      const index = queue.findIndex((item) => item.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= queue.length) return;
      [queue[index], queue[target]] = [queue[target], queue[index]];
      if (this.kind === 'merge') this.resetStatuses(queue);
      this.render();
    }

    resetStatuses(queue) {
      for (const item of queue) {
        item.status = 'pending';
        item.progress = 0;
        item.error = '';
        item.details = '';
        item.output = null;
      }
    }

    retryItem(id) {
      if (this.running) return;
      const item = this.kindQueue.find((entry) => entry.id === id);
      if (!item) return;
      item.status = 'pending';
      item.error = '';
      item.details = '';
      item.progress = 0;
      item.output = null;
      this.render();
    }

    async chooseFolder() {
      if (this.running) return null;
      const dir = await this.api.openFolder(this.outputDir() || this.config[OUTPUT_KEY[this.kind]] || '');
      if (!dir) return null;
      this.config[OUTPUT_KEY[this.kind]] = dir;
      this.onConfigChange?.({ [OUTPUT_KEY[this.kind]]: dir });
      this.render();
      return dir;
    }

    // Birleştirme kuyruğu tek bir iştir: tüm videolar sırayla tek dosyaya.
    async startMerge() {
      const queue = this.kindQueue;
      if (queue.length < 2) {
        toast('Birleştirmek için en az iki video ekleyin.', { type: 'warn' });
        return;
      }
      const engine = this.getEngine();
      if (engine && engine.available === false) {
        toast('FFmpeg bulunamadı. Birleştirme kullanılamıyor.', { type: 'error', timeout: 7000 });
        return;
      }
      if (!this.outputDir()) {
        const dir = await this.chooseFolder();
        if (!dir) {
          toast('Birleştirme için bir çıktı klasörü seçin.', { type: 'warn' });
          return;
        }
      }
      clearToasts();
      this.running = true;
      this.cancelRequested = false;
      this.resetStatuses(queue);
      for (const item of queue) item.status = 'running';
      const jobId = randomId();
      this.currentJobId = jobId;
      this.activeItem = null;
      this.onRunningChange?.(true);
      this.render();
      const first = queue[0];
      try {
        const result = await this.api.mergeVideos({
          inputs: queue.map((item) => item.path),
          settings: this.settings.merge,
          outputDir: this.outputDir(),
          baseName: sanitizeBaseName(`${fileStem(first.name)}-birlesik`, 'odak-birlesik'),
          jobId,
        });
        if (!result || result.ok === false) {
          const error = new Error(result?.message || 'Videolar birleştirilemedi.');
          error.details = result?.details || '';
          error.canceled = Boolean(result?.canceled);
          throw error;
        }
        for (const item of queue) {
          item.status = 'done';
          item.progress = 100;
          item.output = result;
        }
        const how = result.lossless ? 'yeniden kodlanmadan' : 'yeniden kodlanarak';
        toast(`${queue.length} video ${how} birleştirildi: ${result.name}`, {
          type: 'success',
          timeout: 7000,
          action: { label: 'Göster', onClick: () => this.api.showItem(result.path).catch(() => {}) },
        });
      } catch (error) {
        const canceled = this.cancelRequested || error?.canceled;
        for (const item of queue) {
          item.status = canceled ? 'pending' : 'error';
          item.progress = 0;
          item.error = canceled ? '' : (error?.message || 'Birleştirilemedi.');
          item.details = canceled ? '' : (error?.details || '');
        }
        if (canceled) toast('Birleştirme durduruldu.', { type: 'warn' });
        else toast(error?.message || 'Videolar birleştirilemedi.', { type: 'error', timeout: 7000 });
      } finally {
        this.running = false;
        this.cancelRequested = false;
        this.currentJobId = null;
        this.onRunningChange?.(false);
        this.render();
      }
    }

    async start() {
      if (this.running) return;
      if (this.kind === 'merge') {
        await this.startMerge();
        return;
      }
      const queue = this.kindQueue;
      const targets = queue.filter((item) => item.status === 'pending' || item.status === 'error');
      if (!targets.length) {
        toast(queue.length ? 'Kuyrukta işlenecek yeni dosya yok.' : 'Önce kuyruğa dosya ekleyin.', { type: 'warn' });
        return;
      }
      const engine = this.getEngine();
      if (this.kind !== 'photo' && engine && engine.available === false) {
        toast('FFmpeg bulunamadı. Video ve GIF toplu işlemi kullanılamıyor.', { type: 'error', timeout: 7000 });
        return;
      }
      if (!this.outputDir()) {
        const dir = await this.chooseFolder();
        if (!dir) {
          toast('Toplu işlem için bir çıktı klasörü seçin.', { type: 'warn' });
          return;
        }
      }

      clearToasts();
      this.running = true;
      this.cancelRequested = false;
      this.currentJobId = null;
      this.activeItem = null;
      for (const item of targets) {
        item.status = 'pending';
        item.progress = 0;
        item.error = '';
        item.details = '';
        item.output = null;
      }
      this.onRunningChange?.(true);
      this.render();

      let succeeded = 0;
      let failed = 0;
      let canceled = false;

      try {
        for (const item of targets) {
          if (this.cancelRequested) {
            canceled = true;
            break;
          }
          item.status = 'running';
          item.progress = 0;
          this.activeItem = item;
          const jobId = randomId();
          this.currentJobId = this.kind === 'photo' ? null : jobId;
          this.renderQueue();
          this.renderFooter();
          try {
            const payload = this.buildPayload(item, jobId);
            let result;
            if (this.kind === 'video') {
              result = await this.api.exportVideo(payload);
            } else if (this.kind === 'photo') {
              result = await this.api.photoExport(payload);
            } else {
              result = await this.api.exportGif(payload);
            }
            if (result && result.ok === false) {
              const error = new Error(result.message || 'Dosya işlenemedi.');
              error.details = result.details || '';
              error.canceled = Boolean(result.canceled);
              throw error;
            }
            if (!result) throw new Error('Dışa aktarma sonucu alınamadı.');
            item.status = 'done';
            item.progress = 100;
            item.output = result;
            succeeded += 1;
          } catch (error) {
            if (this.cancelRequested || error?.canceled) {
              item.status = 'pending';
              item.progress = 0;
              canceled = true;
            } else {
              item.status = 'error';
              item.error = error?.message || 'Dosya işlenemedi.';
              item.details = error?.details || '';
              failed += 1;
            }
          } finally {
            this.currentJobId = null;
            this.activeItem = null;
            this.renderQueue();
            this.renderFooter();
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      } finally {
        this.running = false;
        this.cancelRequested = false;
        this.currentJobId = null;
        this.activeItem = null;
        this.onRunningChange?.(false);
        this.render();
      }

      const doneCount = queue.filter((item) => item.status === 'done').length;
      if (canceled) {
        toast(`Toplu işlem durduruldu. ${doneCount} dosya tamamlandı.`, { type: 'warn', timeout: 6500 });
      } else if (failed) {
        toast(`${succeeded} dosya tamamlandı, ${failed} dosyada hata oluştu. Hataları yeniden deneyebilirsin.`, {
          type: 'warn',
          timeout: 8000,
        });
      } else if (succeeded) {
        toast(`${succeeded} dosya başarıyla işlendi.`, { type: 'success', timeout: 5500 });
      }
    }

    buildPayload(item, jobId) {
      const settings = this.settings[this.kind];
      const outputDir = this.outputDir();
      const stem = sanitizeBaseName(fileStem(item.name), this.kind === 'gif' ? 'odak-gif' : 'odak-cikti');
      const baseName = sanitizeBaseName(
        plan.suggestName(stem, this.kind),
        this.kind === 'gif' ? 'odak-gif' : 'odak-cikti',
      );
      if (this.kind === 'video') {
        const options = plan.buildVideoOptions(settings, item.meta);
        return {
          kind: 'video',
          input: item.path,
          options,
          outputDir,
          baseName,
          jobId,
          display: {
            fileName: item.name,
            folder: outputDir,
            summary: this.summaryText(),
          },
        };
      }
      if (this.kind === 'photo') {
        return {
          kind: 'photo',
          path: item.path,
          ops: plan.photoOps(settings, item.meta),
          options: plan.buildPhotoOptions(settings),
          outputDir,
          baseName,
          display: {
            fileName: item.name,
            folder: outputDir,
            summary: this.summaryText(),
          },
        };
      }
      const gifItem = plan.buildGifItem(settings, item.meta, item.path);
      return {
        kind: 'gif',
        items: [gifItem],
        settings: plan.buildGifSettings(settings),
        outputDir,
        baseName,
        jobId,
        display: {
          fileName: item.name,
          folder: outputDir,
          summary: this.summaryText(),
        },
      };
    }

    async cancel() {
      if (!this.running || this.cancelRequested) return;
      this.cancelRequested = true;
      this.els.cancelBtn.disabled = true;
      this.els.cancelBtn.textContent = 'Durduruluyor…';
      this.renderFooter();
      if (this.currentJobId) {
        try {
          await this.api.cancelJob(this.currentJobId);
        } catch {
          // The current job may already be finishing.
        }
      }
    }

    handleProgress(data) {
      if (!this.running || !this.currentJobId) return;
      if (String(data?.jobId || '') !== String(this.currentJobId)) return;
      const percent = Math.max(0, Math.min(100, asNumber(data.percent)));
      // Birleştirmede tek iş tüm kuyruğu kapsar; her satır aynı ilerlemeyi gösterir.
      const items = this.kind === 'merge' ? this.kindQueue : (this.activeItem ? [this.activeItem] : []);
      for (const item of items) {
        item.progress = percent;
        const row = this.els.list.querySelector(`[data-batch-id="${item.id}"]`);
        if (!row) continue;
        const bar = row.querySelector('.batch-item-bar');
        const label = row.querySelector('.batch-item-percent');
        if (bar) bar.style.width = `${percent}%`;
        if (label) label.textContent = `%${Math.round(percent)}`;
      }
      this.renderFooter();
    }

    render() {
      const queue = this.kindQueue;
      this.els.tabButtons.forEach((button) => {
        const active = button.dataset.batchKind === this.kind;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        button.disabled = this.running;
      });
      this.els.countVideo.textContent = String(this.queues.video.length);
      this.els.countPhoto.textContent = String(this.queues.photo.length);
      this.els.countGif.textContent = String(this.queues.gif.length);
      this.els.countMerge.textContent = String(this.queues.merge.length);
      this.els.settingsVideo.hidden = this.kind !== 'video';
      this.els.settingsPhoto.hidden = this.kind !== 'photo';
      this.els.settingsGif.hidden = this.kind !== 'gif';
      this.els.settingsMerge.hidden = this.kind !== 'merge';
      this.els.settingsTitle.textContent = `${KIND_LABEL[this.kind]} ayarları`;
      this.els.settingsHint.textContent = {
        video: 'Seçimler kuyruktaki tüm videolara uygulanır.',
        photo: 'Seçimler kuyruktaki tüm fotoğraflara uygulanır.',
        gif: 'Her medya ayrı bir GIF dosyasına dönüştürülür.',
        merge: 'Kuyruktaki videolar listedeki sırayla tek dosyada birleştirilir.',
      }[this.kind];
      this.els.saveNote.textContent = this.kind === 'merge' ? 'Tek dosya' : 'Her dosya ayrı';
      const engine = this.getEngine();
      this.els.engineWarn.hidden = !(this.kind !== 'photo' && engine && engine.available === false);
      this.els.emptyTitle.textContent = EMPTY_COPY[this.kind].title;
      this.els.emptyText.textContent = EMPTY_COPY[this.kind].text;
      this.els.emptyFormats.textContent = EMPTY_COPY[this.kind].formats;
      this.els.empty.hidden = queue.length > 0;
      this.els.list.hidden = queue.length === 0;
      this.els.clearBtn.disabled = this.running || queue.length === 0;
      this.els.addBtn.disabled = this.running;
      this.els.emptyAddBtn.disabled = this.running;
      this.els.folderBtn.disabled = this.running;
      this.els.list.querySelectorAll('[data-batch-action]').forEach((button) => {
        button.disabled = this.running;
      });
      this.renderMeta(queue);
      this.renderQueue();
      this.renderSettings();
      this.renderSummary(queue);
      this.renderFooter();
      this.syncBusyUI();
    }

    renderMeta(queue) {
      this.els.metaChips.textContent = '';
      const totalBytes = queue.reduce((sum, item) => sum + (Number(item.meta?.size) || 0), 0);
      // "GIF" küçültülmez (tr-TR'de "gıf" olur); birleştirmede öğeler videodur.
      const noun = { video: 'video', photo: 'fotoğraf', gif: 'GIF', merge: 'video' }[this.kind];
      const chips = [`${queue.length} ${noun}`];
      if (totalBytes) chips.push(formatBytes(totalBytes));
      if (this.kind === 'video' || this.kind === 'merge') {
        const duration = queue.reduce((sum, item) => sum + (Number(item.meta?.duration) || 0), 0);
        if (duration) chips.push(formatDuration(duration));
      }
      if (this.kind === 'gif') {
        const engine = this.getEngine();
        chips.push(engine?.available ? 'FFmpeg hazır' : engine ? 'FFmpeg yok' : 'GIF · ses yok');
      }
      for (const text of chips) {
        const span = document.createElement('span');
        span.textContent = text;
        this.els.metaChips.appendChild(span);
      }
    }

    setHardware(hardware) {
      this.hardware = hardware && typeof hardware === 'object' ? hardware : null;
      this.render();
    }

    // Toplu kuyrukta seçili codec ekran kartıyla kodlanabiliyor mu?
    gpuAvailable() {
      return Boolean(this.hardware?.[this.settings.video.codec]?.length);
    }

    renderSettings() {
      this.renderVideoPresets();
      const video = this.settings.video;
      const anyGpu = Boolean(this.hardware?.h264?.length || this.hardware?.h265?.length);
      this.els.videoEncoderField.hidden = !anyGpu || video.quality === 'copy';
      this.els.videoEncoder.value = video.encoder;
      this.els.videoCodec.value = video.codec;
      this.els.videoQuality.value = video.quality;
      this.els.videoCrf.value = String(video.crf);
      this.els.videoCrfValue.textContent = `CRF ${video.crf}`;
      this.els.videoPreset.value = video.preset;
      this.els.videoBitrate.value = String(video.bitrateKbps);
      this.els.videoWidth.value = String(video.maxWidth);
      this.els.videoAudio.value = video.audioMode;
      this.els.videoCrfField.hidden = video.quality !== 'crf';
      this.els.videoBitrateField.hidden = video.quality !== 'bitrate';
      this.els.videoSizeField.hidden = video.quality !== 'size';
      if (document.activeElement !== this.els.videoTargetMB) this.els.videoTargetMB.value = String(video.targetMB);
      this.els.videoCopyHint.hidden = video.quality !== 'copy';
      this.els.videoCopyHint.textContent = video.maxWidth
        ? 'Boyut seçiliyken kopyalama kullanılamaz; başlatınca CRF ile yeniden kodlanır.'
        : 'Video akışı yeniden kodlanmadan kopyalanır. Ses ayrıca seçilebilir.';

      const photo = this.settings.photo;
      this.els.photoFormat.value = photo.format;
      this.els.photoQuality.value = photo.quality;
      this.els.photoMaxEdge.value = String(photo.maxEdge);
      this.els.photoMetadata.classList.toggle('on', photo.keepMetadata);
      this.els.photoMetadata.setAttribute('aria-checked', String(photo.keepMetadata));
      this.els.photoQualityField.hidden = ['png', 'tiff'].includes(photo.format);

      const gif = this.settings.gif;
      this.els.gifWidth.value = String(gif.width);
      this.els.gifFps.value = String(gif.fps);
      this.els.gifLoop.value = String(gif.loop);
      this.els.gifRatio.value = gif.ratio;
      this.els.gifSeconds.value = String(gif.maxSeconds);
      const first = this.kindQueue[0]?.meta;
      if (first && first.kind === 'video' && !gif.maxSeconds && Number(first.duration) > plan.GIF_MAX_DURATION) {
        this.els.gifHint.textContent = 'İlk video 60 sn sınırını aşıyor; süre sınırı seçmezsen bu dosya hata verir.';
        this.els.gifHint.classList.add('warn');
      } else {
        this.els.gifHint.textContent = 'GIF ses içermez ve 256 renk kullanır. Her dosya ayrı kaydedilir; uzun videolarda süre sınırı seç.';
        this.els.gifHint.classList.remove('warn');
      }
      this.renderMergeSettings();
    }

    // Birleştirme kayıpsız mı olacak? Ana süreçle aynı uyumluluk kuralı.
    mergeState() {
      const metas = this.queues.merge.map((item) => item.meta);
      const compat = window.OdakShared.mergeCompatibility(metas);
      return {
        count: metas.length,
        compat,
        lossless: this.settings.merge.mode !== 'reencode' && compat.compatible,
      };
    }

    renderMergeSettings() {
      const merge = this.settings.merge;
      this.els.mergeMode.value = merge.mode;
      this.els.mergeCodec.value = merge.codec;
      this.els.mergeCrf.value = String(merge.crf);
      this.els.mergeCrfValue.textContent = `CRF ${merge.crf}`;
      this.els.mergePreset.value = merge.preset;
      this.els.mergeEncoder.value = merge.encoder;
      this.els.mergeAudio.value = merge.audioMode;
      const state = this.mergeState();
      const gpu = Boolean(this.hardware?.[merge.codec]?.length);
      this.els.mergeEncoderField.hidden = !gpu || state.lossless;
      // Kayıpsız birleştirmede kodlama ayarları kullanılmaz.
      for (const control of [this.els.mergeCodec, this.els.mergeCrf, this.els.mergePreset]) {
        control.closest('.field')?.classList.toggle('is-disabled', state.lossless);
      }
      if (state.count < 2) {
        this.els.mergeStatusTitle.textContent = 'En az iki video ekle';
        this.els.mergeStatusText.textContent = 'Videolar listedeki sırayla tek dosyada birleştirilir.';
      } else if (state.lossless) {
        this.els.mergeStatusTitle.textContent = 'Kayıpsız birleştirme';
        this.els.mergeStatusText.textContent = 'Videolar aynı biçimde; yeniden kodlanmadan, saniyeler içinde birleştirilir.';
      } else if (merge.mode === 'reencode') {
        this.els.mergeStatusTitle.textContent = 'Yeniden kodlanacak';
        this.els.mergeStatusText.textContent = 'İstediğin için tüm videolar seçilen codec ile yeniden kodlanır.';
      } else {
        this.els.mergeStatusTitle.textContent = 'Yeniden kodlanacak';
        this.els.mergeStatusText.textContent = `Videolar farklı (${state.compat.reasons.join(', ')}); ilk videonun boyutuna ve kare hızına getirilip kodlanır.`;
      }
    }

    renderSummary(queue = this.kindQueue) {
      this.els.summary.textContent = this.summaryText();
      const totalBytes = queue.reduce((sum, item) => sum + (Number(item.meta?.size) || 0), 0);
      this.els.outNote.textContent = queue.length
        ? `${queue.length} dosya · ${formatBytes(totalBytes)} · ${shortenPath(this.outputDir() || 'Klasör seç', 34)}`
        : 'Kuyruğa dosya ekle';
      this.els.folderPath.textContent = this.outputDir() ? shortenPath(this.outputDir(), 38) : 'Klasör seç';
      this.els.folderPath.title = this.outputDir() || '';
      this.els.startBtn.disabled = this.running || !queue.some((item) => item.status !== 'done');
      this.els.cancelBtn.hidden = !this.running;
      this.els.cancelBtn.disabled = !this.running || this.cancelRequested;
      this.els.cancelBtn.textContent = this.cancelRequested ? 'Durduruluyor…' : 'İptal';
      if (this.running) {
        this.els.startBtn.textContent = 'İşleniyor…';
      } else if (queue.some((item) => item.status === 'error') && !queue.some((item) => item.status === 'pending')) {
        this.els.startBtn.textContent = 'Hataları yeniden dene';
      } else if (queue.length && queue.every((item) => item.status === 'done')) {
        this.els.startBtn.textContent = 'Tamamlandı';
      } else {
        this.els.startBtn.textContent = this.kind === 'merge' ? 'Birleştir' : 'Kuyruğu başlat';
      }
      if (this.kind === 'merge' && !this.running) {
        // Birleştirme hatasında tüm kuyruk tek seferde yeniden denenir.
        this.els.startBtn.disabled = queue.length < 2 || queue.every((item) => item.status === 'done');
        if (queue.some((item) => item.status === 'error')) this.els.startBtn.textContent = 'Yeniden dene';
      }
    }

    summaryText() {
      if (this.kind === 'video') {
        const settings = this.settings.video;
        let quality = `CRF ${settings.crf} · ${settings.preset}`;
        if (settings.quality === 'copy') quality = 'kayıpsız kopya';
        else if (settings.quality === 'bitrate') quality = `${settings.bitrateKbps} kbps`;
        else if (settings.quality === 'size') quality = `dosya başına en fazla ${window.OdakUI.formatNumber(settings.targetMB)} MB`;
        const width = settings.maxWidth ? `uzun kenar ${settings.maxWidth} px` : 'orijinal boyut';
        const audio = settings.audioMode === 'none'
          ? 'ses yok'
          : settings.audioMode === 'aac' ? 'ses AAC' : 'ses korunur';
        let codec = settings.quality === 'copy' ? 'Kaynak codec' : CODE_LABEL[settings.codec];
        if (settings.quality !== 'copy' && settings.encoder === 'gpu' && this.gpuAvailable()) codec += ' (GPU)';
        return `${codec} · ${quality} · ${width} · ${audio}`;
      }
      if (this.kind === 'photo') {
        const settings = this.settings.photo;
        const quality = ['png', 'tiff'].includes(settings.format) ? 'kayıpsız'
          : settings.quality === 'max' ? 'maksimum' : settings.quality === 'high' ? 'yüksek' : 'dengeli';
        const edge = settings.maxEdge ? `uzun kenar ${settings.maxEdge} px` : 'orijinal boyut';
        return `${PHOTO_FORMAT_LABEL[settings.format]} · ${quality} · ${edge}${settings.keepMetadata ? ' · meta korunur' : ''}`;
      }
      if (this.kind === 'merge') {
        const state = this.mergeState();
        const merge = this.settings.merge;
        const audio = merge.audioMode === 'none' ? 'ses yok' : 'ses korunur';
        if (state.lossless) return `Kayıpsız birleştirme · ${audio}`;
        const gpu = merge.encoder === 'gpu' && this.hardware?.[merge.codec]?.length ? ' (GPU)' : '';
        return `${CODE_LABEL[merge.codec]}${gpu} · CRF ${merge.crf} · ${audio}`;
      }
      const settings = this.settings.gif;
      const loop = settings.loop === 0 ? 'sonsuz döngü' : `${settings.loop} döngü`;
      const seconds = settings.maxSeconds ? `ilk ${settings.maxSeconds} sn` : 'tam süre';
      return `${settings.width} px · ${settings.fps} fps · ${loop} · ${seconds}`;
    }

    renderQueue() {
      const queue = this.kindQueue;
      const scrollTop = this.els.list.scrollTop;
      this.els.list.textContent = '';
      for (const item of queue) {
        const row = document.createElement('div');
        row.className = `batch-item ${item.status}`;
        row.dataset.batchId = item.id;

        const iconWrap = document.createElement('span');
        iconWrap.className = 'batch-item-icon';
        const itemKind = item.meta?.kind === 'video' ? 'video' : this.kind === 'photo' ? 'photo' : 'photo';
        iconWrap.appendChild(icon(KIND_ICON[itemKind] || 'file'));
        row.appendChild(iconWrap);

        const body = document.createElement('div');
        body.className = 'batch-item-body';

        const top = document.createElement('div');
        top.className = 'batch-item-top';
        const name = document.createElement('b');
        name.className = 'batch-item-name';
        name.textContent = item.name;
        name.title = item.path;
        top.appendChild(name);
        const status = document.createElement('span');
        status.className = `batch-status ${item.status}`;
        status.textContent = STATUS_LABEL[item.status] || item.status;
        top.appendChild(status);
        body.appendChild(top);

        const meta = document.createElement('div');
        meta.className = 'batch-item-meta';
        const parts = [];
        if (item.meta?.width && item.meta?.height) parts.push(formatResolution(item.meta.width, item.meta.height));
        if (item.meta?.size) parts.push(formatBytes(item.meta.size));
        if (item.meta?.duration && this.kind !== 'photo') parts.push(formatDuration(item.meta.duration));
        if (item.meta?.format) parts.push(String(item.meta.format).toUpperCase());
        meta.textContent = parts.join(' · ') || 'Medya';
        body.appendChild(meta);

        if (item.status === 'running') {
          const progress = document.createElement('div');
          progress.className = 'batch-item-progress';
          const track = document.createElement('div');
          track.className = 'progress-track';
          const bar = document.createElement('div');
          bar.className = 'progress-bar batch-item-bar';
          bar.style.width = `${Math.max(0, Math.min(100, item.progress))}%`;
          track.appendChild(bar);
          const percent = document.createElement('span');
          percent.className = 'batch-item-percent';
          percent.textContent = `%${Math.round(item.progress)}`;
          progress.append(track, percent);
          body.appendChild(progress);
        } else if (item.status === 'done' && item.output) {
          const result = document.createElement('div');
          result.className = 'batch-item-result';
          const resultParts = [];
          if (item.output.width && item.output.height) {
            resultParts.push(formatResolution(item.output.width, item.output.height));
          }
          if (item.output.size) resultParts.push(formatBytes(item.output.size));
          if (item.output.frames) resultParts.push(`${item.output.frames} kare`);
          result.textContent = resultParts.join(' · ') || item.output.name || 'Kaydedildi';
          body.appendChild(result);
        } else if (item.status === 'error') {
          const error = document.createElement('div');
          error.className = 'batch-item-error';
          error.textContent = item.error || 'İşlenemedi.';
          if (item.details) error.title = item.details;
          body.appendChild(error);
        }
        row.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'batch-item-actions';
        if (this.kind === 'merge' && !this.running && queue.length > 1) {
          // Birleştirme sırası listedeki sıradır.
          const index = queue.indexOf(item);
          for (const [action, iconName, title, disabled] of [
            ['up', 'arrow-up', 'Yukarı taşı', index === 0],
            ['down', 'arrow-down', 'Aşağı taşı', index === queue.length - 1],
          ]) {
            const button = document.createElement('button');
            button.className = 'icon-btn small';
            button.dataset.batchAction = action;
            button.title = title;
            button.disabled = disabled;
            button.appendChild(icon(iconName));
            actions.appendChild(button);
          }
        }
        if (item.status === 'error' && !this.running && this.kind !== 'merge') {
          const retry = document.createElement('button');
          retry.className = 'icon-btn small';
          retry.dataset.batchAction = 'retry';
          retry.title = 'Yeniden dene';
          retry.appendChild(icon('reset'));
          actions.appendChild(retry);
        }
        if (item.status === 'done' && item.output?.path) {
          const show = document.createElement('button');
          show.className = 'icon-btn small';
          show.dataset.batchAction = 'show';
          show.title = 'Klasörde göster';
          show.disabled = this.running;
          show.appendChild(icon('folder'));
          actions.appendChild(show);
        }
        if (!this.running && item.status !== 'running') {
          const remove = document.createElement('button');
          remove.className = 'icon-btn small danger';
          remove.dataset.batchAction = 'remove';
          remove.title = 'Kuyruktan çıkar';
          remove.appendChild(icon('close'));
          actions.appendChild(remove);
        }
        row.appendChild(actions);
        this.els.list.appendChild(row);
      }
      this.els.list.scrollTop = scrollTop;
      this.els.list.hidden = queue.length === 0;
      this.els.empty.hidden = queue.length > 0;
    }

    renderFooter() {
      const queue = this.kindQueue;
      const completed = queue.filter((item) => item.status === 'done' || item.status === 'error').length;
      const active = queue.find((item) => item.status === 'running');
      const fraction = active ? Math.max(0, Math.min(1, active.progress / 100)) : 0;
      let percent = queue.length
        ? Math.max(0, Math.min(100, ((completed + fraction) / queue.length) * 100))
        : 0;
      // Birleştirme tek iştir: ilerleme doğrudan işin ilerlemesidir.
      if (this.kind === 'merge' && active) percent = fraction * 100;
      this.els.footBar.style.width = `${percent}%`;
      this.els.footPercent.textContent = this.running || completed ? `%${Math.round(percent)}` : 'Hazır';
      this.els.footCount.textContent = queue.length
        ? `${completed} / ${queue.length} dosya`
        : 'Kuyruk boş';
      if (this.running && active) {
        this.els.footNote.textContent = `${active.name} · ${KIND_LABEL[this.kind]} işleniyor`;
      } else if (queue.some((item) => item.status === 'error')) {
        const errors = queue.filter((item) => item.status === 'error').length;
        this.els.footNote.textContent = `${errors} dosyada hata var; yeniden deneyebilirsin.`;
      } else if (queue.length && queue.every((item) => item.status === 'done')) {
        this.els.footNote.textContent = 'Tüm dosyalar işlendi.';
      } else if (queue.length) {
        this.els.footNote.textContent = 'Dosyalar sırayla işlenir; bir hata sonrakini durdurmaz.';
      } else {
        this.els.footNote.textContent = this.kind === 'photo'
          ? 'Fotoğraflar yerel görsel motoruyla işlenir.'
          : 'Video ve GIF işlemleri yerel FFmpeg ile yapılır.';
      }
    }

    syncBusyUI() {
      this.els.editor.classList.toggle('running', this.running);
      [this.els.settingsVideo, this.els.settingsPhoto, this.els.settingsGif, this.els.settingsMerge].forEach((panel) => {
        panel.querySelectorAll('input, select, button').forEach((control) => {
          control.disabled = this.running;
        });
      });
      this.els.startBtn.disabled = this.running || !this.kindQueue.some((item) => item.status !== 'done') ||
        (this.kind === 'merge' && this.kindQueue.length < 2);
      this.els.cancelBtn.hidden = !this.running;
    }
  }

  window.BatchEditor = BatchEditor;
})();
