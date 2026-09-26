/**
 * Decodes an image with the browser and re-encodes it through a canvas.
 */
(function (root) {
  'use strict';

  const { OUTPUT_FORMATS, computeTargetSize } = root.WebpUtility.helpers;

  // Vector images without width/height attributes have no intrinsic size.
  const VECTOR_FALLBACK_SIZE = 1024;
  const THUMBNAIL_SIZE = 480;

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('This file could not be decoded.'));
      image.src = url;
    });
  }

  function intrinsicSize(image) {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width && height) return { width, height };
    if (width) return { width, height: width };
    if (height) return { width: height, height };
    return { width: VECTOR_FALLBACK_SIZE, height: VECTOR_FALLBACK_SIZE };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function drawAndEncode(image, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const opaque = type === 'image/jpeg';
    const context = canvas.getContext('2d', { alpha: !opaque });
    if (!context) throw new Error('Not enough memory to process this image.');

    if (opaque) {
      // JPEG has no alpha channel: flatten transparency onto white instead of black.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, width, height);

    try {
      return await canvasToBlob(canvas, type, quality);
    } finally {
      // Release the backing store right away instead of waiting for garbage collection.
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * @param {string} sourceUrl object URL of the original file
   * @param {{format: string, quality: number, scale: number, maxWidth: ?number, maxHeight: ?number}} settings
   * @param {{thumbnail?: boolean}} [options]
   * @returns {Promise<{blob: Blob, width: number, height: number, sourceWidth: number,
   *   sourceHeight: number, limited: boolean, thumbnail: ?Blob}>}
   */
  async function optimizeImage(sourceUrl, settings, options = {}) {
    const format = OUTPUT_FORMATS[settings.format];
    if (!format) throw new Error(`Unsupported output format: ${settings.format}`);

    const image = await loadImage(sourceUrl);
    const source = intrinsicSize(image);
    const target = computeTargetSize(source.width, source.height, settings);

    const quality = format.lossy ? settings.quality / 100 : undefined;
    const blob = await drawAndEncode(image, target.width, target.height, settings.format, quality);
    if (!blob) throw new Error('The image is too large to encode.');
    if (blob.type !== settings.format) {
      throw new Error(`${format.label} encoding is not supported by this browser.`);
    }

    let thumbnail = null;
    if (options.thumbnail) {
      const thumbSize = computeTargetSize(source.width, source.height, {
        scale: 100,
        maxWidth: THUMBNAIL_SIZE,
        maxHeight: THUMBNAIL_SIZE,
      });
      thumbnail = await drawAndEncode(image, thumbSize.width, thumbSize.height, 'image/webp', 0.82);
    }

    return {
      blob,
      width: target.width,
      height: target.height,
      sourceWidth: source.width,
      sourceHeight: source.height,
      limited: target.limited,
      thumbnail,
    };
  }

  root.WebpUtility.compressor = { optimizeImage };
})(self);
