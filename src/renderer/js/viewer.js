/**
 * Before/after comparison viewer with synchronized zoom, pan and a split divider.
 */
(function (root) {
  'use strict';

  const { clamp } = root.WebpUtility.helpers;

  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 16;
  const BUTTON_ZOOM_STEP = 1.25;
  const FIT_PADDING = 40;

  function createCompareViewer(elements) {
    const { viewport, stage, originalImage, optimizedImage, optimizedLayer, handle, zoomLabel } = elements;

    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let split = 0.5; // fraction of the viewport width
    let imageWidth = 0;
    let imageHeight = 0;
    let drag = null;
    let fitOnLoad = true;

    function render() {
      stage.style.width = `${imageWidth}px`;
      stage.style.height = `${imageHeight}px`;
      stage.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      stage.classList.toggle('is-magnified', zoom >= 2);

      const splitX = split * viewport.clientWidth;
      handle.style.left = `${splitX}px`;
      handle.setAttribute('aria-valuenow', String(Math.round(split * 100)));

      // Clip in image space so the divider lines up with the split at any zoom and pan.
      const clipX = clamp((splitX - panX) / zoom, 0, imageWidth);
      optimizedLayer.style.clipPath = `inset(0 0 0 ${clipX}px)`;

      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    }

    function centerImage() {
      panX = (viewport.clientWidth - imageWidth * zoom) / 2;
      panY = (viewport.clientHeight - imageHeight * zoom) / 2;
      render();
    }

    function fit() {
      if (!imageWidth || !imageHeight) return;
      const availableWidth = Math.max(1, viewport.clientWidth - FIT_PADDING);
      const availableHeight = Math.max(1, viewport.clientHeight - FIT_PADDING);
      zoom = clamp(Math.min(availableWidth / imageWidth, availableHeight / imageHeight, 1), MIN_ZOOM, MAX_ZOOM);
      centerImage();
    }

    function actualSize() {
      zoom = 1;
      centerImage();
    }

    function zoomAt(nextZoom, anchorX, anchorY) {
      const newZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      const ratio = newZoom / zoom;
      panX = anchorX - (anchorX - panX) * ratio;
      panY = anchorY - (anchorY - panY) * ratio;
      zoom = newZoom;
      render();
    }

    function zoomBy(factor) {
      zoomAt(zoom * factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
    }

    function setSplitFromClientX(clientX) {
      const rect = viewport.getBoundingClientRect();
      split = rect.width ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
      render();
    }

    /** Shows a new pair of images. Both layers use the original's size so they overlap exactly. */
    function open(originalUrl, optimizedUrl, fallbackSize) {
      fitOnLoad = true;
      split = 0.5;
      imageWidth = fallbackSize?.width || imageWidth || 1;
      imageHeight = fallbackSize?.height || imageHeight || 1;
      optimizedImage.src = optimizedUrl;
      originalImage.src = originalUrl;
      fit();
    }

    function updateOptimized(url) {
      if (optimizedImage.getAttribute('src') !== url) optimizedImage.src = url;
    }

    function close() {
      originalImage.removeAttribute('src');
      optimizedImage.removeAttribute('src');
      drag = null;
    }

    originalImage.addEventListener('load', () => {
      imageWidth = originalImage.naturalWidth || imageWidth;
      imageHeight = originalImage.naturalHeight || imageHeight;
      if (fitOnLoad) {
        fitOnLoad = false;
        fit();
      } else {
        render();
      }
    });

    viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const mode = handle.contains(event.target) ? 'split' : 'pan';
      drag = { mode, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, panX, panY };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add(mode === 'pan' ? 'is-panning' : 'is-splitting');
      if (mode === 'split') setSplitFromClientX(event.clientX);
      event.preventDefault();
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.mode === 'split') {
        setSplitFromClientX(event.clientX);
      } else {
        panX = drag.panX + event.clientX - drag.startX;
        panY = drag.panY + event.clientY - drag.startY;
        render();
      }
    });

    const endDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      viewport.classList.remove('is-panning', 'is-splitting');
    };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY; // lines → pixels
      zoomAt(zoom * Math.pow(1.0015, -delta), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') split = clamp(split - step, 0, 1);
      else if (event.key === 'ArrowRight') split = clamp(split + step, 0, 1);
      else if (event.key === 'Home') split = 0;
      else if (event.key === 'End') split = 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      render();
    });

    // Keep the divider and image placement consistent when the window is resized.
    new ResizeObserver(() => render()).observe(viewport);

    return {
      open,
      close,
      updateOptimized,
      fit,
      actualSize,
      zoomIn: () => zoomBy(BUTTON_ZOOM_STEP),
      zoomOut: () => zoomBy(1 / BUTTON_ZOOM_STEP),
    };
  }

  root.WebpUtility.createCompareViewer = createCompareViewer;
})(self);
