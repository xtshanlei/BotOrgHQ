import React, { useState } from 'react';
import { useTranslation } from './use-locale.jsx';

const columns = [['todo', 'To-do'], ['in_progress', 'In progress'], ['waiting', 'Waiting'], ['finished', 'Finished'], ['aborted', 'Aborted']];

export function TaskBoard({ company, disabled, mutate, openSession }) {
  const { t, status, date } = useTranslation();
  const [draft, setDraft] = useState(null);
  const employees = company.departments.flatMap(department => department.employees.map(employee => ({ ...employee, departmentName: department.name })));
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const tasks = company.tasks ?? [];
  const edit = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const create = () => setDraft({ title: '', ownerId: '', description: '', expectedResult: '', acceptanceCriteria: '', status: 'todo', result: '', evidence: '', reason: '', requestId: crypto.randomUUID() });
  const fields = [
    ['description', "Work description", 8000], ['expectedResult', "Expected outcome", 4000], ['acceptanceCriteria', "Acceptance criteria", 4000],
    ['result', "Result", 12000], ['evidence', "Evidence and context (links, paths, conversations, or verification records)", 12000], ['reason', "Reason for waiting or aborting", 4000]
  ];
  return <section className="bohq-panel" aria-label={t('Company task board')}>
    <header className="bohq-panel-head"><div><h2>{t('Company task board')}</h2><p>{t('Owners, expected outcomes, acceptance criteria, and evidence are shared within the company.')}</p></div>
      <button disabled={disabled} onClick={create}>{t('＋ New task')}</button></header>
    {draft && <form className="bohq-form bohq-task-form" onSubmit={async event => {
      event.preventDefault();
      const saved = await mutate(draft.id ? 'update-task' : 'create-task', { ...draft, taskId: draft.id, companyId: company.id, ownerId: draft.ownerId || null });
      if (saved) setDraft(null);
    }}>
      <label>{t('Task title')}<input required maxLength={160} value={draft.title} onChange={event => edit('title', event.target.value)} /></label>
      <label>{t('Owner')}<select value={draft.ownerId ?? ''} onChange={event => edit('ownerId', event.target.value)}><option value="">{t('Unassigned')}</option>
        {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}
        {draft.ownerId && !byId.has(draft.ownerId) && <option value={draft.ownerId}>{t('Removed employee')}</option>}
      </select></label>
      {draft.id && <label>{t('Status')}<select value={draft.status} onChange={event => edit('status', event.target.value)}>
        {columns.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
      </select></label>}
      {fields.filter(([key]) => draft.id || !['result', 'evidence', 'reason'].includes(key)).map(([key, label, limit]) =>
        <label className="bohq-full" key={key}>{t(label)}<textarea maxLength={limit} rows={key === 'description' ? 3 : 2} value={draft[key]}
          required={['expectedResult', 'acceptanceCriteria'].includes(key) || (draft.status === 'finished' && ['result', 'evidence'].includes(key)) || (['waiting', 'aborted'].includes(draft.status) && key === 'reason')}
          onChange={event => edit(key, event.target.value)} /></label>)}
      <div className="bohq-actions bohq-full"><button type="button" disabled={disabled} onClick={() => setDraft(null)}>{t('Cancel')}</button>
        <button className="bohq-primary" disabled={disabled}>{t('Save task')}</button></div>
    </form>}
    <div className="bohq-board">{columns.map(([id, label]) => {
      const entries = tasks.filter(task => task.status === id);
      return <section className="bohq-column" key={id} aria-label={t(label)}><h3>{t(label)}<span>{entries.length}</span></h3>
        {!entries.length && <p className="bohq-muted">{t('No tasks')}</p>}
        {entries.map(task => {
          const owner = byId.get(task.ownerId);
          return <article className="bohq-task" key={task.id}>
            <h4>{task.title}</h4>{task.source === 'proactive' && <p className="bohq-muted">{t('Proactive task · {workflow} · {verification}', { workflow: status(task.workflowStatus), verification: status(task.verificationStatus) })}</p>}<p className="bohq-muted">{owner ? `${owner.name} · ${owner.departmentName}` : task.ownerId ? t('Removed employee') : t('Unassigned')}</p>
            <dl><dt>{t('Expected outcome')}</dt><dd>{task.expectedResult}</dd><dt>{t('Acceptance criteria')}</dt><dd>{task.acceptanceCriteria}</dd>
              {task.reason && <><dt>{t('Reason for waiting or aborting')}</dt><dd>{task.reason}</dd></>}
              {task.result && <><dt>{t('Result')}</dt><dd>{task.result}</dd></>}
              {task.evidence && <><dt>{t('Evidence')}</dt><dd>{task.evidence}</dd></>}
            </dl>
            <div className="bohq-actions">{task.source !== 'proactive' && <button disabled={disabled} onClick={() => setDraft({ ...task })}>{t('View / edit')}</button>}
              {owner?.sessionId && <button onClick={() => openSession(owner.sessionId)}>{t('Employee conversation ↗')}</button>}</div>
            <details><summary>{t('Description and change history')}</summary><p>{task.description}</p>
              <ol>{task.history.map((entry, index) => <li key={index}>{date(entry.at)} · {entry.actorId === 'human' ? t('Human') : byId.get(entry.actorId)?.name ?? entry.actorId}
                {Object.entries(entry.changes).map(([key, value]) => <p key={key}>{key} · {String(value.before ?? '—')} → {String(value.after ?? '—')}</p>)}
              </li>)}</ol></details>
          </article>;
        })}</section>;
    })}</div>
  </section>;
}

export function ReportingForm({ company, disabled, mutate, cancel }) {
  const { t } = useTranslation();
  const employees = company.departments.flatMap(department => department.employees.map(employee => ({ ...employee, departmentName: department.name })));
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const member = employees.find(employee => employee.id === employeeId);
  return <form className="bohq-form" onSubmit={async event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await mutate('change-reporting', { companyId: company.id, employeeId, departmentId: fields.get('departmentId'), managerId: fields.get('managerId') || null })) cancel();
  }}>
    <label>{t('Employee')}<select value={employeeId} onChange={event => setEmployeeId(event.target.value)}>{employees.map(employee =>
      <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}</select></label>
    {member && <React.Fragment key={employeeId}>
      <label>{t('Department assignment')}<select name="departmentId" defaultValue={member.departmentId}>{company.departments.map(department =>
        <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label>{t('Direct manager (may be in another department)')}<select name="managerId" defaultValue={member.managerId ?? ''}><option value="">{t('Group Chief')}</option>{employees.filter(employee => employee.id !== employeeId).map(employee =>
        <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}</select></label>
    </React.Fragment>}
    <div className="bohq-actions"><button type="button" onClick={cancel} disabled={disabled}>{t('Cancel')}</button><button className="bohq-primary" disabled={disabled || !member}>{t('Save reporting line')}</button></div>
  </form>;
}
