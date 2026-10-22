'use strict';

(function () {
  const ui = window.OdakUI;
  const {
    clamp, even, formatDuration, formatResolution, formatTimecode, fileStem,
    shortenPath, setIcon, toast, parseNumber, clearToasts,
  } = ui;

  const shared = window.OdakShared;
  const MAX_SECONDS = shared.GIF_MAX_DURATION;
  const MAX_FRAMES = shared.GIF_MAX_FRAMES;
  const ratioValue = shared.gifRatioValue;

  function clampTrim(value, min, max) {
    return Math.round(clamp(Number(value) || 0, min, max) * 1000) / 1000;
  }

  function newJobId() {
    return (window.crypto && typeof window.crypto.randomUUID === 'function')
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function itemSourceRatio(item) {
    const width = Number(item?.meta?.width) || 0;
    const height = Number(item?.meta?.height) || 0;
    return width > 0 && height > 0 ? width / height : 16 / 9;
  }

  class GifEditor {
    constructor({ api, config, onConfigChange, onExportRequest, onChange } = {}) {
      this.api = api;
      this.appConfig = config || {};
      this.onConfigChange = onConfigChange;
      this.onExportRequest = onExportRequest;
      this.onChange = onChange;
      this.nextId = 1;
      this.adding = false;
      this.loadingTimer = null;
      this.previewToken = 0;
      this.previewJobId = null;
      this.stageKey = '';
      this.state = this.freshState();
      this.els = {
        editor: document.getElementById('gifEditor'),
        fileName: document.getElementById('gifFileName'),
        metaChips: document.getElementById('gifMetaChips'),
        previewBtn: document.getElementById('gifPreviewBtn'),
        addBtn: document.getElementById('gifAddBtn'),
        stage: document.getElementById('gifStage'),
        frame: document.getElementById('gifFrame'),
        video: document.getElementById('gifVideo'),
        photo: document.getElementById('gifPhoto'),
        previewImg: document.getElementById('gifPreviewImg'),
        stageBadge: document.getElementById('gifStageBadge'),
        previewTag: document.getElementById('gifPreviewTag'),
        loading: document.getElementById('gifLoading'),
        loadingText: document.getElementById('gifLoadingText'),
        sequence: document.getElementById('gifSequence'),
        sequenceCount: document.getElementById('gifSequenceCount'),
        sequenceTotal: document.getElementById('gifSequenceTotal'),
        playBtn: document.getElementById('gifPlayBtn'),
        prevBtn: document.getElementById('gifPrevBtn'),
        nextBtn: document.getElementById('gifNextBtn'),
        clipTime: document.getElementById('gifClipTime'),
        clipDuration: document.getElementById('gifClipDuration'),
        removeBtn: document.getElementById('gifRemoveBtn'),
        tabs: Array.from(document.querySelectorAll('.gif-inspector .inspector-tab[data-gtab]')),
        panes: Array.from(document.querySelectorAll('#gifEditor [data-gpane]')),
        inspectorScroll: document.getElementById('gifInspectorScroll'),
        clipType: document.getElementById('gifClipType'),
        clipName: document.getElementById('gifClipName'),
        clipEmpty: document.getElementById('gifClipEmpty'),
        clipSettings: document.getElementById('gifClipSettings'),
        clipDurationNote: document.getElementById('gifClipDurationNote'),
        clipHint: document.getElementById('gifClipHint'),
        videoTrimRow: document.getElementById('gifVideoTrimRow'),
        trimStart: document.getElementById('gifTrimStart'),
        trimEnd: document.getElementById('gifTrimEnd'),
        photoDurationField: document.getElementById('gifPhotoDurationField'),
        photoDuration: document.getElementById('gifPhotoDuration'),
        speedField: document.getElementById('gifSpeedField'),
        speed: document.getElementById('gifSpeed'),
        cropNote: document.getElementById('gifCropNote'),
        cropPills: document.getElementById('gifCropPills'),
        itemPosition: document.getElementById('gifItemPosition'),
        moveLeft: document.getElementById('gifMoveLeft'),
        moveRight: document.getElementById('gifMoveRight'),
        addMoreBtn: document.getElementById('gifAddMoreBtn'),
        removeClipBtn: document.getElementById('gifRemoveClipBtn'),
        canvasNote: document.getElementById('gifCanvasNote'),
        canvasRatio: document.getElementById('gifCanvasRatio'),
        width: document.getElementById('gifWidth'),
        canvasHint: document.getElementById('gifCanvasHint'),
        fps: document.getElementById('gifFps'),
        loop: document.getElementById('gifLoop'),
        baseName: document.getElementById('gifBaseName'),
        folderBtn: document.getElementById('gifFolderBtn'),
        folderPath: document.getElementById('gifFolderPath'),
        summary: document.getElementById('gifSummary'),
        outNote: document.getElementById('gifOutNote'),
        exportBtn: document.getElementById('gifExportBtn'),
        textSection: document.getElementById('gifTextSection'),
      };
      // GIF metinleri tüm tuvalde, baştan sona görünür (zamanlama yok).
      this.textEditor = new window.TextLayerEditor({
        host: this.els.textSection,
        frame: this.els.frame,
        onChange: (layers) => {
          this.state.textLayers = layers;
          this.invalidatePreview();
          this.renderSummary();
        },
        emptyHint: 'GIF\'e üst/alt yazı ekle. Metin tüm kliplerde görünür ve 256 renklik palete dahil edilir.',
      });
      this.bind();
      this.resizeObserver = new ResizeObserver(() => this.layoutFrame());
      this.resizeObserver.observe(this.els.stage);
      this.renderAll();
    }

    freshState() {
      // Son kullanılan GIF ayarları; toplu GIF ile aynı doğrulamadan geçer.
      const remembered = window.OdakBatchPlan.normalizeGifSettings(this.appConfig.preferences?.gif || {});
      return {
        items: [],
        selectedId: null,
        settings: {
          width: remembered.width,
          fps: remembered.fps,
          loop: remembered.loop,
          ratio: remembered.ratio,
        },
        outputDir: this.appConfig.gifOutputDir || '',
        baseName: 'odak-gif',
        previewVisible: false,
        previewBusy: false,
        previewUrl: '',
        previewDims: null,
        currentTime: 0,
        dragId: null,
        textLayers: [],
      };
    }

    // Önizleme ve dışa aktarma için ayarlar (metin katmanları dahil).
    exportSettings() {
      return { ...this.state.settings, textLayers: this.state.textLayers };
    }

    hasMedia() {
      return this.state.items.length > 0;
    }

    selected() {
      return this.state.items.find((item) => item.id === this.state.selectedId) || null;
    }

    selectedIndex() {
      return this.state.items.findIndex((item) => item.id === this.state.selectedId);
    }

    bind() {
      const els = this.els;
      els.addBtn.addEventListener('click', () => this.openAdd());
      els.addMoreBtn.addEventListener('click', () => this.openAdd());
      els.previewBtn.addEventListener('click', () => this.togglePreview());
      els.playBtn.addEventListener('click', () => this.togglePlay());
      els.prevBtn.addEventListener('click', () => this.stepSelection(-1));
      els.nextBtn.addEventListener('click', () => this.stepSelection(1));
      els.removeBtn.addEventListener('click', () => this.removeSelected());
      els.removeClipBtn.addEventListener('click', () => this.removeSelected());
      els.moveLeft.addEventListener('click', () => this.moveSelected(-1));
      els.moveRight.addEventListener('click', () => this.moveSelected(1));

      els.tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const name = tab.dataset.gtab;
          els.tabs.forEach((item) => item.classList.toggle('active', item === tab));
          els.panes.forEach((pane) => { pane.hidden = pane.dataset.gpane !== name; });
          if (name === 'gif') els.inspectorScroll.scrollTop = 0;
        });
      });

      els.trimStart.addEventListener('change', () => this.commitTrim('start'));
      els.trimEnd.addEventListener('change', () => this.commitTrim('end'));
      els.trimStart.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.trimStart.blur(); });
      els.trimEnd.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.trimEnd.blur(); });
      els.photoDuration.addEventListener('change', () => this.commitPhotoDuration());
      els.photoDuration.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.photoDuration.blur(); });
      els.speed.addEventListener('change', () => this.setSelectedSpeed(Number(els.speed.value)));
      els.cropPills.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-crop]');
        if (!button) return;
        this.setSelectedCrop(button.dataset.crop);
      });

      els.canvasRatio.addEventListener('change', () => {
        this.state.settings.ratio = els.canvasRatio.value;
        this.settingsChanged();
      });
      els.width.addEventListener('change', () => {
        this.state.settings.width = Number(els.width.value) || 480;
        this.settingsChanged();
      });
      els.fps.addEventListener('change', () => {
        this.state.settings.fps = Number(els.fps.value) || 12;
        this.settingsChanged();
      });
      els.loop.addEventListener('change', () => {
        this.state.settings.loop = Number(els.loop.value) || 0;
        this.settingsChanged();
      });
      els.baseName.addEventListener('input', () => {
        this.state.baseName = els.baseName.value;
        this.renderOutput();
      });
      els.folderBtn.addEventListener('click', () => this.chooseFolder());
      els.exportBtn.addEventListener('click', () => this.export());

      els.sequence.addEventListener('click', (event) => this.onSequenceClick(event));
      els.sequence.addEventListener('keydown', (event) => this.onSequenceKeyDown(event));
      els.sequence.addEventListener('dragstart', (event) => this.onDragStart(event));
      els.sequence.addEventListener('dragover', (event) => this.onDragOver(event));
      els.sequence.addEventListener('dragleave', (event) => this.onDragLeave(event));
      els.sequence.addEventListener('drop', (event) => this.onDrop(event));
      els.sequence.addEventListener('dragend', () => this.clearDragState());

      els.video.addEventListener('loadedmetadata', () => {
        this.layoutFrame();
        this.prepareVideoPosition();
        this.syncTransport();
      });
      els.video.addEventListener('timeupdate', () => this.onVideoTimeUpdate());
      els.video.addEventListener('play', () => this.syncPlayButton());
      els.video.addEventListener('pause', () => this.syncPlayButton());
      els.video.addEventListener('ended', () => {
        this.syncPlayButton();
        this.prepareVideoPosition();
      });
      els.video.addEventListener('error', () => {
        if (!this.selected() || this.selected().kind !== 'video') return;
        this.els.stageBadge.textContent = 'VİDEO ÖNİZLENEMİYOR';
        toast('Bu video tarayıcıda önizlenemiyor; GIF oluşturma yine de çalışır.', {
          type: 'warn',
          timeout: 5000,
        });
      });
      els.previewImg.addEventListener('load', () => this.layoutFrame());
    }

    async openAdd() {
      if (this.adding) return;
      try {
        const paths = await this.api.openFiles({ kind: 'media', multiple: true });
        if (paths && paths.length) await this.addFiles(paths);
      } catch (error) {
        toast(error.message || 'Medya seçilemedi.', { type: 'error' });
      }
    }

    async addFiles(paths) {
      if (!Array.isArray(paths) || paths.length === 0) return 0;
      if (this.adding) return 0;
      clearToasts();
      this.adding = true;
      this.invalidatePreview();
      this.showLoading(true, 'Medya hazırlanıyor');
      let added = 0;
      try {
        for (const file of paths) {
          try {
            const meta = await this.api.probe(file);
            if (!meta || (meta.kind !== 'video' && meta.kind !== 'image')) {
              throw new Error('Bu dosya GIF klibi olarak kullanılamıyor.');
            }
            const url = await this.api.mediaUrl(file);
            const kind = meta.kind === 'video' ? 'video' : 'photo';
            const item = {
              id: `gif-${Date.now()}-${this.nextId++}`,
              path: file,
              meta,
              kind,
              name: meta.name || file,
              url,
              thumbUrl: kind === 'photo' ? url : '',
              trimStart: 0,
              trimEnd: kind === 'video' ? Math.max(0.05, Number(meta.duration) || 0) : 0,
              speed: 1,
              duration: kind === 'photo' ? 2 : 0,
              cropRatio: 'auto',
            };
            if (kind === 'video' && !(item.trimEnd > 0.05)) {
              throw new Error('Videonun süresi okunamadı.');
            }
            this.state.items.push(item);
            added += 1;
            if (kind === 'video') {
              this.api.poster({ path: file, duration: meta.duration })
                .then((posterUrl) => {
                  if (!posterUrl) return;
                  const current = this.state.items.find((entry) => entry.id === item.id);
                  if (!current) return;
                  current.thumbUrl = posterUrl;
                  this.renderSequence();
                })
                .catch(() => {});
            }
          } catch (error) {
            toast(`${this.baseName(file)}: ${error.message || 'Medya açılamadı.'}`, {
              type: 'error',
              timeout: 6000,
            });
          }
        }
      } finally {
        this.adding = false;
        this.showLoading(false);
      }

      if (added > 0) {
        if (!this.state.selectedId) {
          this.state.selectedId = this.state.items[0].id;
        }
        if (!this.state.baseName || this.state.baseName === 'odak-gif') {
          if (this.state.items.length === 1) {
            this.state.baseName = `${fileStem(this.state.items[0].name)}-gif`;
          }
        }
        this.stageKey = '';
        this.renderAll();
        this.loadSelectedStage();
        this.onChange?.();
      }
      return added;
    }

    baseName(file) {
      return String(file || '').split(/[\\/]/).pop() || 'Dosya';
    }

    showLoading(show, text = 'Medya hazırlanıyor') {
      this.els.loading.hidden = !show;
      this.els.loading.classList.toggle('hidden', !show);
      if (text) this.els.loadingText.textContent = text;
    }

    renderAll() {
      this.renderHeader();
      this.renderSequence();
      this.renderClip();
      this.renderGifSettings();
      this.renderOutput();
      this.renderSummary();
      this.loadSelectedStage();
      this.layoutFrame();
    }

    renderHeader() {
      const items = this.state.items;
      const dims = this.canvasDims();
      const total = this.totalDuration();
      this.els.fileName.textContent = items.length ? 'GIF Stüdyo' : 'GIF Stüdyo';
      this.els.metaChips.textContent = '';
      if (items.length) {
        const videos = items.filter((item) => item.kind === 'video').length;
        const photos = items.length - videos;
        const chips = [
          `${items.length} klip`,
          `${videos} video${photos ? ` · ${photos} fotoğraf` : ''}`,
          formatResolution(dims.width, dims.height),
          `${this.state.settings.fps} fps`,
          formatDuration(total),
        ];
        for (const text of chips) {
          const span = document.createElement('span');
          span.textContent = text;
          this.els.metaChips.appendChild(span);
        }
      } else {
        const span = document.createElement('span');
        span.textContent = 'Video ve fotoğrafları uç uca ekle';
        this.els.metaChips.appendChild(span);
      }

      const preview = this.state.previewVisible && this.state.previewDims;
      const selected = this.selected();
      if (preview) {
        this.els.stageBadge.textContent = `GIF • ${formatResolution(preview.width, preview.height)} • ${formatDuration(this.totalDuration())}`;
      } else if (selected) {
        const label = selected.kind === 'video' ? 'VİDEO' : 'FOTOĞRAF';
        this.els.stageBadge.textContent = `${label} • ${formatResolution(selected.meta.width, selected.meta.height)} • ${formatDuration(this.itemDuration(selected))}`;
      } else {
        this.els.stageBadge.textContent = '—';
      }
    }

    renderSequence() {
      const list = this.els.sequence;
      list.textContent = '';
      for (let index = 0; index < this.state.items.length; index += 1) {
        const item = this.state.items[index];
        const element = document.createElement('div');
        element.className = 'gif-seq-item';
        element.dataset.id = item.id;
        element.draggable = true;
        element.tabIndex = 0;
        element.setAttribute('role', 'button');
        element.setAttribute('aria-label', `${index + 1}. ${item.name}`);
        element.title = item.path;
        element.classList.toggle('selected', item.id === this.state.selectedId);

        const thumb = document.createElement('div');
        thumb.className = 'gif-seq-thumb';
        if (item.thumbUrl) {
          const img = document.createElement('img');
          img.src = item.thumbUrl;
          img.alt = '';
          img.draggable = false;
          thumb.appendChild(img);
        }
        element.appendChild(thumb);

        const shade = document.createElement('span');
        shade.className = 'gif-seq-shade';
        element.appendChild(shade);

        const indexLabel = document.createElement('span');
        indexLabel.className = 'gif-seq-index';
        indexLabel.textContent = String(index + 1);
        element.appendChild(indexLabel);

        const type = document.createElement('span');
        type.className = 'gif-seq-type';
        type.innerHTML = `<svg class="icon"><use href="#i-${item.kind === 'video' ? 'video' : 'photo'}"></use></svg>`;
        element.appendChild(type);

        const copy = document.createElement('span');
        copy.className = 'gif-seq-copy';
        const name = document.createElement('span');
        name.className = 'gif-seq-name';
        name.textContent = item.name;
        const duration = document.createElement('span');
        duration.className = 'gif-seq-duration';
        duration.textContent = formatDuration(this.itemDuration(item));
        copy.append(name, duration);
        element.appendChild(copy);
        list.appendChild(element);
      }

      const add = document.createElement('button');
      add.className = 'gif-seq-add';
      add.type = 'button';
      add.innerHTML = '<svg class="icon"><use href="#i-plus"></use></svg><span>Ekle</span>';
      add.addEventListener('click', () => this.openAdd());
      list.appendChild(add);

      this.els.sequenceCount.textContent = String(this.state.items.length);
      this.els.sequenceTotal.textContent = this.state.items.length
        ? `${formatDuration(this.totalDuration())} · ${this.canvasDims().width}×${this.canvasDims().height}`
        : '—';
    }

    onSequenceClick(event) {
      const item = event.target.closest('.gif-seq-item');
      if (!item) return;
      this.select(item.dataset.id);
    }

    onSequenceKeyDown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('.gif-seq-item');
      if (!item) return;
      event.preventDefault();
      this.select(item.dataset.id);
    }

    onDragStart(event) {
      const item = event.target.closest('.gif-seq-item');
      if (!item) return;
      this.state.dragId = item.dataset.id;
      item.classList.add('dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', item.dataset.id);
      }
    }

    onDragOver(event) {
      const item = event.target.closest('.gif-seq-item');
      if (!item || !this.state.dragId) return;
      event.preventDefault();
      this.els.sequence.querySelectorAll('.drop-target').forEach((entry) => {
        if (entry !== item) entry.classList.remove('drop-target');
      });
      if (item.dataset.id !== this.state.dragId) item.classList.add('drop-target');
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    onDragLeave(event) {
      const item = event.target.closest('.gif-seq-item');
      if (item) item.classList.remove('drop-target');
    }

    onDrop(event) {
      const target = event.target.closest('.gif-seq-item');
      if (!target || !this.state.dragId) return;
      event.preventDefault();
      const sourceId = this.state.dragId;
      const targetId = target.dataset.id;
      this.clearDragState();
      if (sourceId === targetId) return;
      const sourceIndex = this.state.items.findIndex((item) => item.id === sourceId);
      const targetIndex = this.state.items.findIndex((item) => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [moved] = this.state.items.splice(sourceIndex, 1);
      this.state.items.splice(Math.min(targetIndex, this.state.items.length), 0, moved);
      this.invalidatePreview();
      this.renderSequence();
      this.renderClip();
      this.renderHeader();
      this.renderSummary();
    }

    clearDragState() {
      this.state.dragId = null;
      this.els.sequence.querySelectorAll('.dragging, .drop-target').forEach((item) => {
        item.classList.remove('dragging', 'drop-target');
      });
    }

    select(id) {
      if (!id || id === this.state.selectedId) return;
      const previous = this.selected();
      if (previous?.kind === 'video') this.pauseVideo();
      this.invalidatePreview();
      this.state.selectedId = id;
      this.stageKey = '';
      this.renderSequence();
      this.renderClip();
      this.renderHeader();
      this.renderSummary();
      this.loadSelectedStage();
    }

    stepSelection(direction) {
      const index = this.selectedIndex();
      if (index < 0 || this.state.items.length < 2) return;
      const next = clamp(index + direction, 0, this.state.items.length - 1);
      if (next === index) return;
      this.select(this.state.items[next].id);
    }

    moveSelected(direction) {
      const index = this.selectedIndex();
      if (index < 0) return;
      const target = index + direction;
      if (target < 0 || target >= this.state.items.length) return;
      const [item] = this.state.items.splice(index, 1);
      this.state.items.splice(target, 0, item);
      this.invalidatePreview();
      this.renderSequence();
      this.renderClip();
      this.renderHeader();
      this.renderSummary();
    }

    removeSelected() {
      const index = this.selectedIndex();
      if (index < 0) return;
      if (this.selected()?.kind === 'video') this.pauseVideo();
      this.invalidatePreview();
      this.state.items.splice(index, 1);
      this.state.selectedId = this.state.items.length
        ? this.state.items[Math.min(index, this.state.items.length - 1)].id
        : null;
      this.stageKey = '';
      this.renderAll();
      if (this.state.items.length === 0) {
        this.clearStage();
        this.onChange?.();
      }
    }

    itemDuration(item) {
      if (!item) return 0;
      if (item.kind === 'photo') return Math.max(0, Number(item.duration) || 0);
      const start = Number(item.trimStart) || 0;
      const end = Number(item.trimEnd) || 0;
      const speed = clamp(Number(item.speed) || 1, 0.25, 4);
      return Math.max(0, end - start) / speed;
    }

    totalDuration() {
      return this.state.items.reduce((sum, item) => sum + this.itemDuration(item), 0);
    }

    canvasRatio() {
      const explicit = ratioValue(this.state.settings.ratio);
      if (explicit) return explicit;
      const first = this.state.items[0];
      if (!first) return 16 / 9;
      return ratioValue(first.cropRatio) || itemSourceRatio(first);
    }

    canvasDims() {
      const width = even(clamp(Number(this.state.settings.width) || 480, 160, 960), 2);
      const height = even(clamp(Math.round(width / this.canvasRatio()), 2, 1600), 2);
      return { width, height };
    }

    renderClip() {
      const item = this.selected();
      const hasItem = Boolean(item);
      this.els.clipEmpty.hidden = hasItem;
      this.els.clipSettings.classList.toggle('is-empty', !hasItem);
      this.els.clipType.textContent = item
        ? (item.kind === 'video' ? 'VİDEO' : 'FOTOĞRAF')
        : 'KLİP';
      this.els.clipName.textContent = item ? item.name : '—';
      if (!item) {
        this.els.itemPosition.textContent = '—';
        this.els.removeBtn.disabled = true;
        this.els.moveLeft.disabled = true;
        this.els.moveRight.disabled = true;
        return;
      }

      const index = this.selectedIndex();
      this.els.itemPosition.textContent = `${index + 1} / ${this.state.items.length}`;
      this.els.removeBtn.disabled = false;
      this.els.moveLeft.disabled = index <= 0;
      this.els.moveRight.disabled = index >= this.state.items.length - 1;
      this.els.videoTrimRow.hidden = item.kind !== 'video';
      this.els.photoDurationField.hidden = item.kind !== 'photo';
      this.els.speedField.hidden = item.kind !== 'video';
      this.els.clipDurationNote.textContent = `${formatDuration(this.itemDuration(item))} çıktı`;
      this.els.clipHint.textContent = item.kind === 'video'
        ? 'Kesim ve hız yalnızca seçili videoyu etkiler. GIF çıktısında ses yer almaz.'
        : 'Fotoğraf, seçilen süre boyunca ekranda kalır. Kırpma oranı tüm kareye uygulanır.';

      if (document.activeElement !== this.els.trimStart) {
        this.els.trimStart.value = Number(item.trimStart || 0).toFixed(2);
      }
      if (document.activeElement !== this.els.trimEnd) {
        this.els.trimEnd.value = Number(item.trimEnd || 0).toFixed(2);
      }
      if (document.activeElement !== this.els.photoDuration) {
        this.els.photoDuration.value = Number(item.duration || 2).toFixed(1);
      }
      this.els.speed.value = String(item.speed || 1);
      const crop = String(item.cropRatio || 'auto');
      this.els.cropPills.querySelectorAll('button[data-crop]').forEach((button) => {
        button.classList.toggle('active', button.dataset.crop === crop);
      });
      const cropLabel = crop === 'auto'
        ? 'Otomatik (tuval)'
        : crop.split(':').join(':');
      this.els.cropNote.textContent = cropLabel === 'Otomatik (tuval)' ? 'Otomatik' : cropLabel;
      this.els.itemPosition.textContent = `${index + 1} / ${this.state.items.length}`;
    }

    commitTrim(field) {
      const item = this.selected();
      if (!item || item.kind !== 'video') return;
      const duration = Math.max(0.05, Number(item.meta.duration) || 0);
      let start = clampTrim(parseNumber(this.els.trimStart.value, item.trimStart), 0, duration);
      let end = clampTrim(parseNumber(this.els.trimEnd.value, item.trimEnd), 0, duration);
      if (field === 'start') {
        if (start >= end) start = Math.max(0, end - 0.05);
      } else if (end <= start) {
        end = Math.min(duration, start + 0.05);
      }
      if (start < 0) start = 0;
      if (end > duration) end = duration;
      if (end <= start) {
        start = 0;
        end = duration;
      }
      item.trimStart = start;
      item.trimEnd = end;
      this.invalidatePreview();
      this.renderClip();
      this.renderHeader();
      this.renderSequence();
      this.renderSummary();
      this.syncTransport();
    }

    commitPhotoDuration() {
      const item = this.selected();
      if (!item || item.kind !== 'photo') return;
      item.duration = clampTrim(parseNumber(this.els.photoDuration.value, item.duration), 0.1, 30);
      this.invalidatePreview();
      this.renderClip();
      this.renderHeader();
      this.renderSequence();
      this.renderSummary();
      this.syncTransport();
    }

    setSelectedSpeed(speed) {
      const item = this.selected();
      if (!item || item.kind !== 'video') return;
      item.speed = clamp(Number(speed) || 1, 0.25, 4);
      this.els.video.playbackRate = item.speed;
      this.invalidatePreview();
      this.renderClip();
      this.renderHeader();
      this.renderSequence();
      this.renderSummary();
    }

    setSelectedCrop(value) {
      const item = this.selected();
      if (!item) return;
      item.cropRatio = String(value || 'auto');
      this.invalidatePreview();
      this.renderClip();
      this.renderHeader();
      this.renderSequence();
      this.renderSummary();
      this.layoutFrame();
    }

    settingsChanged() {
      const { width, fps, loop, ratio } = this.state.settings;
      this.onConfigChange?.({ preferences: { gif: { width, fps, loop, ratio } } });
      this.invalidatePreview();
      this.renderHeader();
      this.renderClip();
      this.renderSequence();
      this.renderGifSettings();
      this.renderSummary();
      this.layoutFrame();
    }

    renderGifSettings() {
      this.els.canvasRatio.value = this.state.settings.ratio;
      this.els.width.value = String(this.state.settings.width);
      this.els.fps.value = String(this.state.settings.fps);
      this.els.loop.value = String(this.state.settings.loop);
      const dims = this.canvasDims();
      this.els.canvasNote.textContent = formatResolution(dims.width, dims.height);
      const total = this.totalDuration();
      const frames = Math.ceil(total * this.state.settings.fps);
      this.els.canvasHint.textContent = total
        ? `Tüm klipler aynı tuvale sığdırılır. ${frames} kare · ${formatDuration(total)}.`
        : 'Tüm klipler aynı tuvale sığdırılır. Genişlik arttıkça GIF dosyası büyür.';
    }

    renderOutput() {
      if (document.activeElement !== this.els.baseName) {
        this.els.baseName.value = this.state.baseName;
      }
      this.els.folderPath.textContent = this.state.outputDir ? shortenPath(this.state.outputDir, 42) : 'Klasör seç';
      this.els.folderPath.title = this.state.outputDir || '';
      this.els.folderBtn.title = this.state.outputDir || 'Çıktı klasörü seç';
    }

    renderSummary() {
      const items = this.state.items;
      const total = this.totalDuration();
      const dims = this.canvasDims();
      const frames = Math.ceil(total * this.state.settings.fps);
      const tooLong = total > MAX_SECONDS || frames > MAX_FRAMES;
      const ready = items.length > 0 && total >= 0.1 && !tooLong;
      this.els.summary.textContent = items.length
        ? `GIF · ${formatResolution(dims.width, dims.height)} · ${this.state.settings.fps} fps`
        : 'Hazır değil';
      if (!items.length) {
        this.els.outNote.textContent = 'Medya ekleyin';
      } else if (tooLong) {
        this.els.outNote.textContent = `Sınır aşıldı · en fazla ${MAX_SECONDS} sn / ${MAX_FRAMES} kare`;
      } else {
        this.els.outNote.textContent = `${formatDuration(total)} · ${items.length} klip · ${frames} kare`;
      }
      this.els.exportBtn.disabled = !ready;
      this.els.exportBtn.title = tooLong ? 'Süreyi veya FPS’i azaltın.' : '';
    }

    clearStage() {
      this.pauseVideo();
      this.els.video.removeAttribute('src');
      this.els.video.load();
      this.els.video.hidden = true;
      this.els.photo.hidden = true;
      this.els.previewImg.hidden = true;
      this.els.previewImg.removeAttribute('src');
      this.els.previewTag.hidden = true;
      this.els.frame.style.width = '0px';
      this.els.frame.style.height = '0px';
      this.els.stageBadge.textContent = '—';
      this.els.clipTime.textContent = '00:00.00';
      this.els.clipDuration.textContent = '00:00.00';
      this.syncPlayButton();
    }

    loadSelectedStage() {
      const selected = this.selected();
      // GIF önizlemesinde metin zaten görüntüye çizilmiştir.
      this.textEditor?.setHidden(Boolean(this.state.previewVisible && this.state.previewUrl) || !selected);
      if (this.state.previewVisible && this.state.previewUrl) {
        this.pauseVideo();
        this.els.video.hidden = true;
        this.els.photo.hidden = true;
        this.els.previewImg.hidden = false;
        if (this.els.previewImg.getAttribute('src') !== this.state.previewUrl) {
          this.els.previewImg.src = this.state.previewUrl;
        }
        this.els.previewTag.hidden = false;
        this.els.previewTag.textContent = `GIF önizlemesi · ${this.state.previewDims?.width || '—'} px`;
        this.syncTransport();
        this.syncPlayButton();
        this.layoutFrame();
        return;
      }

      this.els.previewImg.hidden = true;
      this.els.previewTag.hidden = true;
      if (!selected) {
        this.clearStage();
        return;
      }
      if (selected.kind === 'photo') {
        this.pauseVideo();
        this.els.video.hidden = true;
        this.els.photo.hidden = false;
        if (this.els.photo.getAttribute('src') !== selected.url) {
          this.els.photo.src = selected.url;
        }
        this.els.photo.alt = selected.name;
        this.syncTransport();
        this.syncPlayButton();
        this.layoutFrame();
        return;
      }

      this.els.photo.hidden = true;
      this.els.video.hidden = false;
      const key = `${selected.id}:${selected.url}`;
      if (this.stageKey !== key) {
        this.stageKey = key;
        this.els.video.src = selected.url;
        this.els.video.load();
      }
      this.els.video.muted = true;
      this.els.video.playbackRate = clamp(Number(selected.speed) || 1, 0.25, 4);
      this.prepareVideoPosition();
      this.syncTransport();
      this.syncPlayButton();
      this.layoutFrame();
    }

    prepareVideoPosition() {
      const item = this.selected();
      if (!item || item.kind !== 'video' || this.state.previewVisible) return;
      const video = this.els.video;
      const start = Number(item.trimStart) || 0;
      const end = Number(item.trimEnd) || Number(item.meta.duration) || 0;
      if (!Number.isFinite(video.currentTime) || video.currentTime < start - 0.02 || video.currentTime >= end - 0.02) {
        try { video.currentTime = start; } catch { /* metadata may not be ready */ }
      }
      video.playbackRate = clamp(Number(item.speed) || 1, 0.25, 4);
      this.onVideoTimeUpdate();
    }

    onVideoTimeUpdate() {
      const item = this.selected();
      if (!item || item.kind !== 'video' || this.state.previewVisible) return;
      const video = this.els.video;
      const start = Number(item.trimStart) || 0;
      const end = Number(item.trimEnd) || Number(item.meta.duration) || 0;
      const current = Number(video.currentTime) || 0;
      if (!video.paused && current >= end - 0.02) {
        video.pause();
        try { video.currentTime = end; } catch { /* ignore */ }
      }
      this.state.currentTime = current;
      this.syncTransport();
    }

    syncTransport() {
      const item = this.selected();
      if (!item) {
        this.els.clipTime.textContent = '00:00.00';
        this.els.clipDuration.textContent = '00:00.00';
        return;
      }
      if (this.state.previewVisible) {
        this.els.clipTime.textContent = '—';
        this.els.clipDuration.textContent = formatTimecode(this.totalDuration());
        return;
      }
      if (item.kind === 'photo') {
        this.els.clipTime.textContent = '—';
        this.els.clipDuration.textContent = formatTimecode(this.itemDuration(item));
        return;
      }
      const start = Number(item.trimStart) || 0;
      const speed = clamp(Number(item.speed) || 1, 0.25, 4);
      const current = Math.max(0, (Number(this.els.video.currentTime) || 0) - start) / speed;
      this.els.clipTime.textContent = formatTimecode(Math.min(current, this.itemDuration(item)));
      this.els.clipDuration.textContent = formatTimecode(this.itemDuration(item));
    }

    syncPlayButton() {
      const item = this.selected();
      const canPlay = Boolean(item && item.kind === 'video' && !this.state.previewVisible);
      const playing = canPlay && !this.els.video.paused && !this.els.video.ended;
      setIcon(this.els.playBtn.querySelector('svg'), playing ? 'pause' : 'play');
      this.els.playBtn.disabled = !canPlay;
      this.els.playBtn.title = playing ? 'Durdur' : 'Seçili videoyu oynat';
      this.els.prevBtn.disabled = this.selectedIndex() <= 0;
      this.els.nextBtn.disabled = this.selectedIndex() >= this.state.items.length - 1;
    }

    togglePlay() {
      const item = this.selected();
      if (!item || item.kind !== 'video' || this.state.previewVisible) return;
      const video = this.els.video;
      if (video.paused) {
        const start = Number(item.trimStart) || 0;
        const end = Number(item.trimEnd) || Number(item.meta.duration) || 0;
        if (video.currentTime < start - 0.02 || video.currentTime >= end - 0.02) {
          try { video.currentTime = start; } catch { /* ignore */ }
        }
        video.playbackRate = clamp(Number(item.speed) || 1, 0.25, 4);
        video.play().catch(() => {
          toast('Video önizlemesi başlatılamadı.', { type: 'warn' });
        });
      } else {
        video.pause();
      }
    }

    pauseVideo() {
      try { this.els.video.pause(); } catch { /* ignore */ }
    }

    pause() {
      this.pauseVideo();
      this.syncPlayButton();
    }

    layoutFrame() {
      if (!this.els.frame || !this.els.stage) return;
      const stageRect = this.els.stage.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;
      let ratio = 16 / 9;
      if (this.state.previewVisible && this.state.previewDims) {
        ratio = this.state.previewDims.width / Math.max(1, this.state.previewDims.height);
      } else {
        const item = this.selected();
        if (item) {
          ratio = ratioValue(item.cropRatio) || this.canvasRatio();
        }
      }
      if (!(ratio > 0)) ratio = 16 / 9;
      const maxWidth = Math.max(80, stageRect.width - 48);
      const maxHeight = Math.max(80, stageRect.height - 48);
      let width = maxWidth;
      let height = width / ratio;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
      }
      this.els.frame.style.width = `${Math.round(width)}px`;
      this.els.frame.style.height = `${Math.round(height)}px`;
    }

    invalidatePreview() {
      this.previewToken += 1;
      // Hazırlanmakta olan önizleme artık geçersiz; FFmpeg'i boşuna çalıştırma.
      if (this.previewJobId) {
        this.api.cancelJob(this.previewJobId).catch(() => {});
        this.previewJobId = null;
      }
      if (!this.state.previewVisible && !this.state.previewBusy && !this.state.previewUrl) return;
      this.state.previewVisible = false;
      this.state.previewBusy = false;
      this.state.previewUrl = '';
      this.state.previewDims = null;
      this.showLoading(false);
      this.els.previewImg.hidden = true;
      this.els.previewImg.removeAttribute('src');
      this.els.previewTag.hidden = true;
      this.els.previewBtn.disabled = false;
      this.els.previewBtn.title = 'GIF önizle';
      setIcon(this.els.previewBtn.querySelector('svg'), 'play');
      this.loadSelectedStage();
      this.renderHeader();
    }

    clearPreview() {
      if (!this.state.previewVisible && !this.state.previewBusy) return;
      this.invalidatePreview();
    }

    async togglePreview() {
      if (this.state.previewBusy) return;
      if (this.state.previewVisible) {
        this.clearPreview();
        return;
      }
      if (!this.state.items.length) return;
      const token = ++this.previewToken;
      const jobId = newJobId();
      this.previewJobId = jobId;
      this.state.previewBusy = true;
      this.showLoading(true, 'GIF önizleniyor');
      this.els.previewBtn.disabled = true;
      this.els.previewBtn.title = 'Önizleme hazırlanıyor';
      try {
        const result = await this.api.previewGif({
          items: this.buildItems(),
          settings: this.exportSettings(),
          jobId,
        });
        if (token !== this.previewToken) return;
        this.previewJobId = null;
        if (!result || result.ok === false || !result.url) {
          throw new Error(result?.message || 'GIF önizlemesi oluşturulamadı.');
        }
        this.state.previewUrl = result.url;
        this.state.previewDims = { width: result.width, height: result.height };
        this.state.previewVisible = true;
        this.state.previewBusy = false;
        this.showLoading(false);
        this.els.previewBtn.title = 'Klibe dön';
        setIcon(this.els.previewBtn.querySelector('svg'), 'close');
        this.loadSelectedStage();
        this.renderHeader();
      } catch (error) {
        if (token !== this.previewToken) return;
        this.previewJobId = null;
        this.state.previewBusy = false;
        this.showLoading(false);
        this.els.previewBtn.title = 'GIF önizle';
        setIcon(this.els.previewBtn.querySelector('svg'), 'play');
        toast(error.message || 'GIF önizlemesi oluşturulamadı.', { type: 'error', timeout: 6000 });
      } finally {
        if (token === this.previewToken) {
          this.els.previewBtn.disabled = false;
        }
      }
    }

    async chooseFolder() {
      const dir = await this.api.openFolder(this.state.outputDir || this.appConfig.gifOutputDir);
      if (!dir) return null;
      this.state.outputDir = dir;
      this.appConfig.gifOutputDir = dir;
      this.onConfigChange?.({ gifOutputDir: dir });
      if (!this.onConfigChange) this.api.setConfig({ gifOutputDir: dir }).catch(() => {});
      this.renderOutput();
      return dir;
    }

    buildItems() {
      return this.state.items.map((item) => ({
        path: item.path,
        kind: item.kind,
        trimStart: item.kind === 'video' ? Number(item.trimStart) || 0 : 0,
        trimEnd: item.kind === 'video' ? Number(item.trimEnd) || 0 : 0,
        speed: item.kind === 'video' ? clamp(Number(item.speed) || 1, 0.25, 4) : 1,
        duration: item.kind === 'photo' ? Math.max(0.1, Number(item.duration) || 2) : 0,
        cropRatio: item.cropRatio || 'auto',
      }));
    }

    buildExportPayload() {
      const dims = this.canvasDims();
      const total = this.totalDuration();
      const baseName = ui.sanitizeBaseName(
        this.state.baseName || `${fileStem(this.state.items[0]?.name || 'odak')}-gif`,
        'odak-gif',
      );
      const jobId = newJobId();
      return {
        kind: 'gif',
        items: this.buildItems(),
        settings: this.exportSettings(),
        outputDir: this.state.outputDir,
        baseName,
        jobId,
        display: {
          fileName: `${baseName}.gif`,
          folder: this.state.outputDir,
          summary: this.els.summary.textContent,
          outNote: this.els.outNote.textContent,
          width: dims.width,
          height: dims.height,
          duration: total,
          fps: this.state.settings.fps,
        },
      };
    }

    async export() {
      if (!this.state.items.length) return;
      if (!this.state.baseName.trim()) {
        this.state.baseName = `${fileStem(this.state.items[0].name)}-gif`;
        this.renderOutput();
      }
      const total = this.totalDuration();
      const frames = Math.ceil(total * this.state.settings.fps);
      if (total < 0.1) {
        toast('GIF için en az 0,1 saniyelik bir klip gerekir.', { type: 'warn' });
        return;
      }
      if (total > MAX_SECONDS || frames > MAX_FRAMES) {
        toast(`GIF çok uzun. En fazla ${MAX_SECONDS} saniye veya ${MAX_FRAMES} kare kullanın.`, { type: 'warn' });
        return;
      }
      if (!this.state.outputDir) {
        const dir = await this.chooseFolder();
        if (!dir) {
          toast('GIF oluşturmak için bir çıktı klasörü seçin.', { type: 'warn' });
          return;
        }
      }
      this.pauseVideo();
      this.invalidatePreview();
      const payload = this.buildExportPayload();
      if (typeof this.onExportRequest === 'function') this.onExportRequest(payload);
    }
  }

  window.GifEditor = GifEditor;
})();
