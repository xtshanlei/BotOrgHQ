import React, { useEffect, useState } from 'react';

export const proactiveTabs = [
  ['goal', '长期目标'], ['opportunity', '主动活动'], ['trigger', '触发器'], ['approval', '人工审批'],
  ['policy', '自治设置'], ['metrics', '指标']
];

const modes = ['OFF', 'SUGGEST', 'SUPERVISED', 'BOUNDED_AUTO'];
const states = ['proposed', 'active', 'paused', 'achieved', 'abandoned', 'blocked'];
const triggers = ['heartbeat', 'interval', 'once', 'cron', 'github', 'webhook', 'internal'];
const flags = ['maxConcurrentTasks', 'maxRunsPerHour', 'maxRunsPerDay', 'maxToolCallsPerRun', 'maxTokensPerDay', 'maxWallClockPerRun'];
const showTime = value => value ? new Date(value).toLocaleString() : '—';
const comma = value => String(value ?? '').split(',').map(part => part.trim()).filter(Boolean);
const textField = (name, label, value, options = {}) =>
  <label key={name}>{label}<input name={name} defaultValue={value ?? ''} {...options} /></label>;
const selectField = (name, label, values, value) => <label key={name}>{label}
  <select name={name} defaultValue={value}>{values.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select>
</label>;

function download(name, value, type) {
  const href = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function PolicyForm({ company, data, perform, disabled }) {
  const [scope, setScope] = useState('company');
  const record = data.records.find(policy => policy.id === scope);
  const current = record ?? data.records.find(policy => policy.id === 'company') ?? data.defaults;
  const tools = Object.entries(data.capabilities);
  const available = [['company', '全公司'], ...company.departments.flatMap(dep => [
    ['department:' + dep.id, dep.name], ...dep.employees.map(employee => ['employee:' + employee.id, dep.name + ' / ' + employee.name])
  ])];
  return <>
    <div className="bohq-pro-toolbar">
      <label>策略对象<select value={scope} onChange={event => setScope(event.target.value)}>
        {available.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      <button disabled={disabled} onClick={() => perform('policy', { scope, revision: record?.revision ?? 0,
        stopped: !current.stopped })}>{current.stopped ? '恢复自治授权' : '紧急暂停此范围'}</button>
    </div>
    <form key={scope + ':' + (record?.revision ?? 0)} className="bohq-form bohq-pro-form" onSubmit={async event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      await perform('policy', { scope, revision: record?.revision ?? 0, mode: fields.get('mode'),
        allowedTools: fields.getAll('allowedTools'), deniedTools: fields.getAll('deniedTools'), approvalRules: fields.getAll('approvalRules'),
        dataScopes: comma(fields.get('dataScopes')), timezone: fields.get('timezone'), shadow: fields.has('shadow'),
        quietHours: fields.get('quietStart') && fields.get('quietEnd') ? { start: fields.get('quietStart'), end: fields.get('quietEnd') } : null,
        notificationPolicy: fields.get('notificationPolicy'),
        maxCostPerDay: fields.get('maxCostPerDay') === '' ? null : Number(fields.get('maxCostPerDay')),
        ...Object.fromEntries(flags.map(key => [key, Number(fields.get(key))])) });
    }}>
      {selectField('mode', '模式', modes.map(mode => [mode, mode]), current.mode)}
      <label className="bohq-checkbox"><input name="shadow" type="checkbox" defaultChecked={current.shadow} /> 影子模式</label>
      {textField('dataScopes', '数据范围（逗号分隔）', current.dataScopes.join(', '), { required: true })}
      {textField('timezone', 'IANA 时区', current.timezone, { required: true })}
      {textField('quietStart', '免打扰开始', current.quietHours?.start, { type: 'time' })}
      {textField('quietEnd', '免打扰结束', current.quietHours?.end, { type: 'time' })}
      {selectField('notificationPolicy', '通知', [['important', '仅重要'], ['all', '所有'], ['none', '仅应用内'], ['daily', '每日摘要'], ['weekly', '每周摘要']], current.notificationPolicy)}
      {textField('maxCostPerDay', '每日货币上限（未提供定价时暂停模型）', current.maxCostPerDay, { type: 'number', min: 0, step: '0.01' })}
      {flags.map((key, index) => textField(key, ['域内并发', '每小时运行', '每天运行', '每运行工具调用', '每天 token', '每运行毫秒'][index], current[key], { type: 'number', min: 1, required: true }))}
      <fieldset className="bohq-full"><legend>工具授权</legend>
        <div className="bohq-pro-tools"><span>能力</span><span>允许</span><span>拒绝</span><span>审批</span>
          {tools.map(([tool, capability]) => <React.Fragment key={tool}><code>{tool} · {capability.risk}</code>
            {['allowedTools', 'deniedTools', 'approvalRules'].map((key, index) => <input key={key} type="checkbox" name={key}
              aria-label={['允许 ', '拒绝 ', '审批 '][index] + tool} value={tool} defaultChecked={current[key].includes(tool)} />)}
          </React.Fragment>)}
        </div>
      </fieldset>
      <button disabled={disabled} className="bohq-primary">保存策略</button>
    </form>
  </>;
}

function Goals({ company, data, versions, perform, disabled }) {
  const [edit, setEdit] = useState(null);
  const goal = edit || {};
  const choices = data.records.map(row => [row.id, row.title]);
  return <>
    <div className="bohq-pro-toolbar"><button disabled={disabled} onClick={() => setEdit({})}>＋ 新建目标</button></div>
    {edit && <form key={goal.id ?? 'new'} className="bohq-form bohq-pro-form" onSubmit={async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (await perform('goal', { ...values, id: goal.id, revision: goal.version,
        dependencies: comma(values.dependencies), measurableIndicators: comma(values.measurableIndicators),
        sourceEvidence: comma(values.sourceEvidence), priority: Number(values.priority), reviewMinutes: Number(values.reviewMinutes) })) setEdit(null);
    }}>
      {textField('title', '目标名称', goal.title, { required: true, maxLength: 160 })}
      {selectField('status', '目标状态', states.map(value => [value, value]), goal.status || 'proposed')}
      {selectField('ownerId', '负责人', [['', '集团 Chief'], ...company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, employee.name]))], goal.ownerId ?? '')}
      {selectField('departmentId', '部门', [['', '公司目标'], ...company.departments.map(dep => [dep.id, dep.name])], goal.departmentId ?? '')}
      {selectField('parentId', '父目标', [['', '无'], ...choices.filter(([id]) => id !== goal.id)], goal.parentId ?? '')}
      {textField('dependencies', '依赖目标 ID（逗号分隔）', goal.dependencies?.join(', '))}
      {textField('priority', '优先级', goal.priority ?? 50, { type: 'number', min: 0, max: 100 })}
      {textField('reviewMinutes', '复查间隔（分钟）', goal.reviewMinutes ?? 30, { type: 'number', min: 5, max: 10080 })}
      {textField('deadline', '截止时间（ISO，含时区）', goal.deadline ? new Date(goal.deadline).toISOString() : '')}
      {textField('policyScope', '数据授权范围', goal.policyScope ?? 'company', { required: true })}
      {selectField('verificationRule', '证据校验', [['owner_review', '人工复核'], ['source_quotes', '核对逐字来源引文']], goal.verificationRule ?? 'owner_review')}
      {textField('measurableIndicators', '可衡量指标（逗号分隔）', goal.measurableIndicators?.join(', '))}
      {textField('sourceEvidence', '来源证据（逗号分隔）', goal.sourceEvidence?.join(', '))}
      {['intent', 'successCriteria', 'businessValue', 'constraints', 'nextAction'].map((key, index) =>
        <label key={key} className="bohq-full">{['目标意图', '成功标准', '业务价值', '限制', '下一步'][index]}
          <textarea name={key} rows={2} defaultValue={goal[key] ?? ''} required={index < 2} />
        </label>)}
      <button type="button" onClick={() => setEdit(null)}>取消</button><button disabled={disabled} className="bohq-primary">保存目标</button>
    </form>}
    {data.records.map(item => <article key={item.id} className="bohq-pro-card">
      <strong>{item.title}</strong><p>{item.intent}</p>
      <p>v{item.version} · {item.status} · 完成 {item.progress.completed} · 已验证 {item.progress.verified}</p>
      <p className="bohq-muted">下次复查 {showTime(item.nextReviewAt)} · {item.id}</p>
      {item.parentId && <p>父目标 {choices.find(([id]) => id === item.parentId)?.[1] ?? item.parentId}</p>}
      {item.dependencies?.length > 0 && <p>依赖 {item.dependencies.map(id => choices.find(([candidate]) => candidate === id)?.[1] ?? id).join('、')}</p>}
      <p>成功标准 · {item.successCriteria}</p>
      <details><summary>最近的版本</summary>{versions.filter(version => version.goalId === item.id).map(version =>
        <p key={version.id}>v{version.revision} · {version.value.status} · {version.value.successCriteria}</p>)}</details>
      <div className="bohq-actions">
        <button disabled={disabled} onClick={() => setEdit(item)}>编辑</button>
        {['active', 'paused', 'proposed', 'blocked'].includes(item.status) && <button disabled={disabled}
          onClick={() => perform('goal', { id: item.id, revision: item.version, status: item.status === 'active' ? 'paused' : 'active' })}>
          {item.status === 'active' ? '暂停' : '授权并启用'}
        </button>}
      </div>
    </article>)}
  </>;
}

function Triggers({ data, goals, company, perform, disabled }) {
  const [type, setType] = useState('heartbeat');
  return <>
    <form className="bohq-form bohq-pro-form" onSubmit={async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (await perform('trigger', { ...values, type, events: comma(values.events), intervalMinutes: Number(values.intervalMinutes) })) event.target.reset();
    }}>
      {textField('name', '触发器名称', '', { required: true })}
      <label>类型<select value={type} onChange={event => setType(event.target.value)}>
        {triggers.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
      {selectField('goalId', '触发目标', goals.map(goal => [goal.id, goal.title]))}
      {selectField('actorId', '目标负责人（可选）', [['', '集团 Chief'], ...company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, employee.name]))])}
      {textField('timezone', 'IANA 时区', 'UTC')}
      {selectField('catchUp', '停机补偿', [['skip', '跳过过时执行'], ['latest', '合并补偿最近一次']])}
      {['heartbeat', 'interval'].includes(type) && textField('intervalMinutes', '间隔（分钟）', 30, { type: 'number', min: 5, required: true })}
      {type === 'once' && textField('at', '执行时间（ISO，含时区）', '', { required: true })}
      {type === 'cron' && textField('cron', 'Cron（分 时 日 月 周）', '0 9 * * 1-5', { required: true })}
      {type === 'github' && textField('repository', 'GitHub 仓库 owner/name', '', { required: true })}
      {type === 'github' && textField('pollTokenEnv', '补偿拉取凭据变量（可选）', '')}
      {['github', 'webhook'].includes(type) && textField('secretEnv', '密钥环境变量名', 'BOTORGHQ_WEBHOOK_RESEARCH', { required: true })}
      {['github', 'internal'].includes(type) && textField('events', '订阅事件（逗号分隔）', type === 'github' ? 'workflow_run' : 'task.finished', { required: true })}
      <button disabled={disabled || !goals.length} className="bohq-primary">添加触发器</button>
    </form>
    {data.records.map(row => <article className="bohq-pro-card" key={row.id}>
      <strong>{row.name}</strong><p>{row.type} · {row.enabled ? '启用' : '停用'} · {row.sourceState}</p>
      <p>上次 {showTime(row.lastAt)} · 下次 {showTime(row.nextAt)} · {row.timezone}</p>
      {row.webhookPath && <code>{row.webhookPath}</code>}
      {row.pollingState && <p>补偿拉取 · {row.pollingState}</p>}
      <div className="bohq-actions">
        <button disabled={disabled} onClick={() => perform('trigger', { id: row.id, revision: row.revision, enabled: !row.enabled })}>{row.enabled ? '停用' : '启用'}</button>
        <button disabled={disabled || !row.enabled} onClick={() => perform('trigger-now', { id: row.id })}>测试触发</button>
      </div>
    </article>)}
  </>;
}

function Approvals({ data, perform, disabled }) {
  return data.records.map(row => <article className="bohq-pro-card" key={row.id}>
    <strong>{row.summary ?? row.tool}</strong>
    <p>{row.status} · {row.risk} · {row.tool} · {row.scope}</p>
    <p>目标 {row.goalId} v{row.goalVersion} · 过期 {showTime(row.expiresAt)}</p>
    {row.snoozedUntil && <p>延后至 {showTime(row.snoozedUntil)}</p>}
    <p className="bohq-muted">参数摘要 {row.argsHash}</p>
    {row.reason && <p>{row.reason}</p>}
    {['pending', 'approved'].includes(row.status) && <form className="bohq-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void perform('approval', { id: row.id, decision: event.nativeEvent.submitter.value, feedback: data.get('feedback') });
    }}>
      {textField('feedback', '修改意见或审批备注', '', { maxLength: 1000 })}
      {([['approve', '仅批准一次'], ['reject', '拒绝'], ['changes', '要求修改'], ['snooze', '延后一小时'], ['mute', '静音类似通知'], ['revoke', '撤销']])
        .filter(([value]) => row.status === 'approved' ? value === 'revoke' : value !== 'revoke')
        .map(([value, label]) => <button key={value} value={value} disabled={disabled}>{label}</button>)}
    </form>}
  </article>);
}

function Activities({ company, opportunities, runs, activity, notifications, memory, events, goals, perform, send, disabled }) {
  return <>
    <div className="bohq-pro-toolbar">
      {['jsonl', 'csv'].map(format => <button key={format} onClick={async () => {
        const result = await send('proactive:export-traces', { format });
        download('botorg-activity.' + format, result, 'text/plain');
      }}>导出 {format.toUpperCase()}</button>)}
    </div>
    <details><summary>公司确认的背景记录</summary>
      <form className="bohq-form bohq-pro-form" onSubmit={async event => {
        event.preventDefault();
        const form = event.currentTarget;
        if (await perform('memory', Object.fromEntries(new FormData(form)))) form.reset();
      }}>
        {textField('title', '标题', '', { required: true })}
        {textField('provenance', '来源', '', { required: true })}
        {textField('expiresAt', '失效时间（ISO，可选）', '')}
        <label className="bohq-full">已确认内容<textarea name="content" rows={2} required maxLength={3000} /></label>
        <button disabled={disabled}>添加</button>
        <button type="button" onClick={async () => download('botorg-company-memory.json', await send('proactive:export-memory'), 'application/json')}>导出</button>
      </form>
      {memory.map(item => <article className="bohq-pro-card" key={item.id}>
        <strong>{item.title}</strong><p>{item.content}</p><p className="bohq-muted">{item.provenance} · {showTime(item.expiresAt)}</p>
        <button disabled={disabled} onClick={() => perform('memory', { operation: 'remove', id: item.id })}>清除记录</button>
      </article>)}
    </details>
    <details><summary>事件与回放</summary>
      <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform('replay', { eventId: data.get('eventId'), goalId: data.get('goalId') });
      }}>
        {selectField('eventId', '事件', events.filter(item => item.trustLevel !== 'replay').map(item => [item.id, item.type + ' · ' + showTime(item.timestamp)]))}
        {selectField('goalId', '授权目标', goals.filter(item => item.status === 'active').map(item => [item.id, item.title]))}
        <button disabled={disabled || !events.length || !goals.some(item => item.status === 'active')}>回放为影子评估</button>
      </form>
    </details>
    <h3>通知</h3>
    {notifications.map(row => <p className="bohq-pro-line" key={row.id}>{row.title} · {showTime(row.updatedAt)}</p>)}
    <h3>机会</h3>
    {opportunities.map(row => <article key={row.id} className="bohq-pro-card">
      <strong>{row.decision} {row.shadow && '· 影子模式'}</strong><p>{row.rationale}</p>
      <p>{row.suppression} · {showTime(row.updatedAt)} · {goals.find(goal => goal.id === row.goalId)?.title ?? row.goalId}</p>
      {row.nodes?.length > 0 && <details><summary>计划与评分</summary><ul>{row.nodes.map(node => <li key={node.key}>{node.title} · {node.expectedResult}</li>)}</ul>
        <p>{Object.entries(row.scores ?? {}).map(([key, value]) => key + ' ' + value).join(' · ')}</p></details>}
    </article>)}
    <h3>工作流</h3>
    {runs.map(run => <article className="bohq-pro-card" key={run.id}>
      <strong>{run.task?.title ?? 'Chief 规划'}</strong><p>{run.status} · 尝试 {run.attempt} · {run.reason}</p>
      {run.result && <><p>{run.result}</p><p>{run.verificationStatus} · {run.limitations}</p></>}
      {run.kind === 'work' && run.status === 'succeeded' && <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform('verify', { id: run.id, verdict: data.get('verdict'), reason: data.get('reason') });
      }}>
        {selectField('verdict', '证据复核', [['passed', '通过'], ['failed', '未通过'], ['inconclusive', '证据不足']])}
        {textField('reason', '理由或复核证据', '', { required: true, maxLength: 2200 })}
        <button disabled={disabled}>保存复核</button>
      </form>}
      {run.kind === 'work' && run.attempt === 0 && ['queued', 'waiting_dependency', 'paused'].includes(run.status) && <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        void perform('workflow', { id: run.id, operation: 'reassign', employeeId: new FormData(event.currentTarget).get('employeeId') });
      }}>
        {selectField('employeeId', '调整负责人', company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, dep.name + ' / ' + employee.name])), run.actorId)}
        <button disabled={disabled}>保存负责人</button>
      </form>}
      {!['succeeded', 'cancelled', 'failed', 'timed_out'].includes(run.status) && <div className="bohq-actions">
        {(run.status === 'paused' ? [['resume', '恢复'], ['cancel', '取消']] : [['pause', '暂停'], ['cancel', '取消']])
          .map(([operation, label]) => <button key={operation} disabled={disabled} onClick={() => perform('workflow', { id: run.id, operation })}>{label}</button>)}
      </div>}
    </article>)}
    <h3>审计</h3>
    <ol>{activity.map(row => <li key={row.seq}>{showTime(row.at)} · {row.type} · {row.tool ?? row.reason ?? row.status ?? row.decision ?? ''}</li>)}</ol>
  </>;
}

export function ProactivePanel({ kind, company, call, disabled }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const send = (action, value = {}, signal) => call(action, { companyId: company.id, ...value }, signal);
  const list = (view, signal) => send('proactive:list', { kind: view }, signal);
  async function load(signal) {
    const views = kind === 'opportunity' ? ['opportunity', 'runs', 'activity', 'notification', 'goal', 'memory', 'event'] : kind === 'trigger' ? ['trigger', 'goal'] : kind === 'goal' ? ['goal', 'goalVersion'] : [kind];
    const entries = await Promise.all(views.map(view => list(view, signal)));
    if (!signal?.aborted) setData(Object.fromEntries(views.map((view, index) => [view, entries[index]])));
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => load(controller.signal).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [company.id, kind]);
  async function perform(action, value) {
    setBusy(true);
    setError('');
    try {
      await send('proactive:' + action, { value });
      await load();
      return true;
    } catch (error) { setError(error.message); return false; }
    finally { setBusy(false); }
  }
  const off = disabled || busy;
  const actual = data?.[kind];
  return <section className="bohq-panel">
    <header className="bohq-panel-head"><h2>{proactiveTabs.find(([id]) => id === kind)?.[1]}</h2></header>
    <div className="bohq-pro-content">
      {error && <p className="bohq-error" role="alert">{error}</p>}
      {!actual && !error && <p>正在加载…</p>}
      {actual && kind === 'goal' && <Goals company={company} data={actual} versions={data.goalVersion.records} perform={perform} disabled={off} />}
      {actual && kind === 'trigger' && <Triggers company={company} data={actual} goals={data.goal.records} perform={perform} disabled={off} />}
      {actual && kind === 'policy' && <PolicyForm company={company} data={actual} perform={perform} disabled={off} />}
      {actual && kind === 'approval' && (actual.records.length ? <Approvals data={actual} perform={perform} disabled={off} /> : <p>没有审批记录。</p>)}
      {actual && kind === 'opportunity' && <Activities company={company} opportunities={actual.records} runs={data.runs.records} activity={data.activity.records}
        notifications={data.notification.records} memory={data.memory.records} events={data.event.records} goals={data.goal.records} perform={perform} send={send} disabled={off} />}
      {actual && kind === 'metrics' && <dl className="bohq-metrics">
        <dt>引擎</dt><dd>{actual.engine} · 本机运行，随宿主退出或休眠而停止调度</dd>
        <dt>有效目标</dt><dd>{actual.activeGoals}</dd><dt>已达成</dt><dd>{actual.achievedGoals}</dd>
        <dt>机会</dt><dd>{actual.opportunityCount}</dd><dt>去重</dt><dd>{actual.duplicatesSuppressed}</dd>
        <dt>待审批</dt><dd>{actual.approvalsPending}</dd><dt>过期审批</dt><dd>{actual.approvalsExpired}</dd>
        <dt>24 小时预留 token</dt><dd>{actual.usage24h.tokens}</dd>
        {actual.jobs.map(row => <React.Fragment key={row.status}><dt>{row.status}</dt><dd>{row.count}</dd></React.Fragment>)}
      </dl>}
    </div>
  </section>;
}
