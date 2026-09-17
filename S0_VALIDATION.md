# S0 validation report

Дата: 16.09.2026

## Что проверено в текущей среде

- JSON seed успешно разобран: 6 legal acts, 7 legal rules, 5 profile fixtures.
- YAML `compose.yaml` успешно разобран PyYAML; определены сервисы `postgres`, `migrate`, `seed`, `api`, `web`, `bot`, `worker`.
- Core TypeScript-файлы evaluator/conditions/effective date транскомпилированы системным TypeScript 5.8.3.
- Выполнен независимый smoke-run детерминированного evaluator на seed-данных.
- Пройдены 10 smoke-проверок:
  1. KKT applies;
  2. KKT `usesKkt=false` -> `needs_review`;
  3. USN start above threshold;
  4. new USN company -> not applicable to start-of-year card;
  5. USN current-year effective date -> next month;
  6. marking supported code -> applies;
  7. PD consent -> `action_required`;
  8. distance seller identity -> `action_required`;
  9. digital ruble unknown bank -> `needs_info`;
  10. digital ruble low-revenue short-circuit -> `not_applicable` without asking bank.

## Что нельзя было проверить здесь

В runtime-среде нет DNS-доступа к `registry.npmjs.org`, поэтому внешние npm-пакеты установить невозможно. Из-за этого здесь не выполнены:

- `npm install` до конца;
- полноценный `npm test` через Vitest;
- `npm run build:web` через Vite/React;
- генерация `package-lock.json`.

Также Docker CLI в текущей среде отсутствует, поэтому `docker compose up --build` здесь не запускался. Сам YAML синтаксически проверен.

## Что выполнить на машине команды

```bash
npm install
npm test
npm run build:web
cp .env.example .env
docker compose up --build
```

После успешного `npm install` необходимо закоммитить сгенерированный `package-lock.json`.

## Известная осознанная корректировка

См. `IMPLEMENTATION_NOTES.md`: seed KKT скорректирован относительно буквального примера из спецификации 06, потому что сам пример противоречил acceptance-сценарию `usesKkt=false -> needs_review`. Исправление не расширяет правовой смысл карточки и сделано явно.
