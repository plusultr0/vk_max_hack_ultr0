# S9.6–S9.8: delivery, lifecycle and MAX integration

Validation date: 2026-09-18. Continues publication producer commit `b0c431b`.
New publication tests use synthetic rules and disposable PostgreSQL 16.
No real candidate was approved; no real MAX message was sent.

## Implemented

- **S9.6:** outbox fan-out into durable per-company jobs; bounded retries/backoff,
  independent failures, admin progress and explicit retry. Assessments, actions,
  notification intent and job completion commit together. Existing assessments
  do not short-circuit repair of missing notification intent.
- A DB trigger enqueues profile changes atomically. A company row lock serializes
  recalculation/profile insertion/action mutation. The existing pg-boss worker
  schedules delivery, extraction, notifications and hourly lifecycle refresh.
- Background extraction returns 202/job ID. Attempts, start/finish, lease,
  sanitized error and candidate ID are separate from valid candidates. Three
  attempts maximum; expired final leases become failed. Claim tokens prevent
  a late worker from committing another worker's result.
- **S9.7:** current/upcoming/history separation; expired/cancelled latest editions
  never resurrect older rules. Time-state transitions create a new assessment.
  Unchanged duties carry execution state; changed obligation, condition,
  context or deadline does not inherit completed. Legacy action identities are
  derived from their original rule/profile before carry-over.
- Historical actions are read-only; stale open actions have a review reason.
  Changing the selected trade object clears facts belonging to the former one.
  Notifications are rechecked immediately before sending and acknowledgements
  are claim-fenced. Cancelled, still-relevant unsent intent can be reactivated.
- **S9.8 technical path:** signed MAX auth/expiry, owner-scoped exact assessment
  links, webhook secret/event deduplication, durable welcome intent and transport
  retry. A new signed launch takes precedence over a previous webview session.
- Review UI has publication confirmation/progress/retry. User UI has current,
  future and historical labels, reasons, source, profile version, completion
  status and history. A seed/dev identity conflict found in browser QA was fixed.

## Verification

```sh
npm run check
ALLOW_INTEGRATION_TESTS=true DATABASE_URL=<disposable-postgres-url> npm run test:integration
```

Never use a production DB for integration tests. Each suite creates/drops a
random schema and applies migrations twice; the lifecycle suite additionally
starts pg-boss with its own queue schema. Docker excludes `.env`.

Verified:

1. Backend/frontend TypeScript, **86 unit tests**, production Vite build.
2. Grounding, review, atomic publication and delivery-lifecycle integration suites.
3. Notification-trigger fault rolls back one company's assessment/actions;
   other companies proceed; retry and concurrent consumers do not create duplicates.
4. Missing notification-intent repair and completed legacy action migration.
5. Actual PostgreSQL connection termination while a claim is locked, then recovery.
   Real pg-boss worker starts, consumes a profile job, is killed, and consumes
   another persisted job after restart.
6. V1 completion → profile change → V2 unchanged → V3 changed duty; ownership,
   stale-action rejection, history, future/cancelled version selection.
7. Extraction retry, stale claim rejection, atomic candidate linkage and
   recovery of an abandoned final attempt.
8. Local fake MAX HTTP 503 → retry → 200, exact assessment link, no repeat after
   acknowledged send; stale claim cannot acknowledge a new notification claim.
9. Real API/bot HTTP processes: signed auth/expiry, foreign-company 404,
   stale action 409, admin guard, extraction 202, webhook secret/duplicate.
10. Browser smoke on a disposable seed database: profile → seven cards →
    completed action → reload preserves completion → history.
    Mobile **390×844** checked visually for navigation, wrapping and controls.

## Operations and changed endpoints

Apply migration **010_delivery_lifecycle.sql** with `npm run db:migrate` before
starting API, bot and worker. Keep the worker running (`npm run dev:worker`
for development). Existing installation data and `.env` must be preserved.

- `POST /admin/source-documents/:id/extract` now returns **202**, not a candidate.
  Poll `GET /admin/extraction-jobs/:id`; use `candidate_id` when processed.
  Equal source/input returns the same job. Exhausted jobs require an operator
  decision/new input; there is no unlimited automatic retry.
- `GET /admin/candidates/:id/publication`: status and company progress.
- `POST /admin/candidates/:id/publication/retry`: audited retry of failed jobs.
  Existing admin authentication and cookie CSRF protections apply.
- `/impacts`: current/upcoming; `/impacts/history`: all; `/impacts/:id`:
  owner-scoped current or historical card. Historical action PATCH returns 409.
- Webhook requires `MAX_WEBHOOK_SECRET`; production refuses startup without it.

## Remaining acceptance and limitations

**S9.8 live acceptance is NOT complete.** The user confirmed that there is no
public HTTPS deployment yet. Local/mocked tests are not real-client acceptance.
Next gate: deploy web/API/bot/worker, disable dev-auth, configure bot username,
mini-app/webhook URLs and secret, subscribe webhook, then verify publication →
notification → exact card → completion → reopen inside real MAX.
The approval system blocked read-only verification using the real token;
the restriction was not bypassed. Explicit permission is required for that request.

- One selected trade-object context per company, not multi-outlet management.
- UTC date boundaries; reminders use 09:00 Moscow minus three days.
- External delivery is **at least once**, not exactly once: a successful send
  followed by lost acknowledgement may duplicate. Changes during the network
  call cannot retract an already sent message.
- Shared admin principal; no automatic queue retention or cross-version act merge.
- Concurrent context answers may return a profile conflict; no silent merge.
- Explanation traces still expose deterministic field/operator values.
- S10 archive/presentation and official-source/live acceptance are not claimed.
  Pilot legal grounds still need final review.
- Tracked `.env` is unchanged; do not distribute it in a release archive.
