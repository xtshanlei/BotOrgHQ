import React, { useState } from 'react';

const columns = [['todo', 'To-do'], ['in_progress', 'In progress'], ['waiting', 'Waiting'], ['finished', 'Finished'], ['aborted', 'Aborted']];

export function TaskBoard({ company, disabled, mutate, openSession }) {
  const [draft, setDraft] = useState(null);
  const employees = company.departments.flatMap(department => department.employees.map(employee => ({ ...employee, departmentName: department.name })));
  const byId = new Map(employees.map(employee => [employee.id, employee]));
  const tasks = company.tasks ?? [];
  const edit = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
  const create = () => setDraft({ title: '', ownerId: '', description: '', expectedResult: '', acceptanceCriteria: '', status: 'todo', result: '', evidence: '', reason: '', requestId: crypto.randomUUID() });
  const fields = [
    ['description', '工作说明', 8000], ['expectedResult', '预期结果', 4000], ['acceptanceCriteria', '验收标准', 4000],
    ['result', '实际结果', 12000], ['evidence', '证据及其说明（链接、文件路径、对话或验证记录）', 12000], ['reason', '等待或终止原因', 4000]
  ];
  return <section className="bohq-panel" aria-label="公司任务看板">
    <header className="bohq-panel-head"><div><h2>公司任务看板</h2><p>负责人、预期结果、验收标准和证据在公司内共享。</p></div>
      <button disabled={disabled} onClick={create}>＋ 新建任务</button></header>
    {draft && <form className="bohq-form bohq-task-form" onSubmit={async event => {
      event.preventDefault();
      const saved = await mutate(draft.id ? 'update-task' : 'create-task', { ...draft, taskId: draft.id, companyId: company.id, ownerId: draft.ownerId || null });
      if (saved) setDraft(null);
    }}>
      <label>任务名称<input required maxLength={160} value={draft.title} onChange={event => edit('title', event.target.value)} /></label>
      <label>负责人<select value={draft.ownerId ?? ''} onChange={event => edit('ownerId', event.target.value)}><option value="">待分配</option>
        {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}
        {draft.ownerId && !byId.has(draft.ownerId) && <option value={draft.ownerId}>已移除的员工</option>}
      </select></label>
      {draft.id && <label>状态<select value={draft.status} onChange={event => edit('status', event.target.value)}>
        {columns.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select></label>}
      {fields.filter(([key]) => draft.id || !['result', 'evidence', 'reason'].includes(key)).map(([key, label, limit]) =>
        <label className="bohq-full" key={key}>{label}<textarea maxLength={limit} rows={key === 'description' ? 3 : 2} value={draft[key]}
          required={['expectedResult', 'acceptanceCriteria'].includes(key) || (draft.status === 'finished' && ['result', 'evidence'].includes(key)) || (['waiting', 'aborted'].includes(draft.status) && key === 'reason')}
          onChange={event => edit(key, event.target.value)} /></label>)}
      <div className="bohq-actions bohq-full"><button type="button" disabled={disabled} onClick={() => setDraft(null)}>取消</button>
        <button className="bohq-primary" disabled={disabled}>保存任务</button></div>
    </form>}
    <div className="bohq-board">{columns.map(([status, label]) => {
      const entries = tasks.filter(task => task.status === status);
      return <section className="bohq-column" key={status} aria-label={label}><h3>{label}<span>{entries.length}</span></h3>
        {!entries.length && <p className="bohq-muted">暂无任务</p>}
        {entries.map(task => {
          const owner = byId.get(task.ownerId);
          return <article className="bohq-task" key={task.id}>
            <h4>{task.title}</h4><p className="bohq-muted">{owner ? `${owner.name} · ${owner.departmentName}` : task.ownerId ? '已移除的员工' : '待分配'}</p>
            <dl><dt>预期结果</dt><dd>{task.expectedResult}</dd><dt>验收标准</dt><dd>{task.acceptanceCriteria}</dd>
              {task.reason && <><dt>等待或终止原因</dt><dd>{task.reason}</dd></>}
              {task.result && <><dt>实际结果</dt><dd>{task.result}</dd></>}
              {task.evidence && <><dt>证据</dt><dd>{task.evidence}</dd></>}
            </dl>
            <div className="bohq-actions"><button disabled={disabled} onClick={() => setDraft({ ...task })}>查看 / 编辑</button>
              {owner?.sessionId && <button onClick={() => openSession(owner.sessionId)}>员工对话 ↗</button>}</div>
            <details><summary>说明与变更记录</summary><p>{task.description}</p>
              <ol>{task.history.map((entry, index) => <li key={index}>{new Date(entry.at).toLocaleString()} · {entry.actorId === 'human' ? '人工' : byId.get(entry.actorId)?.name ?? entry.actorId}
                {Object.entries(entry.changes).map(([key, value]) => <p key={key}>{key} · {String(value.before ?? '—')} → {String(value.after ?? '—')}</p>)}
              </li>)}</ol></details>
          </article>;
        })}</section>;
    })}</div>
  </section>;
}

export function ReportingForm({ company, disabled, mutate, cancel }) {
  const employees = company.departments.flatMap(department => department.employees.map(employee => ({ ...employee, departmentName: department.name })));
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const member = employees.find(employee => employee.id === employeeId);
  return <form className="bohq-form" onSubmit={async event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await mutate('change-reporting', { companyId: company.id, employeeId, departmentId: fields.get('departmentId'), managerId: fields.get('managerId') || null })) cancel();
  }}>
    <label>员工<select value={employeeId} onChange={event => setEmployeeId(event.target.value)}>{employees.map(employee =>
      <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}</select></label>
    {member && <React.Fragment key={employeeId}>
      <label>所属部门<select name="departmentId" defaultValue={member.departmentId}>{company.departments.map(department =>
        <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
      <label>直属上级（可跨部门）<select name="managerId" defaultValue={member.managerId ?? ''}><option value="">集团 Chief</option>{employees.filter(employee => employee.id !== employeeId).map(employee =>
        <option key={employee.id} value={employee.id}>{employee.name} · {employee.departmentName}</option>)}</select></label>
    </React.Fragment>}
    <div className="bohq-actions"><button type="button" onClick={cancel} disabled={disabled}>取消</button><button className="bohq-primary" disabled={disabled || !member}>保存汇报关系</button></div>
  </form>;
}
