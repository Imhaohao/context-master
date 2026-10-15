import type { LibraryStore } from './store';
import { draftBrief } from './context';
import type { AgentCli } from './types';

// A made-up surf-school booking app. Every chat below was written for the demo
// library; none of it comes from a real project or a real person's history.
interface DemoSession { title: string; source: 'claude' | 'codex'; turns: string[] }
interface DemoSpecialist { name: string; description: string; tags: string[]; sessions: DemoSession[] }

const project = 'tidepool (example project)';

const webhooks: DemoSession = {
  title: 'Stripe webhooks arriving twice', source: 'claude', turns: [
    'Some Tidepool students got two "Booking confirmed" emails for one lesson. Stripe shows a single charge. The checkout.session.completed handler in app/api/stripe/webhook/route.ts creates the booking and sends the email. What is going on?',
    'Stripe delivers webhooks at least once, so the same event can arrive twice. In your logs both deliveries share event id evt_1Q8… and the first one took 11.4 seconds because the handler waits for the email provider before answering. Stripe treats a slow or failed response as undelivered and retries it, so the handler ran twice.\n\nFix it in two places:\n1. Record every processed event in a stripe_events table with event_id as the primary key. Insert first with ON CONFLICT DO NOTHING; if no row was inserted, return 200 immediately because the event was already handled.\n2. Answer Stripe as soon as the booking row is written. Put the confirmation email on the jobs queue instead of sending it inside the request.',
    'Should the booking insert and the stripe_events insert be in the same transaction?',
    'Yes. Write both in one transaction so a crash cannot leave an event marked as processed without its booking. The email job is enqueued after the commit with dedupe key confirmation:{bookingId}, so a retry that slips through still sends one email.',
    'Done. I also added a test that posts the same signed event twice.',
    'Good. Decision for the record: webhook handlers in Tidepool must be idempotent on Stripe event id, respond within a second or two, and never send email inline. The duplicate-delivery test lives in tests/stripe-webhook.test.ts.'
  ]
};

const refunds: DemoSession = {
  title: 'Refunds for lessons cancelled by weather', source: 'codex', turns: [
    'When the instructor cancels a lesson because of surf conditions we refund everyone. Last Saturday one student was refunded twice after the admin double-clicked "Cancel lesson". How do we stop that?',
    'Pass an idempotency key to stripe.refunds.create. Use refund:{bookingId}:weather so a second click, or a retried job, returns the original refund instead of creating a new one. Also mark the booking as refund_pending before calling Stripe and disable the button while the request runs.',
    'Students who cancel themselves less than 24 hours before the lesson get 50% back. Same code path?',
    'Same function, different key and amount: refund:{bookingId}:late-cancel with amount set to half of the amount_received on the PaymentIntent. Keep the policy in lib/refunds.ts so the admin screen and the student screen cannot drift apart. Refunds are only marked complete when the charge.refunded webhook arrives, which goes through the same idempotent handler as bookings.'
  ]
};

const capacity: DemoSession = {
  title: 'Add lesson capacity without locking bookings', source: 'claude', turns: [
    'I need a capacity column on lessons (max students per lesson, default 6) and a check that bookings never exceed it. The lessons table has about 2 million rows and the booking page reads it constantly. How do I migrate without downtime?',
    'Split it into steps that each hold only short locks:\n1. ALTER TABLE lessons ADD COLUMN capacity integer NOT NULL DEFAULT 6. On Postgres 11 and later a constant default is stored in the catalog, so this does not rewrite the table.\n2. ALTER TABLE lessons ADD CONSTRAINT capacity_positive CHECK (capacity > 0) NOT VALID, then VALIDATE CONSTRAINT in a separate migration. Validation scans the table but only takes a SHARE UPDATE EXCLUSIVE lock, so reads and writes keep working.\n3. Set lock_timeout = 3s on every migration so a stuck lock fails fast instead of queueing the booking page behind it.',
    'What about enforcing that bookings do not exceed capacity?',
    'Do that in the booking transaction, not with a trigger: SELECT the lesson FOR UPDATE, count confirmed bookings, and insert only if the count is below capacity. Index bookings on (lesson_id) WHERE status = \'confirmed\' and build it with CREATE INDEX CONCURRENTLY, which cannot run inside a transaction block, so it needs its own migration file.',
    'Migrations 0042 to 0044 are merged and ran on staging in under a second each.'
  ]
};

const reminders: DemoSession = {
  title: 'Move lesson reminders off the cron box', source: 'claude', turns: [
    'Reminder texts go out from a cron job on a single VM every 15 minutes. When the VM restarted on Sunday nobody got reminders, and students in Lisbon got theirs an hour late after the clock change. What should replace it?',
    'Schedule one job per booking at the moment it is confirmed: run_at = lesson start minus 24 hours, dedupe key reminder:{bookingId}:24h. Store lesson start as timestamptz and keep the school\'s IANA time zone (Europe/Lisbon) next to it, so the reminder text shows local time correctly across daylight-saving changes.\n\nThe worker claims due jobs with SELECT … FOR UPDATE SKIP LOCKED, so two workers never send the same reminder and a restart only delays jobs instead of dropping them.',
    'If a lesson is rescheduled?',
    'Cancel the pending job by its dedupe key and enqueue a new one with the new run_at. If the new start is less than 24 hours away, send the reminder right away instead of skipping it.'
  ]
};

const specialists: DemoSpecialist[] = [
  { name: 'Tidepool payments', description: 'Stripe checkout, webhooks and refunds in the Tidepool booking app.', tags: ['stripe', 'webhooks', 'refunds'], sessions: [webhooks, refunds] },
  { name: 'Tidepool database', description: 'Postgres schema changes and booking capacity in the Tidepool booking app.', tags: ['postgres', 'migrations'], sessions: [capacity] },
  { name: 'Tidepool reminders', description: 'Background jobs and time zones for lesson reminders in the Tidepool booking app.', tags: ['jobs', 'time zones'], sessions: [reminders] }
];

function importDemoSession(store: LibraryStore, session: DemoSession): string {
  const messages = session.turns.map((content, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content }));
  const imported = store.import(JSON.stringify({ title: session.title, project, source: session.source, messages }), `${session.title}.json`);
  return imported.sessions[0].id;
}

export function loadExamples(store: LibraryStore, cli: AgentCli) {
  return specialists.map(specialist => {
    const sessionIds = specialist.sessions.map(session => importDemoSession(store, session));
    const existing = store.specialists().find(item => sessionIds.every(id => item.sessionIds.includes(id)));
    if (existing) return existing;
    const draft = draftBrief(sessionIds.map(id => store.session(id)));
    return store.createSpecialist({ ...draft, name: specialist.name, description: specialist.description, tags: ['example', ...specialist.tags], cli, sessionIds });
  });
}
