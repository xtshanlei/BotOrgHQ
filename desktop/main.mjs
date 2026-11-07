import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { startEngine } from './engine.mjs';

let engine;
let window;
let quitting = false;

function openExternal(address) {
  const url = new URL(address);
  if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href).catch(() => {});
}

function fail(error) {
  if (quitting) return;
  dialog.showErrorBox('BotOrgHQ could not start', error.message);
  app.quit();
}

async function open() {
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : fileURLToPath(new URL('./runtime', import.meta.url));
  engine = startEngine(runtime, join(app.getPath('userData'), 'dsh'), fail);
  const url = await engine.ready;
  if (quitting) return;
  window = new BrowserWindow({
    title: 'BotOrgHQ',
    width: 1320,
    height: 880,
    minWidth: 700,
    minHeight: 480,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === url.origin) return;
    event.preventDefault();
    openExternal(target);
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (new URL(target).origin !== url.origin) openExternal(target);
    return { action: 'deny' };
  });
  await window.loadURL(url.href);
  if (!window.isDestroyed() && !quitting) window.show();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!engine || quitting) return;
    event.preventDefault();
    quitting = true;
    void engine.stop().finally(() => app.quit());
  });
  app.whenReady().then(open).catch(fail);
}
