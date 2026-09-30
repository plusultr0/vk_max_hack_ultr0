# Hotfix 0.9.19.4

Исправляет найденный полным Docker acceptance дефект повторного regulatory recalculation.

## Симптом

`packages/db/src/lifecycle.integration.ts` удаляет сохраненный `regulatory_update` intent для уже существующего актуального assessment, затем повторяет `recalculateCompanyAtomic(companyId, 'regulatory_update')`. До исправления assessment/actions оставались идемпотентными, но отсутствующее уведомление не восстанавливалось: ожидалось 5 notification rows, оставалось 4.

## Исправление

`packages/db/src/runtime.ts` теперь восстанавливает regulatory notification intents из уже сохраненных текущих assessment после расчета. Источником служат `currentIds` и persisted `impact_assessments`, поэтому повторный запуск одинаково работает для нового и уже существующего assessment. Dedupe key прежний, существующие sent intents не дублируются, cancelled intent можно безопасно вернуть в pending при актуальном regulatory update.

`.env`, миграции, seed и production данные этот hotfix не содержит.

## Проверено в среде подготовки

- `node scripts/check-syntax.mjs`: 108 TS/TSX, 0 syntax errors.
- `node scripts/test-core-offline.mjs`: 229/229.
- `node scripts/test-chatbot-offline.mjs`: 10/10.
- Полный PostgreSQL lifecycle regression должен быть повторно подтвержден командой `bash scripts/acceptance.sh` на сервере, где уже доступен Docker/PostgreSQL acceptance environment.
