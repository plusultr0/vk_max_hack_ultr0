# Hotfix 0.9.19.5

Исправляет повторно подтвержденный Docker acceptance дефект восстановления `regulatory_update` после частичного сбоя.

## Симптом

После удаления потерянного `regulatory_update` intent повторный `recalculateCompanyAtomic(companyId, 'regulatory_update')` оставлял количество уведомлений на 4 вместо прежних 5, хотя assessment и action уже существовали.

## Исправление

`packages/db/src/runtime.ts` теперь формирует список ожидаемых regulatory intent по точной тройке `ruleId + ruleVersion + calculationKey`, вычисленной текущим пересчетом. После материализации assessment он находит persisted assessment по этой точной идентичности и выполняет идемпотентный UPSERT уведомления. Восстановление больше не зависит от `currentIds` и одинаково работает для нового и уже существующего assessment.

Dedupe key остается прежним. Отмененное, но снова актуальное уведомление возвращается в `pending`; sent/failed строки не клонируются.

`.env`, миграций, seed и production-данных в hotfix нет.

## Локальные проверки

- `node scripts/check-syntax.mjs`: 108 TS/TSX, 0 syntax errors.
- `node scripts/test-core-offline.mjs`: 229/229.
- `node scripts/test-chatbot-offline.mjs`: 10/10.
- Полный PostgreSQL lifecycle regression должен быть подтвержден серверным `bash scripts/acceptance.sh`.
