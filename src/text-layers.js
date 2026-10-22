'use strict';

// Video, fotoğraf ve GIF düzenleyicilerinin ortak metin katmanı bileşeni:
// denetçideki katman listesi + düzenleme formu ve önizleme karesinin
// üzerinde sürüklenebilen canlı metin. Ölçüler shared.js'teki modelle aynıdır
// (boyut çıktı yüksekliğinin yüzdesi, konum metnin merkezi), böylece ekranda
// görülen yazı çıktıdakiyle aynı yerde ve boyutta olur.
(function () {
  const { toast, parseNumber } = window.OdakUI;
  const shared = window.OdakShared;

  const STYLE_LABELS = { outline: 'Kenarlık', shadow: 'Gölge', box: 'Kutu', plain: 'Düz' };
  // Chromium "Segoe UI"yi libass ve librsvg'den farklı bir yüzle çiziyor
  // (kalında ~%6 daha geniş). Önizleme çıktıyla aynı genişlikte görünsün
  // diye yatayda ölçülen oranla düzeltilir. Diğer yazı tipleri üç çizicide
  // de %1 içinde aynıdır.
  const PREVIEW_WIDTH_FIX = { 'Segoe UI': { normal: 1.02, bold: 0.94 } };
  const PLACES = { top: 0.12, middle: 0.5, bottom: 0.86 };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  class TextLayerEditor {
    // host: denetçideki <section>; frame: önizleme karesi (çıktıyla aynı oranda).
    // timed: video için başlangıç/bitiş alanları. onChange(layers): her değişiklikte.
    constructor({ host, frame, timed = false, getCurrentTime = () => 0, onChange, emptyHint }) {
      this.host = host;
      this.frame = frame;
      this.timed = timed;
      this.getCurrentTime = getCurrentTime;
      this.onChange = onChange;
      this.layers = [];
      this.selectedId = null;
      this.hidden = false;
      this.drag = null;
      this.build(emptyHint);
      this.overlay = element('div', 'text-overlay');
      this.overlay.setAttribute('aria-hidden', 'true');
      this.frame.appendChild(this.overlay);
      this.resizeObserver = new ResizeObserver(() => this.renderOverlay());
      this.resizeObserver.observe(this.frame);
      this.render();
    }

    build(emptyHint) {
      const host = this.host;
      host.classList.add('text-section');
      const head = element('div', 'group-head');
      head.appendChild(element('h3', '', 'Metin'));
      this.addButton = element('button', 'link-btn', '+ Metin ekle');
      this.addButton.type = 'button';
      this.addButton.addEventListener('click', () => this.addLayer());
      head.appendChild(this.addButton);
      host.appendChild(head);

      this.list = element('div', 'text-layer-list');
      this.list.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove]');
        if (remove) {
          this.removeLayer(remove.dataset.remove);
          return;
        }
        const item = event.target.closest('[data-layer]');
        if (item) this.select(item.dataset.layer);
      });
      host.appendChild(this.list);

      this.empty = element('p', 'hint', emptyHint || 'Yazı, başlık veya filigran ekle. Önizlemede sürükleyerek yerleştirebilirsin.');
      host.appendChild(this.empty);

      const form = element('div', 'text-form');
      this.form = form;
      const textField = element('label', 'field');
      textField.appendChild(element('span', '', 'Metin'));
      this.textInput = element('textarea');
      this.textInput.rows = 2;
      this.textInput.maxLength = 500;
      this.textInput.spellcheck = false;
      this.textInput.addEventListener('input', () => this.update({ text: this.textInput.value }, { soft: true }));
      textField.appendChild(this.textInput);
      form.appendChild(textField);

      const row = element('div', 'field-row');
      const fontField = element('label', 'field');
      fontField.appendChild(element('span', '', 'Yazı tipi'));
      this.fontSelect = element('select');
      for (const font of shared.TEXT_FONTS) {
        const option = element('option', '', font);
        option.value = font;
        option.style.fontFamily = font;
        this.fontSelect.appendChild(option);
      }
      this.fontSelect.addEventListener('change', () => this.update({ font: this.fontSelect.value }));
      fontField.appendChild(this.fontSelect);
      row.appendChild(fontField);
      const colorField = element('label', 'field color-field');
      colorField.appendChild(element('span', '', 'Renk'));
      this.colorInput = element('input');
      this.colorInput.type = 'color';
      this.colorInput.addEventListener('input', () => this.update({ color: this.colorInput.value }, { soft: true }));
      colorField.appendChild(this.colorInput);
      row.appendChild(colorField);
      form.appendChild(row);

      const sizeHead = element('div', 'range-head');
      sizeHead.appendChild(element('span', '', 'Boyut'));
      this.sizeLabel = element('b', '', '8');
      sizeHead.appendChild(this.sizeLabel);
      form.appendChild(sizeHead);
      this.sizeInput = element('input', 'range');
      this.sizeInput.type = 'range';
      this.sizeInput.min = '2';
      this.sizeInput.max = '25';
      this.sizeInput.step = '0.5';
      this.sizeInput.addEventListener('input', () => this.update({ size: Number(this.sizeInput.value) }, { soft: true }));
      form.appendChild(this.sizeInput);

      this.styleGroup = element('div', 'segmented text-style');
      for (const [style, label] of Object.entries(STYLE_LABELS)) {
        const button = element('button', '', label);
        button.type = 'button';
        button.dataset.style = style;
        this.styleGroup.appendChild(button);
      }
      this.styleGroup.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-style]');
        if (button) this.update({ style: button.dataset.style });
      });
      form.appendChild(this.styleGroup);

      const toggles = element('div', 'chip-row text-toggles');
      this.boldButton = element('button', 'toggle-bold', 'Kalın');
      this.italicButton = element('button', 'toggle-italic', 'İtalik');
      for (const button of [this.boldButton, this.italicButton]) {
        button.type = 'button';
        toggles.appendChild(button);
      }
      this.boldButton.addEventListener('click', () => this.update({ bold: !this.selected()?.bold }));
      this.italicButton.addEventListener('click', () => this.update({ italic: !this.selected()?.italic }));
      toggles.appendChild(element('span', 'grow'));
      for (const [place, label] of [['top', 'Üst'], ['middle', 'Orta'], ['bottom', 'Alt']]) {
        const button = element('button', '', label);
        button.type = 'button';
        button.dataset.place = place;
        button.title = `Metni ${label.toLocaleLowerCase('tr-TR')} ortaya taşı`;
        toggles.appendChild(button);
      }
      toggles.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-place]');
        if (button) this.update({ x: 0.5, y: PLACES[button.dataset.place] });
      });
      form.appendChild(toggles);

      if (this.timed) {
        const timeRow = element('div', 'field-row');
        this.startInput = this.timeField(timeRow, 'Başlangıç', 'start');
        this.endInput = this.timeField(timeRow, 'Bitiş', 'end');
        this.endInput.placeholder = 'sona kadar';
        form.appendChild(timeRow);
        const nowRow = element('div', 'chip-row');
        for (const [key, label] of [['start', 'Başlangıç = şu an'], ['end', 'Bitiş = şu an'], ['all', 'Tüm video']]) {
          const button = element('button', '', label);
          button.type = 'button';
          button.dataset.time = key;
          nowRow.appendChild(button);
        }
        nowRow.addEventListener('click', (event) => {
          const button = event.target.closest('button[data-time]');
          if (!button) return;
          const now = Math.round(this.getCurrentTime() * 100) / 100;
          if (button.dataset.time === 'start') this.update({ start: now });
          else if (button.dataset.time === 'end') this.update({ end: now });
          else this.update({ start: 0, end: null });
        });
        form.appendChild(nowRow);
      }
      this.formHint = element('p', 'hint', 'Metni önizlemede sürükleyerek konumlandır. Boyut, çıktı yüksekliğinin yüzdesidir.');
      form.appendChild(this.formHint);
      host.appendChild(form);
    }

    timeField(row, label, key) {
      const field = element('label', 'field');
      const span = element('span', '', `${label} `);
      span.appendChild(element('small', '', 'sn'));
      field.appendChild(span);
      const input = element('input');
      input.type = 'number';
      input.min = '0';
      input.step = '0.1';
      input.inputMode = 'decimal';
      input.addEventListener('change', () => {
        const raw = input.value.trim();
        if (key === 'end' && !raw) this.update({ end: null });
        else this.update({ [key]: Math.max(0, parseNumber(raw, 0)) });
      });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
      field.appendChild(input);
      row.appendChild(field);
      return input;
    }

    selected() {
      return this.layers.find((layer) => layer.id === this.selectedId) || null;
    }

    setLayers(layers) {
      this.layers = shared.cleanTextLayers(layers);
      if (!this.layers.some((layer) => layer.id === this.selectedId)) this.selectedId = this.layers[0]?.id || null;
      this.render();
    }

    getLayers() {
      return shared.cleanTextLayers(this.layers);
    }

    addLayer() {
      if (this.layers.length >= shared.MAX_TEXT_LAYERS) {
        toast(`En fazla ${shared.MAX_TEXT_LAYERS} metin eklenebilir.`, { type: 'warn' });
        return;
      }
      // Yeni metin bir öncekinin üstüne binmesin diye sırayla yerleştirilir.
      const places = [0.86, 0.12, 0.5, 0.7, 0.3];
      const y = places[this.layers.length % places.length];
      const start = this.timed ? Math.round(this.getCurrentTime() * 10) / 10 : 0;
      const layer = shared.defaultTextLayer({
        text: window.OdakI18n ? window.OdakI18n.t('Metin') : 'Metin',
        y,
        start: this.timed && start > 0.05 ? start : 0,
      });
      this.layers.push(layer);
      this.selectedId = layer.id;
      this.emit();
      this.render();
      this.textInput.focus();
      this.textInput.select();
    }

    removeLayer(id) {
      const index = this.layers.findIndex((layer) => layer.id === id);
      if (index < 0) return;
      this.layers.splice(index, 1);
      if (this.selectedId === id) this.selectedId = this.layers[Math.min(index, this.layers.length - 1)]?.id || null;
      this.emit();
      this.render();
    }

    select(id) {
      if (!this.layers.some((layer) => layer.id === id)) return;
      this.selectedId = id;
      this.render();
    }

    // soft: yazarken/sürüklerken listeyi baştan kurmadan yalnızca önizlemeyi güncelle.
    update(patch, { soft = false } = {}) {
      const layer = this.selected();
      if (!layer) return;
      Object.assign(layer, shared.cleanTextLayer({ ...layer, ...patch }));
      this.emit();
      if (soft) {
        this.renderList();
        this.renderOverlay();
        this.renderSize(layer);
      } else {
        this.render();
      }
    }

    emit() {
      this.onChange?.(this.getLayers());
    }

    // Kırpma modunda kare kırpılmamış görüntüyü gösterir; metin gizlenir.
    setHidden(hidden) {
      this.hidden = Boolean(hidden);
      this.renderOverlay();
    }

    render() {
      this.renderList();
      this.renderForm();
      this.renderOverlay();
    }

    renderList() {
      this.list.textContent = '';
      for (const layer of this.layers) {
        const item = element('div', 'text-layer-item');
        item.dataset.layer = layer.id;
        item.classList.toggle('selected', layer.id === this.selectedId);
        const label = element('span', 'text-layer-label', layer.text.split('\n')[0].trim() || '(boş)');
        label.style.fontFamily = layer.font;
        item.appendChild(label);
        if (this.timed) {
          const end = layer.end === null ? 'son' : `${layer.end}s`;
          item.appendChild(element('small', '', `${layer.start}s – ${end}`));
        }
        const remove = element('button', 'text-layer-remove', '×');
        remove.type = 'button';
        remove.title = 'Metni sil';
        remove.dataset.remove = layer.id;
        item.appendChild(remove);
        this.list.appendChild(item);
      }
      this.list.hidden = !this.layers.length;
      this.empty.hidden = Boolean(this.layers.length);
    }

    renderForm() {
      const layer = this.selected();
      this.form.hidden = !layer;
      this.addButton.disabled = this.layers.length >= shared.MAX_TEXT_LAYERS;
      if (!layer) return;
      if (document.activeElement !== this.textInput) this.textInput.value = layer.text;
      this.fontSelect.value = layer.font;
      this.fontSelect.style.fontFamily = layer.font;
      this.colorInput.value = layer.color;
      this.sizeInput.value = String(layer.size);
      this.renderSize(layer);
      this.styleGroup.querySelectorAll('button[data-style]').forEach((button) => {
        button.classList.toggle('active', button.dataset.style === layer.style);
      });
      this.boldButton.classList.toggle('active', layer.bold);
      this.italicButton.classList.toggle('active', layer.italic);
      if (this.timed) {
        if (document.activeElement !== this.startInput) this.startInput.value = String(layer.start);
        if (document.activeElement !== this.endInput) this.endInput.value = layer.end === null ? '' : String(layer.end);
      }
    }

    renderSize(layer) {
      this.sizeLabel.textContent = `%${layer.size.toLocaleString('tr-TR')}`;
      const min = Number(this.sizeInput.min);
      const max = Number(this.sizeInput.max);
      const fill = ((layer.size - min) / (max - min)) * 100;
      this.sizeInput.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${fill}%, rgba(255,255,255,0.09) ${fill}%, rgba(255,255,255,0.09) 100%)`;
    }

    // Zaman değişince (video oynarken) yalnızca görünürlük güncellenir.
    refreshTime() {
      if (this.timed) this.renderOverlay();
    }

    renderOverlay() {
      const overlay = this.overlay;
      overlay.textContent = '';
      if (this.hidden) return;
      const rect = this.frame.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const now = this.getCurrentTime();
      for (const layer of this.layers) {
        if (!layer.text.trim()) continue;
        const active = !this.timed || (now >= layer.start - 0.001 && (layer.end === null || now < layer.end));
        const isSelected = layer.id === this.selectedId;
        if (!active && !isSelected) continue;
        const metrics = shared.textLayerMetrics(layer, rect.height);
        const item = element('div', 'text-overlay-item');
        item.dataset.layer = layer.id;
        item.classList.toggle('selected', isSelected);
        item.classList.toggle('inactive', !active);
        item.style.left = `${layer.x * 100}%`;
        item.style.top = `${layer.y * 100}%`;
        const widthFix = PREVIEW_WIDTH_FIX[layer.font]?.[layer.bold ? 'bold' : 'normal'];
        if (widthFix) item.style.transform = `translate(-50%, -50%) scaleX(${widthFix})`;
        item.style.fontFamily = `"${layer.font}"`;
        item.style.fontSize = `${metrics.fontPx}px`;
        item.style.fontWeight = layer.bold ? '700' : '400';
        item.style.fontStyle = layer.italic ? 'italic' : 'normal';
        item.style.color = layer.color;
        const span = element('span', `text-overlay-text style-${layer.style}`, layer.text);
        if (layer.style === 'outline') {
          span.style.webkitTextStroke = `${(metrics.outlinePx * 2).toFixed(2)}px #000`;
        } else if (layer.style === 'shadow') {
          const offset = metrics.shadowPx.toFixed(2);
          span.style.textShadow = `${offset}px ${offset}px 0 rgba(0,0,0,0.55)`;
          span.style.webkitTextStroke = `${(metrics.outlinePx * 2).toFixed(2)}px #000`;
        } else if (layer.style === 'box') {
          const pad = metrics.boxPadPx;
          span.style.padding = `${(pad * 0.4).toFixed(2)}px ${pad.toFixed(2)}px`;
          span.style.background = `rgba(0,0,0,${metrics.boxAlpha})`;
        }
        item.appendChild(span);
        item.addEventListener('pointerdown', (event) => this.startDrag(event, layer.id));
        overlay.appendChild(item);
      }
    }

    startDrag(event, id) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.selectedId !== id) this.select(id);
      const rect = this.frame.getBoundingClientRect();
      const layer = this.selected();
      if (!layer || rect.width < 4) return;
      const startX = event.clientX;
      const startY = event.clientY;
      const origin = { x: layer.x, y: layer.y };
      const move = (moveEvent) => {
        const x = Math.min(1, Math.max(0, origin.x + (moveEvent.clientX - startX) / rect.width));
        const y = Math.min(1, Math.max(0, origin.y + (moveEvent.clientY - startY) / rect.height));
        layer.x = Math.round(x * 1000) / 1000;
        layer.y = Math.round(y * 1000) / 1000;
        this.renderOverlay();
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        this.emit();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    }
  }

  window.TextLayerEditor = TextLayerEditor;
})();
