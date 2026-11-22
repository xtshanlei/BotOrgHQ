import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerMonitor, safeStorage, shell, Tray } from 'electron';
import { startEngine } from './engine.mjs';
import { backupData, prepareData, recordVersion } from './data.mjs';
import { DesktopUpdates } from './updates.mjs';
import { exportProfile, importProfile, rollbackImport } from './profile-transfer.mjs';

let engine;
let window;
let quitting = false;
let updateWindow;
let updater;
let installing = false;
let runtimePath;
let runtimeOrigin;
let transferring = false;
let keepRunning = false;
let osNotifications = false;
let tray;
const desktop = dirname(fileURLToPath(import.meta.url));
const profileHome = () => join(app.getPath('userData'), 'dsh');
const preferencesPath = () => join(profileHome(), '.botorghq-desktop.json');

function readPreferences() {
  try {
    const values = JSON.parse(readFileSync(preferencesPath(), 'utf8'));
    keepRunning = values.keepRunning === true;
    osNotifications = values.osNotifications === true;
  } catch { keepRunning = false; osNotifications = false; }
}

function savePreferences() {
  writeFileSync(preferencesPath(), JSON.stringify({ keepRunning, osNotifications }) + '\n', { mode: 0o600 });
}

function front() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function setTray() {
  if (!keepRunning || process.platform !== 'win32') {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (tray) return;
  const icon = await app.getFileIcon(process.execPath, { size: 'small' });
  if (!keepRunning || quitting || tray) return;
  tray = new Tray(icon);
  tray.setToolTip('BotOrgHQ · 本机后台运行');
  tray.on('click', front);
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 BotOrgHQ', click: front }, { label: '退出', click: () => app.quit() }]));
}

function createEngine(onUnexpectedExit = fail) {
  return startEngine(runtimePath, profileHome(), onUnexpectedExit, message => {
    if (osNotifications && Notification.isSupported()) {
      const notice = new Notification({ title: 'BotOrgHQ', body: '公司工作台有新的主动活动，请在应用内查看。' });
      notice.on('click', front);
      notice.show();
    }
  });
}

async function startWorkspace(onUnexpectedExit) {
  engine = createEngine(onUnexpectedExit);
  const url = await engine.ready;
  runtimeOrigin = url.origin;
  await window.loadURL(url.href);
}

async function transfer(operation, passphrase) {
  if (transferring || installing || quitting) throw new Error('Another desktop operation is running.');
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 512) throw new Error('请输入 12–512 个字符的恢复密码。');
  transferring = true;
  let stopped = false;
  let imported;
  const home = profileHome();
  const filters = [{ name: 'BotOrgHQ encrypted profile', extensions: ['bohq'] }];
  try {
    const filename = operation === 'export'
      ? (await dialog.showSaveDialog(updateWindow, { title: '导出 BotOrgHQ 数据', defaultPath: 'BotOrgHQ-profile.bohq', filters })).filePath
      : (await dialog.showOpenDialog(updateWindow, { title: '导入 BotOrgHQ 数据', properties: ['openFile'], filters })).filePaths[0];
    if (!filename) return { cancelled: true };
    if (operation === 'import') {
      const permission = await dialog.showMessageBox(updateWindow, { type: 'question',
        message: '导入并启用这个用户数据目录？', detail: '当前数据会另外保留。导入后，主动执行保持暂停。',
        buttons: ['取消', '备份并导入'], defaultId: 0, cancelId: 0 });
      if (permission.response !== 1) return { cancelled: true };
    }
    const shutdown = await engine.stop();
    stopped = true;
    if (shutdown.forced) throw new Error('DSH 未能正常停止。请稍后重新尝试。');
    if (operation === 'export') await exportProfile(home, filename, passphrase);
    else imported = await importProfile(home, filename, passphrase);
    await startWorkspace(error => { if (!transferring) fail(error); });
    stopped = false;
    if (imported) {
      readPreferences();
      await setTray();
    }
    return { path: filename, previous: imported?.previous ?? null };
  } catch (error) {
    if (imported) {
      await engine.stop();
      await rollbackImport(imported);
    }
    if (stopped || imported) await startWorkspace(fail).catch(fail);
    throw error;
  } finally { transferring = false; }
}

function githubToken() {
  try { return safeStorage.decryptString(readFileSync(join(app.getPath('userData'), 'github-update-token.bin'))); }
  catch { return ''; }
}

async function showUpdates(transferMode = false) {
  if (updateWindow && !updateWindow.isDestroyed()) {
    updateWindow.show(); updateWindow.focus();
    if (transferMode === true) updateWindow.webContents.send('updates:show-transfer');
    return;
  }
  updateWindow = new BrowserWindow({ title: 'BotOrgHQ 更新与数据', width: 680, height: 720, parent: window,
    webPreferences: { preload: join(desktop, 'update-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  updateWindow.webContents.on('will-navigate', event => event.preventDefault());
  updateWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await updateWindow.loadFile(join(desktop, 'update.html'));
  if (transferMode === true) updateWindow.webContents.send('updates:show-transfer');
  if (!['ready', 'downloading', 'installing'].includes(updater.state.phase)) void updater.check();
}

function registerUpdates() {
  updater = new DesktopUpdates({ directory: join(app.getPath('userData'), 'updates'), version: app.getVersion(), token: githubToken });
  const handle = (name, action) => ipcMain.handle(`updates:${name}`, (event, ...args) => {
    if (!updateWindow || event.sender !== updateWindow.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid update window.');
    return action(...args);
  });
  handle('state', () => ({ ...updater.state, keepRunning, osNotifications, transferring }));
  handle('transfer', (operation, passphrase) => {
    if (!['export', 'import'].includes(operation)) throw new Error('Unknown transfer operation.');
    return transfer(operation, passphrase);
  });
  handle('preferences', async values => {
    if (transferring || installing) throw new Error('Desktop is busy.');
    keepRunning = values?.keepRunning === true;
    osNotifications = values?.osNotifications === true;
    savePreferences();
    await setTray();
  });
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
    if (installing || transferring || updater.state.phase !== 'ready') return;
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
        await startWorkspace(fail);
      }
    } finally { installing = false; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'BotOrgHQ', submenu: [{ role: 'about' }, { label: '检查更新…', click: showUpdates }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '帮助', submenu: [{ label: '检查更新…', click: showUpdates }, { label: '导出或导入数据…', click: () => showUpdates(true) }, { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) }] }
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
  readPreferences();
  engine = createEngine();
  const url = await engine.ready;
  runtimeOrigin = url.origin;
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
  window.on('close', event => {
    if (!quitting && (keepRunning || transferring || installing)) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === runtimeOrigin) return;
    event.preventDefault();
    openExternal(target);
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (new URL(target).origin !== runtimeOrigin) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (new URL(target).origin !== runtimeOrigin) openExternal(target);
    return { action: 'deny' };
  });
  await window.loadURL(url.href);
  if (!window.isDestroyed() && !quitting) window.show();
  await recordVersion(app.getPath('userData'), app.getVersion());
  registerUpdates();
  await setTray();
  powerMonitor.on('suspend', () => engine.suspend(true));
  powerMonitor.on('resume', () => engine.suspend(false));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    front();
  });
  app.on('activate', front);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!engine || quitting) return;
    event.preventDefault();
    if (transferring) return;
    quitting = true;
    void engine.stop().finally(() => app.quit());
  });
  app.whenReady().then(open).catch(fail);
}

