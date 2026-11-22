import { createHash } from 'node:crypto';
import { OrgError } from '../org-store.mjs';

export const MODES = ['OFF', 'SUGGEST', 'SUPERVISED', 'BOUNDED_AUTO'];
export const CAPABILITIES = Object.freeze({
  'model.plan': { risk: 'R0' },
  'org_delegate': { risk: 'R1' },
  'company.evidence.read': { risk: 'R0' },
  'model.work': { risk: 'R0' },
  'task.result.submit': { risk: 'R1' }
});
export const limits = {
  maxConcurrentTasks: [1, 8, 2], maxRunsPerHour: [1, 100, 12], maxRunsPerDay: [1, 500, 48],
  maxToolCallsPerRun: [1, 20, 4], maxTokensPerDay: [1, 2_000_000, 50_000], maxWallClockPerRun: [1_000, 180_000, 60_000]
};
export const DEFAULT_POLICY = {
  mode: 'OFF', allowedTools: [], deniedTools: [], dataScopes: ['company'], maxCostPerDay: null,
  quietHours: null, timezone: 'UTC', approvalRules: [], notificationPolicy: 'important',
  stopped: false, shadow: false, revision: 0, ...Object.fromEntries(Object.entries(limits).map(([key, [, , value]]) => [key, value]))
};

export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

export function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
  catch { throw new OrgError('Invalid IANA timezone.'); }
  return zone;
}

function choices(value, possible, label) {
  if (!Array.isArray(value) || value.length > 100 || !value.every(item => typeof item === 'string' && possible(item))) throw new OrgError('Invalid ' + label + '.');
  return [...new Set(value)].sort();
}

export function validatePolicy(input, current, actorId) {
  const value = { ...current };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new OrgError('Invalid ' + key + '.');
    value[key] = input[key];
  }
  for (const key of ['stopped', 'shadow']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'boolean') throw new OrgError('Invalid ' + key + '.');
    value[key] = input[key];
  }
  for (const key of ['allowedTools', 'deniedTools', 'approvalRules']) {
    if (input[key] !== undefined) value[key] = choices(input[key], item => Object.hasOwn(CAPABILITIES, item), key);
  }
  if (input.dataScopes !== undefined) value.dataScopes = choices(input.dataScopes, item => item === 'company' || /^github:[\w.-]+\/[\w.-]+$/.test(item), 'data scopes');
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode)) throw new OrgError('Invalid autonomy mode.');
    value.mode = input.mode;
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || !input.timezone) throw new OrgError('Invalid timezone.');
    value.timezone = validZone(input.timezone);
  }
  if (input.quietHours !== undefined) {
    const q = input.quietHours;
    if (q !== null && (!q || ![q.start, q.end].every(time => typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || q.start === q.end)) {
      throw new OrgError('Quiet hours need distinct HH:MM start and end times.');
    }
    value.quietHours = q && { start: q.start, end: q.end };
  }
  if (input.maxCostPerDay !== undefined) {
    if (input.maxCostPerDay !== null && (!Number.isFinite(input.maxCostPerDay) || input.maxCostPerDay < 0)) throw new OrgError('Invalid daily monetary limit.');
    value.maxCostPerDay = input.maxCostPerDay;
  }
  if (input.notificationPolicy !== undefined) {
    if (!['none', 'important', 'all', 'daily', 'weekly'].includes(input.notificationPolicy)) throw new OrgError('Invalid notification policy.');
    value.notificationPolicy = input.notificationPolicy;
  }
  return { ...value, revision: current.revision + 1, updatedBy: actorId };
}

export function effectivePolicy(records) {
  const company = records[0] ?? DEFAULT_POLICY;
  const policies = [company, ...records.slice(1).filter(Boolean)];
  return {
    ...company,
    mode: MODES[Math.min(...policies.map(policy => MODES.indexOf(policy.mode)))],
    stopped: policies.some(policy => policy.stopped),
    shadow: policies.some(policy => policy.shadow),
    allowedTools: company.allowedTools.filter(tool => policies.every(policy => policy.allowedTools.includes(tool) && !policy.deniedTools.includes(tool))),
    dataScopes: company.dataScopes.filter(scope => policies.every(policy => policy.dataScopes.includes(scope))),
    approvalRules: [...new Set(policies.flatMap(policy => policy.approvalRules))],
    maxCostPerDay: policies.some(policy => policy.maxCostPerDay !== null) ? Math.min(...policies.map(policy => policy.maxCostPerDay ?? Infinity)) : null,
    versions: policies.map(policy => [policy.id ?? 'company', policy.revision]),
    limits: policies.map(policy => [policy.id ?? 'company', Object.fromEntries(Object.keys(limits).map(key => [key, policy[key]]))]),
    fingerprint: digest(policies.map(policy => [policy.id ?? 'company', policy.revision])),
    ...Object.fromEntries(Object.keys(limits).map(key => [key, Math.min(...policies.map(policy => policy[key]))]))
  };
}

export function quietAt(policy, now) {
  if (!policy.quietHours) return false;
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: policy.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const { start, end } = policy.quietHours;
  return start < end ? clock >= start && clock < end : clock >= start || clock < end;
}

export function admit(policy, tool, scope) {
  const capability = CAPABILITIES[tool];
  if (!capability) return 'unsupported_tool';
  if (policy.stopped || policy.mode === 'OFF') return 'autonomy_disabled';
  if (!policy.allowedTools.includes(tool) || !policy.dataScopes.includes(scope)) return 'scope_or_tool_denied';
  if ((policy.shadow || policy.mode === 'SUGGEST') && tool !== 'model.plan') return 'suggestion_only';
  if (tool.startsWith('model.') && policy.maxCostPerDay !== null) return 'provider_cost_cannot_be_bounded';
  if (capability.risk === 'R1' && policy.mode === 'SUPERVISED' && tool === 'org_delegate') return 'approval_required';
  if (capability.approval || policy.approvalRules.includes(tool)) return 'approval_required';
  return null;
}
