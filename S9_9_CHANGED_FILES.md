# S9.9 - Changed files

Baseline: `vk_max_hack_ultr0-main (1).zip`. Version: `0.9.9`.

New: 31. Modified: 38. Deleted: 0.

The working `.env` is byte-for-byte identical. Migrations 001-010 are unchanged.

## New

- `S9_9_CHANGED_FILES.md`
- `S9_9_IMPLEMENTATION.md`
- `S9_9_VALIDATION.md`
- `apps/web/src/facts/FactQuestionsForm.tsx`
- `apps/web/src/review/FactMetadataEditor.tsx`
- `docs/S9_9_REQUEST.md`
- `docs/validation/S9_9_LOCAL_IMPORTS.json`
- `docs/validation/S9_9_SANDBOX_TEST_RESULTS.json`
- `docs/validation/S9_9_STANDARD_CHECK_ATTEMPTS.json`
- `docs/validation/S9_9_SYNTAX.json`
- `docs/validation/S9_9_TYPECHECK_ATTEMPT.log`
- `docs/validation/S9_9_VITEST_ATTEMPT.log`
- `docs/validation/S9_9_WEB_BUILD_ATTEMPT.log`
- `packages/db/migrations/011_business_facts.sql`
- `packages/db/src/automation.ts`
- `packages/db/src/autonomous.integration.ts`
- `packages/db/src/fact-answers.ts`
- `packages/db/src/fact-evaluation.ts`
- `packages/db/src/fact-runtime.test.ts`
- `packages/db/src/facts.ts`
- `packages/db/src/regulatory-feed.ts`
- `packages/db/src/targeting.ts`
- `packages/domain/src/fact-builtins.ts`
- `packages/domain/src/fact-logic.ts`
- `packages/domain/src/fact-schema.ts`
- `packages/domain/src/facts.test.ts`
- `packages/domain/src/targeting-logic.ts`
- `packages/llm/src/automation-schema.ts`
- `packages/review/src/automatic.test.ts`
- `packages/review/src/automatic.ts`
- `packages/review/test/automatic-fixture.ts`

## Modified

- `.env.example`
- `IMPLEMENTATION_NOTES.md`
- `README.md`
- `SOURCE_MANIFEST.sha256`
- `apps/api/src/index.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/review/PhaseEditor.tsx`
- `apps/web/src/review/ReviewApp.tsx`
- `apps/web/src/review/types.ts`
- `apps/web/src/styles.css`
- `apps/worker/src/extraction.ts`
- `apps/worker/src/index.ts`
- `package-lock.json`
- `package.json`
- `packages/config/src/index.ts`
- `packages/db/package.json`
- `packages/db/src/extraction-jobs.ts`
- `packages/db/src/impacts.ts`
- `packages/db/src/index.ts`
- `packages/db/src/ingestion.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/outbox.ts`
- `packages/db/src/profile.ts`
- `packages/db/src/publication.ts`
- `packages/db/src/review.ts`
- `packages/db/src/runtime.ts`
- `packages/domain/src/condition.ts`
- `packages/domain/src/index.ts`
- `packages/domain/src/schemas.ts`
- `packages/ingestion/src/index.ts`
- `packages/ingestion/src/ingestion.test.ts`
- `packages/llm/src/extraction.ts`
- `packages/llm/src/index.ts`
- `packages/review/src/compiler.ts`
- `packages/review/src/draft.ts`
- `packages/review/src/index.ts`
- `packages/review/src/schema.ts`
- `packages/review/src/temporal.ts`

## Verification

See `S9_9_VALIDATION.md`. No production acceptance is claimed.
