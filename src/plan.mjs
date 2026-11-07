import { randomUUID } from 'node:crypto';
import { InputError } from './store.mjs';

const maxHires = 8;
const maxTasks = 8;
const maxBots = 60;
const maxDepth = 8;

function text(value, field, limit) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    throw new InputError(`Chief 返回的 ${field} 格式有误。`);
  }
  return value.trim();
}

export function validatePlan(plan, roster) {
  if (!Array.isArray(plan?.hires) || plan.hires.length > maxHires ||
      !Array.isArray(plan.tasks) || plan.tasks.length > maxTasks) {
    throw new InputError('Chief 的规划格式有误，或超过本轮 8 名员工／8 个任务的上限。');
  }
  if (roster.length + plan.hires.length > maxBots) {
    throw new InputError('该公司已达到当前版本的 60 名员工上限。');
  }

  const reply = text(plan.reply, 'reply', 2500);
  const bots = new Map(roster.map(bot => [bot.id, bot]));
  const pending = new Map();
  const names = new Set(roster.map(bot => bot.name.normalize('NFKC').toLowerCase()));
  for (const item of plan.hires) {
    const ref = item?.ref;
    if (typeof ref !== 'string' || !/^new:[a-z][a-z0-9-]{0,30}$/.test(ref) || pending.has(ref)) {
      throw new InputError('Chief 返回了无效或重复的新员工引用。');
    }
    const name = text(item.name, '员工姓名', 36);
    const key = name.normalize('NFKC').toLowerCase();
    if (names.has(key)) throw new InputError(`公司内已存在员工「${name}」。`);
    names.add(key);
    pending.set(ref, {
      id: randomUUID(), name, role: text(item.role, '员工职位', 40),
      mission: text(item.mission, '员工职责', 550), manager: text(item.manager, '直属上级', 72)
    });
  }

  const hires = [];
  while (pending.size) {
    let progress = false;
    for (const [ref, draft] of pending) {
      const manager = bots.get(draft.manager);
      if (!manager) continue;
      let depth = 1;
      for (let parent = manager; parent.managerId; parent = bots.get(parent.managerId)) {
        if (++depth >= maxDepth) throw new InputError('直属汇报层级超过当前版本的上限。');
      }
      const { id, name, role, mission } = draft;
      const bot = { id, managerId: manager.id, name, role, mission };
      bots.set(ref, bot);
      bots.set(id, bot);
      hires.push(bot);
      pending.delete(ref);
      progress = true;
    }
    if (!progress) throw new InputError('Chief 引用了不在本公司的上级，或创建了循环汇报关系。');
  }

  const tasks = plan.tasks.map(item => assignment(item, bots, 'Chief 把任务指派给了不在本公司的员工。'));
  return { reply, hires, tasks };
}

function assignment(item, bots, message) {
  const bot = bots.get(item?.bot);
  if (!bot) throw new InputError(message);
  return {
    botId: bot.id, name: bot.name, title: text(item.title, '任务标题', 70),
    brief: text(item.brief, '任务说明', 2400)
  };
}

export function validateWork(work, reports) {
  if (typeof work?.output !== 'string' || !work.output.trim()) {
    throw new InputError('员工没有返回文字结果。');
  }
  if (!Array.isArray(work.delegations) || work.delegations.length > 4) {
    throw new InputError('员工的委派格式有误，或超过 4 项的上限。');
  }
  const directReports = new Map(reports.map(bot => [bot.id, bot]));
  const delegations = work.delegations.map(item => assignment(item, directReports, '员工只能向自己的直属下属委派。'));
  return { output: work.output.trim().slice(0, 12_000), delegations };
}
