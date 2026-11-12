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

async function refresh() {
  try {
    const state = await window.updates.state();
    element('version').textContent = `当前版本 ${state.currentVersion}${state.version ? ` · 可更新到 ${state.version}` : ''}`;
    element('message').textContent = state.message;
    element('progress').hidden = state.phase !== 'downloading';
    element('progress').value = state.progress ?? 0;
    element('download').hidden = state.phase !== 'available';
    element('install').hidden = state.phase !== 'ready';
    element('check').disabled = ['checking', 'downloading', 'installing'].includes(state.phase);
    element('save-token').disabled = element('check').disabled;
  } catch (error) { element('message').textContent = error.message; }
  setTimeout(refresh, 500);
}
void refresh();
