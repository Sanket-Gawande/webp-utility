# Changelog

## [1.1.0] - 2026-09-26

First public release of the WebP Utility desktop app for Windows.

**Download:** `WebP-Utility-Setup-1.1.0.exe` below. Windows SmartScreen may warn because the installer
is not code-signed; choose **More info → Run anyway** to continue.

### Added
- New app icon, used for the installer, executable, taskbar, title bar, sidebar and favicon.
- Drop whole folders (their images are collected recursively) and paste images with `Ctrl+V`.
- "Keep original if it's smaller" option: files that would grow when re-encoded in the same format keep their original bytes.
- Per-image error state for files that can't be decoded (for example TIFF, HEIC or corrupted files).
- Live queue status, "Remove selected", keyboard shortcuts and an indeterminate "Select all" state.
- Conflict handling when saving to a folder: **Replace**, **Keep Both** (auto-numbered) or **Cancel**.
- ZIP export and folder saves wait for images that are still optimizing instead of failing.

### Fixed
- Two images that produced the same output name overwrote each other in ZIPs and folders.
- Files were silently overwritten when saving into a folder that already contained them.
- Stale results could replace newer ones when settings changed while images were still processing.
- Transparent images turned black when converted to JPEG; they are now flattened onto white.
- The comparison divider drifted away from the real split when zooming or panning.
- Finishing a pan outside the inspector closed it; the inspector also gained `Esc` to close.
- File names with HTML characters could inject markup into the page.
- Invalid or reserved file names (`<>:"/\|?*`, `CON`, trailing dots) broke folder saves.
- Negative or fractional max dimensions produced 1 × 1 px images.
- Files without an extension lost their name; unsupported "image" types were accepted and exported as-is.
- "Export All" reset the current selection.
- `build.bat` printed errors (unescaped `&` in `echo`) and depended on paths from one machine.

### Changed
- Upgraded to Electron 44 with a sandboxed renderer, strict Content Security Policy, single-instance lock,
  and folder writes restricted to folders chosen in the native dialog.
- JSZip and the Plus Jakarta Sans font are bundled, so the app works fully offline and makes no network requests.
- Card previews use small thumbnails, which keeps memory usage low with large batches.
- Up to three images are optimized in parallel.
- Source reorganized into `src/main.js`, `src/preload.js` and `src/renderer/`; pure helpers are unit tested.
