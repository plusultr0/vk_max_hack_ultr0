# Changed files 0.9.15

## MAX bot

- `apps/bot/src/index.ts` — interactive webhook routing, safe secret validation, health flags.
- `apps/bot/src/handler.ts` — message/callback scenarios, DB-backed responses, dedupe, group privacy, action completion.
- `apps/bot/src/scenarios.ts` — commands, intent routing, copy, native keyboards, safe personal requirement search.
- `apps/bot/src/subscribe.ts` — webhook + bot command synchronization.
- `apps/bot/src/handler.test.ts` — interactive handler tests.
- `apps/bot/src/scenarios.test.ts` — routing/copy/button tests.
- `apps/bot/package.json` — bot test script + explicit Zod dependency.

## MAX integration

- `packages/max/src/index.ts` — native `open_app`/callback buttons, callback answers, command registration, expanded send methods.
- `packages/max/src/max.test.ts` — native button tests.

## Data / lifecycle

- `packages/db/src/webhook.ts` — interactive webhook claim/dedupe and MAX identity synchronization.
- `packages/db/src/runtime.ts` — publication-driven `needs_info` regulatory notifications; no profile-edit notification spam.
- `packages/db/src/notifications.ts` — `needs_info` relevance for regulatory updates.
- `packages/db/src/lifecycle.integration.ts` — native open_app notification assertions and publication-driven repair scenario.

## Worker / Mini App

- `apps/worker/src/jobs.ts` — native buttons in welcome/reminder/update notifications; separate copy for needs-info.
- `apps/web/src/App.tsx` — navigation from MAX `start_param` into exact Mini App sections/cards.

## Tests / package metadata / docs

- `scripts/test-chatbot-offline.mjs` — dependency-free chatbot routing/copy gate.
- `package.json` — version 0.9.15, bot tests in workspace suite, offline chatbot script.
- `package-lock.json` — version/dependency lock update.
- `README.md`
- `ROADMAP.md`
- `TEST_REPORT.md`
- `BOT_SCENARIOS_0.9.15.md`
- `DEPLOY_0.9.15_YANDEX.md`
- `CHANGELOG_0.9.15.md`
- `CHANGED_FILES_0.9.15.md`
- `SOURCE_MANIFEST.sha256` — regenerated after final packaging cleanup.

No migration and no seed rule change is introduced in 0.9.15. `.env` is preserved byte-for-byte.
