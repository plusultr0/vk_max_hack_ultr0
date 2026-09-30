# Changed files · 0.9.14

Сравнение выполнено с фактическим root `vk_max_hack_ultr0-main/` из входного архива 0.9.13.

## Product / UX

- `apps/web/src/App.tsx` — section-14 UX: удалён лишний верхний текст, onboarding progress упрощён, применимая карточка получила completion block, action copy уточнён, customer headings говорят о требовании.
- `apps/web/src/styles.css` — spacing onboarding и стили `requirement-completion`.
- `packages/domain/src/presentation.ts` — человекочитаемые applicable/not-applicable/upcoming/compliant формулировки.
- `packages/domain/src/business-checks.ts` — customer copy без внутреннего «эта проверка».
- `tests/layout/fixtures.json` — layout fixtures синхронизированы с новым copy и completion block.

## Seed / persistence

- `packages/db/src/seed.ts` — установка `factModel.definitions` и регистрация `rule_fact_dependencies` при seed через существующие helpers.
- `seed/v1/legal-acts.json` — добавлены/актуализированы официальные основания для 30 новых требований.
- `seed/v1/legal-rules.json` — 37 rules total, +30 новых персонализируемых требований с actions/evidence/dynamic facts.
- `seed/v1/rule-scenarios.json` — новый fixture-набор для 30 правил: `applies`, `notApplicable`, `needsInfo`.
- `seed/v1/manifest.json` — seed version `2026-09-27-v2`, 37 rules.

## Tests

- `tests/offline/core.test.mjs` — suite расширен до 186 тестов: 37-rule count, 90 scenario verdict checks, evidence/actions и section-14 UX assertions.
- `docs/validation-0.9.14/*` — фактические логи offline/syntax/layout/dynamic-fact проверок, контроль `.env` и ограничения окружения.
- `test-results/layout-0.9.14/*` — generated screenshots/report для 80 user layout cases.
- `test-results/review-layout-0.9.14/*` — generated screenshots/report для 5 admin-review cases.

## Release metadata / docs

- `package.json`, `package-lock.json` — версия 0.9.14.
- `README.md` — текущий scope, 37-rule seed, execution UX, test/runtime status.
- `ROADMAP.md` — выполненные этапы A–C и оставшиеся runtime/live gates.
- `TEST_REPORT.md` — результаты 0.9.14 и честно отмеченные недоступные runtime checks.
- `CHANGELOG_0.9.14.md` — changelog текущей версии.
- `LEGAL_SEED_RESEARCH_0.9.14.md` — официальные источники и реестр 30 новых rule IDs.
- `CHANGED_FILES_0.9.14.md` — этот файл.
- `SOURCE_MANIFEST.sha256` — пересобран перед упаковкой; `.env` намеренно исключён из public hash manifest.

## Не изменено намеренно

- `.env` — побайтно совпадает с входным ZIP 0.9.13.
- Архитектура deterministic evaluator / immutable rule lifecycle / existing action execution state не заменялась новым параллельным механизмом.
- Старые validation/changelog документы сохранены как история.
