import { InputError } from './store.mjs';
import { ProviderError } from './engines.mjs';
import { validatePlan, validateWork } from './plan.mjs';

export class Runtime {
  constructor(store, engine, publish) {
    this.store = store;
    this.engine = engine;
    this.publish = publish;
    this.running = new Set();
    this.controller = new AbortController();
    this.scheduled = false;
    this.store.recover(engine.mode);
  }

  submit(companyId, prompt) {
    const id = this.store.enqueue(companyId, prompt, this.engine.mode);
    this.publish(companyId);
    this.wake();
    return id;
  }

  wake() {
    if (this.scheduled || this.controller.signal.aborted) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.controller.signal.aborted) this.dispatch();
    });
  }

  dispatch() {
    while (this.running.size < 3) {
      const job = this.store.claim(this.engine.mode);
      if (!job) return;
      this.publish(job.companyId);
      const promise = this.perform(job).catch(error => {
        // Persistence errors require operator attention. Avoid logging model input or provider data.
        console.error('Unable to persist job state:', error.code ?? error.name);
      }).finally(() => {
        this.running.delete(promise);
        this.wake();
      });
      this.running.add(promise);
    }
  }

  async perform(job) {
    const { companyId, id } = job;
    const signal = this.controller.signal;
    const company = this.store.company(companyId);
    try {
      if (job.kind === 'request') {
        const { prompt, mode } = this.store.request(companyId, id);
        const bots = this.store.bots(companyId);
        const history = this.store.chiefContext(companyId, mode);
        const draft = await this.engine.plan({ company, bots, history, prompt, signal });
        signal.throwIfAborted();
        this.store.finishPlan(job, validatePlan(draft, bots));
      } else {
        const task = this.store.task(companyId, id);
        const reports = this.store.reports(companyId, task.botId);
        const history = this.store.workerContext(companyId, task.botId, this.engine.mode);
        const work = await this.engine.execute({ company, task, reports, history, signal });
        signal.throwIfAborted();
        this.store.finishTask(job, validateWork(work, reports));
      }
    } catch (error) {
      const reason = signal.aborted ? '服务关闭，工作已中断。'
        : error instanceof InputError || error instanceof ProviderError ? error.message
          : '运行失败，请检查服务连接后重试。';
      this.store.fail(job, reason);
    } finally {
      this.publish(companyId);
    }
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled(this.running);
  }
}
