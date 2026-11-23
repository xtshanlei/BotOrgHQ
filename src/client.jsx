import React, { useEffect, useRef, useState } from 'react';
import styles from './client.css';
import { workbenchLocale } from './messages.mjs';
import { ProactivePanel, proactiveTabs } from './proactive-panel.jsx';
import { ReportingForm, TaskBoard } from './task-board.jsx';
import { WorkbenchLocale, useTranslation } from './use-locale.jsx';

export const inject = ['slots', 'uiWorkspace', 'locale'];
const panelId = 'bot-org-hq';
const statusNames = { idle: 'Idle', working: 'Working', approval: 'Awaiting approval', waiting: 'Awaiting delivery', blocked: 'Needs attention' };
let selection = { companyId: null, departmentId: null };

async function call(action, fields = {}, signal) {
  const response = await fetch('api/bot-org-hq', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...fields })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not connect to BotOrgHQ.');
  return result.value;
}

function Icon({ size = 18 }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M12 8v4m-7 4v-4h14v4" />
    <rect x="9" y="3" width="6" height="5" rx="1" />
    <rect x="2" y="16" width="6" height="5" rx="1" />
    <rect x="16" y="16" width="6" height="5" rx="1" />
  </svg>;
}

export function Launcher({ wide, onOpen }) {
  return <button type="button" className="bohq-launcher" aria-label="BotOrgHQ" title="BotOrgHQ" onClick={onOpen}>
    <Icon size={16} />{wide && <span>BotOrgHQ</span>}
  </button>;
}

function Status({ status }) {
  const { t } = useTranslation();
  return <span className="bohq-status" data-status={status}><i aria-hidden="true" />{t(statusNames[status] ?? 'Idle')}</span>;
}

function DepartmentChart({ company, openDepartment }) {
  const { t } = useTranslation();
  if (!company.departments.length) return <p className="bohq-empty">{t('Add the first department here or ask the Chief to create one.')}</p>;
  return <div className="bohq-canvas" tabIndex="0" aria-label={t('Department organisation chart')}>
    <ul className="bohq-tree">
      <li>
        <div className="bohq-root"><Icon /><strong>{company.name}</strong></div>
        <ul>{company.departments.map(department => {
          const active = department.employees.filter(employee => employee.status === 'working').length;
          return <li key={department.id} data-active={active > 0}>
            <button className="bohq-node" data-status={active ? 'working' : undefined} onClick={() => openDepartment(department.id)}>
              <strong>{department.name}</strong>
              <span>{t('Employees: {count} · Working: {active}', { count: department.employees.length, active })}</span>
              <span className="bohq-node-action">{t('View department →')}</span>
            </button>
          </li>;
        })}</ul>
      </li>
    </ul>
  </div>;
}

function EmployeeBranch({ employee, childrenByManager, activePath, openSession }) {
  const { t, status } = useTranslation();
  const reports = childrenByManager.get(employee.id) ?? [];
  return <li data-active={activePath.has(employee.id)}>
    <button className="bohq-node" data-status={employee.status} onClick={() => openSession(employee.sessionId)}>
      <strong>{employee.name}</strong>
      <span>{employee.role}</span>
      <Status status={employee.status} />
      {employee.proactive && <span title={[employee.proactive.task, employee.proactive.goalId].filter(Boolean).join(' · ')}>{t('Proactive · {status}', { status: status(employee.proactive.status) })}</span>}
      {employee.tool && <span className="bohq-tool">{employee.tool}</span>}
    </button>
    {reports.length > 0 && <ul>{reports.map(report =>
      <EmployeeBranch key={report.id} employee={report} childrenByManager={childrenByManager} activePath={activePath} openSession={openSession} />
    )}</ul>}
  </li>;
}

function EmployeeChart({ company, department, openSession }) {
  const { t } = useTranslation();
  if (!department.employees.length) return <p className="bohq-empty">{t('Ask the Chief to add a department lead and assign employees to them.')}</p>;
  const byId = new Map(department.employees.map(employee => [employee.id, employee]));
  const childrenByManager = new Map();
  const activePath = new Set();
  for (const employee of department.employees) {
    const children = childrenByManager.get(employee.managerId) ?? [];
    children.push(employee);
    childrenByManager.set(employee.managerId, children);
    if (employee.status !== 'working') continue;
    for (let current = employee; current && !activePath.has(current.id); current = byId.get(current.managerId)) {
      activePath.add(current.id);
    }
  }
  return <div className="bohq-canvas" tabIndex="0" aria-label={t('Employee reporting lines')}>
    <ul className="bohq-tree">
      {department.employees.filter(employee => !byId.has(employee.managerId)).map(employee => {
        const managerDepartment = company.departments.find(item => item.employees.some(manager => manager.id === employee.managerId));
        const manager = managerDepartment?.employees.find(item => item.id === employee.managerId);
        return <li key={employee.id}>{manager && <div className="bohq-root"><button onClick={() => openSession(manager.sessionId)}>{t('Direct manager · {name} · {department} ↗', { name: manager.name, department: managerDepartment.name })}</button></div>}
          <ul><EmployeeBranch employee={employee} childrenByManager={childrenByManager} activePath={activePath} openSession={openSession} /></ul></li>;
      })}
    </ul>
  </div>;
}

function CreateForm({ kind, submit, cancel, saving }) {
  const { t } = useTranslation();
  const company = kind === 'company';
  return <form className="bohq-form" onSubmit={event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void submit({ name: fields.get('name'), mission: fields.get('mission') });
  }}>
    <label>{t(company ? 'Company name' : 'Department name')}<input name="name" required maxLength={48} /></label>
    <label>{t(company ? 'Company mission' : 'Department mission')}<input name="mission" maxLength={500} /></label>
    <div className="bohq-actions">
      <button type="button" onClick={cancel} disabled={saving}>{t('Cancel')}</button>
      <button className="bohq-primary" disabled={saving}>{saving ? t('Saving…') : t(company ? 'Create company' : 'Create department')}</button>
    </div>
  </form>;
}

function OrganisationPanel({ openSession }) {
  const { t, locale } = useTranslation();
  const [view, setView] = useState(null);
  const [current, setCurrent] = useState(selection);
  const [create, setCreate] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [tab, setTab] = useState('organisation');
  const refreshId = useRef(0);

  async function refresh(signal) {
    const id = ++refreshId.current;
    try {
      const result = await call('state', {}, signal);
      if (id === refreshId.current) {
        setView(result);
        setConnectionError('');
      }
    } catch (error) {
      if (id === refreshId.current && !signal?.aborted) setConnectionError(error.message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  function select(companyId, departmentId = null) {
    selection = { companyId, departmentId };
    setCurrent(selection);
    setCreate(null);
    setError('');
  }

  const company = view?.companies.find(item => item.id === current.companyId) ?? view?.companies[0];
  const department = company?.departments.find(item => item.id === current.departmentId);
  const chief = view?.chief;
  const disabled = !view || !!view.readOnly || saving;

  async function mutate(action, fields) {
    setError('');
    setSaving(true);
    try {
      await call(action, fields);
      await refresh();
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submit(fields) {
    setError('');
    setSaving(true);
    try {
      const item = await call('create-' + create, { ...fields, ...(create === 'department' ? { companyId: company.id } : {}) });
      await refresh();
      if (create === 'company') select(item.id);
      else select(company.id, item.id);
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }

  return <main className="bohq" lang={locale}>
    <div className="bohq-content">
      <header className="bohq-header">
        <div><p className="bohq-kicker"><Icon /> BotOrgHQ</p><h1>{department?.name ?? company?.name ?? t('Company workbench')}</h1>
          <p className="bohq-muted">{department?.mission || company?.mission || t('Manage companies, departments, and Bots in DeepSeek Harness.')}</p>
        </div>
        <button className="bohq-primary" disabled={!chief?.sessionId} onClick={() => openSession(chief.sessionId)}>{t('Open Group Chief ↗')}</button>
      </header>
      {connectionError && <p className="bohq-error" role="alert">{t(connectionError)}</p>}
      {view?.readOnly && <p className="bohq-error" role="status">{view.readOnly}</p>}
      <div className="bohq-bar">
        <LanguagePicker />
        <label>{t('Current company')}
          <select value={company?.id ?? ''} disabled={!company || saving} onChange={event => select(event.target.value)}>
            {!company && <option value="">{t('Select a company')}</option>}
            {view?.companies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="bohq-actions">
          <button disabled={!view || !!view.readOnly || saving} onClick={() => { setError(''); setCreate('company'); }}>{t('＋ New company')}</button>
          {company && <button disabled={!!view.readOnly || saving} onClick={() => { setError(''); setCreate('department'); }}>{t('＋ New department')}</button>}
          {company && <button disabled={disabled} onClick={() => { setError(''); setCreate('reporting'); }}>{t('Edit department / reporting line')}</button>}
        </div>
      </div>
      {create === 'reporting' && <ReportingForm key={company.id} company={company} disabled={disabled} mutate={mutate} cancel={() => setCreate(null)} />}
      {create && create !== 'reporting' && <CreateForm key={create} kind={create} submit={submit} cancel={() => { setCreate(null); setError(''); }} saving={saving} />}
      {error && <p className="bohq-error" role="alert">{t(error)}</p>}
      {!view && !connectionError && <p role="status">{t('Loading organisation…')}</p>}
      {view && !company && <p className="bohq-empty">{t('Create a company here or ask the Chief to set one up with its departments.')}</p>}
      {company && <nav className="bohq-tabs" aria-label={t('Company views')}><button aria-pressed={tab === 'organisation'} onClick={() => setTab('organisation')}>{t('Organisation')}</button><button aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>{t('Task board')}</button>{proactiveTabs.map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{t(label)}</button>)}</nav>}
      {company && proactiveTabs.some(([id]) => id === tab) && <ProactivePanel key={company.id + ':' + tab} kind={tab} company={company} call={call} disabled={disabled} />}
      {company && tab === 'tasks' && <TaskBoard key={company.id} company={company} disabled={disabled} mutate={mutate} openSession={openSession} />}
      {company && tab === 'organisation' && <section className="bohq-panel" aria-label={department ? t('Department employees') : t('Department structure')}>
        <header className="bohq-panel-head">
          <div>
            {department && <button className="bohq-back" onClick={() => select(company.id)}>{t('← Back to departments')}</button>}
            <h2>{department ? t('Employee reporting lines') : t('Department structure')}</h2>
            <p>{department ? t('Select an employee to open their DSH conversation.') : t('Select a department to see its employees and reporting lines.')}</p>
          </div>
          <span className="bohq-chip">{department ? t('Employees · {count}', { count: department.employees.length })
            : t('Departments · {count}', { count: company.departments.length })}</span>
        </header>
        {department
          ? <EmployeeChart company={company} department={department} openSession={openSession} />
          : <DepartmentChart company={company} openDepartment={id => select(company.id, id)} />}
      </section>}
      <p className="bohq-note">{t('Tell the Chief the company, department, role, and manager when asking it to add an employee and assign work.')}</p>
    </div>
  </main>;
}

function LanguagePicker() {
  const { active, t, setLocale } = useTranslation();
  const [error, setError] = useState(false);
  return <div>
    <label>{t('Language')}<select value={active} onChange={event => {
      try { setLocale(event.target.value); setError(false); }
      catch { setError(true); }
    }}>
      {active !== 'en' && active !== 'zh' && <option value={active} disabled>{t('DSH language')}</option>}
      <option value="en">English</option><option value="zh">简体中文</option>
    </select></label>
    {error && <p role="alert" className="bohq-error">{t('Could not change language. Please try again.')}</p>}
  </div>;
}

function LocalisedPanel({ service, openSession }) {
  return <WorkbenchLocale service={service}><OrganisationPanel openSession={openSession} /></WorkbenchLocale>;
}

export function apply(ctx) {
  const locale = ctx.get('locale');
  ctx.effect(() => {
    const desktop = window.botorghqDesktop;
    if (!desktop) return;
    const sync = () => void desktop.setLocale(workbenchLocale(locale.getLocale().active)).catch(() => {});
    sync();
    return locale.subscribe(sync);
  }, 'BotOrgHQ desktop language');
  ctx.effect(() => {
    const sheet = document.createElement('style');
    sheet.textContent = styles;
    document.head.append(sheet);
    return () => sheet.remove();
  }, 'BotOrgHQ styles');
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, inject: () => ({ service: locale, openSession: id => ctx.uiWorkspace.openSession(id) })
  }, LocalisedPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 15, label: 'BotOrgHQ'
  }, Icon));
}

