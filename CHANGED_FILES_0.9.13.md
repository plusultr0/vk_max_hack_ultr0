# Changed files 0.9.13

По сравнению с 0.9.12:

- `apps/web/src/App.tsx` — навигационный контекст, тексты, статусы, профиль dirty state, документы, errors/notices, детализация источников и ручной проверки.
- `apps/web/src/facts/FactQuestionsForm.tsx` — понятные состояния сохранения/unknown/stale, единая структура формы.
- `apps/web/src/styles.css` — системные отступы, адаптив, единые карточки/поля, touch targets, source links, detail layout, long-text safety.
- `apps/web/src/review/review.css` — визуальное выравнивание admin review с mini-app.
- `apps/web/src/main.tsx`, `apps/web/index.html` — пользовательские title/theme/fonts.
- `packages/domain/src/presentation.ts` — plain-language copy, статусы, ошибки, human-readable conditions и manual-review explanations.
- `packages/domain/src/business-checks.ts`, `packages/db/src/business-checks.ts` — понятные checklist labels/help, отдельный тип динамического действия и сохранение self-report semantics.
- `packages/llm/src/automation-schema.ts` — требования к понятности автоматически создаваемых вопросов/описаний.
- `tests/offline/core.test.mjs` — проверки human-facing copy/status/manual review.
- `tests/layout/check_layout.py`, `tests/layout/fixtures.json` — 16 UI states, 5 widths, alignment/touch/overflow invariants.
- `tests/layout/check_review_layout.py` — responsive smoke для review UI.
- `tests/browser/regression.py` — UX regression и актуальные 0.9.13 labels/selectors.
- `docs/validation-0.9.13/` — core/syntax/layout/review/contrast отчёты и screenshots.
- `UX_AUDIT_0.9.13.md`, `CHANGELOG_0.9.13.md`, `CHANGED_FILES_0.9.13.md` — документация текущего pass.
- `README.md`, `ROADMAP.md`, `TEST_REPORT.md`, `SOURCE_MANIFEST.sha256` — актуализированы под 0.9.13.
- `package.json`, `package-lock.json` — версия 0.9.13.

`.env` и все файлы `seed/v1` сохранены побайтно.
