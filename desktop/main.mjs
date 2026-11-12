import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { startEngine } from './engine.mjs';
import { backupData, prepareData, recordVersion } from './data.mjs';
import { DesktopUpdates } from './updates.mjs';

let engine;
let window;
let quitting = false;
let updateWindow;
let updater;
let installing = false;
let runtimePath;
const desktop = dirname(fileURLToPath(import.meta.url));

function githubToken() {
  try { return safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'github-update-token.bin'))); }
  catch { return ''; }
}

async function showUpdates() {
  if (updateWindow && !updateWindow.isDestroyed()) { updateWindow.show(); updateWindow.focus(); return; }
  updateWindow = new BrowserWindow({ title: 'BotOrgHQ 更新', width: 650, height: 640, parent: window,
    webPreferences: { preload: join(desktop, 'update-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  updateWindow.webContents.on('will-navigate', event => event.preventDefault());
  updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await updateWindow.loadFile(join(desktop, 'update.html'));
  if (!['ready', 'downloading', 'installing'].includes(updater.state.phase)) void updater.check();
}

function registerUpdates() {
  updater = new DesktopUpdates({ directory: join(app.getPath('userData'), 'updates'), version: app.getVersion(), token: githubToken });
  const handle = (name, action) => ipcMain.handle(`updates:${name}`, (event, ...args) => {
    if (!updateWindow || event.sender !== updateWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid update window.');
    return action(...args);
  });
  handle('state', () => ({ ...updater.state }));
  handle('check', () => updater.check());
  handle('download', () => updater.downloadUpdate());
  handle('backups', () => shell.openPath(join(app.getPath('userData'), 'backups')));
  handle('token', token => {
    if (typeof token !== 'string' || token.length > 500) throw new Error('Invalid GitHub token.');
    const file = join(app.getPath('userData'), 'github-update-token.bin');
    if (!token.trim()) { rmSync(file, { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，无法保存 Token。');
    writeFileSync(file, safeStorage.encryptString(token.trim()), { mode: 0o600 });
  });
  handle('install', async () => {
    if (installing || updater.state.phase !== 'ready') return;
    installing = true;
    let stopped = false;
    try {
      const answer = await dialog.showMessageBox(updateWindow, { type: 'question', buttons: ['取消', '备份并安装'], defaultId: 0, cancelId: 0,
        message: '现在安装更新？', detail: '正在运行的任务会停止。应用会先备份全部 DSH 数据，再安装并退出。' });
      if (answer.response !== 1) return;
      const installation = await updater.prepareInstall(resolve(dirname(process.execPath), '..', '..'));
      updater.set({ phase: 'installing', message: '正在停止任务并备份数据…' });
      const shutdown = await engine.stop();
      stopped = true;
      if (shutdown.forced) throw new Error('DSH 未能及时完成关闭。本次更新已停止，请重新检查任务后再安装。');
      const backup = await backupData(app.getPath('userData'), app.getVersion(), 'before-in-app-install');
      updater.set({ message: `数据已备份到 ${backup}，正在启动安装程序…` });
      await updater.launchInstall(installation);
      app.quit();
    } catch (error) {
      updater.set({ phase: 'error', message: error.message });
      if (stopped) {
        engine = startEngine(runtimePath, join(app.getPath('userData'), 'dsh'), fail);
        await window.loadURL((await engine.ready).href);
      }
    } finally { installing = false; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'BotOrgHQ', submenu: [{ role: 'about' }, { label: '检查更新…', click: showUpdates }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '帮助', submenu: [{ label: '检查更新…', click: showUpdates }, { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) }] }
  ]));
}

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
  runtimePath = runtime;
  await prepareData(app.getPath('userData'), app.getVersion());
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
  await recordVersion(app.getPath('userData'), app.getVersion());
  registerUpdates();
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

