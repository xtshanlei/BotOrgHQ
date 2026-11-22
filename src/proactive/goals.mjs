import { randomUUID } from 'node:crypto';
import { OrgError, text } from '../org-store.mjs';
import { date } from './triggers.mjs';

export const GOAL_STATES = ['proposed', 'active', 'paused', 'achieved', 'abandoned', 'blocked'];

export function checkDag(nodes, dependencies = node => node.dependencies ?? [], identity = node => node.id) {
  const graph = new Map(nodes.map(node => [identity(node), node]));
  if (graph.size !== nodes.length) throw new OrgError('Duplicate dependency node.');
  const visited = new Set();
  const visiting = new Set();
  function walk(id) {
    if (!graph.has(id)) throw new OrgError('Dependency is outside this graph.');
    if (visiting.has(id)) throw new OrgError('Dependency cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of dependencies(graph.get(id))) walk(next);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) walk(id);
}

function list(value, label, max = 12) {
  if (!Array.isArray(value) || value.length > max) throw new OrgError('Invalid ' + label + '.');
  return [...new Set(value.map(item => text(item, label, 300)))];
}

export function updateGoal(db, company, input, actor, now, validateOwner) {
  const id = input.id || randomUUID();
  const current = db.get('goal', company, id);
  if (input.id && (!current || input.revision !== current.version)) throw new OrgError('Goal was changed. Reload before saving.');
  if (actor !== 'owner' && current && (current.status !== 'proposed' || current.createdBy !== actor)) throw new OrgError('Bots may edit only their own unapproved proposals.');
  const value = { ownerId: null, departmentId: null, parentId: null, dependencies: [], policyScope: 'company', priority: 50,
    reviewMinutes: 30, createdBy: actor, createdAt: now, approvedBy: null, businessValue: '', constraints: '',
    measurableIndicators: [], sourceEvidence: [], nextAction: '', ...current, id };
  for (const [field, min, max] of [['priority', 0, 100], ['reviewMinutes', 5, 10080]]) {
    if (input[field] === undefined) continue;
    if (!Number.isInteger(input[field]) || input[field] < min || input[field] > max) throw new OrgError('Invalid goal ' + field + '.');
    value[field] = input[field];
  }
  for (const [field, length] of [['title', 160], ['intent', 5000], ['successCriteria', 4000], ['businessValue', 2000], ['constraints', 2000], ['nextAction', 1000]]) {
    if (input[field] !== undefined) value[field] = text(input[field], field, length, !['title', 'intent', 'successCriteria'].includes(field));
  }
  if (!value.title || !value.intent || !value.successCriteria) throw new OrgError('Goal requires title, intent and success criteria.');
  for (const field of ['ownerId', 'departmentId', 'parentId']) {
    if (input[field] !== undefined) value[field] = input[field] === null || input[field] === '' ? null : text(input[field], field, 100);
  }
  for (const field of ['dependencies', 'measurableIndicators', 'sourceEvidence']) {
    if (input[field] !== undefined) value[field] = list(input[field], field);
  }
  if (input.deadline !== undefined) value.deadline = input.deadline ? date(input.deadline, 'Goal deadline') : null;
  if (input.policyScope !== undefined) {
    value.policyScope = text(input.policyScope, 'Policy scope', 150);
    if (value.policyScope !== 'company' && !/^github:[\w.-]+\/[\w.-]+$/.test(value.policyScope)) throw new OrgError('Invalid goal resource scope.');
  }
  validateOwner(value);
  value.status = actor === 'owner' ? input.status ?? current?.status ?? 'proposed' : 'proposed';
  if (!GOAL_STATES.includes(value.status)) throw new OrgError('Invalid goal status.');
  value.version = (current?.version ?? 0) + 1;
  value.authorizedVersion = value.status === 'active' ? value.version : null;
  value.approvedBy = value.status === 'active' ? 'owner' : value.approvedBy;
  value.nextReviewAt = value.status === 'active' ? now : null;
  value.changedBy = actor;
  value.progress = current?.progress ?? { completed: 0, verified: 0 };
  const all = db.all('goal', company).filter(goal => goal.id !== id);
  checkDag([...all, value], node => [...node.dependencies, ...(node.parentId ? [node.parentId] : [])]);
  const goal = db.put('goal', company, id, value);
  db.put('goalVersion', company, id + ':' + goal.version, { goalId: id, revision: goal.version, value: goal });
  return goal;
}

export function goalReady(db, goal, now) {
  if (!goal || goal.status !== 'active' || goal.authorizedVersion !== goal.version || (goal.deadline && goal.deadline <= now)) return false;
  const dependenciesDone = goal.dependencies.every(id => db.get('goal', goal.companyId, id)?.status === 'achieved');
  const parentValid = !goal.parentId || goalReady(db, db.get('goal', goal.companyId, goal.parentId), now);
  return dependenciesDone && parentValid;
}
