# S7 validation — MAX notifications and deep links

Status: **implemented in code; live MAX delivery pending bot token/public HTTPS**.

## Implemented

- durable `notifications` table with delivery state, attempts, dedupe key and payload;
- future action deadline reminders are created idempotently;
- past deadlines do not create fresh bot spam;
- “new relevant regulation” notification mode is reserved for regulatory-update recalculation, not onboarding/profile edits;
- pg-boss 12 worker queue runs a minute-level notification dispatcher;
- due rows are claimed with PostgreSQL `FOR UPDATE SKIP LOCKED`;
- failures retry after 5 minutes and become terminal after 5 delivery attempts;
- stale `sending` claims are recovered;
- MAX message includes an inline link back to the exact rule card via `startapp=impact_<ruleId>`;
- mini-app reads the signed/validated launch start parameter returned by API auth and opens/scrolls to the matching impact card;
- `/notifications` exposes the company's delivery history for authenticated debugging/support.

## Anti-spam behavior

- notification scheduling has a unique `dedupe_key`;
- first onboarding does not send a message per already-known rule;
- one rule version gets at most one “new relevant” notification per company;
- one rule/action/deadline tuple gets at most one deadline reminder;
- dev users (`dev-*`) never get external MAX delivery rows.

## Queue choice

S7 now uses `pg-boss` over the same PostgreSQL database, matching the architecture plan and avoiding a separate Redis service. The current package pin is `pg-boss@12.32.0`; it must be locked in `package-lock.json` after the first successful `npm install`.

## Live acceptance later

With a real MAX bot token and public HTTPS:

1. register webhook;
2. open mini-app from MAX and confirm a profile;
3. create a future action reminder or approved regulatory-update notification;
4. run worker;
5. verify one bot message arrives;
6. tap “Открыть карточку”;
7. verify mini-app lands on the intended rule card;
8. rerun dispatcher/recalculation and confirm no duplicate row/message is scheduled;
9. temporarily force a send failure and verify retry/terminal state behavior.

## Known delivery boundary

The database side is idempotent. External message delivery is still fundamentally at-least-once if the worker crashes after MAX accepts a message but before our `sent_at` transaction is written; this rare edge can only be fully removed if the external API offers a usable idempotency primitive.
