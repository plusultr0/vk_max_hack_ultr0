# S5–S6 validation — applicability + action plan

Status: **implemented in code; database/API/browser acceptance pending local dependency install**.

## S5 implemented

- confirmed `company_profile` is parsed by the same domain schema as test fixtures;
- latest reviewed `active/upcoming` rule version is selected per `ruleId`;
- all rules are evaluated by the deterministic tri-state engine;
- assessment is persisted per `(company, profile_version, rule_id, rule_version)`;
- `GET /impacts` exposes the real company's results, not demo fixtures;
- `GET /impacts/:id` is ownership-scoped;
- `needs_info` is mapped to human questions from rule `questionMap`;
- context answer endpoint creates a **new immutable profile version**, recalculates rules and preserves old assessments;
- stale impact and concurrent profile-draft guards prevent answering against the wrong version.

## S6 implemented

- evaluator materializes action templates only for allowed states;
- actions are persisted idempotently with an impact-scoped key;
- action status can move through `open / in_progress / completed / dismissed`;
- completing an action preserves `completed_at`;
- a newer assessment marks older non-completed actions `review_required=true` instead of deleting them;
- impact feedback and action status changes are written to `audit_log`;
- the mini-app shows real impacts, sources, questions and action controls after profile confirmation.

## Correctness fixes made while integrating S5

1. Added DSL operator `known`.
   - `exists(missing)` is legitimately `false`.
   - a **required but unknown fact** must instead produce `unknown + missingFields` so the product asks a question.
2. USN rules now require `hasCombinedTaxRegimes` to be known for USN cases.
3. The PD rule no longer asks the same “consent is the legal basis” fact twice after `usesConsent=true` already established it.
4. Digital-ruble local exception facts are requested only after the main revenue/agreement/bank gate can still pass, preserving short-circuit behavior.

These are implementation corrections to keep runtime behavior aligned with the explicit MVP semantics: unknown facts must not silently become negative facts.

## Static checks run here

- all `package.json` files parse;
- `seed/v1/*.json` parses;
- `compose.yaml` parses;
- TypeScript parser reported no syntax-level diagnostics; unresolved-module diagnostics remain because dependencies are not installed in this environment;
- a separate deterministic seed sanity script verified the main seven fixture verdicts, low-revenue short-circuit, and missing-date `needs_info` behavior.

## Acceptance checks to run locally

```bash
npm install
npm test
npm run db:migrate
npm run seed
npm run dev:api
npm run dev:web
```

Then verify:

1. dev auth opens the onboarding;
2. confirming the profile creates profile v1;
3. `/impacts` returns the current profile version and 7 current cards;
4. an unresolved card asks a context question;
5. answering it creates profile v2 and a linked new assessment;
6. old v1 assessment still exists;
7. applicable non-reviewed actions appear;
8. clicking “В работу” and “Выполнено” persists after reload;
9. a new profile version does not delete completed actions;
10. production config does not expose `/dev/demo`.
