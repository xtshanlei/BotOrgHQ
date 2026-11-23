import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopLocale, desktopMessages, translateDesktop } from '../desktop/messages.mjs';
import { translateNotification, translateWorkbench, workbenchLocale, workbenchMessages } from '../src/messages.mjs';

test('Workbench and desktop messages retain all substitution slots in Chinese', () => {
  const slots = value => (value.match(/\{\w+\}/g) ?? []).sort();
  for (const messages of [workbenchMessages, desktopMessages]) {
    for (const [english, chinese] of Object.entries(messages)) assert.deepEqual(slots(chinese), slots(english), english);
  }
  for (const resolve of [workbenchLocale, desktopLocale]) {
    assert.equal(resolve('zh-CN'), 'zh');
    assert.equal(resolve('en-GB'), 'en');
    assert.equal(resolve('ja'), 'en');
  }
  assert.equal(translateWorkbench('zh', 'Employees: {count} · Working: {active}', { count: 7, active: 2 }), '7 名员工 · 2 工作中');
  const path = '/profiles/{team}/restore';
  assert.equal(translateDesktop('zh', 'Exported to {path}', { path }), '已导出到 ' + path);
});

test('Existing notifications translate around their original approval summaries', () => {
  const title = '需要批准 · 检查审批记录 {project}';
  assert.equal(translateNotification('en', title), 'Approval required · 检查审批记录 {project}');
  assert.equal(translateNotification('zh', title), title);
  assert.equal(translateNotification('en', '任务来源引文校验通过'), 'Source quotations verified');
  assert.equal(translateNotification('en', 'Existing custom notice'), 'Existing custom notice');
});
