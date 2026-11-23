const element = id => document.getElementById(id);
let busy = false;
let language;
let messages = {};
const feedback = new Map();
const t = (key, values = {}) => (Object.hasOwn(messages, key) ? messages[key] : key)
  .replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);

function showFeedback(id, key, values) {
  feedback.set(id, { key, values });
  element(id).textContent = t(key, values);
}

function localize(state) {
  if (language === state.locale) return;
  ({ locale: language, messages } = state);
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const [id, { key, values }] of feedback) showFeedback(id, key, values);
}

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
  showFeedback('token-state', 'Saved. You can check for updates again.');
});

for (const operation of ['export', 'import']) {
  element(operation).onclick = () => action(async () => {
    const field = element('transfer-password');
    try {
      showFeedback('transfer-state', 'Working. Keep BotOrgHQ open.');
      const result = await window.updates.transfer(operation, field.value);
      const key = result.cancelled ? 'Cancelled.' : operation === 'export' ? 'Exported to {path}' : 'Imported. The previous profile is at {path}';
      showFeedback('transfer-state', key, { path: operation === 'export' ? result.path : result.previous });
    } catch (error) { showFeedback('transfer-state', error.message); }
    finally { field.value = ''; }
  });
}
window.updates.onShowTransfer(() => { element('transfer').open = true; });
let loadedPreferences = false;
element('save-preferences').onclick = () => action(async () => {
  try {
    await window.updates.preferences({ keepRunning: element('background').checked, osNotifications: element('os-notifications').checked });
    showFeedback('preferences-state', 'Saved.');
  } catch (error) { showFeedback('preferences-state', error.message); }
});

async function refresh() {
  try {
    const state = await window.updates.state();
    localize(state);
    element('version').textContent = t('Current version {version}', { version: state.currentVersion })
      + (state.version ? t(' · Update available to {version}', { version: state.version }) : '');
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
