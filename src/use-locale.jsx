import React, { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { translateWorkbench, workbenchLocale } from './messages.mjs';

const LocaleContext = createContext(null);
const labels = {
  OFF: 'Off', SUGGEST: 'Suggest', SUPERVISED: 'Supervised', BOUNDED_AUTO: 'Bounded auto',
  idle: 'Idle', working: 'Working', approval: 'Awaiting approval', waiting: 'Waiting', blocked: 'Blocked',
  todo: 'To-do', in_progress: 'In progress', finished: 'Finished', aborted: 'Aborted',
  proposed: 'Proposed', active: 'Active', paused: 'Paused', achieved: 'Achieved', abandoned: 'Abandoned',
  heartbeat: 'Heartbeat', interval: 'Interval', once: 'One time', cron: 'Cron', github: 'GitHub', webhook: 'Webhook', internal: 'Internal event',
  queued: 'Queued', waiting_dependency: 'Waiting for dependencies', running: 'Running', waiting_approval: 'Waiting for approval',
  retry_scheduled: 'Retry scheduled', retrying: 'Retrying', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out',
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', expired: 'Expired', invalidated: 'Invalidated',
  consumed: 'Consumed', revoked: 'Revoked', unverified: 'Unverified', needs_human_review: 'Needs human review',
  passed: 'Passed', inconclusive: 'Inconclusive', verified: 'Verified', evidence_recorded: 'Evidence recorded',
  IGNORE: 'Ignore', MONITOR: 'Monitor', PREPARE: 'Prepare', REQUEST_APPROVAL: 'Request approval', EXECUTE_ALLOWED: 'Execute allowed work',
  suppressed: 'Suppressed',
  ready: 'Ready', listening: 'Listening', configured: 'Configured', connected: 'Connected',
  not_connected: 'Not connected', not_configured: 'Not configured',
  low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical'
};

export function WorkbenchLocale({ service, children }) {
  const store = useMemo(() => ({
    subscribe: listener => service.subscribe(listener),
    read: () => service.getLocale().active
  }), [service]);
  const active = useSyncExternalStore(store.subscribe, store.read);
  const locale = workbenchLocale(active);
  const value = useMemo(() => {
    const t = (key, values) => translateWorkbench(locale, key, values);
    return {
      active, locale, t,
      setLocale: id => service.setLocale(id),
      status: code => code == null ? '—' : t(Object.hasOwn(labels, code) ? labels[code] : String(code)),
      date: value => value ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en') : '—'
    };
  }, [active, locale, service]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useTranslation() {
  return useContext(LocaleContext);
}
