# Hotfix 0.9.19.2

Исправляет неполную синхронизацию bot workspace на production-сервере после 0.9.19/0.9.19.1.

Изменения:
- `apps/bot/package.json`: добавлен существующий в полном релизе скрипт `test: vitest run`;
- `apps/bot/src/scenarios.test.ts`: возвращён regression test сценариев бота, отсутствовавший в server patch.

`.env`, миграции и production-данные не входят в архив и не изменяются.

После распаковки повторно выполнить:

```bash
bash scripts/acceptance.sh
```

Production запускать только после `ACCEPTANCE_EXIT=0`.
