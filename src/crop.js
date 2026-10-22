'use strict';

(function () {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const MIN_SIZE = 0.015;

  class CropOverlay {
    constructor({ overlay, box, sizeLabel }) {
      this.overlay = overlay;
      this.box = box;
      this.sizeLabel = sizeLabel;
      this.active = false;
      this.rect = { x: 0, y: 0, w: 1, h: 1 };
      this.ratio = null;
      this.sourceWidth = 0;
      this.sourceHeight = 0;
      this.drag = null;
      this.onChange = null;
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.overlay.addEventListener('pointerdown', this.onPointerDown);
    }

    setSourceSize(width, height) {
      this.sourceWidth = Math.max(0, Number(width) || 0);
      this.sourceHeight = Math.max(0, Number(height) || 0);
      this.updateLabel();
    }

    open({ rect = null, ratio = null, sourceWidth = 0, sourceHeight = 0, onChange = null } = {}) {
      this.active = true;
      this.ratio = Number(ratio) > 0 ? Number(ratio) : null;
      this.sourceWidth = Number(sourceWidth) || this.sourceWidth;
      this.sourceHeight = Number(sourceHeight) || this.sourceHeight;
      this.onChange = typeof onChange === 'function' ? onChange : null;
      if (rect && rect.w > 0 && rect.h > 0) {
        this.rect = this.normalizeRect(rect);
      } else {
        this.rect = { x: 0, y: 0, w: 1, h: 1 };
      }
      this.overlay.hidden = false;
      this.overlay.classList.remove('hidden');
      this.applyStyle();
      this.updateLabel();
    }

    close() {
      this.active = false;
      this.stopDrag();
      this.overlay.hidden = true;
      this.overlay.classList.add('hidden');
      this.drag = null;
    }

    getRect() {
      return { ...this.rect };
    }

    setRatio(ratio) {
      this.ratio = Number(ratio) > 0 ? Number(ratio) : null;
      if (!this.active) return;
      if (this.ratio) {
        const bounds = this.overlay.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        let width = bounds.width;
        let height = width / this.ratio;
        if (height > bounds.height) {
          height = bounds.height;
          width = height * this.ratio;
        }
        this.rect = {
          x: (bounds.width - width) / 2 / bounds.width,
          y: (bounds.height - height) / 2 / bounds.height,
          w: width / bounds.width,
          h: height / bounds.height,
        };
      }
      this.applyStyle();
      this.updateLabel();
      this.onChange?.(this.getRect());
    }

    applyStyle() {
      const rect = this.rect;
      this.box.style.left = `${rect.x * 100}%`;
      this.box.style.top = `${rect.y * 100}%`;
      this.box.style.width = `${rect.w * 100}%`;
      this.box.style.height = `${rect.h * 100}%`;
      if (this.sizeLabel) {
        this.sizeLabel.classList.toggle('inside', rect.y < 0.075);
      }
    }

    updateLabel() {
      if (!this.sizeLabel) return;
      let text = `${Math.round(this.rect.w * 100)}% × ${Math.round(this.rect.h * 100)}%`;
      if (this.sourceWidth > 0 && this.sourceHeight > 0) {
        const width = Math.max(1, Math.round(this.rect.w * this.sourceWidth));
        const height = Math.max(1, Math.round(this.rect.h * this.sourceHeight));
        text = `${width} × ${height}`;
      }
      this.sizeLabel.textContent = text;
    }

    normalizeRect(rect) {
      const width = clamp(Number(rect.w) || 0, MIN_SIZE, 1);
      const height = clamp(Number(rect.h) || 0, MIN_SIZE, 1);
      return {
        x: clamp(Number(rect.x) || 0, 0, 1 - width),
        y: clamp(Number(rect.y) || 0, 0, 1 - height),
        w: width,
        h: height,
      };
    }

    onPointerDown(event) {
      if (!this.active || event.button !== 0) return;
      const bounds = this.overlay.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      const handleElement = event.target.closest('.crop-handle');
      const boxElement = event.target.closest('.crop-box');
      let mode = 'new';
      let handle = null;
      if (handleElement) {
        mode = 'resize';
        handle = handleElement.dataset.handle || '';
      } else if (boxElement) {
        mode = 'move';
      }

      event.preventDefault();
      event.stopPropagation();
      const point = {
        x: clamp(event.clientX - bounds.left, 0, bounds.width),
        y: clamp(event.clientY - bounds.top, 0, bounds.height),
      };
      this.drag = {
        mode,
        handle,
        bounds,
        startX: point.x,
        startY: point.y,
        startRect: { ...this.rect },
        rectPx: {
          x: this.rect.x * bounds.width,
          y: this.rect.y * bounds.height,
          w: this.rect.w * bounds.width,
          h: this.rect.h * bounds.height,
        },
        moved: false,
      };
      if (mode === 'new') {
        this.rect = {
          x: point.x / bounds.width,
          y: point.y / bounds.height,
          w: MIN_SIZE,
          h: MIN_SIZE,
        };
        this.applyStyle();
      }
      try { this.overlay.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      window.addEventListener('pointermove', this.onPointerMove, { passive: false });
      window.addEventListener('pointerup', this.onPointerUp);
      window.addEventListener('pointercancel', this.onPointerUp);
    }

    onPointerMove(event) {
      if (!this.drag) return;
      event.preventDefault();
      const { bounds } = this.drag;
      const x = clamp(event.clientX - bounds.left, 0, bounds.width);
      const y = clamp(event.clientY - bounds.top, 0, bounds.height);
      if (Math.abs(x - this.drag.startX) > 1 || Math.abs(y - this.drag.startY) > 1) {
        this.drag.moved = true;
      }

      let rect;
      if (this.drag.mode === 'move') {
        const dx = (x - this.drag.startX) / bounds.width;
        const dy = (y - this.drag.startY) / bounds.height;
        const start = this.drag.startRect;
        rect = {
          x: clamp(start.x + dx, 0, 1 - start.w),
          y: clamp(start.y + dy, 0, 1 - start.h),
          w: start.w,
          h: start.h,
        };
      } else if (this.drag.mode === 'resize') {
        rect = this.resizeRect(x, y);
      } else {
        rect = this.newRect(x, y);
      }

      this.rect = this.normalizeRect(rect);
      this.applyStyle();
      this.updateLabel();
      this.onChange?.(this.getRect());
    }

    resizeRect(x, y) {
      const { handle, bounds, rectPx, startX, startY } = this.drag;
      const ratio = this.ratio;
      let left = rectPx.x;
      let top = rectPx.y;
      let right = rectPx.x + rectPx.w;
      let bottom = rectPx.y + rectPx.h;
      const horizontal = handle.includes('w') || handle.includes('e');
      const vertical = handle.includes('n') || handle.includes('s');

      if (horizontal && vertical) {
        const anchorX = handle.includes('w') ? right : left;
        const anchorY = handle.includes('n') ? bottom : top;
        let width = Math.abs(x - anchorX);
        let height = Math.abs(y - anchorY);
        if (ratio) {
          if (width / Math.max(height, 1) > ratio) height = width / ratio;
          else width = height * ratio;
          const availableWidth = handle.includes('w') ? anchorX : bounds.width - anchorX;
          const availableHeight = handle.includes('n') ? anchorY : bounds.height - anchorY;
          const scale = Math.min(1, availableWidth / Math.max(width, 1), availableHeight / Math.max(height, 1));
          width *= scale;
          height *= scale;
        }
        width = Math.max(8, width);
        height = Math.max(ratio ? width / ratio : 8, height);
        left = handle.includes('w') ? anchorX - width : anchorX;
        top = handle.includes('n') ? anchorY - height : anchorY;
        right = left + width;
        bottom = top + height;
      } else if (horizontal) {
        const anchorX = handle.includes('w') ? right : left;
        let width = Math.abs(x - anchorX);
        if (ratio) {
          const centerY = rectPx.y + rectPx.h / 2;
          let height = width / ratio;
          const maxHeight = 2 * Math.min(centerY, bounds.height - centerY);
          if (height > maxHeight) {
            height = maxHeight;
            width = height * ratio;
          }
          const availableWidth = handle.includes('w') ? anchorX : bounds.width - anchorX;
          if (width > availableWidth) {
            width = availableWidth;
            height = width / ratio;
          }
          left = handle.includes('w') ? anchorX - width : anchorX;
          right = left + width;
          top = centerY - height / 2;
          bottom = top + height;
        } else {
          width = Math.max(8, width);
          left = handle.includes('w') ? anchorX - width : anchorX;
          right = left + width;
        }
      } else {
        const anchorY = handle.includes('n') ? bottom : top;
        let height = Math.abs(y - anchorY);
        if (ratio) {
          const centerX = rectPx.x + rectPx.w / 2;
          let width = height * ratio;
          const maxWidth = 2 * Math.min(centerX, bounds.width - centerX);
          if (width > maxWidth) {
            width = maxWidth;
            height = width / ratio;
          }
          const availableHeight = handle.includes('n') ? anchorY : bounds.height - anchorY;
          if (height > availableHeight) {
            height = availableHeight;
            width = height * ratio;
          }
          top = handle.includes('n') ? anchorY - height : anchorY;
          bottom = top + height;
          left = centerX - width / 2;
          right = left + width;
        } else {
          height = Math.max(8, height);
          top = handle.includes('n') ? anchorY - height : anchorY;
          bottom = top + height;
        }
      }

      left = clamp(left, 0, bounds.width);
      top = clamp(top, 0, bounds.height);
      right = clamp(right, left + 8, bounds.width);
      bottom = clamp(bottom, top + 8, bounds.height);
      return {
        x: left / bounds.width,
        y: top / bounds.height,
        w: (right - left) / bounds.width,
        h: (bottom - top) / bounds.height,
      };
    }

    newRect(x, y) {
      const { bounds, startX, startY } = this.drag;
      const ratio = this.ratio;
      let width = Math.abs(x - startX);
      let height = Math.abs(y - startY);
      const dirX = x >= startX ? 1 : -1;
      const dirY = y >= startY ? 1 : -1;

      if (ratio) {
        if (width / Math.max(height, 1) > ratio) height = width / ratio;
        else width = height * ratio;
        const availableWidth = dirX > 0 ? bounds.width - startX : startX;
        const availableHeight = dirY > 0 ? bounds.height - startY : startY;
        const scale = Math.min(1, availableWidth / Math.max(width, 1), availableHeight / Math.max(height, 1));
        width *= scale;
        height *= scale;
      }
      width = Math.max(8, Math.min(width, bounds.width));
      height = Math.max(ratio ? width / ratio : 8, Math.min(height, bounds.height));
      if (ratio && height > bounds.height) {
        height = bounds.height;
        width = height * ratio;
      }
      const left = dirX > 0 ? startX : startX - width;
      const top = dirY > 0 ? startY : startY - height;
      return {
        x: clamp(left, 0, bounds.width) / bounds.width,
        y: clamp(top, 0, bounds.height) / bounds.height,
        w: width / bounds.width,
        h: height / bounds.height,
      };
    }

    stopDrag() {
      window.removeEventListener('pointermove', this.onPointerMove);
      window.removeEventListener('pointerup', this.onPointerUp);
      window.removeEventListener('pointercancel', this.onPointerUp);
    }

    onPointerUp() {
      if (!this.drag) return;
      const { mode, moved, startRect } = this.drag;
      this.stopDrag();
      this.drag = null;
      if (mode === 'new' && !moved) {
        this.rect = startRect;
        this.applyStyle();
        this.updateLabel();
        this.onChange?.(this.getRect());
      }
    }
  }

  window.CropOverlay = CropOverlay;
})();
