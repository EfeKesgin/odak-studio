'use strict';

(function () {
  const ui = window.OdakUI;
  const {
    $, clamp, even, formatBytes, formatTimecode, formatClock, formatDuration,
    formatBitrate, formatResolution, fileStem, shortenPath, setIcon, toast, parseNumber, clearToasts,
  } = ui;

  const CODEC_LABELS = {
    h264: 'H.264',
    h265: 'H.265',
    vp9: 'VP9',
    prores: 'ProRes',
  };

  const SOURCE_CODEC_LABELS = {
    h264: 'H.264',
    hevc: 'H.265',
    vp9: 'VP9',
    av1: 'AV1',
    prores: 'ProRes',
    mpeg4: 'MPEG-4',
    mpeg2video: 'MPEG-2',
    vp8: 'VP8',
    theora: 'Theora',
  };

  // Geri al / yinele kapsamındaki düzenleme alanları.
  const HISTORY_FIELDS = [
    'inPoint', 'outPoint', 'segments', 'rotation', 'flipH', 'flipV', 'crop', 'resize',
    'speed', 'audioMode', 'textLayers', 'burnSubtitle',
  ];

  function sourceCodecLabel(codec) {
    return SOURCE_CODEC_LABELS[String(codec || '').toLowerCase()] || String(codec || '—').toUpperCase();
  }

  function fpsText(fps) {
    const value = Number(fps) || 0;
    if (!value) return null;
    return `${Math.abs(value - Math.round(value)) < 0.01 ? Math.round(value) : value.toFixed(2)} fps`;
  }

  function modeLabel(mode) {
    if (mode === 'copy') return 'Kayıpsız kopya';
    if (mode === 'bitrate') return 'Hedef bit hızı';
    return 'CRF';
  }

  function sanitizeClientName(value, fallback = 'odak-cikti') {
    return window.OdakUI.sanitizeBaseName(value, fallback);
  }

  class VideoEditor {
    constructor({ api, config, onConfigChange, onExportRequest } = {}) {
      this.api = api;
      this.appConfig = config || {};
      this.onConfigChange = onConfigChange;
      this.onExportRequest = onExportRequest;
      this.loadToken = 0;
      this.loadingTimer = null;
      this.hardware = null;
      this.history = { undo: [], redo: [], lastKind: null, lastAt: 0 };
      this.scrubbing = null;
      this.handleDrag = null;
      this.reencodeNoticeShown = false;
      this.lastAudioMode = 'original';
      this.cropOverlay = new window.CropOverlay({
        overlay: document.getElementById('videoCropOverlay'),
        box: document.getElementById('videoCropBox'),
        sizeLabel: document.getElementById('videoCropSize'),
      });
      this.els = {
        editor: document.getElementById('videoEditor'),
        fileName: document.getElementById('videoFileName'),
        metaChips: document.getElementById('videoMetaChips'),
        replaceBtn: document.getElementById('videoReplaceBtn'),
        undoBtn: document.getElementById('videoUndoBtn'),
        redoBtn: document.getElementById('videoRedoBtn'),
        stage: document.getElementById('videoStage'),
        frame: document.getElementById('videoFrame'),
        video: document.getElementById('videoEl'),
        poster: document.getElementById('videoPoster'),
        fallback: document.getElementById('videoFallback'),
        fallbackText: document.getElementById('videoFallbackText'),
        stageBadge: document.getElementById('videoStageBadge'),
        loading: document.getElementById('videoLoading'),
        cropBar: document.getElementById('videoCropBar'),
        cropDims: document.getElementById('videoCropDims'),
        cropApply: document.getElementById('videoCropApply'),
        cropCancel: document.getElementById('videoCropCancel'),
        ratioPills: document.getElementById('videoRatioPills'),
        playBtn: document.getElementById('videoPlayBtn'),
        prevFrame: document.getElementById('videoPrevFrame'),
        nextFrame: document.getElementById('videoNextFrame'),
        currentTime: document.getElementById('videoCurrentTime'),
        totalTime: document.getElementById('videoTotalTime'),
        muteBtn: document.getElementById('videoMuteBtn'),
        frameBtn: document.getElementById('videoFrameBtn'),
        speedChip: document.getElementById('videoSpeedChip'),
        timeline: document.getElementById('videoTimeline'),
        tlTrack: document.getElementById('videoTlTrack'),
        filmstrip: document.getElementById('videoFilmstrip'),
        selection: document.getElementById('videoSelection'),
        shadeL: document.getElementById('videoShadeL'),
        shadeR: document.getElementById('videoShadeR'),
        handleIn: document.getElementById('videoHandleIn'),
        handleOut: document.getElementById('videoHandleOut'),
        playhead: document.getElementById('videoPlayhead'),
        rangeLabel: document.getElementById('videoRangeLabel'),
        scaleStart: document.getElementById('videoScaleStart'),
        scaleMid: document.getElementById('videoScaleMid'),
        scaleEnd: document.getElementById('videoScaleEnd'),
        trimStart: document.getElementById('trimStartInput'),
        trimEnd: document.getElementById('trimEndInput'),
        trimHint: document.getElementById('trimHint'),
        trimLength: document.getElementById('trimLength'),
        trimMode: document.getElementById('trimModeSwitch'),
        markInBtn: document.getElementById('videoMarkInBtn'),
        markOutBtn: document.getElementById('videoMarkOutBtn'),
        segmentDetails: document.getElementById('videoSegmentDetails'),
        resetTrim: document.getElementById('videoResetTrim'),
        addSegment: document.getElementById('videoAddSegment'),
        segmentList: document.getElementById('videoSegmentList'),
        segmentHint: document.getElementById('videoSegmentHint'),
        rotateLeft: document.getElementById('videoRotateLeft'),
        rotateRight: document.getElementById('videoRotateRight'),
        flipH: document.getElementById('videoFlipH'),
        flipV: document.getElementById('videoFlipV'),
        frameReset: document.getElementById('videoFrameReset'),
        cropBtn: document.getElementById('videoCropBtn'),
        cropState: document.getElementById('videoCropState'),
        resizeW: document.getElementById('videoResizeW'),
        resizeH: document.getElementById('videoResizeH'),
        resizeLock: document.getElementById('videoResizeLock'),
        scaleChips: document.getElementById('videoScaleChips'),
        speedSelect: document.getElementById('videoSpeed'),
        speedHint: document.getElementById('speedHint'),
        muteSwitch: document.getElementById('videoMuteSwitch'),
        audioMode: document.getElementById('videoAudioMode'),
        audioHint: document.getElementById('audioHint'),
        codecGrid: document.getElementById('videoCodecGrid'),
        codecNote: document.getElementById('codecNote'),
        codecHint: document.getElementById('codecHint'),
        encoderRow: document.getElementById('videoEncoderRow'),
        encoderMode: document.getElementById('videoEncoderMode'),
        encoderHint: document.getElementById('videoEncoderHint'),
        qualityMode: document.getElementById('videoQualityMode'),
        copyPane: document.getElementById('copyQualityPane'),
        crfPane: document.getElementById('crfQualityPane'),
        bitratePane: document.getElementById('bitrateQualityPane'),
        crfRange: document.getElementById('crfRange'),
        crfValue: document.getElementById('crfValue'),
        preset: document.getElementById('videoPreset'),
        bitrateInput: document.getElementById('bitrateInput'),
        bitrateHint: document.getElementById('bitrateHint'),
        bitrateWarn: document.getElementById('bitrateWarn'),
        textSection: document.getElementById('videoTextSection'),
        subtitleSection: document.getElementById('videoSubtitleSection'),
        subtitleNote: document.getElementById('videoSubtitleNote'),
        burnSubtitle: document.getElementById('videoBurnSubtitle'),
        subtitleHint: document.getElementById('videoSubtitleHint'),
        presetSelect: document.getElementById('videoPresetSelect'),
        presetSave: document.getElementById('videoPresetSave'),
        presetDelete: document.getElementById('videoPresetDelete'),
        presetSaveRow: document.getElementById('videoPresetSaveRow'),
        presetName: document.getElementById('videoPresetName'),
        presetConfirm: document.getElementById('videoPresetConfirm'),
        presetCancel: document.getElementById('videoPresetCancel'),
        sizePane: document.getElementById('sizeQualityPane'),
        sizeTarget: document.getElementById('sizeTargetInput'),
        sizeChips: document.getElementById('sizeChips'),
        sizeHint: document.getElementById('sizeHint'),
        sizeWarn: document.getElementById('sizeWarn'),
        baseName: document.getElementById('videoBaseName'),
        ext: document.getElementById('videoExt'),
        folderBtn: document.getElementById('videoFolderBtn'),
        folderPath: document.getElementById('videoFolderPath'),
        summary: document.getElementById('videoSummary'),
        outNote: document.getElementById('videoOutNote'),
        exportBtn: document.getElementById('videoExportBtn'),
        tabs: Array.from(document.querySelectorAll('.inspector-tab[data-vtab]')),
        panes: Array.from(document.querySelectorAll('[data-vpane]')),
        inspectorScroll: document.querySelector('#videoEditor .inspector-scroll'),
      };
      this.state = this.freshState();
      this.textEditor = new window.TextLayerEditor({
        host: this.els.textSection,
        frame: this.els.frame,
        timed: true,
        getCurrentTime: () => this.state.currentTime,
        onChange: (layers) => this.setTextLayers(layers),
      });
      this.bind();
      this.resizeObserver = new ResizeObserver(() => this.layoutFrame());
      this.resizeObserver.observe(this.els.stage);
      this.render();
    }

    freshState() {
      return {
        file: null,
        meta: null,
        loaded: false,
        duration: 0,
        inPoint: 0,
        outPoint: 0,
        // Kayıtlı kesim bölümleri; boşsa yalnızca giriş/çıkış seçimi dışa aktarılır.
        segments: [],
        currentTime: 0,
        rotation: 0,
        flipH: false,
        flipV: false,
        crop: null,
        resize: null,
        speed: 1,
        audioMode: 'original',
        quality: 'copy',
        codec: 'h264',
        crf: 16,
        preset: 'medium',
        bitrateKbps: 0,
        targetMB: 10,
        encoder: 'cpu',
        presetId: '',
        textLayers: [],
        burnSubtitle: -1,
        baseName: '',
        outputDir: this.appConfig.videoOutputDir || '',
        aspectLocked: true,
        videoBroken: false,
        videoReady: false,
        posterUrl: null,
        cropActive: false,
        cropRatio: null,
      };
    }

    hasMedia() {
      return Boolean(this.state.loaded && this.state.meta);
    }

    bind() {
      const els = this.els;
      els.replaceBtn.addEventListener('click', () => this.openVideo());
      els.undoBtn.addEventListener('click', () => this.undo());
      els.redoBtn.addEventListener('click', () => this.redo());
      els.playBtn.addEventListener('click', () => this.togglePlay());
      els.prevFrame.addEventListener('click', () => this.stepFrame(-1));
      els.nextFrame.addEventListener('click', () => this.stepFrame(1));
      els.muteBtn.addEventListener('click', () => this.toggleMute());
      els.frameBtn.addEventListener('click', () => this.saveFrame());
      els.muteSwitch.addEventListener('click', () => this.toggleMute());
      els.resetTrim.addEventListener('click', () => this.resetTrim());
      els.addSegment.addEventListener('click', () => this.addSegment());
      els.segmentList.addEventListener('click', (event) => {
        const item = event.target.closest('[data-segment]');
        if (!item) return;
        const index = Number(item.dataset.segment);
        if (event.target.closest('[data-remove]')) this.removeSegment(index);
        else this.selectSegment(index);
      });
      els.trimStart.addEventListener('change', () => this.commitTrimFields());
      els.trimEnd.addEventListener('change', () => this.commitTrimFields());
      els.trimStart.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.trimStart.blur(); });
      els.trimEnd.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.trimEnd.blur(); });
      els.markInBtn.addEventListener('click', () => this.markIn());
      els.markOutBtn.addEventListener('click', () => this.markOut());
      els.trimMode.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-trim-mode]');
        if (!button || button.disabled) return;
        this.setTrimMode(button.dataset.trimMode);
      });

      els.rotateLeft.addEventListener('click', () => this.rotate(-90));
      els.rotateRight.addEventListener('click', () => this.rotate(90));
      els.flipH.addEventListener('click', () => this.flip('h'));
      els.flipV.addEventListener('click', () => this.flip('v'));
      els.frameReset.addEventListener('click', () => this.resetFrame());

      els.cropBtn.addEventListener('click', () => this.openCrop());
      els.cropApply.addEventListener('click', () => this.applyCrop());
      els.cropCancel.addEventListener('click', () => this.cancelCrop());
      els.ratioPills.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-ratio]');
        if (!button) return;
        this.setCropRatio(button.dataset.ratio);
      });

      els.resizeW.addEventListener('change', () => this.commitResize('width'));
      els.resizeH.addEventListener('change', () => this.commitResize('height'));
      els.resizeW.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.resizeW.blur(); });
      els.resizeH.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.resizeH.blur(); });
      els.resizeLock.addEventListener('click', () => this.toggleAspectLock());
      els.scaleChips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-scale]');
        if (!button) return;
        this.applyScale(Number(button.dataset.scale));
      });
      els.speedSelect.addEventListener('change', () => this.setSpeed(Number(els.speedSelect.value)));

      els.audioMode.addEventListener('change', () => this.setAudioMode(els.audioMode.value));
      els.codecGrid.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-codec]');
        if (!button) return;
        this.setCodec(button.dataset.codec);
      });
      els.qualityMode.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-quality]');
        if (!button) return;
        this.setQuality(button.dataset.quality);
      });
      els.crfRange.addEventListener('input', () => {
        this.state.crf = Number(els.crfRange.value);
        this.outputSettingsChanged();
        this.renderQuality();
        this.renderSummary();
      });
      els.preset.addEventListener('change', () => {
        this.state.preset = els.preset.value;
        this.outputSettingsChanged();
        this.renderSummary();
      });
      els.burnSubtitle.addEventListener('change', () => this.setBurnSubtitle(Number(els.burnSubtitle.value)));
      els.encoderMode.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-encoder]');
        if (!button || !this.state.loaded) return;
        this.state.encoder = button.dataset.encoder === 'gpu' ? 'gpu' : 'cpu';
        this.rememberOutputSettings();
        this.renderQuality();
        this.renderSummary();
      });
      els.presetSelect.addEventListener('change', () => this.applyPreset(els.presetSelect.value));
      els.presetSave.addEventListener('click', () => this.showPresetSave(true));
      els.presetCancel.addEventListener('click', () => this.showPresetSave(false));
      els.presetConfirm.addEventListener('click', () => this.saveUserPreset());
      els.presetName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.saveUserPreset();
        else if (event.key === 'Escape') this.showPresetSave(false);
      });
      els.presetDelete.addEventListener('click', () => this.deleteUserPreset());
      els.bitrateInput.addEventListener('change', () => this.commitBitrate());
      els.bitrateInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.bitrateInput.blur(); });
      els.sizeTarget.addEventListener('change', () => this.setTargetSize(parseNumber(els.sizeTarget.value, this.state.targetMB)));
      els.sizeTarget.addEventListener('keydown', (event) => { if (event.key === 'Enter') els.sizeTarget.blur(); });
      els.sizeChips.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-size]');
        if (button) this.setTargetSize(Number(button.dataset.size));
      });

      els.baseName.addEventListener('input', () => {
        this.state.baseName = els.baseName.value;
        this.renderOutput();
      });
      els.folderBtn.addEventListener('click', () => this.chooseFolder());
      els.exportBtn.addEventListener('click', () => this.export());

      els.tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
          const name = tab.dataset.vtab;
          els.tabs.forEach((item) => item.classList.toggle('active', item === tab));
          els.panes.forEach((pane) => { pane.hidden = pane.dataset.vpane !== name; });
          if (name === 'output') els.inspectorScroll.scrollTop = 0;
        });
      });

      els.video.addEventListener('loadedmetadata', () => {
        this.hideLoadingSoon();
        this.layoutFrame();
        this.updateTimeUI();
      });
      els.video.addEventListener('loadeddata', () => {
        if (this.state.videoBroken) return;
        this.state.videoReady = true;
        this.showLoading(false);
        els.poster.classList.add('hidden');
        els.fallback.classList.add('hidden');
        els.video.classList.remove('hidden');
        this.syncPlayButton();
      });
      els.video.addEventListener('error', () => this.onVideoError());
      els.video.addEventListener('timeupdate', () => this.onTimeUpdate());
      els.video.addEventListener('play', () => this.syncPlayButton());
      els.video.addEventListener('pause', () => this.syncPlayButton());
      els.video.addEventListener('ended', () => this.onEnded());
      this.bindTimeline();
    }

    async openVideo() {
      const paths = await this.api.openFiles({ kind: 'video' });
      if (paths && paths[0]) await this.load(paths[0]);
    }

    async load(file) {
      if (!file) return false;
      clearToasts();
      const token = ++this.loadToken;
      this.showLoading(true);
      try {
        this.els.video.pause();
      } catch { /* ignore */ }
      let meta;
      let url;
      try {
        meta = await this.api.probe(file);
        if (token !== this.loadToken) return false;
        if (meta.kind !== 'video') throw new Error('Bu dosya bir video değil.');
        url = await this.api.mediaUrl(file);
        if (token !== this.loadToken) return false;
      } catch (error) {
        if (token === this.loadToken) {
          this.showLoading(false);
          toast(error.message || 'Video açılamadı.', { type: 'error' });
        }
        return false;
      }

      const previousDir = this.state.outputDir || this.appConfig.videoOutputDir || '';
      this.state = this.freshState();
      this.state.file = file;
      this.state.meta = meta;
      this.state.outputDir = previousDir;
      this.state.loaded = true;
      this.state.duration = Math.max(0, Number(meta.duration) || 0);
      this.state.inPoint = 0;
      this.state.outPoint = this.state.duration;
      this.state.currentTime = 0;
      this.state.codec = meta.isHdr || meta.bitDepth > 8 ? 'h265' : 'h264';
      this.state.audioMode = meta.hasAudio ? 'original' : 'none';
      this.state.quality = 'copy';
      this.applyRememberedSettings();
      this.showPresetSave(false);
      this.textEditor.setLayers([]);
      this.textEditor.setHidden(false);
      this.renderSubtitles();
      this.resetHistory();
      this.state.bitrateKbps = Math.max(100, Math.round((Number(meta.videoBitrate) || Number(meta.overallBitrate) || 4000) / 1000));
      this.state.baseName = `${fileStem(meta.name)}-odak`;
      this.lastAudioMode = this.state.audioMode === 'none' ? 'original' : this.state.audioMode;
      this.reencodeNoticeShown = false;
      this.cropOverlay.close();
      this.els.cropBar.hidden = true;
      this.els.poster.classList.add('hidden');
      this.els.poster.removeAttribute('src');
      this.els.fallback.classList.add('hidden');
      this.els.video.classList.remove('hidden');
      this.els.video.muted = this.state.audioMode === 'none';
      this.els.video.playbackRate = 1;
      this.els.filmstrip.style.backgroundImage = '';
      this.state.videoBroken = false;
      this.state.videoReady = false;
      this.els.selection.classList.remove('hidden');

      try {
        this.els.video.src = url;
        this.els.video.load();
      } catch {
        this.onVideoError();
      }
      this.showLoading(true);
      clearTimeout(this.loadingTimer);
      this.loadingTimer = setTimeout(() => {
        if (token === this.loadToken) this.showLoading(false);
      }, 2200);

      this.prefetchExtras(token);
      this.render();
      this.els.inspectorScroll.scrollTop = 0;
      this.els.tabs.forEach((tab, index) => tab.classList.toggle('active', index === 0));
      this.els.panes.forEach((pane) => { pane.hidden = pane.dataset.vpane !== 'edit'; });
      requestAnimationFrame(() => this.layoutFrame());
      return true;
    }

    prefetchExtras(token) {
      const state = this.state;
      if (!state.meta) return;
      this.api.poster({ path: state.file, duration: state.duration })
        .then((url) => {
          if (!url || token !== this.loadToken) return;
          this.state.posterUrl = url;
          if (this.state.videoBroken || !this.state.videoReady) {
            this.els.poster.src = url;
            this.els.poster.classList.remove('hidden');
          }
        })
        .catch(() => {});
      this.api.filmstrip({ path: state.file, duration: state.duration })
        .then((url) => {
          if (!url || token !== this.loadToken) return;
          this.els.filmstrip.style.backgroundImage = `url("${url}")`;
        })
        .catch(() => {});
    }

    showLoading(show) {
      this.els.loading.hidden = !show;
      this.els.loading.classList.toggle('hidden', !show);
    }

    hideLoadingSoon() {
      clearTimeout(this.loadingTimer);
      this.els.loading.hidden = true;
      this.els.loading.classList.add('hidden');
    }

    onVideoError() {
      if (!this.state.meta) return;
      this.state.videoBroken = true;
      this.state.videoReady = false;
      this.showLoading(false);
      this.els.video.classList.add('hidden');
      this.els.fallback.classList.remove('hidden');
      this.els.fallbackText.textContent = `${sourceCodecLabel(this.state.meta.videoCodec)} codec tarayıcıda açılamıyor. Kesim, kare kaydetme ve dışa aktarma çalışmaya devam eder.`;
      if (this.state.posterUrl) {
        this.els.poster.src = this.state.posterUrl;
        this.els.poster.classList.remove('hidden');
      }
      this.syncPlayButton();
    }

    onTimeUpdate() {
      const video = this.els.video;
      if (!this.state.loaded || !video) return;
      const current = Number(video.currentTime) || 0;
      this.state.currentTime = current;
      this.updateTimeUI();
      if (!video.paused && this.state.outPoint > this.state.inPoint && current >= this.state.outPoint - 0.02) {
        video.pause();
        this.seekTo(this.state.outPoint, false);
      }
    }

    // Video sonuna kadar oynadığında oynatıcıyı kesimin başına geri sar;
    // aksi halde sonraki oynatma 0. saniyeden başlar.
    onEnded() {
      this.syncPlayButton();
      this.seekTo(this.state.inPoint);
    }

    updateTimeUI() {
      const duration = Math.max(0.001, this.state.duration);
      this.els.currentTime.textContent = formatTimecode(this.state.currentTime);
      this.els.totalTime.textContent = formatTimecode(this.state.duration);
      const percent = clamp((this.state.currentTime / duration) * 100, 0, 100);
      this.els.playhead.style.left = `${percent}%`;
      this.textEditor?.refreshTime();
    }

    syncPlayButton() {
      const playing = Boolean(this.els.video) && !this.els.video.paused && !this.els.video.ended;
      const icon = this.els.playBtn.querySelector('svg');
      setIcon(icon, playing ? 'pause' : 'play');
      icon?.classList.add('fill');
      this.els.playBtn.disabled = !this.state.loaded || this.state.videoBroken;
      this.els.playBtn.title = playing ? 'Durdur (Space)' : 'Oynat (Space)';
    }

    togglePlay() {
      if (!this.state.loaded || this.state.videoBroken) return;
      const video = this.els.video;
      if (video.paused) {
        if (this.state.currentTime < this.state.inPoint - 0.02 || this.state.currentTime >= this.state.outPoint - 0.02) {
          this.seekTo(this.state.inPoint);
        }
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    }

    pause() {
      try { this.els.video.pause(); } catch { /* ignore */ }
      this.syncPlayButton();
    }

    stepFrame(direction) {
      if (!this.state.loaded) return;
      const fps = Number(this.state.meta?.fps) || 30;
      try { this.els.video.pause(); } catch { /* ignore */ }
      const next = this.state.currentTime + (direction / fps);
      this.seekTo(clamp(next, 0, this.state.duration));
    }

    seekTo(time, updateVideo = true) {
      if (!this.state.loaded) return;
      const clamped = clamp(Number(time) || 0, 0, this.state.duration);
      this.state.currentTime = clamped;
      if (updateVideo && !this.state.videoBroken) {
        try { this.els.video.currentTime = clamped; } catch { /* ignore */ }
      }
      this.updateTimeUI();
    }

    toggleMute() {
      if (!this.state.loaded) return;
      this.remember('audio');
      if (this.state.meta && !this.state.meta.hasAudio) {
        toast('Bu videoda ses akışı yok.', { type: 'warn' });
        return;
      }
      if (this.state.audioMode === 'none') {
        this.state.audioMode = this.lastAudioMode || 'original';
        if (this.state.audioMode === 'none') this.state.audioMode = 'original';
      } else {
        this.lastAudioMode = this.state.audioMode;
        this.state.audioMode = 'none';
      }
      this.els.video.muted = this.state.audioMode === 'none';
      this.renderAudio();
      this.renderOutput();
      this.renderSummary();
    }

    setAudioMode(mode) {
      if (!this.state.loaded) return;
      this.remember('audio');
      const hasAudio = Boolean(this.state.meta?.hasAudio);
      this.state.audioMode = !hasAudio ? 'none' : ['original', 'aac', 'none'].includes(mode) ? mode : 'original';
      if (this.state.audioMode !== 'none') this.lastAudioMode = this.state.audioMode;
      this.els.video.muted = this.state.audioMode === 'none';
      this.renderAudio();
      this.renderOutput();
      this.renderSummary();
    }

    openCrop() {
      if (!this.state.loaded || this.state.cropActive) return;
      try { this.els.video.pause(); } catch { /* ignore */ }
      const dims = this.getRotatedDims();
      if (dims.width < 2 || dims.height < 2) return;
      this.state.cropActive = true;
      this.state.cropRatio = null;
      // Kırpma sırasında kare kırpılmamış görüntüyü gösterir; metin konumu
      // çıktıya göre olduğu için o sırada gizlenir.
      this.textEditor.setHidden(true);
      this.els.cropBar.hidden = false;
      this.els.cropBar.classList.remove('hidden');
      this.els.cropBtn.classList.add('active');
      this.els.cropState.textContent = 'Kırpma modu';
      this.els.ratioPills.querySelectorAll('button').forEach((button) => {
        button.classList.toggle('active', button.dataset.ratio === 'free');
      });
      this.cropOverlay.setSourceSize(dims.width, dims.height);
      const existing = this.state.crop;
      const rect = existing ? {
        x: existing.x / dims.width,
        y: existing.y / dims.height,
        w: existing.width / dims.width,
        h: existing.height / dims.height,
      } : { x: 0, y: 0, w: 1, h: 1 };
      this.cropOverlay.open({
        rect,
        sourceWidth: dims.width,
        sourceHeight: dims.height,
        onChange: (cropRect) => this.updateCropReadout(cropRect, dims),
      });
      this.updateCropReadout(rect, dims);
      requestAnimationFrame(() => {
        this.layoutFrame();
        this.cropOverlay.setSourceSize(this.getRotatedDims().width, this.getRotatedDims().height);
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
      this.els.cropBtn.classList.remove('active');
      this.renderCropState();
      requestAnimationFrame(() => this.layoutFrame());
    }

    applyCrop() {
      if (!this.state.cropActive) return;
      this.remember('crop');
      const dims = this.getRotatedDims();
      const rect = this.cropOverlay.getRect();
      let x = Math.round(rect.x * dims.width);
      let y = Math.round(rect.y * dims.height);
      let width = Math.round(rect.w * dims.width);
      let height = Math.round(rect.h * dims.height);
      x = clamp(x, 0, Math.max(0, dims.width - 2));
      y = clamp(y, 0, Math.max(0, dims.height - 2));
      width = clamp(width, 2, dims.width - x);
      height = clamp(height, 2, dims.height - y);
      width = Math.max(2, even(width));
      height = Math.max(2, even(height));
      if (width >= dims.width - 2 && height >= dims.height - 2) {
        this.state.crop = null;
      } else {
        this.state.crop = { x, y, width, height };
      }
      const hadResize = Boolean(this.state.resize);
      this.state.resize = null;
      this.state.cropActive = false;
      this.textEditor.setHidden(false);
      this.cropOverlay.close();
      this.els.cropBar.hidden = true;
      this.els.cropBar.classList.add('hidden');
      this.els.cropBtn.classList.remove('active');
      this.ensureEditsQuality();
      this.renderCropState();
      this.renderResize();
      this.renderQuality();
      this.renderSummary();
      this.renderOutput();
      requestAnimationFrame(() => this.layoutFrame());
      if (this.state.crop) {
        const suffix = hadResize ? ' · boyut ayarı sıfırlandı' : '';
        toast(`Kırpma uygulandı · ${this.state.crop.width} × ${this.state.crop.height}${suffix}`, { type: 'success' });
      } else {
        toast('Kırpma kaldırıldı.');
      }
    }

    rotate(delta) {
      if (!this.state.loaded) return;
      this.remember('rotate');
      this.cancelCrop();
      const hadCrop = Boolean(this.state.crop);
      if (hadCrop) this.state.crop = null;
      this.state.resize = null;
      this.state.rotation = ((this.state.rotation + delta) % 360 + 360) % 360;
      this.ensureEditsQuality();
      this.renderTransformControls();
      this.renderCropState();
      this.renderResize();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
      this.layoutFrame();
      if (hadCrop) toast('Döndürme sonrası kırpma sıfırlandı.', { type: 'warn' });
    }

    flip(axis) {
      if (!this.state.loaded) return;
      this.remember('flip');
      this.cancelCrop();
      if (axis === 'h') this.state.flipH = !this.state.flipH;
      else this.state.flipV = !this.state.flipV;
      if (this.state.crop) {
        const dims = this.getRotatedDims();
        if (axis === 'h') this.state.crop.x = dims.width - this.state.crop.x - this.state.crop.width;
        else this.state.crop.y = dims.height - this.state.crop.y - this.state.crop.height;
      }
      this.ensureEditsQuality();
      this.renderTransformControls();
      this.renderCropState();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
      this.layoutFrame();
    }

    resetFrame() {
      if (!this.state.loaded) return;
      this.remember('frame');
      this.cancelCrop();
      this.state.rotation = 0;
      this.state.flipH = false;
      this.state.flipV = false;
      this.state.crop = null;
      this.state.resize = null;
      this.ensureEditsQuality();
      this.renderTransformControls();
      this.renderCropState();
      this.renderResize();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
      this.layoutFrame();
      toast('Kadraj sıfırlandı.');
    }

    getRotatedDims() {
      const meta = this.state.meta;
      if (!meta) return { width: 0, height: 0 };
      const rotated = this.state.rotation === 90 || this.state.rotation === 270;
      return rotated
        ? { width: meta.height, height: meta.width }
        : { width: meta.width, height: meta.height };
    }

    getBaseDims() {
      if (this.state.crop) {
        return { width: this.state.crop.width, height: this.state.crop.height };
      }
      return this.getRotatedDims();
    }

    getOutputDims() {
      const base = this.getBaseDims();
      const target = this.state.resize || base;
      return {
        width: Math.max(2, even(target.width)),
        height: Math.max(2, even(target.height)),
      };
    }

    copyAllowed() {
      return !this.state.rotation && !this.state.flipH && !this.state.flipV && !this.state.crop &&
        !this.state.resize && Math.abs(this.state.speed - 1) < 0.0001 &&
        !this.state.textLayers.length && this.state.burnSubtitle < 0;
    }

    setTextLayers(layers) {
      if (!this.state.loaded) return;
      this.remember('text');
      this.state.textLayers = layers;
      this.ensureEditsQuality();
      this.renderQuality();
      this.renderTrim();
      this.renderOutput();
      this.renderSummary();
    }

    renderSubtitles() {
      const tracks = this.state.meta?.subtitleTracks || [];
      this.els.subtitleSection.hidden = !tracks.length;
      if (!tracks.length) return;
      const select = this.els.burnSubtitle;
      select.textContent = '';
      const none = document.createElement('option');
      none.value = '-1';
      none.textContent = 'Yakma (ayrı altyazı olarak kalır)';
      select.appendChild(none);
      const bitmap = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];
      tracks.forEach((track, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        const language = track.language && track.language !== 'und' ? ` · ${track.language}` : '';
        const isBitmap = bitmap.includes(track.codec);
        option.textContent = `${index + 1}. iz · ${String(track.codec || '?').toUpperCase()}${language}${isBitmap ? ' (resim, yakılamaz)' : ''}`;
        option.disabled = isBitmap;
        select.appendChild(option);
      });
      select.value = String(this.state.burnSubtitle);
      this.els.subtitleNote.textContent = `${tracks.length} iz`;
      this.els.subtitleHint.textContent = this.state.burnSubtitle >= 0
        ? 'Bu iz görüntüye kalıcı olarak yakılır ve ayrı altyazı olarak eklenmez. Video yeniden kodlanır.'
        : 'Yakılan altyazı görüntünün parçası olur; her oynatıcıda görünür ama kapatılamaz.';
    }

    setBurnSubtitle(index) {
      if (!this.state.loaded) return;
      this.remember('subtitle');
      const tracks = this.state.meta?.subtitleTracks || [];
      this.state.burnSubtitle = Number.isInteger(index) && index >= 0 && index < tracks.length ? index : -1;
      this.ensureEditsQuality();
      this.renderSubtitles();
      this.renderQuality();
      this.renderAudio();
      this.renderTrim();
      this.renderOutput();
      this.renderSummary();
    }

    ensureEditsQuality() {
      if (!this.copyAllowed() && this.state.quality === 'copy') {
        this.state.quality = 'crf';
        if (!this.reencodeNoticeShown) {
          this.reencodeNoticeShown = true;
          toast('Görsel değişiklikler için video yeniden kodlanacak; kesim türü "Tam kesim" oldu.', { type: 'warn' });
        }
        this.renderAudio();
      }
      this.renderTrim();
    }

    layoutFrame() {
      const meta = this.state.meta;
      if (!meta || !meta.width || !meta.height) return;
      const rect = this.els.stage.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      const padX = Math.min(64, Math.max(30, rect.width * 0.055));
      const padY = Math.min(48, Math.max(22, rect.height * 0.065));
      const availW = Math.max(40, rect.width - padX);
      const availH = Math.max(40, rect.height - padY);
      const full = this.getRotatedDims();
      const crop = this.state.crop;
      const showCrop = Boolean(crop) && !this.state.cropActive;
      const windowDims = showCrop ? { width: crop.width, height: crop.height } : full;
      const scale = Math.min(availW / windowDims.width, availH / windowDims.height);
      const frameW = Math.max(30, windowDims.width * scale);
      const frameH = Math.max(30, windowDims.height * scale);
      this.els.frame.style.width = `${frameW}px`;
      this.els.frame.style.height = `${frameH}px`;
      let contentW = frameW;
      let contentH = frameH;
      let offsetX = 0;
      let offsetY = 0;
      if (showCrop) {
        const scaleX = frameW / crop.width;
        const scaleY = frameH / crop.height;
        contentW = full.width * scaleX;
        contentH = full.height * scaleY;
        offsetX = (crop.x + crop.width / 2 - full.width / 2) * scaleX;
        offsetY = (crop.y + crop.height / 2 - full.height / 2) * scaleY;
      }
      const swaps = this.state.rotation === 90 || this.state.rotation === 270;
      const videoW = swaps ? contentH : contentW;
      const videoH = swaps ? contentW : contentH;
      this.els.video.style.width = `${videoW}px`;
      this.els.video.style.height = `${videoH}px`;
      this.els.video.style.left = `calc(50% - ${offsetX}px)`;
      this.els.video.style.top = `calc(50% - ${offsetY}px)`;
      this.els.video.style.transform = `translate(-50%, -50%) scaleX(${this.state.flipH ? -1 : 1}) scaleY(${this.state.flipV ? -1 : 1}) rotate(${this.state.rotation}deg)`;
    }

    renderMeta() {
      const meta = this.state.meta;
      if (!meta) return;
      this.els.fileName.textContent = meta.name;
      this.els.fileName.title = meta.name;
      const chips = [
        formatResolution(meta.width, meta.height),
        formatTimecode(meta.duration),
      ];
      const fps = fpsText(meta.fps);
      if (fps) chips.push(fps);
      chips.push(sourceCodecLabel(meta.videoCodec));
      if (meta.videoBitrate || meta.overallBitrate) {
        chips.push(formatBitrate(meta.videoBitrate || meta.overallBitrate));
      }
      chips.push(formatBytes(meta.size));
      const audioTrackCount = meta.audioTracks?.length || 0;
      const subtitleCount = meta.subtitleTracks?.length || 0;
      if (audioTrackCount > 1) chips.push(`${audioTrackCount} ses izi`);
      if (subtitleCount) chips.push(`${subtitleCount} altyazı`);
      if (meta.bitDepth > 8) chips.push(`${meta.bitDepth}-bit`);
      if (meta.hasDolbyVision) chips.push('Dolby Vision');
      else if (meta.isHdr) chips.push('HDR');

      this.els.metaChips.textContent = '';
      for (const text of chips) {
        const span = document.createElement('span');
        span.textContent = text;
        if (['HDR', 'Dolby Vision'].includes(text)) span.classList.add('chip-quality');
        this.els.metaChips.appendChild(span);
      }
      const badgeParts = [
        formatResolution(meta.width, meta.height),
        fps,
        sourceCodecLabel(meta.videoCodec),
      ].filter(Boolean);
      this.els.stageBadge.textContent = badgeParts.join(' · ');
      this.els.stageBadge.title = meta.name;
    }

    render() {
      if (!this.state.meta) {
        this.els.exportBtn.disabled = true;
        return;
      }
      this.renderMeta();
      this.renderTrim();
      this.renderTransformControls();
      this.renderCropState();
      this.renderResize();
      this.renderQuality();
      this.renderAudio();
      this.renderOutput();
      this.renderSummary();
      this.syncPlayButton();
      this.updateTimeUI();
      requestAnimationFrame(() => this.layoutFrame());
    }

    bindTimeline() {
      const { tlTrack, handleIn, handleOut } = this.els;
      handleIn.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.startHandleDrag('in', event);
      });
      handleOut.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        this.startHandleDrag('out', event);
      });
      tlTrack.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.tl-handle')) return;
        this.startTrackScrub(event);
      });
    }

    timeAt(clientX) {
      const rect = this.els.tlTrack.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * this.state.duration;
    }

    startTrackScrub(event) {
      if (!this.state.loaded || event.button !== 0) return;
      event.preventDefault();
      try { this.els.video.pause(); } catch { /* ignore */ }
      this.seekTo(this.timeAt(event.clientX));
      const move = (moveEvent) => this.seekTo(this.timeAt(moveEvent.clientX));
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    }

    startHandleDrag(which, event) {
      if (!this.state.loaded || event.button !== 0) return;
      this.remember();
      event.preventDefault();
      try { this.els.video.pause(); } catch { /* ignore */ }
      const move = (moveEvent) => {
        const time = this.timeAt(moveEvent.clientX);
        const gap = Math.min(0.04, this.state.duration);
        if (which === 'in') {
          this.setTrim(Math.min(time, this.state.outPoint - gap), this.state.outPoint, false);
        } else {
          this.setTrim(this.state.inPoint, Math.max(time, this.state.inPoint + gap), false);
        }
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (which === 'in') this.seekTo(this.state.inPoint);
        else this.seekTo(this.state.outPoint);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    }

    setTrim(start, end, seek = true) {
      const duration = this.state.duration;
      const gap = Math.min(0.04, Math.max(0.001, duration));
      let nextStart = clamp(Number(start) || 0, 0, Math.max(0, duration - gap));
      let nextEnd = clamp(Number(end) || duration, nextStart + gap, duration);
      if (duration <= gap) {
        nextStart = 0;
        nextEnd = duration;
      }
      this.state.inPoint = nextStart;
      this.state.outPoint = nextEnd;
      if (seek && (this.state.currentTime < nextStart - 0.02 || this.state.currentTime > nextEnd + 0.02)) {
        this.seekTo(nextStart);
      }
      this.renderTrim();
      this.renderSummary();
      this.renderOutput();
    }

    resetTrim() {
      if (!this.state.loaded) return;
      this.remember();
      this.setTrim(0, this.state.duration);
      this.seekTo(0);
    }

    commitTrimFields() {
      if (!this.state.loaded) return;
      this.remember();
      const parse = (input, fallback) => {
        const value = window.OdakShared.parseTimecode(input.value);
        if (Number.isFinite(value)) return value;
        toast('Zamanı dakika:saniye (ör. 1:05.5) ya da saniye olarak yaz.', { type: 'warn' });
        return fallback;
      };
      const start = parse(this.els.trimStart, this.state.inPoint);
      const end = parse(this.els.trimEnd, this.state.outPoint);
      this.setTrim(start, end);
      this.renderTrim();
    }

    // Kesim türü, kalite modunun sade yüzüdür: "Hızlı" kayıpsız kopya,
    // "Tam" yeniden kodlamadır (CRF; bit hızı/boyut modları da tamdır).
    setTrimMode(mode) {
      if (!this.state.loaded) return;
      if (mode === 'fast') {
        if (this.state.quality !== 'copy') this.setQuality('copy');
      } else if (this.state.quality === 'copy') {
        this.setQuality('crf');
      }
    }

    renderTrim() {
      const duration = Math.max(0.001, this.state.duration);
      const inPercent = clamp((this.state.inPoint / duration) * 100, 0, 100);
      const outPercent = clamp((this.state.outPoint / duration) * 100, 0, 100);
      this.els.selection.style.left = `${inPercent}%`;
      this.els.selection.style.width = `${Math.max(0, outPercent - inPercent)}%`;
      this.els.shadeL.style.width = `${inPercent}%`;
      this.els.shadeR.style.width = `${Math.max(0, 100 - outPercent)}%`;
      this.els.rangeLabel.textContent = this.state.segments.length
        ? `${this.state.segments.length} bölüm · ${formatDuration(this.getOutputDuration() * Math.max(0.25, this.state.speed))}`
        : `${formatTimecode(this.state.inPoint)} — ${formatTimecode(this.state.outPoint)}`;
      this.renderSegments();
      this.els.scaleStart.textContent = formatClock(0);
      this.els.scaleMid.textContent = formatClock(duration / 2);
      this.els.scaleEnd.textContent = formatClock(duration);
      const forceHours = duration >= 3600;
      if (document.activeElement !== this.els.trimStart) {
        this.els.trimStart.value = formatTimecode(this.state.inPoint, forceHours);
      }
      if (document.activeElement !== this.els.trimEnd) {
        this.els.trimEnd.value = formatTimecode(this.state.outPoint, forceHours);
      }
      this.els.trimLength.textContent = formatTimecode(this.state.outPoint - this.state.inPoint, forceHours);
      const fast = this.state.quality === 'copy';
      const copyOk = this.copyAllowed();
      this.els.trimMode.querySelectorAll('button[data-trim-mode]').forEach((button) => {
        const isFast = button.dataset.trimMode === 'fast';
        button.classList.toggle('active', isFast === fast);
        button.disabled = isFast && !copyOk;
        button.title = isFast && !copyOk
          ? 'Kırpma, döndürme, boyut, hız veya metin varken video yeniden kodlanmak zorunda.'
          : '';
      });
      this.els.trimHint.textContent = fast
        ? 'Kalite hiç değişmez ve çok hızlıdır, ama başlangıç en yakın anahtar kareye kayabilir (genelde 1–2 sn erken).'
        : 'Başlangıç ve bitiş tam seçtiğin yerde olur. Video yüksek kalitede yeniden kodlanır.';
      if (this.state.segments.length) this.els.segmentDetails.open = true;
      if (Math.abs(this.state.speed - 1) > 0.0001) {
        this.els.speedChip.textContent = `${this.state.speed}×`;
        this.els.speedChip.hidden = false;
        this.els.speedChip.classList.remove('hidden');
      } else {
        this.els.speedChip.hidden = true;
        this.els.speedChip.classList.add('hidden');
      }
    }

    renderTransformControls() {
      this.els.flipH.classList.toggle('active', this.state.flipH);
      this.els.flipV.classList.toggle('active', this.state.flipV);
      this.els.rotateLeft.classList.toggle('active', this.state.rotation === 270);
      this.els.rotateRight.classList.toggle('active', this.state.rotation === 90);
      this.els.speedSelect.value = String(this.state.speed);
      this.els.speedHint.textContent = Math.abs(this.state.speed - 1) > 0.0001
        ? 'Hız değişince video ve ses yeniden kodlanır.'
        : 'Hız değişince video yeniden kodlanır.';
      this.layoutFrame();
    }

    renderCropState() {
      const crop = this.state.crop;
      this.els.cropState.textContent = crop ? `${crop.width} × ${crop.height}` : 'Tam kare';
      this.els.cropBtn.classList.toggle('active', this.state.cropActive);
      this.els.cropBtn.title = crop ? 'Kırpmayı düzenle' : 'Kırp';
      if (this.state.cropActive) {
        const dims = this.getRotatedDims();
        this.cropOverlay.setSourceSize(dims.width, dims.height);
      }
    }

    renderResize() {
      const dims = this.getOutputDims();
      if (document.activeElement !== this.els.resizeW) this.els.resizeW.value = dims.width;
      if (document.activeElement !== this.els.resizeH) this.els.resizeH.value = dims.height;
      const base = this.getBaseDims();
      const ratio = this.state.resize && base.width ? this.state.resize.width / base.width : 1;
      this.els.scaleChips.querySelectorAll('button[data-scale]').forEach((button) => {
        button.classList.toggle('active', Math.abs(Number(button.dataset.scale) - ratio) < 0.015);
      });
      this.els.resizeLock.classList.toggle('active', this.state.aspectLocked);
      this.els.resizeLock.setAttribute('aria-pressed', String(this.state.aspectLocked));
      const lockIcon = this.els.resizeLock.querySelector('svg');
      setIcon(lockIcon, this.state.aspectLocked ? 'lock' : 'unlock');
    }

    commitResize(changed) {
      if (!this.state.loaded) return;
      this.remember('resize');
      const base = this.getBaseDims();
      if (!base.width || !base.height) return;
      let width = parseNumber(this.els.resizeW.value, 0);
      let height = parseNumber(this.els.resizeH.value, 0);
      if (width < 2 || height < 2) {
        this.renderResize();
        return;
      }
      const aspect = base.width / base.height;
      if (this.state.aspectLocked) {
        if (changed === 'height') width = height * aspect;
        else height = width / aspect;
      }
      width = clamp(even(width), 2, 16384);
      height = clamp(even(height), 2, 16384);
      if (this.state.aspectLocked) {
        if (changed === 'height') width = clamp(even(height * aspect), 2, 16384);
        else height = clamp(even(width / aspect), 2, 16384);
      }
      const baseEvenW = Math.max(2, even(base.width));
      const baseEvenH = Math.max(2, even(base.height));
      this.state.resize = (width === baseEvenW && height === baseEvenH) ? null : { width, height };
      this.state.presetId = '';
      this.ensureEditsQuality();
      this.renderResize();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
    }

    applyScale(factor) {
      if (!this.state.loaded) return;
      this.remember();
      const base = this.getBaseDims();
      const cleanFactor = clamp(Number(factor) || 1, 0.1, 1);
      if (cleanFactor >= 0.999) {
        this.state.resize = null;
      } else {
        this.state.resize = {
          width: Math.max(2, even(base.width * cleanFactor)),
          height: Math.max(2, even(base.height * cleanFactor)),
        };
      }
      this.state.presetId = '';
      this.ensureEditsQuality();
      this.renderResize();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
    }

    toggleAspectLock() {
      this.state.aspectLocked = !this.state.aspectLocked;
      this.renderResize();
    }

    setSpeed(speed) {
      if (!this.state.loaded) return;
      this.remember();
      this.state.speed = clamp(Number(speed) || 1, 0.25, 4);
      if (!this.state.videoBroken) {
        try { this.els.video.playbackRate = this.state.speed; } catch { /* ignore */ }
      }
      this.ensureEditsQuality();
      this.renderTransformControls();
      this.renderTrim();
      this.renderQuality();
      this.renderOutput();
      this.renderSummary();
    }

    renderQuality() {
      if (!this.state.meta) return;
      if (this.state.codec === 'prores' && ['bitrate', 'size'].includes(this.state.quality)) this.state.quality = 'crf';
      if (this.state.quality === 'copy' && !this.copyAllowed()) this.state.quality = 'crf';
      const mode = this.state.quality;
      this.els.qualityMode.querySelectorAll('button[data-quality]').forEach((button) => {
        const isActive = button.dataset.quality === mode;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', String(isActive));
        if (button.dataset.quality === 'copy') {
          button.disabled = !this.copyAllowed();
          button.title = this.copyAllowed() ? 'Yeniden kodlama yapmadan kopyala' : 'Kırpma, döndürme, boyut veya hız değişikliği varken kullanılamaz';
        }
        if (button.dataset.quality === 'bitrate' || button.dataset.quality === 'size') {
          button.disabled = this.state.codec === 'prores';
        }
      });
      this.els.copyPane.hidden = mode !== 'copy';
      this.els.crfPane.hidden = mode !== 'crf';
      this.els.bitratePane.hidden = mode !== 'bitrate';
      this.els.sizePane.hidden = mode !== 'size';
      this.renderEncoder();
      this.els.codecGrid.classList.toggle('disabled', mode === 'copy');
      this.els.codecGrid.querySelectorAll('button[data-codec]').forEach((button) => {
        button.classList.toggle('active', button.dataset.codec === this.state.codec);
      });
      const ext = this.outputExt();
      this.els.codecNote.textContent = ext.replace('.', '').toUpperCase();
      this.els.crfRange.value = String(this.state.crf);
      this.els.crfValue.textContent = String(this.state.crf);
      const fillPercent = ((this.state.crf - 10) / 20) * 100;
      this.els.crfRange.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${fillPercent}%, rgba(255,255,255,0.09) ${fillPercent}%, rgba(255,255,255,0.09) 100%)`;
      this.els.preset.value = this.state.preset;
      const aacOption = this.els.audioMode.querySelector('option[value="aac"]');
      if (aacOption) {
        if (mode !== 'copy' && this.state.codec === 'prores') {
          aacOption.textContent = 'PCM 24-bit (ProRes)';
        } else if (mode !== 'copy' && this.state.codec === 'vp9') {
          aacOption.textContent = 'Opus 256 kbps';
        } else {
          aacOption.textContent = 'AAC 320 kbps';
        }
      }
      if (document.activeElement !== this.els.bitrateInput) {
        this.els.bitrateInput.value = this.state.bitrateKbps;
      }
      const sourceKbps = Math.round((this.state.meta.videoBitrate || this.state.meta.overallBitrate || 0) / 1000);
      this.els.bitrateHint.textContent = sourceKbps
        ? `Kaynak video: ~${window.OdakUI.formatNumber(sourceKbps)} kbps. Değer kaynağın altına inerse kalite düşer.`
        : 'Kaynak bit hızı okunamadı. Yüksek bir değer seçin.';
      const belowSource = sourceKbps > 0 && this.state.bitrateKbps < sourceKbps * 0.85;
      this.els.bitrateWarn.hidden = !belowSource;
      this.els.bitrateWarn.classList.toggle('hidden', !belowSource);
      if (mode === 'copy') {
        this.els.codecHint.textContent = this.state.meta.hasDolbyVision
          ? 'Kayıpsız kopyada Dolby Vision ve HDR bilgisi korunur; kapsayıcı kaynaktan gelir.'
          : 'Kayıpsız kopyada codec ve kapsayıcı kaynaktan gelir.';
      } else if (this.state.codec === 'prores') {
        this.els.codecHint.textContent = 'ProRes 422 HQ arşiv içindir; çok yüksek kalite, büyük dosya.';
      } else if (this.state.meta.hasDolbyVision) {
        this.els.codecHint.textContent = 'Dolby Vision kaynağı: yeniden kodlama DV katmanını korumaz. DV’yi korumak için kayıpsız kopya modunu kullanın.';
      } else if (this.state.meta.bitDepth > 8 && this.state.codec === 'h264') {
        this.els.codecHint.textContent = '10-bit kaynak H.264 çıktıda 10-bit kalır ancak bazı oynatıcılarda desteklenmez. H.265 önerilir.';
      } else if (this.state.meta.isHdr) {
        this.els.codecHint.textContent = 'HDR kaynak: H.265 seçimi renk bilgisini korur.';
      } else {
        this.els.codecHint.textContent = 'H.264 geniş uyumluluk, H.265 daha küçük dosya, ProRes arşiv içindir.';
      }
    }

    userPresets() {
      return window.OdakShared.cleanUserPresets(this.appConfig.preferences?.videoPresets);
    }

    findPreset(id) {
      return [...window.OdakShared.VIDEO_PRESETS, ...this.userPresets()].find((preset) => preset.id === id) || null;
    }

    // Kullanıcı codec/kalite ayarını elle değiştirdi: seçili hazır ayar artık
    // geçerli değil, son ayarlar bir sonraki video için hatırlanır.
    outputSettingsChanged() {
      this.state.presetId = '';
      this.rememberOutputSettings();
    }

    rememberOutputSettings() {
      if (!this.state.loaded) return;
      const { codec, quality, crf, preset, targetMB, encoder } = this.state;
      this.onConfigChange?.({ preferences: { video: { codec, quality, crf, preset, targetMB, encoder } } });
    }

    // GPU kodlayıcılar açılıştan kısa süre sonra tespit edilir.
    setHardware(hardware) {
      this.hardware = hardware && typeof hardware === 'object' ? hardware : null;
      if (this.state.meta) {
        this.renderQuality();
        this.renderSummary();
      }
    }

    // Bu çıktı ekran kartıyla kodlanacaksa üretici kodu (nvenc/qsv/amf).
    gpuVendor() {
      if (this.state.encoder !== 'gpu' || this.state.quality === 'copy') return null;
      return this.hardware?.[this.state.codec]?.[0] || null;
    }

    renderEncoder() {
      const available = this.hardware?.[this.state.codec] || [];
      const show = this.state.quality !== 'copy' && available.length > 0;
      this.els.encoderRow.hidden = !show;
      if (!show) return;
      this.els.encoderMode.querySelectorAll('button[data-encoder]').forEach((button) => {
        button.classList.toggle('active', button.dataset.encoder === this.state.encoder);
      });
      const label = this.hardware.labels?.[available[0]] || 'Ekran kartı';
      if (this.state.encoder === 'gpu') {
        const deepNote = this.state.meta?.bitDepth > 8 && this.state.codec === 'h264'
          ? ' 10-bit kaynak, H.264 donanım kodlamasında 8-bit olur; 10-bit için H.265 seçin.'
          : '';
        this.els.encoderHint.textContent = `${label} ile kodlanır: birkaç kat daha hızlı, aynı kalite ayarında dosya biraz daha büyük olabilir.${deepNote}`;
      } else {
        this.els.encoderHint.textContent = `İşlemci en iyi sıkıştırmayı verir. ${label} çok daha hızlıdır.`;
      }
    }

    // Son kullanılan codec ve kalite ayarları yeni açılan videoya uygulanır.
    applyRememberedSettings() {
      const raw = this.appConfig.preferences?.video;
      if (raw?.encoder === 'gpu') this.state.encoder = 'gpu';
      const remembered = window.OdakShared.cleanVideoPresetSettings(raw);
      if (remembered.codec) this.state.codec = remembered.codec;
      if (remembered.crf) this.state.crf = remembered.crf;
      if (remembered.preset) this.state.preset = remembered.preset;
      if (remembered.targetMB) this.state.targetMB = remembered.targetMB;
      // Hedef boyut ve bit hızı o videoya özgü seçimlerdir; yeni videoya
      // taşınmaz, yalnızca kayıpsız / CRF tercihi hatırlanır.
      if (remembered.quality === 'copy' || remembered.quality === 'crf') this.state.quality = remembered.quality;
    }

    renderPresetSelect() {
      const select = this.els.presetSelect;
      const builtIn = window.OdakShared.VIDEO_PRESETS;
      const user = this.userPresets();
      const signature = JSON.stringify(user.map((preset) => [preset.id, preset.name]));
      if (select.dataset.signature !== signature) {
        select.dataset.signature = signature;
        select.textContent = '';
        const custom = document.createElement('option');
        custom.value = '';
        custom.textContent = 'Özel (elle ayarlandı)';
        select.appendChild(custom);
        const addGroup = (label, presets) => {
          if (!presets.length) return;
          const group = document.createElement('optgroup');
          group.label = label;
          for (const preset of presets) {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            group.appendChild(option);
          }
          select.appendChild(group);
        };
        addGroup('Hazır ayarlar', builtIn);
        addGroup('Kaydettiklerim', user);
      }
      const known = this.state.presetId && this.findPreset(this.state.presetId);
      select.value = known ? this.state.presetId : '';
      this.els.presetDelete.hidden = !(known && this.state.presetId.startsWith('user-'));
    }

    applyPreset(id) {
      if (!this.state.loaded) return;
      const preset = id ? this.findPreset(id) : null;
      if (!preset) {
        this.state.presetId = '';
        this.renderPresetSelect();
        return;
      }
      const settings = preset.settings;
      if (settings.quality === 'copy' && !this.copyAllowed()) {
        toast('Kırpma, döndürme, boyut veya hız değişikliği varken kayıpsız kopya uygulanamaz.', { type: 'warn' });
        this.renderPresetSelect();
        return;
      }
      if (settings.codec) this.state.codec = settings.codec;
      if (settings.crf) this.state.crf = settings.crf;
      if (settings.preset) this.state.preset = settings.preset;
      if (settings.targetMB) this.state.targetMB = settings.targetMB;
      if (settings.bitrateKbps) this.state.bitrateKbps = settings.bitrateKbps;
      if (settings.quality) this.state.quality = settings.quality;
      let resized = false;
      if (settings.maxEdge) {
        // Uzun kenar sınırı yalnızca küçültür; küçük videolar olduğu gibi kalır.
        const base = this.getBaseDims();
        const longEdge = Math.max(base.width, base.height);
        if (longEdge > settings.maxEdge) {
          const factor = settings.maxEdge / longEdge;
          this.state.resize = {
            width: Math.max(2, even(base.width * factor)),
            height: Math.max(2, even(base.height * factor)),
          };
          resized = true;
        }
      }
      this.state.presetId = preset.id;
      this.ensureEditsQuality();
      this.rememberOutputSettings();
      this.renderResize();
      this.renderQuality();
      this.renderAudio();
      this.renderTrim();
      this.renderOutput();
      this.renderSummary();
      const dims = this.getOutputDims();
      toast(`${preset.name} uygulandı${resized ? ` · ${dims.width} × ${dims.height}` : ''}`, { type: 'success' });
    }

    showPresetSave(show) {
      this.els.presetSaveRow.hidden = !show;
      this.els.presetSave.disabled = show;
      if (!show) return;
      const quality = this.state.quality === 'copy'
        ? 'Kayıpsız'
        : this.state.quality === 'size'
          ? `${this.state.targetMB} MB`
          : this.state.quality === 'bitrate'
            ? `${this.state.bitrateKbps} kbps`
            : `CRF ${this.state.crf}`;
      this.els.presetName.value = this.state.quality === 'copy' ? quality : `${CODEC_LABELS[this.state.codec]} · ${quality}`;
      this.els.presetName.focus();
      this.els.presetName.select();
    }

    saveUserPreset() {
      const name = this.els.presetName.value.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) {
        toast('Ayara bir ad verin.', { type: 'warn' });
        return;
      }
      const shared = window.OdakShared;
      const { codec, quality, crf, preset, targetMB, bitrateKbps } = this.state;
      const settings = shared.cleanVideoPresetSettings({
        codec, quality, crf, preset, targetMB, bitrateKbps: quality === 'bitrate' ? bitrateKbps : undefined,
      });
      const list = this.userPresets();
      // Aynı adla kaydedilen ayar eskisinin yerine geçer.
      const existing = list.find((entry) => entry.name.toLocaleLowerCase('tr-TR') === name.toLocaleLowerCase('tr-TR'));
      if (!existing && list.length >= shared.MAX_USER_PRESETS) {
        toast(`En fazla ${shared.MAX_USER_PRESETS} ayar kaydedilebilir. Önce birini silin.`, { type: 'warn' });
        return;
      }
      const id = existing ? existing.id : `user-${Date.now().toString(36)}`;
      const next = existing
        ? list.map((entry) => (entry.id === id ? { id, name, settings } : entry))
        : [...list, { id, name, settings }];
      this.onConfigChange?.({ preferences: { videoPresets: next } });
      this.state.presetId = id;
      this.showPresetSave(false);
      this.renderPresetSelect();
      toast(existing ? `"${name}" güncellendi.` : `"${name}" kaydedildi.`, { type: 'success' });
    }

    deleteUserPreset() {
      const id = this.state.presetId;
      if (!id.startsWith('user-')) return;
      const preset = this.findPreset(id);
      const next = this.userPresets().filter((entry) => entry.id !== id);
      this.onConfigChange?.({ preferences: { videoPresets: next } });
      this.state.presetId = '';
      this.renderPresetSelect();
      if (preset) toast(`"${preset.name}" silindi.`);
    }

    // Hedef boyut modunun bit hızı bütçesi; arayüz ipucu ve doğrulama için
    // ana süreçle aynı ortak hesaplama kullanılır.
    sizeRates() {
      const meta = this.state.meta;
      const audioTracks = meta?.hasAudio && this.state.audioMode !== 'none'
        ? Math.max(1, meta.audioTracks?.length || 1)
        : 0;
      return window.OdakShared.sizeModeBitrates({
        targetMB: this.state.targetMB,
        duration: this.getOutputDuration(),
        codec: this.state.codec,
        audioTracks,
        sourceVideoKbps: ((Number(meta?.videoBitrate) || 0) / 1000) * Math.max(0.25, this.state.speed),
      });
    }

    renderSizePane() {
      if (document.activeElement !== this.els.sizeTarget) {
        this.els.sizeTarget.value = String(this.state.targetMB);
      }
      this.els.sizeChips.querySelectorAll('button[data-size]').forEach((button) => {
        button.classList.toggle('active', Number(button.dataset.size) === this.state.targetMB);
      });
      if (this.state.quality !== 'size' || !this.state.meta) return;
      const rates = this.sizeRates();
      const audioPart = rates.audioKbps ? ` · ses ${rates.audioKbps} kbps` : '';
      const passes = this.gpuVendor()
        ? 'Ekran kartının çok geçişli modunda kodlanır'
        : 'İki geçişte kodlanır';
      this.els.sizeHint.textContent = rates.feasible
        ? `Video ~${window.OdakUI.formatNumber(rates.videoKbps)} kbps${audioPart}. ${passes}; çıktı hedefin altında kalır.${rates.capped ? ' Kaynak bu hedeften küçük olduğu için bit hızı artırılmaz.' : ''}`
        : `${passes}; çıktı hedefin altında kalır.`;
      let warning = '';
      if (!rates.feasible) {
        warning = `Hedef bu süre için çok küçük. En az ${window.OdakUI.formatNumber(rates.minMB)} MB seçin, videoyu kısaltın veya sesi kapatın.`;
      } else {
        // Piksel başına bit çok düşükse görüntü belirgin şekilde bozulur.
        const dims = this.getOutputDims();
        const fps = Number(this.state.meta.fps) || 30;
        const bitsPerPixel = (rates.videoKbps * 1000) / Math.max(1, dims.width * dims.height * fps);
        if (bitsPerPixel < 0.03) {
          warning = 'Bu boyutta kalite belirgin düşer. Çözünürlüğü küçültmek daha iyi sonuç verir.';
        }
      }
      this.els.sizeWarn.textContent = warning;
      this.els.sizeWarn.hidden = !warning;
      this.els.sizeWarn.classList.toggle('hidden', !warning);
    }

    setTargetSize(value) {
      if (!this.state.loaded) return;
      const shared = window.OdakShared;
      const next = Math.round(clamp(Number(value) || this.state.targetMB, 0.1, shared.SIZE_MAX_MB) * 10) / 10;
      this.state.targetMB = next;
      if (this.state.quality !== 'size') this.setQuality('size');
      this.outputSettingsChanged();
      this.renderQuality();
      this.renderAudio();
      this.renderSummary();
    }

    setQuality(mode) {
      if (!this.state.loaded) return;
      if (!['copy', 'crf', 'bitrate', 'size'].includes(mode)) return;
      if (mode === 'copy' && !this.copyAllowed()) {
        toast('Kırpma, döndürme, boyut veya hız değişikliği varken kayıpsız kopyalama kullanılamaz.', { type: 'warn' });
        return;
      }
      if (mode === 'bitrate' && this.state.codec === 'prores') {
        toast('ProRes için bit hızı modu yerine CRF kullanılır.', { type: 'warn' });
        return;
      }
      if (mode === 'size' && this.state.codec === 'prores') {
        toast('ProRes hedef boyut modunu desteklemez; H.264, H.265 veya VP9 seçin.', { type: 'warn' });
        return;
      }
      this.state.quality = mode;
      if (mode === 'copy') this.reencodeNoticeShown = false;
      this.outputSettingsChanged();
      this.renderQuality();
      this.renderAudio();
      this.renderTrim();
      this.renderOutput();
      this.renderSummary();
    }

    setCodec(codec) {
      if (!this.state.loaded || !CODEC_LABELS[codec]) return;
      const wasCopy = this.state.quality === 'copy';
      this.state.codec = codec;
      if (wasCopy) this.state.quality = 'crf';
      if (codec === 'prores' && ['bitrate', 'size'].includes(this.state.quality)) this.state.quality = 'crf';
      this.outputSettingsChanged();
      this.renderQuality();
      this.renderAudio();
      this.renderTrim();
      this.renderOutput();
      this.renderSummary();
    }

    commitBitrate() {
      if (!this.state.loaded) return;
      const value = parseNumber(this.els.bitrateInput.value, this.state.bitrateKbps);
      this.state.bitrateKbps = Math.round(clamp(value, 100, 200000));
      this.state.presetId = '';
      this.renderQuality();
      this.renderSummary();
      this.renderOutput();
    }

    renderAudio() {
      const meta = this.state.meta;
      if (!meta) return;
      const hasAudio = Boolean(meta.hasAudio);
      const muted = this.state.audioMode === 'none' || !hasAudio;
      this.els.muteSwitch.classList.toggle('on', muted);
      this.els.muteSwitch.setAttribute('aria-checked', String(muted));
      this.els.muteSwitch.disabled = !hasAudio;
      this.els.audioMode.value = hasAudio ? this.state.audioMode : 'none';
      this.els.audioMode.disabled = !hasAudio;
      this.els.video.muted = muted;
      setIcon(this.els.muteBtn.querySelector('svg'), muted ? 'muted' : 'volume');
      this.els.muteBtn.title = muted ? 'Sesi aç' : 'Sesi kapat';
      if (!hasAudio) {
        this.els.audioHint.textContent = 'Bu videoda ses akışı yok.';
      } else if (this.state.quality === 'size' && this.state.audioMode !== 'none') {
        const rates = this.sizeRates();
        const codec = this.outputExt() === '.webm' ? 'Opus' : 'AAC';
        this.els.audioHint.textContent = `Hedef boyut bütçesine göre ses ${codec} ${rates.audioKbps || 64} kbps olarak kodlanır. Sesi kapatmak videoya daha çok yer bırakır.`;
      } else if (this.state.audioMode === 'aac') {
        const ext = this.outputExt();
        const videoPart = this.state.quality === 'copy' ? 'Video kopyalanır' : 'Video yeniden kodlanır';
        let audioPart = 'ses AAC 320 kbps olarak kodlanır.';
        if (this.state.quality !== 'copy' && this.state.codec === 'prores') {
          audioPart = 'ses PCM 24-bit olarak kodlanır (ProRes).';
        } else if (ext === '.webm') {
          audioPart = 'ses Opus 256 kbps olarak kodlanır (WebM).';
        }
        this.els.audioHint.textContent = `${videoPart}; ${audioPart}`;
      } else if (Math.abs(this.state.speed - 1) > 0.0001) {
        this.els.audioHint.textContent = 'Hız değiştiği için ses yeniden kodlanır.';
      } else if (this.state.audioMode === 'none') {
        this.els.audioHint.textContent = 'Ses akışı çıktıya eklenmez.';
      } else {
        this.els.audioHint.textContent = 'Ses, kapsayıcı destekliyorsa yeniden kodlanmadan kopyalanır.';
      }
      const trackCount = meta.audioTracks?.length || 0;
      if (hasAudio && trackCount > 1 && this.state.audioMode !== 'none') {
        this.els.audioHint.textContent += ` ${trackCount} ses izinin tamamı korunur.`;
      }
      if (meta.subtitleTracks?.length) {
        this.els.audioHint.textContent += this.subtitleNote();
      }
    }

    // Altyazılar ses ayarından bağımsız korunur; kapsayıcının taşıyamadığı
    // resim altyazılar (PGS/DVD) MP4, MOV ve WebM çıktısında atlanır.
    subtitleNote() {
      const tracks = this.state.meta?.subtitleTracks || [];
      const bitmap = tracks.filter((track) => ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'].includes(track.codec)).length;
      const ext = this.outputExt();
      if (ext === '.mkv') return ` ${tracks.length} altyazı olduğu gibi korunur.`;
      const kept = tracks.length - bitmap;
      const target = ext === '.webm' ? 'WebVTT' : 'MP4 metin altyazısı';
      if (!kept) return ` Resim altyazılar (${bitmap}) ${ext.slice(1).toUpperCase()} çıktısında taşınamaz; MKV için kayıpsız kopya kullanın.`;
      const skipped = bitmap ? `; ${bitmap} resim altyazı taşınamaz` : '';
      return ` ${kept} altyazı ${target} olarak korunur${skipped}.`;
    }

    outputExt() {
      const meta = this.state.meta;
      if (!meta) return '.mp4';
      if (this.state.quality === 'copy') {
        const sourceExt = `.${meta.ext || 'mp4'}`;
        let ext = sourceExt;
        if (sourceExt === '.mp4' || sourceExt === '.m4v') ext = '.mp4';
        else if (sourceExt === '.mov') ext = '.mov';
        else if (sourceExt === '.webm') ext = '.webm';
        else ext = '.mkv';
        if (this.state.audioMode === 'aac' && ext === '.webm') ext = '.mkv';
        return ext;
      }
      if (this.state.codec === 'h265') return '.mp4';
      if (this.state.codec === 'vp9') return '.webm';
      if (this.state.codec === 'prores') return '.mov';
      return '.mp4';
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

    getOutputDuration() {
      const trimmed = this.state.segments.length
        ? this.state.segments.reduce((sum, segment) => sum + (segment.end - segment.start), 0)
        : Math.max(0, this.state.outPoint - this.state.inPoint);
      return trimmed / Math.max(0.25, this.state.speed);
    }

    // Bölümler zaman sırasında tutulur; örtüşen/bitişik bölümler birleşir
    // (ana süreçteki normalizeSegments ile aynı kural).
    normalizeSegments(list) {
      const sorted = list
        .filter((segment) => segment.end - segment.start >= 0.04)
        .map((segment) => ({ start: segment.start, end: segment.end }))
        .sort((a, b) => a.start - b.start);
      const merged = [];
      for (const segment of sorted) {
        const last = merged[merged.length - 1];
        if (last && segment.start <= last.end + 0.001) last.end = Math.max(last.end, segment.end);
        else merged.push(segment);
      }
      return merged;
    }

    addSegment() {
      if (!this.state.loaded) return;
      this.remember();
      const start = Math.round(this.state.inPoint * 1000) / 1000;
      const end = Math.round(this.state.outPoint * 1000) / 1000;
      if (end - start < 0.04) {
        toast('Seçili aralık bölüm için çok kısa.', { type: 'warn' });
        return;
      }
      const before = this.state.segments.length;
      this.state.segments = this.normalizeSegments([...this.state.segments, { start, end }]);
      const merged = this.state.segments.length <= before;
      this.segmentsChanged();
      toast(merged
        ? 'Seçim mevcut bir bölümle birleştirildi.'
        : `${this.state.segments.length}. bölüm eklendi · ${formatTimecode(start)} – ${formatTimecode(end)}`, { type: 'success' });
    }

    removeSegment(index) {
      if (!this.state.segments[index]) return;
      this.remember();
      this.state.segments.splice(index, 1);
      this.segmentsChanged();
    }

    // Bölüme tıklanınca seçim o aralığa taşınır (önizlemek ve düzeltmek için).
    selectSegment(index) {
      const segment = this.state.segments[index];
      if (!segment) return;
      this.setTrim(segment.start, segment.end, false);
      this.seekTo(segment.start);
    }

    // ── Geri al / yinele ──
    // Düzenlemeler (kesim, bölümler, kadraj, hız, ses, metin, altyazı) her
    // değişiklikten önce anlık görüntü olarak saklanır. Çıktı ayarları
    // (codec, kalite) bu geçmişe girmez. Aynı türden art arda gelen
    // değişiklikler (yazı yazmak, sürüklemek) bir saniye içinde tek adım sayılır.
    historySnapshot() {
      const snapshot = {};
      for (const key of HISTORY_FIELDS) snapshot[key] = this.state[key];
      return JSON.parse(JSON.stringify(snapshot));
    }

    remember(kind) {
      if (!this.state.loaded) return;
      const now = Date.now();
      if (kind && kind === this.history.lastKind && now - this.history.lastAt < 1000) {
        this.history.lastAt = now;
        return;
      }
      this.history.undo.push(this.historySnapshot());
      if (this.history.undo.length > 100) this.history.undo.shift();
      this.history.redo = [];
      this.history.lastKind = kind;
      this.history.lastAt = now;
      this.renderHistory();
    }

    resetHistory() {
      this.history = { undo: [], redo: [], lastKind: null, lastAt: 0 };
      this.renderHistory();
    }

    undo() {
      if (!this.state.loaded || !this.history.undo.length) return;
      this.history.redo.push(this.historySnapshot());
      this.restoreSnapshot(this.history.undo.pop());
    }

    redo() {
      if (!this.state.loaded || !this.history.redo.length) return;
      this.history.undo.push(this.historySnapshot());
      this.restoreSnapshot(this.history.redo.pop());
    }

    restoreSnapshot(snapshot) {
      this.cancelCrop();
      Object.assign(this.state, JSON.parse(JSON.stringify(snapshot)));
      this.history.lastKind = null;
      this.textEditor.setLayers(this.state.textLayers);
      this.state.textLayers = this.textEditor.getLayers();
      this.els.video.muted = this.state.audioMode === 'none';
      if (!this.state.videoBroken) {
        try { this.els.video.playbackRate = this.state.speed; } catch { /* ignore */ }
      }
      this.state.presetId = '';
      this.ensureEditsQuality();
      this.render();
      this.renderSubtitles();
      this.renderHistory();
    }

    renderHistory() {
      if (!this.els.undoBtn) return;
      this.els.undoBtn.disabled = !this.state.loaded || !this.history.undo.length;
      this.els.redoBtn.disabled = !this.state.loaded || !this.history.redo.length;
    }

    // Giriş noktası çıkışı geçerse çıkış videonun sonuna taşınır (ve tersi);
    // böylece bir sonraki bölüm, öncekinin bitişine sıkışıp onunla birleşmez.
    markIn() {
      if (!this.state.loaded) return;
      this.remember();
      const time = this.state.currentTime;
      const end = time < this.state.outPoint - 0.04 ? this.state.outPoint : this.state.duration;
      this.setTrim(time, end, false);
    }

    markOut() {
      if (!this.state.loaded) return;
      this.remember();
      const time = this.state.currentTime;
      const start = time > this.state.inPoint + 0.04 ? this.state.inPoint : 0;
      this.setTrim(start, time, false);
    }

    segmentsChanged() {
      this.renderTrim();
      this.renderSizePane();
      this.renderOutput();
      this.renderSummary();
    }

    renderSegments() {
      const segments = this.state.segments;
      const duration = Math.max(0.001, this.state.duration);
      this.els.tlTrack.querySelectorAll('.tl-segment').forEach((node) => node.remove());
      this.els.segmentList.textContent = '';
      segments.forEach((segment, index) => {
        const block = document.createElement('div');
        block.className = 'tl-segment';
        block.style.left = `${(segment.start / duration) * 100}%`;
        block.style.width = `${((segment.end - segment.start) / duration) * 100}%`;
        const label = document.createElement('span');
        label.textContent = String(index + 1);
        block.appendChild(label);
        this.els.tlTrack.appendChild(block);

        const item = document.createElement('div');
        item.className = 'segment-item';
        item.dataset.segment = String(index);
        item.title = 'Seçimi bu bölüme taşı';
        const number = document.createElement('b');
        number.textContent = String(index + 1);
        const range = document.createElement('span');
        range.textContent = `${formatTimecode(segment.start)} – ${formatTimecode(segment.end)}`;
        const length = document.createElement('small');
        length.textContent = formatDuration(segment.end - segment.start);
        const remove = document.createElement('button');
        remove.className = 'text-layer-remove';
        remove.type = 'button';
        remove.title = 'Bölümü sil';
        remove.dataset.remove = 'true';
        remove.textContent = '×';
        item.append(number, range, length, remove);
        this.els.segmentList.appendChild(item);
      });
      this.els.segmentList.hidden = !segments.length;
      this.els.segmentHint.hidden = !segments.length;
      this.els.segmentHint.textContent = segments.length
        ? `Dışa aktarmada yalnızca bu ${segments.length} bölüm sırayla birleştirilir${this.state.meta?.subtitleTracks?.length ? '; yumuşak altyazılar taşınmaz' : ''}. Seçim, yeni bölüm eklemek içindir.`
        : '';
    }

    estimateSize() {
      const meta = this.state.meta;
      const duration = this.getOutputDuration();
      if (!meta || duration <= 0) return null;
      const dims = this.getOutputDims();
      const pixels = Math.max(1, dims.width * dims.height);
      if (this.state.quality === 'copy') {
        const bps = Number(meta.overallBitrate) || (Number(meta.videoBitrate) + Number(meta.audioBitrate));
        return bps > 0 ? (bps / 8) * duration : null;
      }
      if (this.state.quality === 'size') {
        // İki geçişli kodlama genellikle hedefin %94-97'sine denk gelir.
        return this.state.targetMB * 1e6 * 0.95;
      }
      if (this.state.quality === 'bitrate') {
        const videoBps = Math.max(100, this.state.bitrateKbps) * 1000;
        const audioBps = this.state.audioMode === 'none' ? 0 : Math.min(Number(meta.audioBitrate) || 320000, 320000);
        return ((videoBps + audioBps) / 8) * duration;
      }
      if (this.state.codec === 'prores') {
        const fps = Number(meta.fps) || 30;
        return (pixels * fps * 3.5 / 8) * duration;
      }
      const sourcePixels = Math.max(1, meta.width * meta.height);
      const scaled = (Number(meta.overallBitrate) || Number(meta.videoBitrate) || 0) * Math.min(1.6, Math.max(0.4, pixels / sourcePixels));
      return scaled > 0 ? (scaled / 8) * duration : null;
    }

    renderSummary() {
      const meta = this.state.meta;
      if (!meta) {
        this.els.summary.textContent = 'Hazır değil';
        this.els.outNote.textContent = 'Dosya seçin';
        this.els.exportBtn.disabled = true;
        return;
      }
      // Süre, boyut veya ses değişince hedef boyut bütçesi de değişir.
      this.renderSizePane();
      this.renderPresetSelect();
      const dims = this.getOutputDims();
      const duration = this.getOutputDuration();
      const ext = this.outputExt().replace('.', '').toUpperCase();
      let summary;
      if (this.state.quality === 'copy') {
        // Kopya modunda yalnızca görüntü akışı garantili olarak kopyalanır;
        // uyumsuz ses yeniden kodlanabilir. Bu yüzden "Kayıpsız" yerine
        // "Video kayıpsız" denir.
        summary = `Video kayıpsız · ${ext} · ${formatResolution(dims.width, dims.height)}`;
      } else if (this.state.quality === 'bitrate') {
        summary = `${CODEC_LABELS[this.state.codec]} · ${window.OdakUI.formatNumber(this.state.bitrateKbps)} kbps · ${formatResolution(dims.width, dims.height)}`;
      } else if (this.state.quality === 'size') {
        summary = `${CODEC_LABELS[this.state.codec]} · en fazla ${window.OdakUI.formatNumber(this.state.targetMB)} MB · ${formatResolution(dims.width, dims.height)}`;
      } else {
        summary = `${CODEC_LABELS[this.state.codec]} · ${this.state.codec === 'prores' ? '422 HQ' : `CRF ${this.state.crf}`} · ${formatResolution(dims.width, dims.height)}`;
      }
      if (this.gpuVendor()) summary += ' · GPU';
      this.els.summary.textContent = summary;
      const estimate = this.estimateSize();
      this.els.outNote.textContent = `${formatDuration(duration)}${estimate ? ` · ≈ ${formatBytes(estimate)}` : ''}`;
      this.els.exportBtn.disabled = !(
        this.state.loaded &&
        duration >= 0.04 &&
        this.state.outPoint > this.state.inPoint
      );
      this.els.ext.textContent = this.outputExt();
    }

    async chooseFolder() {
      const dir = await this.api.openFolder(this.state.outputDir || this.appConfig.videoOutputDir);
      if (!dir) return null;
      this.state.outputDir = dir;
      this.appConfig.videoOutputDir = dir;
      this.onConfigChange?.({ videoOutputDir: dir });
      if (!this.onConfigChange) this.api.setConfig({ videoOutputDir: dir }).catch(() => {});
      this.renderOutput();
      return dir;
    }

    buildExportPayload() {
      const meta = this.state.meta;
      const ext = this.outputExt();
      const baseName = sanitizeClientName(
        this.state.baseName,
        `${fileStem(meta?.name || 'video')}-odak`,
      );
      const crop = this.state.crop ? { ...this.state.crop } : null;
      const resize = this.state.resize ? { ...this.state.resize } : null;
      const options = {
        trimStart: this.state.inPoint,
        trimEnd: this.state.outPoint,
        segments: this.state.segments.map((segment) => ({ ...segment })),
        rotation: this.state.rotation,
        flipH: this.state.flipH,
        flipV: this.state.flipV,
        crop,
        resize,
        speed: this.state.speed,
        audioMode: meta?.hasAudio ? this.state.audioMode : 'none',
        mode: this.state.quality,
        codec: this.state.codec,
        crf: this.state.crf,
        preset: this.state.preset,
        bitrateKbps: this.state.bitrateKbps,
        targetMB: this.state.targetMB,
        encoder: this.state.encoder,
        textLayers: this.state.textLayers,
        burnSubtitle: this.state.burnSubtitle,
      };
      const dims = this.getOutputDims();
      const duration = this.getOutputDuration();
      const jobId = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return {
        kind: 'video',
        input: this.state.file,
        options,
        outputDir: this.state.outputDir,
        baseName,
        jobId,
        display: {
          fileName: `${baseName}${ext}`,
          folder: this.state.outputDir,
          summary: this.els.summary.textContent,
          outNote: this.els.outNote.textContent,
          ext,
          duration,
          width: dims.width,
          height: dims.height,
          mode: this.state.quality,
          codec: this.state.codec,
        },
      };
    }

    async export() {
      if (!this.state.loaded || !this.state.meta) return;
      if (!this.state.baseName.trim()) {
        this.state.baseName = `${fileStem(this.state.meta.name)}-odak`;
        this.renderOutput();
      }
      if (this.state.quality === 'copy' && !this.copyAllowed()) {
        this.ensureEditsQuality();
        this.renderQuality();
        this.renderSummary();
      }
      if (!this.state.outputDir) {
        const dir = await this.chooseFolder();
        if (!dir) {
          toast('Dışa aktarmak için bir çıktı klasörü seçin.', { type: 'warn' });
          return;
        }
      }
      const duration = this.getOutputDuration();
      if (duration < 0.04) {
        toast('Seçilen aralık çok kısa.', { type: 'warn' });
        return;
      }
      if (this.state.quality === 'size') {
        const rates = this.sizeRates();
        if (!rates.feasible) {
          toast(`Hedef boyut bu süre için çok küçük. En az ${window.OdakUI.formatNumber(rates.minMB)} MB seçin.`, { type: 'warn' });
          return;
        }
      }
      try { this.els.video.pause(); } catch { /* ignore */ }
      const payload = this.buildExportPayload();
      if (typeof this.onExportRequest === 'function') this.onExportRequest(payload);
    }

    async saveFrame() {
      if (!this.state.loaded || !this.state.meta) return;
      try {
        const result = await this.api.saveFrame({
          input: this.state.file,
          time: this.state.currentTime,
          defaultDir: this.appConfig.photoOutputDir || '',
          baseName: fileStem(this.state.meta.name),
          options: {
            rotation: this.state.rotation,
            flipH: this.state.flipH,
            flipV: this.state.flipV,
            crop: this.state.crop ? { ...this.state.crop } : null,
            resize: this.state.resize ? { ...this.state.resize } : null,
            textLayers: this.state.textLayers,
            burnSubtitle: this.state.burnSubtitle,
          },
        });
        if (!result || result.canceled) return;
        toast(`Kare kaydedildi: ${result.name}`, {
          type: 'success',
          action: {
            label: 'Göster',
            onClick: () => this.api.showItem(result.path),
          },
        });
      } catch (error) {
        toast(error.message || 'Kare kaydedilemedi.', { type: 'error' });
      }
    }
  }

  window.VideoEditor = VideoEditor;
})();
