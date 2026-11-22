const element = id => document.getElementById(id);
let busy = false;

async function action(operation) {
  if (busy) return;
  busy = true;
  try { await operation(); }
  catch (error) { element('message').textContent = error.message; }
  finally { busy = false; }
}

element('check').onclick = () => action(() => window.updates.check());
element('download').onclick = () => action(() => window.updates.download());
element('install').onclick = () => action(() => window.updates.install());
element('backups').onclick = () => action(() => window.updates.showBackups());
element('save-token').onclick = () => action(async () => {
  await window.updates.saveToken(element('token').value);
  element('token').value = '';
  element('token-state').textContent = '已保存，可以重新检查更新。';
});

for (const operation of ['export', 'import']) {
  element(operation).onclick = () => action(async () => {
    const status = element('transfer-state');
    const field = element('transfer-password');
    try {
      status.textContent = '处理中。请保持应用打开。';
      const result = await window.updates.transfer(operation, field.value);
      status.textContent = result.cancelled ? '已取消。' : operation === 'export' ? '已导出 ' + result.path : '已导入。原用户数据目录保留在 ' + result.previous;
    } catch (error) { status.textContent = error.message; }
    finally { field.value = ''; }
  });
}
window.updates.onShowTransfer(() => { element('transfer').open = true; });
let loadedPreferences = false;
element('save-preferences').onclick = () => action(async () => {
  try {
    await window.updates.preferences({ keepRunning: element('background').checked, osNotifications: element('os-notifications').checked });
    element('preferences-state').textContent = '已保存。';
  } catch (error) { element('preferences-state').textContent = error.message; }
});

async function refresh() {
  try {
    const state = await window.updates.state();
    element('version').textContent = `当前版本 ${state.currentVersion}${state.version ? ` · 可更新到 ${state.version}` : ''}`;
    element('message').textContent = state.message;
    element('progress').hidden = state.phase !== 'downloading';
    element('progress').value = state.progress ?? 0;
    element('download').hidden = state.phase !== 'available';
    element('install').hidden = state.phase !== 'ready';
    if (!loadedPreferences) {
      element('background').checked = state.keepRunning;
      element('os-notifications').checked = state.osNotifications;
      loadedPreferences = true;
    }
    element('check').disabled = state.transferring || ['checking', 'downloading', 'installing'].includes(state.phase);
    element('save-token').disabled = element('check').disabled;
  } catch (error) { element('message').textContent = error.message; }
  setTimeout(refresh, 500);
}
void refresh();
