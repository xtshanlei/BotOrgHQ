import React, { useEffect, useState } from 'react';
import { useTranslation } from './use-locale.jsx';
import { translateNotification } from './messages.mjs';

export const proactiveTabs = [
  ['goal', "Long-term goals"], ['opportunity', "Proactive activity"], ['trigger', "Triggers"], ['approval', "Human approvals"],
  ['policy', "Autonomy settings"], ['metrics', "Metrics"]
];

const modes = ['OFF', 'SUGGEST', 'SUPERVISED', 'BOUNDED_AUTO'];
const states = ['proposed', 'active', 'paused', 'achieved', 'abandoned', 'blocked'];
const triggers = ['heartbeat', 'interval', 'once', 'cron', 'github', 'webhook', 'internal'];
const flags = ['maxConcurrentTasks', 'maxRunsPerHour', 'maxRunsPerDay', 'maxToolCallsPerRun', 'maxTokensPerDay', 'maxWallClockPerRun'];
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
  const { t, status } = useTranslation();
  const [scope, setScope] = useState('company');
  const record = data.records.find(policy => policy.id === scope);
  const current = record ?? data.records.find(policy => policy.id === 'company') ?? data.defaults;
  const tools = Object.entries(data.capabilities);
  const available = [['company', t('Entire company')], ...company.departments.flatMap(dep => [
    ['department:' + dep.id, dep.name], ...dep.employees.map(employee => ['employee:' + employee.id, dep.name + ' / ' + employee.name])
  ])];
  return <>
    <div className="bohq-pro-toolbar">
      <label>{t('Policy scope')}<select value={scope} onChange={event => setScope(event.target.value)}>
        {available.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
      </select></label>
      <button disabled={disabled} onClick={() => perform('policy', { scope, revision: record?.revision ?? 0,
        stopped: !current.stopped })}>{current.stopped ? t('Resume autonomous actions') : t('Emergency stop for this scope')}</button>
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
      {selectField('mode', t('Mode'), modes.map(mode => [mode, status(mode)]), current.mode)}
      <label className="bohq-checkbox"><input name="shadow" type="checkbox" defaultChecked={current.shadow} /> {t('Shadow mode')}</label>
      {textField('dataScopes', t('Data scopes (comma-separated)'), current.dataScopes.join(', '), { required: true })}
      {textField('timezone', t('IANA time zone'), current.timezone, { required: true })}
      {textField('quietStart', t('Quiet hours start'), current.quietHours?.start, { type: 'time' })}
      {textField('quietEnd', t('Quiet hours end'), current.quietHours?.end, { type: 'time' })}
      {selectField('notificationPolicy', t('Notifications'), [['important', t('Important only')], ['all', t('All')], ['none', t('In-app only')], ['daily', t('Daily digest')], ['weekly', t('Weekly digest')]], current.notificationPolicy)}
      {textField('maxCostPerDay', t('Daily spend limit (blocks calls when pricing is unavailable)'), current.maxCostPerDay, { type: 'number', min: 0, step: '0.01' })}
      {flags.map((key, index) => textField(key, [t('Concurrent tasks in this scope'), t('Runs per hour'), t('Runs per day'), t('Tool calls per run'), t('Tokens per day'), t('Time per run (milliseconds)')][index], current[key], { type: 'number', min: 1, required: true }))}
      <fieldset className="bohq-full"><legend>{t('Tool permissions')}</legend>
        <div className="bohq-pro-tools"><span>{t('Capability')}</span><span>{t('Allow')}</span><span>{t('Deny')}</span><span>{t('Approval')}</span>
          {tools.map(([tool, capability]) => <React.Fragment key={tool}><code>{tool} · {status(capability.risk)}</code>
            {['allowedTools', 'deniedTools', 'approvalRules'].map((key, index) => <input key={key} type="checkbox" name={key}
              aria-label={[t('Allow'), t('Deny'), t('Approval')][index] + ' ' + tool} value={tool} defaultChecked={current[key].includes(tool)} />)}
          </React.Fragment>)}
        </div>
      </fieldset>
      <button disabled={disabled} className="bohq-primary">{t('Save policy')}</button>
    </form>
  </>;
}

function Goals({ company, data, versions, perform, disabled }) {
  const { t, status, date, locale } = useTranslation();
  const [edit, setEdit] = useState(null);
  const goal = edit || {};
  const choices = data.records.map(row => [row.id, row.title]);
  return <>
    <div className="bohq-pro-toolbar"><button disabled={disabled} onClick={() => setEdit({})}>{t('＋ New goal')}</button></div>
    {edit && <form key={goal.id ?? 'new'} className="bohq-form bohq-pro-form" onSubmit={async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (await perform('goal', { ...values, id: goal.id, revision: goal.version,
        dependencies: comma(values.dependencies), measurableIndicators: comma(values.measurableIndicators),
        sourceEvidence: comma(values.sourceEvidence), priority: Number(values.priority), reviewMinutes: Number(values.reviewMinutes) })) setEdit(null);
    }}>
      {textField('title', t('Goal title'), goal.title, { required: true, maxLength: 160 })}
      {selectField('status', t('Goal status'), states.map(value => [value, status(value)]), goal.status || 'proposed')}
      {selectField('ownerId', t('Owner'), [['', t('Group Chief')], ...company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, employee.name]))], goal.ownerId ?? '')}
      {selectField('departmentId', t('Department'), [['', t('Company goal')], ...company.departments.map(dep => [dep.id, dep.name])], goal.departmentId ?? '')}
      {selectField('parentId', t('Parent goal'), [['', t('None')], ...choices.filter(([id]) => id !== goal.id)], goal.parentId ?? '')}
      {textField('dependencies', t('Dependency goal IDs (comma-separated)'), goal.dependencies?.join(', '))}
      {textField('priority', t('Priority'), goal.priority ?? 50, { type: 'number', min: 0, max: 100 })}
      {textField('reviewMinutes', t('Review interval (minutes)'), goal.reviewMinutes ?? 30, { type: 'number', min: 5, max: 10080 })}
      {textField('deadline', t('Deadline (ISO with time zone)'), goal.deadline ? new Date(goal.deadline).toISOString() : '')}
      {textField('policyScope', t('Authorised data scope'), goal.policyScope ?? 'company', { required: true })}
      {selectField('verificationRule', t('Verification rule'), [['owner_review', t('Owner review')], ['source_quotes', t('Verify verbatim source quotations')]], goal.verificationRule ?? 'owner_review')}
      {textField('measurableIndicators', t('Measurable indicators (comma-separated)'), goal.measurableIndicators?.join(', '))}
      {textField('sourceEvidence', t('Source evidence (comma-separated)'), goal.sourceEvidence?.join(', '))}
      {['intent', 'successCriteria', 'businessValue', 'constraints', 'nextAction'].map((key, index) =>
        <label key={key} className="bohq-full">{[t('Goal intent'), t('Success criteria'), t('Business value'), t('Constraints'), t('Next step')][index]}
          <textarea name={key} rows={2} defaultValue={goal[key] ?? ''} required={index < 2} />
        </label>)}
      <button type="button" onClick={() => setEdit(null)}>{t('Cancel')}</button><button disabled={disabled} className="bohq-primary">{t('Save goal')}</button>
    </form>}
    {data.records.map(item => <article key={item.id} className="bohq-pro-card">
      <strong>{item.title}</strong><p>{item.intent}</p>
      <p>{t('v{version} · {status} · Completed: {completed} · Verified: {verified}', {
        version: item.version, status: status(item.status), completed: item.progress.completed, verified: item.progress.verified
      })}</p>
      <p className="bohq-muted">{t('Next review {time} · {id}', { time: date(item.nextReviewAt), id: item.id })}</p>
      {item.parentId && <p>{t('Parent goal: {name}', { name: choices.find(([id]) => id === item.parentId)?.[1] ?? item.parentId })}</p>}
      {item.dependencies?.length > 0 && <p>{t('Dependencies: {names}', { names: new Intl.ListFormat(locale).format(item.dependencies.map(id => choices.find(([candidate]) => candidate === id)?.[1] ?? id)) })}</p>}
      <p>{t('Success criteria · {criteria}', { criteria: item.successCriteria })}</p>
      <details><summary>{t('Recent versions')}</summary>{versions.filter(version => version.goalId === item.id).map(version =>
        <p key={version.id}>v{version.revision} · {status(version.value.status)} · {version.value.successCriteria}</p>)}</details>
      <div className="bohq-actions">
        <button disabled={disabled} onClick={() => setEdit(item)}>{t('Edit')}</button>
        {['active', 'paused', 'proposed', 'blocked'].includes(item.status) && <button disabled={disabled}
          onClick={() => perform('goal', { id: item.id, revision: item.version, status: item.status === 'active' ? 'paused' : 'active' })}>
          {item.status === 'active' ? t('Pause') : t('Authorise and enable')}
        </button>}
      </div>
    </article>)}
  </>;
}

function Triggers({ data, goals, company, perform, disabled }) {
  const { t, status, date } = useTranslation();
  const [type, setType] = useState('heartbeat');
  return <>
    <form className="bohq-form bohq-pro-form" onSubmit={async event => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (await perform('trigger', { ...values, type, events: comma(values.events), intervalMinutes: Number(values.intervalMinutes) })) event.target.reset();
    }}>
      {textField('name', t('Trigger name'), '', { required: true })}
      <label>{t('Type')}<select value={type} onChange={event => setType(event.target.value)}>
        {triggers.map(value => <option key={value} value={value}>{status(value)}</option>)}
      </select></label>
      {selectField('goalId', t('Target goal'), goals.map(goal => [goal.id, goal.title]))}
      {selectField('actorId', t('Goal owner (optional)'), [['', t('Group Chief')], ...company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, employee.name]))])}
      {textField('timezone', t('IANA time zone'), 'UTC')}
      {selectField('catchUp', t('After downtime'), [['skip', t('Skip missed runs')], ['latest', t('Run only the most recent missed trigger')]])}
      {['heartbeat', 'interval'].includes(type) && textField('intervalMinutes', t('Interval (minutes)'), 30, { type: 'number', min: 5, required: true })}
      {type === 'once' && textField('at', t('Run at (ISO with time zone)'), '', { required: true })}
      {type === 'cron' && textField('cron', t('Cron (minute hour day month weekday)'), '0 9 * * 1-5', { required: true })}
      {type === 'github' && textField('repository', t('GitHub repository (owner/name)'), '', { required: true })}
      {type === 'github' && textField('pollTokenEnv', t('Catch-up polling token variable (optional)'), '')}
      {['github', 'webhook'].includes(type) && textField('secretEnv', t('Secret environment variable name'), 'BOTORGHQ_WEBHOOK_RESEARCH', { required: true })}
      {['github', 'internal'].includes(type) && textField('events', t('Subscribed events (comma-separated)'), type === 'github' ? 'workflow_run' : 'task.finished', { required: true })}
      <button disabled={disabled || !goals.length} className="bohq-primary">{t('Add trigger')}</button>
    </form>
    {data.records.map(row => <article className="bohq-pro-card" key={row.id}>
      <strong>{row.name}</strong><p>{status(row.type)} · {t(row.enabled ? 'Enabled' : 'Disabled')} · {status(row.sourceState)}</p>
      <p>{t('Last {last} · Next {next} · {timezone}', { last: date(row.lastAt), next: date(row.nextAt), timezone: row.timezone })}</p>
      {row.webhookPath && <code>{row.webhookPath}</code>}
      {row.pollingState && <p>{t('Catch-up polling · {status}', { status: status(row.pollingState) })}</p>}
      <div className="bohq-actions">
        <button disabled={disabled} onClick={() => perform('trigger', { id: row.id, revision: row.revision, enabled: !row.enabled })}>{row.enabled ? t('Disable') : t('Enable')}</button>
        <button disabled={disabled || !row.enabled} onClick={() => perform('trigger-now', { id: row.id })}>{t('Test trigger')}</button>
      </div>
    </article>)}
  </>;
}

function Approvals({ data, perform, disabled }) {
  const { t, status, date } = useTranslation();
  return data.records.map(row => <article className="bohq-pro-card" key={row.id}>
    <strong>{row.summary ?? row.tool}</strong>
    <p>{status(row.status)} · {status(row.risk)} · {row.tool} · {row.scope}</p>
    <p>{t('Goal {id} v{version} · Expires {time}', { id: row.goalId, version: row.goalVersion, time: date(row.expiresAt) })}</p>
    {row.snoozedUntil && <p>{t('Snoozed until {time}', { time: date(row.snoozedUntil) })}</p>}
    <p className="bohq-muted">{t('Argument digest {hash}', { hash: row.argsHash })}</p>
    {row.reason && <p>{row.reason}</p>}
    {['pending', 'approved'].includes(row.status) && <form className="bohq-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void perform('approval', { id: row.id, decision: event.nativeEvent.submitter.value, feedback: data.get('feedback') });
    }}>
      {textField('feedback', t('Feedback or approval note'), '', { maxLength: 1000 })}
      {([['approve', t('Approve once')], ['reject', t('Reject')], ['changes', t('Request changes')], ['snooze', t('Snooze for one hour')], ['mute', t('Mute similar notifications')], ['revoke', t('Revoke')]])
        .filter(([value]) => row.status === 'approved' ? value === 'revoke' : value !== 'revoke')
        .map(([value, label]) => <button key={value} value={value} disabled={disabled}>{label}</button>)}
    </form>}
  </article>);
}

function Activities({ company, opportunities, runs, activity, notifications, memory, events, goals, perform, send, disabled }) {
  const { t, status, date, locale } = useTranslation();
  return <>
    <div className="bohq-pro-toolbar">
      {['jsonl', 'csv'].map(format => <button key={format} onClick={async () => {
        const result = await send('proactive:export-traces', { format });
        download('botorg-activity.' + format, result, 'text/plain');
      }}>{t('Export {format}', { format: format.toUpperCase() })}</button>)}
    </div>
    <details><summary>{t('Company-confirmed context')}</summary>
      <form className="bohq-form bohq-pro-form" onSubmit={async event => {
        event.preventDefault();
        const form = event.currentTarget;
        if (await perform('memory', Object.fromEntries(new FormData(form)))) form.reset();
      }}>
        {textField('title', t('Title'), '', { required: true })}
        {textField('provenance', t('Source'), '', { required: true })}
        {textField('expiresAt', t('Expiry (ISO, optional)'), '')}
        <label className="bohq-full">{t('Confirmed context')}<textarea name="content" rows={2} required maxLength={3000} /></label>
        <button disabled={disabled}>{t('Add')}</button>
        <button type="button" onClick={async () => download('botorg-company-memory.json', await send('proactive:export-memory'), 'application/json')}>{t('Export')}</button>
      </form>
      {memory.map(item => <article className="bohq-pro-card" key={item.id}>
        <strong>{item.title}</strong><p>{item.content}</p><p className="bohq-muted">{item.provenance} · {date(item.expiresAt)}</p>
        <button disabled={disabled} onClick={() => perform('memory', { operation: 'remove', id: item.id })}>{t('Remove record')}</button>
      </article>)}
    </details>
    <details><summary>{t('Events and replay')}</summary>
      <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform('replay', { eventId: data.get('eventId'), goalId: data.get('goalId') });
      }}>
        {selectField('eventId', t('Event'), events.filter(item => item.trustLevel !== 'replay').map(item => [item.id, item.type + ' · ' + date(item.timestamp)]))}
        {selectField('goalId', t('Authorised goal'), goals.filter(item => item.status === 'active').map(item => [item.id, item.title]))}
        <button disabled={disabled || !events.length || !goals.some(item => item.status === 'active')}>{t('Replay as a shadow evaluation')}</button>
      </form>
    </details>
    <h3>{t('Notifications')}</h3>
    {notifications.map(row => <p className="bohq-pro-line" key={row.id}>{translateNotification(locale, row.title)} · {date(row.updatedAt)}</p>)}
    <h3>{t('Opportunities')}</h3>
    {opportunities.map(row => <article key={row.id} className="bohq-pro-card">
      <strong>{status(row.decision)}{row.shadow && <> · {t('Shadow mode')}</>}</strong><p>{row.rationale}</p>
      <p>{row.suppression && status(row.suppression)} · {date(row.updatedAt)} · {goals.find(goal => goal.id === row.goalId)?.title ?? row.goalId}</p>
      {row.nodes?.length > 0 && <details><summary>{t('Plan and scores')}</summary><ul>{row.nodes.map(node => <li key={node.key}>{node.title} · {node.expectedResult}</li>)}</ul>
        <p>{Object.entries(row.scores ?? {}).map(([key, value]) => key + ' ' + value).join(' · ')}</p></details>}
    </article>)}
    <h3>{t('Workflows')}</h3>
    {runs.map(run => <article className="bohq-pro-card" key={run.id}>
      <strong>{run.task?.title ?? t('Chief planning')}</strong><p>{t('{status} · Attempt {attempt}', { status: status(run.status), attempt: run.attempt })} · {run.reason}</p>
      {run.result && <><p>{run.result}</p><p>{status(run.verificationStatus)} · {run.limitations}</p></>}
      {run.kind === 'work' && run.status === 'succeeded' && <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void perform('verify', { id: run.id, verdict: data.get('verdict'), reason: data.get('reason') });
      }}>
        {selectField('verdict', t('Evidence review'), [['passed', t('Passed')], ['failed', t('Review failed')], ['inconclusive', t('Inconclusive')]])}
        {textField('reason', t('Reason or review evidence'), '', { required: true, maxLength: 2200 })}
        <button disabled={disabled}>{t('Save review')}</button>
      </form>}
      {run.kind === 'work' && run.attempt === 0 && ['queued', 'waiting_dependency', 'paused'].includes(run.status) && <form className="bohq-form" onSubmit={event => {
        event.preventDefault();
        void perform('workflow', { id: run.id, operation: 'reassign', employeeId: new FormData(event.currentTarget).get('employeeId') });
      }}>
        {selectField('employeeId', t('Reassign owner'), company.departments.flatMap(dep => dep.employees.map(employee => [employee.id, dep.name + ' / ' + employee.name])), run.actorId)}
        <button disabled={disabled}>{t('Save owner')}</button>
      </form>}
      {!['succeeded', 'cancelled', 'failed', 'timed_out'].includes(run.status) && <div className="bohq-actions">
        {(run.status === 'paused' ? [['resume', t('Resume')], ['cancel', t('Cancel')]] : [['pause', t('Pause')], ['cancel', t('Cancel')]])
          .map(([operation, label]) => <button key={operation} disabled={disabled} onClick={() => perform('workflow', { id: run.id, operation })}>{label}</button>)}
      </div>}
    </article>)}
    <h3>{t('Audit history')}</h3>
    <ol>{activity.map(row => <li key={row.seq}>{date(row.at)} · {row.type} · {row.tool ?? row.reason ?? (row.status || row.decision ? status(row.status ?? row.decision) : '')}</li>)}</ol>
  </>;
}

export function ProactivePanel({ kind, company, call, disabled }) {
  const { t, status } = useTranslation();
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
    <header className="bohq-panel-head"><h2>{t(proactiveTabs.find(([id]) => id === kind)[1])}</h2></header>
    <div className="bohq-pro-content">
      {error && <p className="bohq-error" role="alert">{t(error)}</p>}
      {!actual && !error && <p>{t('Loading…')}</p>}
      {actual && kind === 'goal' && <Goals company={company} data={actual} versions={data.goalVersion.records} perform={perform} disabled={off} />}
      {actual && kind === 'trigger' && <Triggers company={company} data={actual} goals={data.goal.records} perform={perform} disabled={off} />}
      {actual && kind === 'policy' && <PolicyForm company={company} data={actual} perform={perform} disabled={off} />}
      {actual && kind === 'approval' && (actual.records.length ? <Approvals data={actual} perform={perform} disabled={off} /> : <p>{t('No approval records.')}</p>)}
      {actual && kind === 'opportunity' && <Activities company={company} opportunities={actual.records} runs={data.runs.records} activity={data.activity.records}
        notifications={data.notification.records} memory={data.memory.records} events={data.event.records} goals={data.goal.records} perform={perform} send={send} disabled={off} />}
      {actual && kind === 'metrics' && <dl className="bohq-metrics">
        <dt>{t('Engine')}</dt><dd>{t('{engine} · Local scheduling pauses when the host exits or sleeps', { engine: actual.engine })}</dd>
        <dt>{t('Active goals')}</dt><dd>{actual.activeGoals}</dd><dt>{t('Goals achieved')}</dt><dd>{actual.achievedGoals}</dd>
        <dt>{t('Opportunities')}</dt><dd>{actual.opportunityCount}</dd><dt>{t('Duplicates suppressed')}</dt><dd>{actual.duplicatesSuppressed}</dd>
        <dt>{t('Awaiting approval')}</dt><dd>{actual.approvalsPending}</dd><dt>{t('Expired approvals')}</dt><dd>{actual.approvalsExpired}</dd>
        <dt>{t('Tokens reserved over 24 hours')}</dt><dd>{actual.usage24h.tokens}</dd>
        {actual.jobs.map(row => <React.Fragment key={row.status}><dt>{status(row.status)}</dt><dd>{row.count}</dd></React.Fragment>)}
      </dl>}
    </div>
  </section>;
}
