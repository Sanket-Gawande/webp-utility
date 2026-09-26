/**
 * Pure helpers shared by the renderer and the unit tests (no DOM access).
 */
(function (root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  } else {
    root.WebpUtility = Object.assign(root.WebpUtility || {}, { helpers });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTPUT_FORMATS = {
    'image/webp': { label: 'WebP', extension: 'webp', lossy: true },
    'image/jpeg': { label: 'JPEG', extension: 'jpg', lossy: true },
    'image/png': { label: 'PNG', extension: 'png', lossy: false },
  };

  // Formats Chromium can decode. TIFF, HEIC, PSD and RAW files are images too, but can't be read here.
  const INPUT_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp',
    'png', 'apng', 'webp', 'gif', 'bmp', 'dib', 'ico', 'cur', 'svg', 'avif',
  ]);
  const INPUT_MIME_TYPES = new Set([
    'image/jpeg', 'image/pjpeg', 'image/png', 'image/apng', 'image/webp', 'image/gif',
    'image/bmp', 'image/x-ms-bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
    'image/svg+xml', 'image/avif',
  ]);

  // Chromium refuses to allocate canvases beyond these limits.
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 16384 * 16384;

  const DEFAULT_SETTINGS = Object.freeze({
    format: 'image/webp',
    quality: 80,
    scale: 100,
    maxWidth: null,
    maxHeight: null,
    suffix: '-opt',
    keepSmaller: true,
    remember: true,
  });

  const INVALID_FILE_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
  const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
  const MAX_STEM_LENGTH = 200; // leaves room for " (n)" and the extension within 255 chars

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatBytes(bytes, decimals = 1) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = clamp(Math.floor(Math.log(bytes) / Math.log(1024)), 0, units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${parseFloat(value.toFixed(exponent === 0 ? 0 : decimals))} ${units[exponent]}`;
  }

  /** Splits "photo.final.JPG" into { base: "photo.final", extension: "jpg" }. */
  function splitFileName(fileName) {
    const name = String(fileName ?? '');
    const dot = name.lastIndexOf('.');
    if (dot === name.length - 1 && dot > 0) return { base: name.slice(0, -1), extension: '' };
    if (dot <= 0) return { base: name, extension: '' };
    return { base: name.slice(0, dot), extension: name.slice(dot + 1).toLowerCase() };
  }

  function isSupportedImage(file) {
    const type = String(file?.type || '').toLowerCase();
    if (INPUT_MIME_TYPES.has(type)) return true;
    // Some systems report an empty or generic type for WebP/AVIF files, so fall back to the extension.
    const { extension } = splitFileName(file?.name);
    return (!type || type === 'application/octet-stream' || type.startsWith('image/')) &&
      INPUT_EXTENSIONS.has(extension);
  }

  function truncate(value, maxLength) {
    if (value.length <= maxLength) return value;
    let result = value.slice(0, maxLength);
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1); // never split a surrogate pair
    return result;
  }

  /** Builds a file name that is valid on Windows, macOS and Linux, e.g. "photo-opt.webp". */
  function buildOutputName(baseName, suffix, extension) {
    let stem = `${baseName ?? ''}${suffix ?? ''}`
      .replace(INVALID_FILE_NAME_CHARS, '_')
      .trim()
      .replace(/[. ]+$/, ''); // Windows silently strips trailing dots and spaces
    stem = truncate(stem, MAX_STEM_LENGTH).trim();
    if (!stem) stem = 'image';
    if (WINDOWS_RESERVED_NAME.test(stem.split('.')[0].trim())) {
      stem = stem.replace(/^([^.]*)/, '$1_');
    }
    return extension ? `${stem}.${extension}` : stem;
  }

  /** Returns fileName, or "name (2).ext", "name (3).ext"... if it's already taken (case-insensitive). */
  function makeUniqueName(fileName, taken) {
    const { base, extension } = splitFileName(fileName);
    const ext = extension ? `.${extension}` : '';
    let candidate = fileName;
    for (let counter = 2; taken.has(candidate.toLowerCase()); counter++) {
      candidate = `${base} (${counter})${ext}`;
    }
    return candidate;
  }

  /** De-duplicates a list of names against each other and against names that already exist. */
  function dedupeFileNames(fileNames, existingNames = []) {
    const taken = new Set(Array.from(existingNames, (name) => String(name).toLowerCase()));
    return fileNames.map((name) => {
      const unique = makeUniqueName(name, taken);
      taken.add(unique.toLowerCase());
      return unique;
    });
  }

  /** Output dimensions for the given source size: scale first, then fit inside the max box. Never upscales. */
  function computeTargetSize(width, height, settings) {
    let targetWidth = width * (clamp(Number(settings.scale) || 100, 1, 100) / 100);
    let targetHeight = height * (clamp(Number(settings.scale) || 100, 1, 100) / 100);

    if (settings.maxWidth && targetWidth > settings.maxWidth) {
      targetHeight *= settings.maxWidth / targetWidth;
      targetWidth = settings.maxWidth;
    }
    if (settings.maxHeight && targetHeight > settings.maxHeight) {
      targetWidth *= settings.maxHeight / targetHeight;
      targetHeight = settings.maxHeight;
    }

    let limited = false;
    const sideRatio = Math.min(1, MAX_CANVAS_SIDE / targetWidth, MAX_CANVAS_SIDE / targetHeight);
    if (sideRatio < 1) {
      targetWidth *= sideRatio;
      targetHeight *= sideRatio;
      limited = true;
    }
    const area = targetWidth * targetHeight;
    if (area > MAX_CANVAS_AREA) {
      const areaRatio = Math.sqrt(MAX_CANVAS_AREA / area);
      targetWidth *= areaRatio;
      targetHeight *= areaRatio;
      limited = true;
    }

    const round = limited ? Math.floor : Math.round;
    return {
      width: Math.max(1, round(targetWidth)),
      height: Math.max(1, round(targetHeight)),
      limited,
    };
  }

  function toInteger(value, min, max, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? clamp(number, min, max) : fallback;
  }

  /** Positive whole pixel count, or null for "no limit". */
  function toDimension(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 1 ? Math.min(number, MAX_CANVAS_SIDE) : null;
  }

  /** Validates settings coming from storage or form fields, falling back to defaults field by field. */
  function normalizeSettings(raw, defaults = DEFAULT_SETTINGS) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      format: OUTPUT_FORMATS[source.format] ? source.format : defaults.format,
      quality: toInteger(source.quality, 5, 100, defaults.quality),
      scale: toInteger(source.scale, 10, 100, defaults.scale),
      maxWidth: toDimension(source.maxWidth),
      maxHeight: toDimension(source.maxHeight),
      suffix: typeof source.suffix === 'string' ? source.suffix.slice(0, 64) : defaults.suffix,
      keepSmaller: typeof source.keepSmaller === 'boolean' ? source.keepSmaller : defaults.keepSmaller,
      remember: typeof source.remember === 'boolean' ? source.remember : defaults.remember,
    };
  }

  /** Human readable size change, e.g. { text: "−62%", tone: "good" } or { text: "+8%", tone: "bad" }. */
  function describeSizeChange(originalSize, newSize) {
    if (!originalSize || !Number.isFinite(newSize)) return { text: '0%', tone: 'neutral', percent: 0 };
    const percent = Math.round(((newSize - originalSize) / originalSize) * 100);
    if (percent < 0) return { text: `−${Math.abs(percent)}%`, tone: 'good', percent };
    if (percent > 0) return { text: `+${percent}%`, tone: 'bad', percent };
    return { text: '0%', tone: 'neutral', percent: 0 };
  }

  /** "webp-utility-2026-09-26_14-05-09.zip" */
  function timestampedName(prefix, extension, date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return `${prefix}-${day}_${time}.${extension}`;
  }

  return {
    OUTPUT_FORMATS,
    DEFAULT_SETTINGS,
    MAX_CANVAS_SIDE,
    MAX_CANVAS_AREA,
    clamp,
    formatBytes,
    splitFileName,
    isSupportedImage,
    buildOutputName,
    makeUniqueName,
    dedupeFileNames,
    computeTargetSize,
    toDimension,
    normalizeSettings,
    describeSizeChange,
    timestampedName,
  };
});
