# Changed files 0.9.12

Основные изменения:

- `apps/web/src/App.tsx` — пользовательские тексты, структура профиля, подписи действий и источников.
- `apps/web/src/styles.css` — новый light UI и responsive layout.
- `apps/web/index.html` — theme color и подключение Manrope/Oswald с fallback.
- `compose.yaml` — SQL-based PostgreSQL readiness для clean start.
- `tests/browser/regression.py` — актуальные пользовательские подписи после UI pass.
- `tests/layout/fixtures.json` — обновлённые fixtures + экран профиля.
- `package.json`, `package-lock.json` — версия 0.9.12.
- `README.md`, `ROADMAP.md`, `TEST_REPORT.md`, `CHANGELOG_0.9.12.md` — актуальное состояние и проверки.

Не изменялись: рабочий `.env`, Core-7/seed и юридическая логика правил.
- `docs/validation-0.9.12/` — компактные отчёты offline core, TS/TSX syntax и Chromium layout.
- `SOURCE_MANIFEST.sha256` — пересобран для текущей 0.9.12; `.env` намеренно не публикуется в hash manifest.
