import React, { useEffect, useRef, useState } from 'react';
import styles from './client.css';
import { ProactivePanel, proactiveTabs } from './proactive-panel.jsx';
import { ReportingForm, TaskBoard } from './task-board.jsx';

export const inject = ['slots', 'uiWorkspace'];
const panelId = 'bot-org-hq';
const statusNames = { idle: '空闲', working: '工作中', approval: '待审批', waiting: '等待交付', blocked: '需处理' };
let selection = { companyId: null, departmentId: null };

async function call(action, fields = {}, signal) {
  const response = await fetch('api/bot-org-hq', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...fields })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '无法连接 BotOrgHQ。');
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
  return <span className="bohq-status" data-status={status}><i aria-hidden="true" />{statusNames[status]}</span>;
}

function DepartmentChart({ company, openDepartment }) {
  if (!company.departments.length) return <p className="bohq-empty">这家公司还没有部门。可以在这里添加，或请 Chief 创建。</p>;
  return <div className="bohq-canvas" tabIndex="0" aria-label="部门组织图">
    <ul className="bohq-tree">
      <li>
        <div className="bohq-root"><Icon /><strong>{company.name}</strong></div>
        <ul>{company.departments.map(department => {
          const active = department.employees.filter(employee => employee.status === 'working').length;
          return <li key={department.id} data-active={active > 0}>
            <button className="bohq-node" data-status={active ? 'working' : undefined} onClick={() => openDepartment(department.id)}>
              <strong>{department.name}</strong>
              <span>{department.employees.length} 名员工 · {active} 工作中</span>
              <span className="bohq-node-action">查看部门 →</span>
            </button>
          </li>;
        })}</ul>
      </li>
    </ul>
  </div>;
}

function EmployeeBranch({ employee, childrenByManager, activePath, openSession }) {
  const reports = childrenByManager.get(employee.id) ?? [];
  return <li data-active={activePath.has(employee.id)}>
    <button className="bohq-node" data-status={employee.status} onClick={() => openSession(employee.sessionId)}>
      <strong>{employee.name}</strong>
      <span>{employee.role}</span>
      <Status status={employee.status} />
      {employee.proactive && <span title={[employee.proactive.task, employee.proactive.goalId].filter(Boolean).join(' · ')}>主动 · {employee.proactive.status}</span>}
      {employee.tool && <span className="bohq-tool">{employee.tool}</span>}
    </button>
    {reports.length > 0 && <ul>{reports.map(report =>
      <EmployeeBranch key={report.id} employee={report} childrenByManager={childrenByManager} activePath={activePath} openSession={openSession} />
    )}</ul>}
  </li>;
}

function EmployeeChart({ company, department, openSession }) {
  if (!department.employees.length) return <p className="bohq-empty">这个部门还没有员工。请 Chief 先聘用部门负责人，再为负责人安排直属下属。</p>;
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
  return <div className="bohq-canvas" tabIndex="0" aria-label="员工汇报层级">
    <ul className="bohq-tree">
      {department.employees.filter(employee => !byId.has(employee.managerId)).map(employee => {
        const managerDepartment = company.departments.find(item => item.employees.some(manager => manager.id === employee.managerId));
        const manager = managerDepartment?.employees.find(item => item.id === employee.managerId);
        return <li key={employee.id}>{manager && <div className="bohq-root"><button onClick={() => openSession(manager.sessionId)}>直属上级 · {manager.name} · {managerDepartment.name} ↗</button></div>}
          <ul><EmployeeBranch employee={employee} childrenByManager={childrenByManager} activePath={activePath} openSession={openSession} /></ul></li>;
      })}
    </ul>
  </div>;
}

function CreateForm({ kind, submit, cancel, saving }) {
  const label = kind === 'company' ? '公司' : '部门';
  return <form className="bohq-form" onSubmit={event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void submit({ name: fields.get('name'), mission: fields.get('mission') });
  }}>
    <label>{label}名称<input name="name" required maxLength={48} /></label>
    <label>{label}职责<input name="mission" maxLength={500} /></label>
    <div className="bohq-actions">
      <button type="button" onClick={cancel} disabled={saving}>取消</button>
      <button className="bohq-primary" disabled={saving}>{saving ? '保存中…' : '创建' + label}</button>
    </div>
  </form>;
}

function OrganisationPanel({ openSession }) {
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

  return <main className="bohq">
    <div className="bohq-content">
      <header className="bohq-header">
        <div><p className="bohq-kicker"><Icon /> BotOrgHQ</p><h1>{department?.name ?? company?.name ?? '公司工作台'}</h1>
          <p className="bohq-muted">{department?.mission || company?.mission || '在 DeepSeek Harness 内管理公司、部门和 Bot 员工。'}</p>
        </div>
        <button className="bohq-primary" disabled={!chief?.sessionId} onClick={() => openSession(chief.sessionId)}>打开集团 Chief ↗</button>
      </header>
      {connectionError && <p className="bohq-error" role="alert">{connectionError}</p>}
      {view?.readOnly && <p className="bohq-error" role="status">{view.readOnly}</p>}
      <div className="bohq-bar">
        <label>当前公司
          <select value={company?.id ?? ''} disabled={!company || saving} onChange={event => select(event.target.value)}>
            {!company && <option value="">选择公司</option>}
            {view?.companies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="bohq-actions">
          <button disabled={!view || !!view.readOnly || saving} onClick={() => { setError(''); setCreate('company'); }}>＋ 新建公司</button>
          {company && <button disabled={!!view.readOnly || saving} onClick={() => { setError(''); setCreate('department'); }}>＋ 新建部门</button>}
          {company && <button disabled={disabled} onClick={() => { setError(''); setCreate('reporting'); }}>修改部门 / 直属关系</button>}
        </div>
      </div>
      {create === 'reporting' && <ReportingForm key={company.id} company={company} disabled={disabled} mutate={mutate} cancel={() => setCreate(null)} />}
      {create && create !== 'reporting' && <CreateForm key={create} kind={create} submit={submit} cancel={() => { setCreate(null); setError(''); }} saving={saving} />}
      {error && <p className="bohq-error" role="alert">{error}</p>}
      {!view && !connectionError && <p role="status">正在加载组织架构…</p>}
      {view && !company && <p className="bohq-empty">新建公司，或在 Chief 对话里让它创建公司和部门。</p>}
      {company && <nav className="bohq-tabs" aria-label="公司视图"><button aria-pressed={tab === 'organisation'} onClick={() => setTab('organisation')}>组织架构</button><button aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>任务看板</button>{proactiveTabs.map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>}
      {company && proactiveTabs.some(([id]) => id === tab) && <ProactivePanel key={company.id + ':' + tab} kind={tab} company={company} call={call} disabled={disabled} />}
      {company && tab === 'tasks' && <TaskBoard key={company.id} company={company} disabled={disabled} mutate={mutate} openSession={openSession} />}
      {company && tab === 'organisation' && <section className="bohq-panel" aria-label={department ? '部门员工' : '部门架构'}>
        <header className="bohq-panel-head">
          <div>
            {department && <button className="bohq-back" onClick={() => select(company.id)}>← 返回部门架构</button>}
            <h2>{department ? '员工汇报层级' : '部门架构'}</h2>
            <p>{department ? '点击员工打开 DSH 对话。' : '点击一个部门，查看里面的员工和汇报关系。'}</p>
          </div>
          <span className="bohq-chip">{department ? department.employees.length + ' 名员工' : company.departments.length + ' 个部门'}</span>
        </header>
        {department
          ? <EmployeeChart company={company} department={department} openSession={openSession} />
          : <DepartmentChart company={company} openDepartment={id => select(company.id, id)} />}
      </section>}
      <p className="bohq-note">在 Chief 对话中说明公司、部门、岗位和汇报对象，即可由 Chief 创建员工并安排工作。</p>
    </div>
  </main>;
}

export function apply(ctx) {
  ctx.effect(() => {
    const sheet = document.createElement('style');
    sheet.textContent = styles;
    document.head.append(sheet);
    return () => sheet.remove();
  }, 'BotOrgHQ styles');
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, inject: () => ({ openSession: id => ctx.uiWorkspace.openSession(id) })
  }, OrganisationPanel));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: panelId, order: 15, label: 'BotOrgHQ'
  }, Icon));
}

