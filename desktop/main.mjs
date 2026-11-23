import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, powerMonitor, safeStorage, shell, Tray } from 'electron';
import { startEngine } from './engine.mjs';
import { backupData, prepareData, recordVersion } from './data.mjs';
import { DesktopUpdates } from './updates.mjs';
import { desktopLocale, desktopMessages, translateDesktop } from './messages.mjs';
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
let language = 'en';
const t = (key, values) => translateDesktop(language, key, values);
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
  tray.on('click', front);
  localizeTray();
}

function localizeTray() {
  if (!tray) return;
  tray.setToolTip(t('BotOrgHQ · Running locally in the background'));
  tray.setContextMenu(Menu.buildFromTemplate([{ label: t('Open BotOrgHQ'), click: front }, { label: t('Quit'), click: () => app.quit() }]));
}

function createEngine(onUnexpectedExit = fail) {
  return startEngine(runtimePath, profileHome(), onUnexpectedExit, message => {
    if (osNotifications && Notification.isSupported()) {
      const notice = new Notification({ title: 'BotOrgHQ', body: t('There is new proactive activity. Open the company workbench to review it.') });
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
  if (transferring || installing || quitting) throw new Error(t('Another desktop operation is running.'));
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 512) throw new Error(t('Enter a recovery passphrase of 12–512 characters.'));
  transferring = true;
  let stopped = false;
  let imported;
  const home = profileHome();
  const filters = [{ name: t('BotOrgHQ encrypted profile'), extensions: ['bohq'] }];
  try {
    const filename = operation === 'export'
      ? (await dialog.showSaveDialog(updateWindow, { title: t('Export BotOrgHQ data'), defaultPath: 'BotOrgHQ-profile.bohq', filters })).filePath
      : (await dialog.showOpenDialog(updateWindow, { title: t('Import BotOrgHQ data'), properties: ['openFile'], filters })).filePaths[0];
    if (!filename) return { cancelled: true };
    if (operation === 'import') {
      const permission = await dialog.showMessageBox(updateWindow, { type: 'question',
        message: t('Import and use this profile?'), detail: t('Your current profile will be kept separately. Proactive execution stays paused after import.'),
        buttons: [t('Cancel'), t('Back up and import')], defaultId: 0, cancelId: 0 });
      if (permission.response !== 1) return { cancelled: true };
    }
    const shutdown = await engine.stop();
    stopped = true;
    if (shutdown.forced) throw new Error(t('DSH could not shut down cleanly. Try again shortly.'));
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
  updateWindow = new BrowserWindow({ title: t('BotOrgHQ Updates and Data'), width: 680, height: 720, parent: window,
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
  handle('state', () => ({
    ...updater.state,
    message: t(updater.state.message, updater.state.messageValues),
    locale: language,
    messages: language === 'zh' ? desktopMessages : {},
    keepRunning, osNotifications, transferring
  }));
  handle('transfer', (operation, passphrase) => {
    if (!['export', 'import'].includes(operation)) throw new Error('Unknown transfer operation.');
    return transfer(operation, passphrase);
  });
  handle('preferences', async values => {
    if (transferring || installing) throw new Error(t('Desktop is busy.'));
    keepRunning = values?.keepRunning === true;
    osNotifications = values?.osNotifications === true;
    savePreferences();
    await setTray();
  });
  handle('check', () => updater.check());
  handle('download', () => updater.downloadUpdate());
  handle('backups', () => shell.openPath(join(app.getPath('userData'), 'backups')));
  handle('token', token => {
    if (typeof token !== 'string' || token.length > 500) throw new Error(t('Invalid GitHub token.'));
    const file = join(app.getPath('userData'), 'github-update-token.bin');
    if (!token.trim()) { rmSync(file, { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error(t('Secure storage is unavailable. The token could not be saved.'));
    writeFileSync(file, safeStorage.encryptString(token.trim()), { mode: 0o600 });
  });
  handle('install', async () => {
    if (installing || transferring || updater.state.phase !== 'ready') return;
    installing = true;
    let stopped = false;
    try {
      const answer = await dialog.showMessageBox(updateWindow, { type: 'question', buttons: [t('Cancel'), t('Back up and install')], defaultId: 0, cancelId: 0,
        message: t('Install the update now?'), detail: t('Running tasks will stop. BotOrgHQ backs up all DSH data before installing and quitting.') });
      if (answer.response !== 1) return;
      const installation = await updater.prepareInstall(resolve(dirname(process.execPath), '..', '..'));
      updater.set({ phase: 'installing', message: 'Stopping tasks and backing up data…' });
      const shutdown = await engine.stop();
      stopped = true;
      if (shutdown.forced) throw new Error(t('DSH did not shut down in time. Review running tasks before trying the update again.'));
      const backup = await backupData(app.getPath('userData'), app.getVersion(), 'before-in-app-install');
      updater.set({ message: 'Data backed up to {path}. Starting the installer…', messageValues: { path: backup } });
      await updater.launchInstall(installation);
      app.quit();
    } catch (error) {
      updater.set({ phase: 'error', message: error.message });
      if (stopped) {
        await startWorkspace(fail);
      }
    } finally { installing = false; }
  });
}

function localizeMenu() {
  const role = (id, label) => ({ role: id, label: t(label) });
  const checkUpdates = { label: t('Check for updates…'), click: () => showUpdates() };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'BotOrgHQ', submenu: [
      role('about', 'About BotOrgHQ'), checkUpdates, { type: 'separator' }, role('quit', 'Quit')
    ] }] : []),
    { label: t('Edit'), submenu: [
      role('undo', 'Undo'), role('redo', 'Redo'), { type: 'separator' },
      role('cut', 'Cut'), role('copy', 'Copy'), role('paste', 'Paste'), role('selectAll', 'Select all')
    ] },
    { label: t('View'), submenu: [
      role('reload', 'Reload'), role('toggleDevTools', 'Toggle developer tools'), role('resetZoom', 'Actual size'),
      role('zoomIn', 'Zoom in'), role('zoomOut', 'Zoom out'), role('togglefullscreen', 'Toggle full screen')
    ] },
    { label: t('Help'), submenu: [checkUpdates, { label: t('Export or import data…'), click: () => showUpdates(true) },
      { label: t('Open data folder'), click: () => shell.openPath(app.getPath('userData')) }] }
  ]));
}

function registerWorkspaceLocale() {
  ipcMain.handle('workbench:set-locale', (event, locale) => {
    if (event.sender !== window?.webContents || !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== runtimeOrigin) {
      throw new Error('Invalid workbench window.');
    }
    if (locale !== 'en' && locale !== 'zh') throw new Error('Unsupported workbench language.');
    if (locale === language) return;
    language = locale;
    localizeMenu();
    localizeTray();
    if (updateWindow && !updateWindow.isDestroyed()) updateWindow.setTitle(t('BotOrgHQ Updates and Data'));
  });
}

function openExternal(address) {
  const url = new URL(address);
  if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href).catch(() => {});
}

function fail(error) {
  if (quitting) return;
  dialog.showErrorBox(t('BotOrgHQ could not start'), t(error.message));
  app.quit();
}

async function open() {
  language = desktopLocale(app.getPreferredSystemLanguages()[0]);
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
    webPreferences: { preload: join(desktop, 'workspace-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
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
  registerUpdates();
  registerWorkspaceLocale();
  localizeMenu();
  await window.loadURL(url.href);
  if (!window.isDestroyed() && !quitting) window.show();
  await recordVersion(app.getPath('userData'), app.getVersion());
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

