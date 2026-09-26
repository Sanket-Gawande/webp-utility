/**
 * WebP Utility renderer: batch state, UI wiring and exports.
 * Images never leave the machine; all work happens in this page.
 */
(function () {
  'use strict';

  const { helpers, compressor, createCompareViewer } = window.WebpUtility;
  const {
    OUTPUT_FORMATS,
    DEFAULT_SETTINGS,
    formatBytes,
    splitFileName,
    isSupportedImage,
    buildOutputName,
    dedupeFileNames,
    toDimension,
    normalizeSettings,
    describeSizeChange,
    timestampedName,
  } = helpers;

  // Present only inside the desktop app (see src/preload.js).
  const desktop = window.desktop || null;

  const STORAGE_KEY = 'webputility_settings';
  const MAX_PARALLEL_JOBS = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const MAX_VISIBLE_TOASTS = 4;
  const DOWNLOAD_URL_LIFETIME_MS = 60_000;

  const $ = (id) => document.getElementById(id);
  const dom = {
    titleBar: $('title-bar'),
    mainContent: $('main-content'),
    dropZone: $('drop-zone'),
    fileInput: $('file-input'),
    gridView: $('grid-view'),
    cardsGrid: $('cards-grid'),
    selectAll: $('select-all-checkbox'),
    selectedBadge: $('selected-count-badge'),
    queueStatus: $('queue-status'),
    queueStatusText: $('queue-status-text'),
    btnAddMore: $('btn-add-more'),
    btnRemoveSelected: $('btn-remove-selected'),

    globalFormat: $('global-format'),
    globalQuality: $('global-quality'),
    globalQualityVal: $('global-quality-val'),
    globalQualityGroup: $('global-quality-group'),
    globalScale: $('global-scale'),
    globalScaleVal: $('global-scale-val'),
    globalMaxWidth: $('global-max-width'),
    globalMaxHeight: $('global-max-height'),
    globalSuffix: $('global-suffix'),
    keepSmaller: $('keep-smaller'),
    rememberSettings: $('save-settings'),

    statCount: $('stat-count'),
    statOrigSize: $('stat-orig-size'),
    statCompSize: $('stat-comp-size'),
    statSavings: $('stat-savings'),
    btnExportAll: $('btn-export-all'),
    btnExportSelected: $('btn-export-selected'),
    btnSaveFolder: $('btn-save-folder'),
    btnClearAll: $('btn-clear-all'),

    modal: $('inspect-modal'),
    modalFilename: $('modal-filename'),
    modalDimensions: $('modal-dimensions-info'),
    btnModalClose: $('btn-modal-close'),
    localFilename: $('local-filename'),
    localToggle: $('local-override-toggle'),
    localPanel: $('local-settings-panel'),
    localFormat: $('local-format'),
    localQuality: $('local-quality'),
    localQualityVal: $('local-quality-val'),
    localQualityGroup: $('local-quality-group'),
    localScale: $('local-scale'),
    localScaleVal: $('local-scale-val'),
    localMaxWidth: $('local-max-width'),
    localMaxHeight: $('local-max-height'),
    mstatOriginal: $('mstat-original-size'),
    mstatOptimized: $('mstat-optimized-size'),
    mstatSavings: $('mstat-savings'),
    mstatNote: $('mstat-note'),
    btnModalDownload: $('btn-modal-download'),
    btnModalSaveFolder: $('btn-modal-save-folder'),

    confirmDialog: $('confirm-dialog'),
    confirmTitle: $('confirm-title'),
    confirmMessage: $('confirm-message'),
    confirmActions: $('confirm-actions'),

    toasts: $('toast-container'),
    loader: $('global-loader'),
    loaderTitle: $('loader-title'),
    loaderDesc: $('loader-desc'),
  };

  const viewer = createCompareViewer({
    viewport: $('viewer-viewport'),
    stage: $('zoom-container'),
    originalImage: $('view-img-original'),
    optimizedImage: $('view-img-optimized'),
    optimizedLayer: $('layer-optimized-wrapper'),
    handle: $('comparison-slider-handle'),
    zoomLabel: $('zoom-badge'),
  });

  // --- State ---------------------------------------------------------------

  let globalSettings = normalizeSettings(null);
  const items = [];
  const itemsById = new Map();
  let nextItemId = 1;
  let activeItem = null; // item shown in the inspector
  let focusBeforeModal = null;
  let uiLocked = false; // true while an export or save is running

  // --- Small UI utilities --------------------------------------------------

  function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    const dismiss = () => {
      if (!toast.isConnected || toast.classList.contains('leaving')) return;
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 250);
    };
    close.addEventListener('click', dismiss);
    toast.append(text, close);
    dom.toasts.appendChild(toast);

    while (dom.toasts.children.length > MAX_VISIBLE_TOASTS) dom.toasts.firstElementChild.remove();
    setTimeout(dismiss, type === 'error' ? 6000 : 4000);
  }

  function showLoader(title, description = '') {
    dom.loaderTitle.textContent = title;
    dom.loaderDesc.textContent = description;
    dom.loader.classList.remove('hidden');
  }

  function updateLoader(description) {
    dom.loaderDesc.textContent = description;
  }

  function hideLoader() {
    dom.loader.classList.add('hidden');
  }

  let resolveConfirm = null;

  /**
   * In-app confirmation dialog.
   * @param {{title: string, message: string, actions: {id: string, label: string, variant?: string, default?: boolean}[], cancelId: string}} options
   * @returns {Promise<string>} id of the chosen action
   */
  function askUser({ title, message, actions, cancelId }) {
    if (resolveConfirm) resolveConfirm(cancelId);
    const previousFocus = document.activeElement;
    dom.confirmTitle.textContent = title;
    dom.confirmMessage.textContent = message;
    dom.confirmActions.replaceChildren();

    return new Promise((resolve) => {
      const finish = (id) => {
        resolveConfirm = null;
        dom.confirmDialog.classList.add('hidden');
        dom.confirmDialog.onclick = null;
        if (previousFocus && previousFocus.isConnected) previousFocus.focus();
        resolve(id);
      };
      resolveConfirm = () => finish(cancelId);

      let defaultButton = null;
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `btn btn-${action.variant || 'secondary'}`;
        button.textContent = action.label;
        button.addEventListener('click', () => finish(action.id));
        dom.confirmActions.appendChild(button);
        if (action.default) defaultButton = button;
      }
      dom.confirmDialog.onclick = (event) => {
        if (event.target === dom.confirmDialog) finish(cancelId);
      };
      dom.confirmDialog.classList.remove('hidden');
      (defaultButton || dom.confirmActions.lastElementChild).focus();
    });
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) &&
      !(target instanceof HTMLInputElement && ['checkbox', 'range', 'button'].includes(target.type));
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }

  function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
  }

  // --- Settings ------------------------------------------------------------

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) globalSettings = normalizeSettings(JSON.parse(saved));
    } catch (error) {
      console.warn('Ignoring unreadable saved settings:', error);
    }
    syncGlobalControls();
  }

  function saveSettings() {
    try {
      if (globalSettings.remember) localStorage.setItem(STORAGE_KEY, JSON.stringify(globalSettings));
      else localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('Could not persist settings:', error);
    }
  }

  function qualityLabel(format, quality) {
    // Chromium switches to lossless WebP encoding at 100% quality.
    return format === 'image/webp' && quality >= 100 ? '100% · lossless' : `${quality}%`;
  }

  function syncGlobalControls() {
    const s = globalSettings;
    dom.globalFormat.value = s.format;
    dom.globalQuality.value = s.quality;
    dom.globalQualityVal.textContent = qualityLabel(s.format, s.quality);
    dom.globalQualityGroup.classList.toggle('hidden', !OUTPUT_FORMATS[s.format].lossy);
    dom.globalScale.value = s.scale;
    dom.globalScaleVal.textContent = `${s.scale}%`;
    dom.globalMaxWidth.value = s.maxWidth ?? '';
    dom.globalMaxHeight.value = s.maxHeight ?? '';
    dom.globalSuffix.value = s.suffix;
    dom.keepSmaller.checked = s.keepSmaller;
    dom.rememberSettings.checked = s.remember;
  }

  function updateGlobalSetting(changes, { reprocess = 'global' } = {}) {
    globalSettings = normalizeSettings({ ...globalSettings, ...changes });
    syncGlobalControls();
    saveSettings();
    if (reprocess === 'global') enqueue(items.filter((item) => !item.useLocal));
    else if (reprocess === 'all') enqueue(items);
    else items.forEach(renderCard);
    if (activeItem) renderModal();
  }

  function effectiveSettings(item) {
    return item.useLocal ? item.localSettings : globalSettings;
  }

  function outputFormat(item) {
    return OUTPUT_FORMATS[effectiveSettings(item).format];
  }

  function outputName(item) {
    return buildOutputName(item.baseName, globalSettings.suffix, outputFormat(item).extension);
  }

  function sourceMimeType(file) {
    const type = (file.type || '').toLowerCase();
    if (type === 'image/pjpeg') return 'image/jpeg';
    if (type) return type;
    const { extension } = splitFileName(file.name);
    if (['jpg', 'jpeg', 'jpe', 'jfif'].includes(extension)) return 'image/jpeg';
    if (extension === 'png') return 'image/png';
    if (extension === 'webp') return 'image/webp';
    return '';
  }

  // --- Compression queue ---------------------------------------------------
  // Items are processed a few at a time. Every settings change bumps item.revision, so a result
  // computed with outdated settings is discarded and the item is processed again.

  const pending = new Set();
  const inFlight = new Set();
  let idleWaiters = [];

  function isBusy(item) {
    return item.status === 'queued' || item.status === 'processing';
  }

  function isCurrent(item, revision) {
    return itemsById.get(item.id) === item && item.revision === revision;
  }

  function enqueue(list) {
    for (const item of list) {
      item.revision += 1;
      item.status = 'queued';
      if (!inFlight.has(item.id)) pending.add(item.id);
      renderCard(item);
    }
    if (activeItem && list.includes(activeItem)) renderModal();
    pump();
  }

  function pump() {
    while (inFlight.size < MAX_PARALLEL_JOBS && pending.size > 0) {
      const id = pending.values().next().value;
      pending.delete(id);
      const item = itemsById.get(id);
      if (item) runJob(item);
    }
    renderQueueStatus();
    renderStats();
    if (pending.size === 0 && inFlight.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  function whenIdle() {
    if (pending.size === 0 && inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  async function runJob(item) {
    inFlight.add(item.id);
    const revision = item.revision;
    const settings = { ...effectiveSettings(item) };
    const keepSmaller = globalSettings.keepSmaller;
    item.status = 'processing';
    renderCard(item);

    try {
      const result = await compressor.optimizeImage(item.sourceUrl, settings, { thumbnail: !item.thumbUrl });
      const stillInBatch = itemsById.get(item.id) === item;
      if (stillInBatch && result.thumbnail && !item.thumbUrl) {
        item.thumbUrl = URL.createObjectURL(result.thumbnail);
      }
      if (isCurrent(item, revision)) applyResult(item, result, settings, keepSmaller);
    } catch (error) {
      if (isCurrent(item, revision)) {
        releaseOutput(item);
        item.status = 'error';
        item.error = error.message || 'This image could not be processed.';
      }
    } finally {
      inFlight.delete(item.id);
      if (itemsById.get(item.id) === item) {
        if (item.revision !== revision) pending.add(item.id); // settings changed while encoding
        renderCard(item);
        if (activeItem === item) renderModal();
      }
      pump();
    }
  }

  function applyResult(item, result, settings, keepSmaller) {
    item.width = result.sourceWidth;
    item.height = result.sourceHeight;

    // Re-encoding an already optimized file in the same format and size can make it bigger.
    const unchangedShape = result.width === result.sourceWidth && result.height === result.sourceHeight;
    const keptOriginal = keepSmaller && unchangedShape &&
      sourceMimeType(item.file) === settings.format && result.blob.size >= item.originalSize;
    const blob = keptOriginal ? item.file : result.blob;

    releaseOutput(item);
    item.output = {
      blob,
      url: URL.createObjectURL(blob),
      size: blob.size,
      width: result.width,
      height: result.height,
      keptOriginal,
      limited: result.limited,
    };
    item.status = 'done';
    item.error = null;
  }

  function releaseOutput(item) {
    if (item.output) URL.revokeObjectURL(item.output.url);
    item.output = null;
  }

  // --- Adding images -------------------------------------------------------

  function fileKey(file) {
    return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  }

  function createItem(file) {
    const { base } = splitFileName(file.name);
    return {
      id: `img-${nextItemId++}`,
      file,
      name: file.name,
      baseName: base || 'image',
      originalSize: file.size,
      sourceUrl: URL.createObjectURL(file),
      thumbUrl: null,
      width: 0,
      height: 0,
      status: 'queued',
      error: null,
      revision: 0,
      output: null,
      selected: true,
      useLocal: false,
      localSettings: null,
      el: null,
    };
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const known = new Set(items.map((item) => fileKey(item.file)));
    const added = [];
    let unsupported = 0;
    let duplicates = 0;
    let gifs = 0;

    for (const file of files) {
      if (!isSupportedImage(file)) {
        unsupported++;
        continue;
      }
      const key = fileKey(file);
      if (known.has(key)) {
        duplicates++;
        continue;
      }
      known.add(key);
      const item = createItem(file);
      if (sourceMimeType(file) === 'image/gif') gifs++;
      items.push(item);
      itemsById.set(item.id, item);
      dom.cardsGrid.appendChild(createCard(item));
      added.push(item);
    }

    if (added.length > 0) {
      showWorkspace(true);
      enqueue(added);
      renderSelection();
    }
    if (unsupported > 0) {
      showToast(`Skipped ${plural(unsupported, 'file')} that isn't a supported image (JPEG, PNG, WebP, AVIF, GIF, SVG, BMP, ICO).`, 'error');
    }
    if (duplicates > 0) showToast(`Skipped ${plural(duplicates, 'duplicate')} already in the batch.`, 'warning');
    if (gifs > 0) showToast('Animated GIFs are exported as a still image of their first frame.', 'warning');
  }

  /** Collects files from a drop, including the contents of dropped folders. */
  async function filesFromDrop(dataTransfer) {
    // Entries must be read synchronously, before the drop event finishes.
    const entries = Array.from(dataTransfer.items || [])
      .filter((entry) => entry.kind === 'file')
      .map((entry) => (entry.webkitGetAsEntry ? entry.webkitGetAsEntry() : null));
    if (entries.length === 0 || entries.some((entry) => !entry)) return Array.from(dataTransfer.files || []);

    const files = [];
    const readEntries = (reader) => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    const getFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

    async function collect(entry) {
      try {
        if (entry.isFile) {
          files.push(await getFile(entry));
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          // readEntries returns results in batches until it yields an empty array.
          for (let batch = await readEntries(reader); batch.length > 0; batch = await readEntries(reader)) {
            for (const child of batch) await collect(child);
          }
        }
      } catch (error) {
        console.warn(`Could not read ${entry.fullPath}:`, error);
      }
    }

    for (const entry of entries) await collect(entry);
    return files;
  }

  function openFilePicker() {
    if (!uiLocked) dom.fileInput.click();
  }

  function showWorkspace(hasItems) {
    dom.dropZone.classList.toggle('hidden', hasItems);
    dom.gridView.classList.toggle('hidden', !hasItems);
  }

  // --- Cards ---------------------------------------------------------------

  const CARD_TEMPLATE = `
    <div class="card-preview">
      <label class="checkbox-container card-checkbox-overlay">
        <input type="checkbox" class="card-checkbox">
        <span class="checkmark"></span>
      </label>
      <button class="btn-card-remove" type="button" title="Remove image" aria-label="Remove image">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <img class="card-thumb" alt="" decoding="async" draggable="false">
      <div class="card-placeholder"><span class="mini-spinner"></span></div>
    </div>
    <div class="card-details">
      <div class="card-name" tabindex="0"></div>
      <span class="card-settings-badge"></span>
      <div class="card-sizes">
        <div class="size-comp">
          <span class="size-orig"></span>
          <span class="size-new"></span>
        </div>
        <span class="savings-pill"></span>
      </div>
    </div>
    <div class="card-actions">
      <button class="btn-card-action compare" type="button">Compare</button>
      <button class="btn-card-action download" type="button">Download</button>
    </div>`;

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'image-card';
    card.dataset.id = item.id;
    card.innerHTML = CARD_TEMPLATE; // static markup only; item data is set via textContent below

    item.el = {
      card,
      checkbox: card.querySelector('.card-checkbox'),
      thumb: card.querySelector('.card-thumb'),
      name: card.querySelector('.card-name'),
      badge: card.querySelector('.card-settings-badge'),
      sizeOrig: card.querySelector('.size-orig'),
      sizeNew: card.querySelector('.size-new'),
      pill: card.querySelector('.savings-pill'),
      download: card.querySelector('.download'),
    };
    item.el.checkbox.setAttribute('aria-label', `Select ${item.name}`);
    item.el.thumb.alt = item.name;
    item.el.sizeOrig.textContent = formatBytes(item.originalSize);

    item.el.checkbox.addEventListener('change', (event) => {
      item.selected = event.target.checked;
      renderSelection();
    });
    card.querySelector('.btn-card-remove').addEventListener('click', (event) => {
      event.stopPropagation();
      removeItems([item]);
    });
    card.querySelector('.card-preview').addEventListener('click', (event) => {
      if (event.target.closest('.card-checkbox-overlay, .btn-card-remove')) return;
      openModal(item);
    });
    card.querySelector('.compare').addEventListener('click', () => openModal(item));
    item.el.download.addEventListener('click', () => downloadItem(item));

    item.el.name.addEventListener('dblclick', () => startInlineRename(item));
    item.el.name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        startInlineRename(item);
      }
    });

    renderCard(item);
    return card;
  }

  function renderCard(item) {
    const el = item.el;
    if (!el) return;
    const format = outputFormat(item);

    el.card.classList.toggle('selected', item.selected);
    el.card.classList.toggle('is-busy', isBusy(item));
    el.card.classList.toggle('has-error', item.status === 'error');
    el.checkbox.checked = item.selected;

    if (item.thumbUrl && el.thumb.getAttribute('src') !== item.thumbUrl) el.thumb.src = item.thumbUrl;
    el.card.classList.toggle('has-thumb', Boolean(item.thumbUrl));

    if (!el.name.querySelector('input')) {
      el.name.textContent = item.baseName;
      el.name.title = `${outputName(item)}\nDouble-click to rename`;
    }

    el.badge.classList.toggle('override', item.useLocal);
    el.badge.classList.toggle('error', item.status === 'error');
    if (item.status === 'error') {
      el.badge.textContent = 'Could not process';
      el.badge.title = item.error;
    } else {
      el.badge.textContent = `${item.useLocal ? 'Custom' : 'Global'}: ${format.label}`;
      el.badge.removeAttribute('title');
    }

    el.pill.className = 'savings-pill';
    el.download.disabled = item.status !== 'done';
    if (item.status === 'error') {
      el.sizeNew.textContent = 'Failed';
      el.pill.textContent = 'Error';
      el.pill.classList.add('bad');
    } else if (isBusy(item) || !item.output) {
      el.sizeNew.textContent = item.status === 'processing' ? 'Optimizing…' : 'Queued…';
      el.pill.textContent = '--';
      el.pill.classList.add('neutral');
    } else {
      const change = describeSizeChange(item.originalSize, item.output.size);
      el.sizeNew.textContent = formatBytes(item.output.size);
      el.pill.textContent = item.output.keptOriginal ? 'Original' : change.text;
      el.pill.classList.add(item.output.keptOriginal ? 'neutral' : change.tone);
      el.pill.title = item.output.keptOriginal ? 'Re-encoding made this file bigger, so the original is kept.' : '';
    }
  }

  function startInlineRename(item) {
    const nameEl = item.el.name;
    if (nameEl.querySelector('input')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-name-input';
    input.value = item.baseName;
    input.spellcheck = false;
    input.setAttribute('aria-label', 'File name');
    const ext = document.createElement('span');
    ext.className = 'card-name-ext';
    ext.textContent = `${globalSettings.suffix}.${outputFormat(item).extension}`;

    nameEl.classList.add('editing');
    nameEl.replaceChildren(input, ext);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (commit && value) setBaseName(item, value);
      nameEl.classList.remove('editing');
      nameEl.replaceChildren();
      renderCard(item);
      nameEl.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  function setBaseName(item, baseName) {
    item.baseName = baseName;
    renderCard(item);
    if (activeItem === item) {
      if (document.activeElement !== dom.localFilename) dom.localFilename.value = baseName;
      renderModal();
    }
  }

  // --- Batch management ----------------------------------------------------

  function selectedItems() {
    return items.filter((item) => item.selected);
  }

  function removeItems(list) {
    if (list.length === 0) return;
    for (const item of list) {
      itemsById.delete(item.id);
      pending.delete(item.id);
      URL.revokeObjectURL(item.sourceUrl);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      releaseOutput(item);
      item.el?.card.remove();
      item.el = null;
      if (activeItem === item) closeModal();
    }
    const remaining = items.filter((item) => itemsById.has(item.id));
    items.splice(0, items.length, ...remaining);

    showWorkspace(items.length > 0);
    renderSelection();
    pump();
  }

  async function removeSelected() {
    const list = selectedItems();
    if (list.length === 0) return;
    if (list.length > 1) {
      const choice = await askUser({
        title: `Remove ${plural(list.length, 'image')}?`,
        message: 'The selected images will be removed from the batch. Files on disk are not touched.',
        actions: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'remove', label: 'Remove', variant: 'danger', default: true },
        ],
        cancelId: 'cancel',
      });
      if (choice !== 'remove') return;
    }
    removeItems(list);
  }

  async function clearBatch() {
    if (items.length === 0) return;
    const choice = await askUser({
      title: 'Clear the whole batch?',
      message: `All ${plural(items.length, 'image')} will be removed from the workspace. Files on disk are not touched.`,
      actions: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'clear', label: 'Clear Batch', variant: 'danger', default: true },
      ],
      cancelId: 'cancel',
    });
    if (choice === 'clear') removeItems([...items]);
  }

  function setAllSelected(selected) {
    items.forEach((item) => {
      item.selected = selected;
    });
    renderSelection();
  }

  function renderSelection() {
    const selectedCount = items.reduce((count, item) => count + (item.selected ? 1 : 0), 0);
    items.forEach((item) => {
      if (!item.el) return;
      item.el.card.classList.toggle('selected', item.selected);
      item.el.checkbox.checked = item.selected;
    });

    dom.selectAll.checked = items.length > 0 && selectedCount === items.length;
    dom.selectAll.indeterminate = selectedCount > 0 && selectedCount < items.length;
    dom.selectedBadge.textContent = `${selectedCount} of ${items.length} selected`;

    const locked = uiLocked;
    dom.btnExportAll.disabled = locked || items.length === 0;
    dom.btnClearAll.disabled = locked || items.length === 0;
    dom.btnExportSelected.disabled = locked || selectedCount === 0;
    dom.btnSaveFolder.disabled = locked || selectedCount === 0;
    dom.btnRemoveSelected.disabled = locked || selectedCount === 0;
    renderStats();
  }

  function renderStats() {
    let original = 0;
    let optimized = 0;
    for (const item of items) {
      original += item.originalSize;
      optimized += item.output ? item.output.size : item.originalSize;
    }
    dom.statCount.textContent = String(items.length);
    dom.statOrigSize.textContent = formatBytes(original);
    dom.statCompSize.textContent = formatBytes(optimized);

    const change = describeSizeChange(original, optimized);
    dom.statSavings.className = `stat-val tone-${change.tone}`;
    if (change.tone === 'good') {
      dom.statSavings.textContent = `${Math.abs(change.percent)}% · ${formatBytes(original - optimized)}`;
    } else if (change.tone === 'bad') {
      dom.statSavings.textContent = `${change.text} larger`;
    } else {
      dom.statSavings.textContent = '0%';
    }
  }

  function renderQueueStatus() {
    const busy = items.reduce((count, item) => count + (isBusy(item) ? 1 : 0), 0);
    dom.queueStatus.classList.toggle('hidden', busy === 0);
    dom.queueStatusText.textContent = `Optimizing ${busy} of ${items.length}…`;
  }

  // --- Inspector modal -----------------------------------------------------

  function openModal(item) {
    if (uiLocked) return;
    activeItem = item;
    focusBeforeModal = document.activeElement;

    dom.localFilename.value = item.baseName;
    dom.localToggle.checked = item.useLocal;
    syncLocalControls(item);

    dom.modal.classList.remove('hidden');
    viewer.open(item.sourceUrl, item.output ? item.output.url : item.sourceUrl, {
      width: item.width,
      height: item.height,
    });
    renderModal();
    dom.btnModalClose.focus();
  }

  function closeModal() {
    if (!activeItem) return;
    activeItem = null;
    dom.modal.classList.add('hidden');
    viewer.close();
    if (focusBeforeModal && focusBeforeModal.isConnected) focusBeforeModal.focus();
    focusBeforeModal = null;
  }

  function syncLocalControls(item) {
    const s = item.localSettings || globalSettings;
    dom.localPanel.disabled = !item.useLocal;
    dom.localFormat.value = s.format;
    dom.localQuality.value = s.quality;
    dom.localQualityVal.textContent = qualityLabel(s.format, s.quality);
    dom.localQualityGroup.classList.toggle('hidden', !OUTPUT_FORMATS[s.format].lossy);
    dom.localScale.value = s.scale;
    dom.localScaleVal.textContent = `${s.scale}%`;
    dom.localMaxWidth.value = s.maxWidth ?? '';
    dom.localMaxHeight.value = s.maxHeight ?? '';
  }

  function renderModal() {
    const item = activeItem;
    if (!item) return;

    const name = outputName(item);
    dom.modalFilename.textContent = name;
    dom.modalFilename.title = name;

    if (item.output) {
      dom.modalDimensions.textContent =
        `Original ${item.width} × ${item.height} px  →  Optimized ${item.output.width} × ${item.output.height} px`;
    } else {
      dom.modalDimensions.textContent = item.width ? `Original ${item.width} × ${item.height} px` : '';
    }

    dom.mstatOriginal.textContent = formatBytes(item.originalSize);
    let note = '';
    dom.mstatSavings.className = 'mstat-val';
    if (item.status === 'error') {
      dom.mstatOptimized.textContent = 'Failed';
      dom.mstatSavings.textContent = '--';
      note = item.error;
    } else if (isBusy(item) || !item.output) {
      dom.mstatOptimized.textContent = item.status === 'processing' ? 'Optimizing…' : 'Queued…';
      dom.mstatSavings.textContent = '--';
    } else {
      const change = describeSizeChange(item.originalSize, item.output.size);
      dom.mstatOptimized.textContent = formatBytes(item.output.size);
      dom.mstatSavings.textContent = item.output.keptOriginal ? 'Original kept' : change.text;
      dom.mstatSavings.classList.add(`tone-${item.output.keptOriginal ? 'neutral' : change.tone}`);
      if (item.output.keptOriginal) {
        note = 'Re-encoding made this file bigger, so the original file will be exported unchanged.';
      } else if (item.output.limited) {
        note = 'Resized to stay within the maximum canvas size supported for encoding.';
      } else if (change.tone === 'bad') {
        note = 'The optimized file is larger than the original. Try a lower quality or a different format.';
      }
      viewer.updateOptimized(item.output.url);
    }
    dom.mstatNote.textContent = note;
    dom.mstatNote.classList.toggle('hidden', !note);

    const ready = item.status === 'done';
    dom.btnModalDownload.disabled = !ready;
    dom.btnModalSaveFolder.disabled = !ready;
  }

  function updateLocalSetting(changes) {
    const item = activeItem;
    if (!item || !item.useLocal) return;
    item.localSettings = normalizeSettings({ ...item.localSettings, ...changes });
    syncLocalControls(item);
    enqueue([item]);
  }

  // --- Exporting -----------------------------------------------------------

  /** Waits for pending work, then splits the list into exportable and failed items. */
  async function readyForExport(list) {
    if (list.some(isBusy)) {
      showLoader('Finishing optimization…', `Waiting for ${plural(list.filter(isBusy).length, 'image')} to finish.`);
      await whenIdle();
    }
    const ready = list.filter((item) => item.status === 'done' && item.output && itemsById.has(item.id));
    return { ready, failed: list.length - ready.length };
  }

  async function runLocked(task) {
    if (uiLocked) return;
    uiLocked = true;
    renderSelection();
    try {
      await task();
    } catch (error) {
      console.error(error);
      showToast(`Something went wrong: ${error.message || error}`, 'error');
    } finally {
      hideLoader();
      uiLocked = false;
      renderSelection();
    }
  }

  function failedNote(failed) {
    return failed > 0 ? ` ${plural(failed, 'image')} that couldn't be processed ${failed === 1 ? 'was' : 'were'} skipped.` : '';
  }

  function exportZip(list) {
    return runLocked(async () => {
      if (typeof JSZip === 'undefined') {
        showToast('The ZIP library failed to load. Reinstall the app or run npm install.', 'error');
        return;
      }
      const { ready, failed } = await readyForExport(list);
      if (ready.length === 0) {
        showToast('None of these images could be processed, so there is nothing to export.', 'error');
        return;
      }

      showLoader('Creating ZIP archive…', `Packaging ${plural(ready.length, 'image')}.`);
      const names = dedupeFileNames(ready.map(outputName));
      const zip = new JSZip();
      ready.forEach((item, index) => zip.file(names[index], item.output.blob));
      // Images are already compressed; storing them is much faster and barely larger.
      const archive = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
        updateLoader(`Packaging ${plural(ready.length, 'image')}… ${Math.round(meta.percent)}%`);
      });

      downloadBlob(archive, timestampedName('webp-utility', 'zip'));
      showToast(`Exported ${plural(ready.length, 'image')} (${formatBytes(archive.size)}) as ZIP.${failedNote(failed)}`,
        failed ? 'warning' : 'success');
    });
  }

  function downloadItem(item) {
    if (item.status !== 'done' || !item.output) {
      showToast(item.status === 'error' ? item.error : 'This image is still being optimized.', 'error');
      return;
    }
    const name = outputName(item);
    downloadBlob(item.output.blob, name);
    showToast(`Downloaded ${name}`);
  }

  /** Lets the user pick a folder. Returns null if cancelled, undefined if unsupported. */
  async function pickFolder() {
    if (desktop) {
      const dirPath = await desktop.fs.selectDirectory();
      if (!dirPath) return null;
      return {
        label: dirPath,
        list: () => desktop.fs.listDirectory(dirPath),
        async write(name, blob, overwrite) {
          const data = new Uint8Array(await blob.arrayBuffer());
          const result = await desktop.fs.writeFile(dirPath, name, data, overwrite);
          if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
        },
      };
    }

    if (typeof window.showDirectoryPicker === 'function') {
      let handle;
      try {
        handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (error) {
        if (error.name === 'AbortError') return null;
        throw error;
      }
      return {
        label: handle.name,
        async list() {
          const names = [];
          for await (const name of handle.keys()) names.push(name);
          return names;
        },
        async write(name, blob, overwrite) {
          if (!overwrite) {
            const exists = await handle.getFileHandle(name).then(
              () => true,
              (error) => (error.name === 'NotFoundError' ? false : true),
            );
            if (exists) throw Object.assign(new Error(`${name} already exists.`), { code: 'EEXIST' });
          }
          const fileHandle = await handle.getFileHandle(name, { create: true });
          const writable = await fileHandle.createWritable();
          try {
            await writable.write(blob);
            await writable.close();
          } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
          }
        },
      };
    }

    return undefined;
  }

  function saveToFolder(list) {
    return runLocked(async () => {
      const { ready, failed } = await readyForExport(list);
      hideLoader();
      if (ready.length === 0) {
        showToast('None of these images could be processed, so there is nothing to save.', 'error');
        return;
      }

      const folder = await pickFolder();
      if (folder === undefined) {
        showToast('Saving to a folder is not supported in this browser. Use a ZIP export instead.', 'error');
        return;
      }
      if (folder === null) return;

      const existing = await folder.list();
      const existingLower = new Set(existing.map((name) => name.toLowerCase()));
      let names = dedupeFileNames(ready.map(outputName));
      const conflicts = names.filter((name) => existingLower.has(name.toLowerCase()));

      let overwrite = false;
      if (conflicts.length > 0) {
        const example = conflicts.length === 1 ? `"${conflicts[0]}" already exists` :
          `"${conflicts[0]}" and ${plural(conflicts.length - 1, 'other file')} already exist`;
        const choice = await askUser({
          title: conflicts.length === 1 ? 'File already exists' : `${conflicts.length} files already exist`,
          message: `${example} in "${folder.label}". Replace them, or keep both by numbering the new files?`,
          actions: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'replace', label: 'Replace', variant: 'danger' },
            { id: 'keep', label: 'Keep Both', variant: 'primary', default: true },
          ],
          cancelId: 'cancel',
        });
        if (choice === 'cancel') return;
        if (choice === 'replace') overwrite = true;
        else names = dedupeFileNames(names, existing);
      }

      showLoader('Saving to folder…', '');
      const taken = new Set([...existingLower, ...names.map((name) => name.toLowerCase())]);
      let saved = 0;
      const errors = [];
      for (let index = 0; index < ready.length; index++) {
        updateLoader(`Writing ${index + 1} of ${ready.length}: ${names[index]}`);
        try {
          await folder.write(names[index], ready[index].output.blob, overwrite);
          saved++;
        } catch (error) {
          if (error.code === 'EEXIST') {
            // A file with this name appeared after the folder was checked: pick a fresh name.
            const [fresh] = dedupeFileNames([names[index]], taken);
            taken.add(fresh.toLowerCase());
            try {
              await folder.write(fresh, ready[index].output.blob, false);
              saved++;
              continue;
            } catch (retryError) {
              errors.push(`${fresh}: ${retryError.message}`);
              continue;
            }
          }
          errors.push(`${names[index]}: ${error.message}`);
        }
      }

      if (errors.length > 0) {
        console.error('Failed to save:', errors);
        showToast(`Saved ${saved} of ${ready.length}. Could not write ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`, 'error');
      } else {
        showToast(`Saved ${plural(saved, 'image')} to "${folder.label}".${failedNote(failed)}`, failed ? 'warning' : 'success');
      }
    });
  }

  // --- Event wiring --------------------------------------------------------

  function bindWindowControls() {
    if (!desktop) {
      document.body.classList.add('is-browser');
      // Closing a tab would silently discard the batch.
      window.addEventListener('beforeunload', (event) => {
        if (items.length > 0) event.preventDefault();
      });
      return;
    }
    $('win-btn-minimize').addEventListener('click', () => desktop.window.minimize());
    $('win-btn-maximize').addEventListener('click', () => desktop.window.toggleMaximize());
    $('win-btn-close').addEventListener('click', () => desktop.window.close());
    desktop.window.onMaximizeChange((isMaximized) => {
      dom.titleBar.classList.toggle('is-maximized', isMaximized);
      $('win-btn-maximize').setAttribute('aria-label', isMaximized ? 'Restore' : 'Maximize');
    });
  }

  function bindDragAndDrop() {
    let dragDepth = 0;
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
    const canDrop = () => !activeItem && !uiLocked && dom.confirmDialog.classList.contains('hidden');
    const reset = () => {
      dragDepth = 0;
      document.body.classList.remove('is-dragging');
    };

    // Prevent the window from navigating to a dropped file anywhere in the app.
    window.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles(event) && canDrop() ? 'copy' : 'none';
    });
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event) || !canDrop()) return;
      dragDepth++;
      document.body.classList.add('is-dragging');
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) reset();
    });
    window.addEventListener('drop', async (event) => {
      event.preventDefault();
      reset();
      if (!hasFiles(event) || !canDrop()) return;
      addFiles(await filesFromDrop(event.dataTransfer));
    });
  }

  function bindGlobalSettings() {
    dom.globalFormat.addEventListener('change', (event) => updateGlobalSetting({ format: event.target.value }));
    dom.globalQuality.addEventListener('input', (event) => {
      dom.globalQualityVal.textContent = qualityLabel(globalSettings.format, Number(event.target.value));
    });
    dom.globalQuality.addEventListener('change', (event) => updateGlobalSetting({ quality: event.target.value }));
    dom.globalScale.addEventListener('input', (event) => {
      dom.globalScaleVal.textContent = `${event.target.value}%`;
    });
    dom.globalScale.addEventListener('change', (event) => updateGlobalSetting({ scale: event.target.value }));

    [dom.globalMaxWidth, dom.globalMaxHeight].forEach((input) => {
      input.addEventListener('change', () => {
        const maxWidth = toDimension(dom.globalMaxWidth.value);
        const maxHeight = toDimension(dom.globalMaxHeight.value);
        if (maxWidth === globalSettings.maxWidth && maxHeight === globalSettings.maxHeight) {
          syncGlobalControls(); // normalize what was typed, e.g. "-5" or "12.7"
          return;
        }
        updateGlobalSetting({ maxWidth, maxHeight });
      });
    });

    dom.globalSuffix.addEventListener('input', (event) => {
      globalSettings = normalizeSettings({ ...globalSettings, suffix: event.target.value });
      saveSettings();
      items.forEach(renderCard);
      if (activeItem) renderModal();
    });

    dom.keepSmaller.addEventListener('change', (event) => {
      updateGlobalSetting({ keepSmaller: event.target.checked }, { reprocess: 'all' });
    });
    dom.rememberSettings.addEventListener('change', (event) => {
      updateGlobalSetting({ remember: event.target.checked }, { reprocess: 'none' });
    });
  }

  function bindModal() {
    dom.btnModalClose.addEventListener('click', closeModal);

    // Only close on a click that both starts and ends on the backdrop, so a pan
    // that ends outside the dialog doesn't close it.
    let pressStartedOnBackdrop = false;
    dom.modal.addEventListener('pointerdown', (event) => {
      pressStartedOnBackdrop = event.target === dom.modal;
    });
    dom.modal.addEventListener('click', (event) => {
      if (pressStartedOnBackdrop && event.target === dom.modal) closeModal();
      pressStartedOnBackdrop = false;
    });

    dom.localFilename.addEventListener('input', (event) => {
      const value = event.target.value.trim();
      if (activeItem && value) setBaseName(activeItem, value);
    });
    dom.localFilename.addEventListener('change', (event) => {
      if (activeItem && !event.target.value.trim()) event.target.value = activeItem.baseName;
    });

    dom.localToggle.addEventListener('change', (event) => {
      const item = activeItem;
      if (!item) return;
      item.useLocal = event.target.checked;
      if (item.useLocal && !item.localSettings) {
        // Start from the current global settings the first time custom settings are enabled.
        const { format, quality, scale, maxWidth, maxHeight } = globalSettings;
        item.localSettings = normalizeSettings({ format, quality, scale, maxWidth, maxHeight });
      }
      syncLocalControls(item);
      enqueue([item]);
    });

    dom.localFormat.addEventListener('change', (event) => updateLocalSetting({ format: event.target.value }));
    dom.localQuality.addEventListener('input', (event) => {
      const format = activeItem?.localSettings?.format || globalSettings.format;
      dom.localQualityVal.textContent = qualityLabel(format, Number(event.target.value));
    });
    dom.localQuality.addEventListener('change', (event) => updateLocalSetting({ quality: event.target.value }));
    dom.localScale.addEventListener('input', (event) => {
      dom.localScaleVal.textContent = `${event.target.value}%`;
    });
    dom.localScale.addEventListener('change', (event) => updateLocalSetting({ scale: event.target.value }));
    [dom.localMaxWidth, dom.localMaxHeight].forEach((input) => {
      input.addEventListener('change', () => {
        updateLocalSetting({
          maxWidth: toDimension(dom.localMaxWidth.value),
          maxHeight: toDimension(dom.localMaxHeight.value),
        });
      });
    });

    dom.btnModalDownload.addEventListener('click', () => activeItem && downloadItem(activeItem));
    dom.btnModalSaveFolder.addEventListener('click', () => activeItem && saveToFolder([activeItem]));

    $('btn-zoom-in').addEventListener('click', viewer.zoomIn);
    $('btn-zoom-out').addEventListener('click', viewer.zoomOut);
    $('btn-zoom-fit').addEventListener('click', viewer.fit);
    $('btn-zoom-reset').addEventListener('click', viewer.actualSize);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      if (!dom.confirmDialog.classList.contains('hidden')) {
        if (event.key === 'Escape' && resolveConfirm) resolveConfirm();
        return;
      }
      if (uiLocked) return;

      const typing = isTypingTarget(event.target);
      const mod = event.ctrlKey || event.metaKey;

      if (activeItem) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeModal();
        } else if (!typing && !mod) {
          const actions = { '+': viewer.zoomIn, '=': viewer.zoomIn, '-': viewer.zoomOut, '0': viewer.fit, '1': viewer.actualSize };
          if (actions[event.key]) {
            event.preventDefault();
            actions[event.key]();
          }
        }
        return;
      }

      if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openFilePicker();
      } else if (!typing && mod && event.key.toLowerCase() === 'a' && items.length > 0) {
        event.preventDefault();
        setAllSelected(!items.every((item) => item.selected));
      } else if (!typing && event.key === 'Delete') {
        removeSelected();
      }
    });

    document.addEventListener('paste', (event) => {
      if (isTypingTarget(event.target) || activeItem || uiLocked) return;
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        addFiles(files);
      }
    });
  }

  function bindEvents() {
    bindWindowControls();
    bindDragAndDrop();
    bindGlobalSettings();
    bindModal();
    bindKeyboard();

    dom.dropZone.addEventListener('click', openFilePicker);
    dom.dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFilePicker();
      }
    });
    dom.fileInput.addEventListener('change', () => {
      addFiles(dom.fileInput.files);
      dom.fileInput.value = ''; // allow picking the same files again
    });
    dom.btnAddMore.addEventListener('click', openFilePicker);
    dom.btnRemoveSelected.addEventListener('click', removeSelected);
    dom.selectAll.addEventListener('change', (event) => setAllSelected(event.target.checked));

    dom.btnExportAll.addEventListener('click', () => exportZip([...items]));
    dom.btnExportSelected.addEventListener('click', () => exportZip(selectedItems()));
    dom.btnSaveFolder.addEventListener('click', () => saveToFolder(selectedItems()));
    dom.btnClearAll.addEventListener('click', clearBatch);
  }

  // --- Start ---------------------------------------------------------------

  if (!desktop && typeof window.showDirectoryPicker !== 'function') {
    dom.btnSaveFolder.classList.add('hidden');
    dom.btnModalSaveFolder.classList.add('hidden');
    document.querySelector('.grid-actions-dual').classList.add('single');
  }

  loadSettings();
  bindEvents();
  renderSelection();

  // Exposed for debugging from the developer tools console.
  window.WebpUtility.state = { items, get globalSettings() { return globalSettings; }, defaults: DEFAULT_SETTINGS };
})();
