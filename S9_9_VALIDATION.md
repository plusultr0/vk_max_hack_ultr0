# S9.9 — Validation

Версия: **0.9.9**. Это отчёт о выполненных действиях, а не декларация завершённой production-приёмки.

## Фактически выполнено здесь

| Проверка | Результат | Что это означает |
|---|---|---|
| Синтаксическая транспиляция TypeScript 5.8.3 | 85 TS/TSX-файлов, 0 syntax diagnostics | Синтаксис; не semantic typecheck |
| Проверка локальных import/export через TS AST | 245 импортов, 0 найденных ошибок | Локальные файлы/имена экспортов разрешаются |
| Исполнение существующих и новых unit-сценариев | 140 passed, 0 failed | Через описанный ниже Node.js adapter |
| Прежние unit-сценарии | 86 passed | Сохранённые тестовые тела S0–S9.8 |
| Новые unit-сценарии | 54 passed | Факты, периоды, таргетинг, automation, preview, runtime guards |
| `.env` | Совпадает с базовым ZIP побайтно | Значения не выводились и не менялись |
| Миграции 001–010 | Совпадают с базовым ZIP побайтно | Добавлена отдельная миграция 011 |
| Исходные файлы | Нет удалённых файлов исходного ZIP | Расширение имеющейся реализации |

### Как запускались unit-сценарии

В среде установлены Node.js 22.16.0 и TypeScript 5.8.3, но зависимостей проекта полностью нет. Доступ к npm registry не позволил завершить установку. Docker и PostgreSQL отсутствуют.

Для независимой проверки логики TS/TSX транспилированы настоящим TypeScript; тестовые тела исполнялись временным адаптером `describe/it/expect/vi` на основе `node:assert`. Использован **настоящий Zod 3.25.76** из установленной поставки Playwright. Локальные `@reg/*` ссылаются на код этого проекта. Для импорта pure DB helpers использован запретительный stub `pg`: любая попытка реального query/connect бросает ошибку.

**Это НЕ Vitest и НЕ замена PostgreSQL.** В отчёте не заявляется, что `npm test`, `npm run check` либо DB integration прошли. Временный адаптер, библиотечные копии и stub не включены в рабочие исходники и не используются приложением.

Машиночитаемый протокол: `docs/validation/S9_9_SANDBOX_TEST_RESULTS.json`, `S9_9_SYNTAX.json`, `S9_9_LOCAL_IMPORTS.json`.

## Что покрывают новые unit-сценарии

- безопасные ключи и запрет prototype traversal / произвольных свойств;
- strict definition schema, опции enum, числовые границы и календарные даты;
- различия null/false/0/пустого списка;
- month/quarter/year/YTD/as_of, смена календарного периода;
- измерение YTD и срок его актуальности;
- подтверждение исторического значения без перезаписи текущего режима;
- scopes/ownership при разрешении наблюдений;
- stricter rule freshness, missing и stale;
- conservative SQL для AND/OR, неизвестных данных, NOT и unsupported-операций;
- параметризация SQL и включение ранее затронутых компаний;
- новое динамическое поле → compilation → needs_info → ответ → applies/not_applicable;
- отсутствие лишних вопросов при доказанном исключении;
- сохранение completed identity при повторном подтверждении;
- будущие/отменённые версии и отсутствие автоматического вывода о нарушении;
- автоматический compiler, конфликт definitions, неизменность server-owned evidence;
- fallback для неполного контекста, изменения машинной ревизии и противоречий;
- реальный вызов extraction-алгоритма с локальным stub провайдера: один успешный вызов на документ, без company data;
- ограничения размера/глубины JSON;
- operator definition revisions, динамический hypothetical preview;
- запрет перенаправления официального HTTPS-источника на посторонний сайт.

## Подготовлено, но НЕ запущено

`packages/db/src/autonomous.integration.ts` — изолированный PostgreSQL acceptance-сценарий. Он создаёт уникальную схему `s99_test_<uuid>` и удаляет только её. Нужны явные `ALLOW_INTEGRATION_TESTS=true` и `DATABASE_URL` тестовой базы.

Сценарий проверяет:

1. миграции 001–010, старый профиль, повторяемую 011 без потери данных;
2. staging тестового документа → extraction job → ответ провайдера → новый fact;
3. автоматическую ревизию/публикацию и durable outbox;
4. cohort из известных, неизвестных, устаревших и заведомо неподходящих компаний;
5. персональные карточки, действия, вопросы и подтверждение;
6. ownership, optimistic concurrency/idempotency;
7. откат ответа при принудительной ошибке записи assessment;
8. переиспользование одного факта другим правилом;
9. baseline нормы 2012 года для нового пользователя;
10. feed и запрет изменения истории definitions/observations.

**Документ и правило в этом тесте вымышленные.** URL используется как входной fixture для проверки trusted-host логики, сетевого вызова к нему нет. Этот материал не является законом, не идёт в seed и не должен публиковаться в рабочей БД. GigaChat/MAX в этом тесте не вызываются.

Также НЕ выполнены: настоящий `tsc` с полными typings, Vitest runner, Vite build, миграция на копии рабочей БД, existing PostgreSQL integration suites, Docker build/run, browser/mobile QA, GigaChat live extraction новой схемы и MAX live.

## Порядок проверки на Windows

### 1. Сохранить рабочую установку

Сохранить копию текущей папки проекта и резервную копию PostgreSQL. Содержимое корня ZIP копировать **в ту же рабочую папку проекта**, где ранее запускался Compose. Не менять Compose project name/volume location случайным запуском из другой папки.

Файл `.env` в ZIP — исходный рабочий файл, совпадающий с предыдущей версией. Не выполнять замену `.env` из `.env.example`.

### 2. Проверка исходников

В корне проекта:

```powershell
npm ci
npm run check
```

`check` запускает backend typecheck, настоящий Vitest и web build. Это первый обязательный local gate. Ошибки этих команд не игнорировать.

Для проверки внутри уже собранного образа можно использовать:

```powershell
docker compose build api
docker compose run --rm --no-deps api npm run check
```

Эта команда не запускает worker и не запрашивает GigaChat.

### 3. PostgreSQL acceptance только на тестовой БД

Создать отдельную тестовую БД. Не использовать рабочую БД для общей команды `test:integration`: исторические integration-скрипты имеют собственные правила очистки.

Пример запуска нового изолированного S9.9-сценария после установки зависимостей:

```powershell
$oldDb = $env:DATABASE_URL
$oldOptIn = $env:ALLOW_INTEGRATION_TESTS
$oldNodeEnv = $env:NODE_ENV
try {
    $env:DATABASE_URL = "postgresql://test_user:test_password@localhost:5432/regcontrol_test"
    $env:ALLOW_INTEGRATION_TESTS = "true"
    $env:NODE_ENV = "test"
    npm run test:s99
    if ($LASTEXITCODE -ne 0) { throw "S9.9 integration failed" }
} finally {
    $env:DATABASE_URL = $oldDb
    $env:ALLOW_INTEGRATION_TESTS = $oldOptIn
    $env:NODE_ENV = $oldNodeEnv
}
```

Показанные test_user/test_password — заглушки для отдельной локальной тестовой БД, не рабочие credentials.

### 4. Обновление рабочей копии после local gates

```powershell
cd "H:\max-regulatory-control-through-s9\project"
docker compose down
docker compose up -d --build
docker compose ps
curl.exe http://localhost:3000/health
```

Не использовать `down -v`. Миграции должны завершиться до seed/api/worker.
Health API должен сообщить `s9.9-autonomous-regulatory-engine`.

**В этой версии automation включена по умолчанию.** После старта worker обрабатывает уже полученные подходящие документы и может обращаться к настроенному LLM, публиковать прошедшие gates правила, ставить пересчёты и уведомления. При изолированной приёмке запускать отдельное тестовое окружение либо переопределять новые флаги через env процесса/Compose override, не переписывая сохранённый рабочий `.env`.

### 5. Живая проверка

Открыть приложение и проверить старый профиль, историю, «Изменения», «Проверка бизнеса», missing/stale карточку, один ответ для нескольких правил и сохранение статуса действий. Затем запустить extraction реального официального документа. Убедиться, что опубликованный результат действительно подтверждается источником; неоднозначный материал должен оставаться в review.

## Итог приёмки

S9.9 **реализован в исходниках и частично проверен в sandbox**. Обязательный полный end-to-end acceptance ещё не подтверждён. Следующий gate — локальный `npm run check` и PostgreSQL integration, затем реальный документ и MAX.

## Дополнение: попытки стандартных команд в этой среде

Стандартные команды были фактически запущены, но не завершили проверку проекта из-за отсутствующих зависимостей:

- `npm run typecheck`: exit 2, TS2688 — отсутствуют type definitions.
- `npm test`: exit 127 — `vitest: not found`.
- `npm run build:web`: exit 1 — отсутствует `vite/client`.

Это не положительный результат typecheck или сборки. Логи лежат в `docs/validation/S9_9_*_ATTEMPT.log`, сводка — `S9_9_STANDARD_CHECK_ATTEMPTS.json`. После `npm ci` в окружении команды эти проверки нужно выполнить заново; дополнительные ошибки кода пока исключить нельзя.
