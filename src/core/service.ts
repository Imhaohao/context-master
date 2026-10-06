import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { contextPacket, matchSpecialists, selectEvidence, validateCitations } from './context';
import { runSpecialist } from './harness';
import { redactCredentials } from './redaction';
import { LibraryStore } from './store';
import { consultationInput } from './validation';
import type { Consultation } from './types';
import type { z } from 'zod';

export class SpecialistService {
  private owner = randomUUID();
  private controllers = new Map<string, AbortController>();
  private executions = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(public store: LibraryStore = new LibraryStore()) { this.store.recoverAbandonedRuns(); }
  search(question: string, limit = 8) { return matchSpecialists(this.store, question, limit); }
  start(input: z.input<typeof consultationInput>): Consultation {
    if (this.stopping) throw new Error('Context Master is shutting down. Reopen the app before asking again.');
    const parsed = consultationInput.parse(input);
    const data = { ...parsed, question: redactCredentials(parsed.question).text };
    const specialist = this.store.specialist(data.specialistId);
    const evidence = selectEvidence(this.store, specialist, data.question);
    const context = contextPacket(specialist, data.question, evidence);
    const run = this.store.createConsultation({ ...data, cli: data.cli ?? specialist.cli, evidence, context, owner: this.owner });
    if (data.mode === 'context') return this.store.transitionRun(run.id, 'completed', { answer: context, durationMs: 0 });
    const controller = new AbortController(); this.controllers.set(run.id, controller);
    this.store.heartbeatRun(run.id, this.owner);
    const execution = this.execute(run, controller).finally(() => this.executions.delete(run.id));
    this.executions.set(run.id, execution);
    void execution.catch(() => undefined);
    return this.store.consultation(run.id);
  }
  cancel(id: string): Consultation {
    const run = this.store.transitionRun(id, 'cancelled');
    this.controllers.get(id)?.abort();
    return run;
  }
  async wait(id: string, signal?: AbortSignal): Promise<Consultation> {
    while (true) {
      const run = this.store.consultation(id);
      if (!['queued', 'running'].includes(run.status)) return run;
      if (signal?.aborted) return this.cancel(id);
      await delay(250);
    }
  }
  async shutdown() {
    this.stopping = true;
    for (const id of this.controllers.keys()) this.cancel(id);
    await Promise.allSettled(this.executions.values());
  }
  private async execute(run: Consultation, controller: AbortController) {
    const started = Date.now();
    const ticker = setInterval(() => {
      if (!['queued', 'running'].includes(this.store.consultation(run.id).status)) controller.abort();
      else this.store.heartbeatRun(run.id, this.owner);
    }, 2000);
    try {
      await this.waitForSlot(run.id, controller.signal);
      if (controller.signal.aborted) return;
      this.store.addEvent(run.id, { type: 'status', text: `Starting ${run.cli} with the saved brief and ${run.evidence.length} source excerpts.` });
      const result = await runSpecialist({ cli: run.cli, prompt: run.context, signal: controller.signal,
        onEvent: event => { if (!controller.signal.aborted) this.store.addEvent(run.id, event); } });
      const checked = validateCitations(redactCredentials(result.text).text, run.evidence);
      if (checked.invalid) this.store.addEvent(run.id, { type: 'status', text: 'The agent returned a source number outside the evidence bundle. It was marked unsupported.' });
      this.store.transitionRun(run.id, 'completed', { answer: checked.answer, durationMs: result.durationMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The agent could not answer. Check its CLI login and try again.';
      this.store.transitionRun(run.id, controller.signal.aborted ? 'cancelled' : 'failed', { error: redactCredentials(message).text, durationMs: Date.now() - started });
    } finally { clearInterval(ticker); this.controllers.delete(run.id); }
  }
  private async waitForSlot(id: string, signal: AbortSignal) {
    this.store.addEvent(id, { type: 'status', text: 'Queued. Up to two specialists can run at once.' });
    const started = Date.now();
    while (!signal.aborted) {
      if (this.store.claimRun(id, this.owner)) return;
      if (Date.now() - started > 240000) throw new Error('The specialist queue is busy. Wait for another consultation to finish and try again.');
      await delay(500, undefined, { signal });
    }
  }
}
const globalService = globalThis as unknown as { contextMasterService?: SpecialistService };
export function service(): SpecialistService { return globalService.contextMasterService ??= new SpecialistService(); }
