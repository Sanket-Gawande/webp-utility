'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const APP_ID = 'com.webputility.app';
const RENDERER_ENTRY = path.join(__dirname, 'renderer', 'index.html');
const WINDOW_ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// Characters that are invalid in file names on Windows, macOS or Linux.
const INVALID_FILE_NAME = /[<>:"/\\|?*\u0000-\u001F\u007F]/;

// Folders the user picked through the native dialog. The renderer may only write into these,
// so a compromised page can never choose an arbitrary location on disk.
const approvedDirectories = new Set();

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250,
    height: 850,
    minWidth: 950,
    minHeight: 700,
    title: 'WebP Utility',
    backgroundColor: '#121315',
    frame: false,
    show: false,
    icon: process.platform === 'darwin' ? undefined : WINDOW_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const sendMaximizedState = () => {
    mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
  };
  mainWindow.on('maximize', sendMaximizedState);
  mainWindow.on('unmaximize', sendMaximizedState);

  // The UI is a single local page: never navigate away from it or spawn windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(RENDERER_ENTRY);
}

function configureMenu() {
  if (process.platform === 'darwin') {
    // macOS needs an Edit menu for copy/paste shortcuts to work in text fields.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    );
  } else if (app.isPackaged) {
    // The frameless window has no visible menu; removing it also disables the default
    // reload / zoom accelerators that would silently wipe the current batch.
    Menu.setApplicationMenu(null);
  }
}

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function resolveApprovedDirectory(dirPath) {
  const resolved = typeof dirPath === 'string' ? path.resolve(dirPath) : null;
  if (!resolved || !approvedDirectories.has(resolved)) {
    throw new Error('This folder was not selected through the folder picker.');
  }
  return resolved;
}

function assertSafeFileName(fileName) {
  const valid =
    typeof fileName === 'string' &&
    fileName.length > 0 &&
    fileName.length <= 255 &&
    fileName !== '.' &&
    fileName !== '..' &&
    !INVALID_FILE_NAME.test(fileName);
  if (!valid) throw new Error(`Invalid file name: ${fileName}`);
  return fileName;
}

function registerIpcHandlers() {
  ipcMain.on('window:minimize', (event) => windowFor(event)?.minimize());
  ipcMain.on('window:toggle-maximize', (event) => {
    const win = windowFor(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', (event) => windowFor(event)?.close());

  ipcMain.handle('fs:select-directory', async (event) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(windowFor(event), {
      title: 'Choose a folder for the optimized images',
      buttonLabel: 'Save Here',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;

    const dirPath = path.resolve(filePaths[0]);
    approvedDirectories.add(dirPath);
    return dirPath;
  });

  ipcMain.handle('fs:list-directory', async (_event, dirPath) => {
    return fs.readdir(resolveApprovedDirectory(dirPath));
  });

  ipcMain.handle('fs:write-file', async (_event, request) => {
    const { dirPath, fileName, data, overwrite } = request || {};
    const directory = resolveApprovedDirectory(dirPath);
    const safeName = assertSafeFileName(fileName);
    if (!(data instanceof Uint8Array)) throw new Error('Invalid file data.');

    try {
      // 'wx' fails instead of silently replacing a file that appeared in the meantime.
      await fs.writeFile(path.join(directory, safeName), data, { flag: overwrite ? 'w' : 'wx' });
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code || 'EUNKNOWN', message: error.message };
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    configureMenu();
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
