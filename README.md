# MAX Regulatory Control — S9.5A/B

Текущая версия: **0.9.5**. Добавлена серверная основа human review: отдельные неизменяемые ревизии, решения по каждому исходному элементу, типизированный компилятор в DSL и предпросмотр без публикации. API, запуск и ограничения: [S9_5_IMPLEMENTATION.md](S9_5_IMPLEMENTATION.md). Проверки: [S9_5_VALIDATION.md](S9_5_VALIDATION.md).

S9.4 сохранён: extraction фиксирует снимок источника и формирует точные цитаты на сервере. Подробности: [S9_4_IMPLEMENTATION.md](S9_4_IMPLEMENTATION.md). Новый review пока не имеет UI и не публикует пакет правил; это следующие блоки.

`npm run check` включает backend typecheck, unit tests и web build. Зависимости зафиксированы в `package-lock.json`, Docker использует `npm ci`. Для существующей установки сохраняйте её `.env` и PostgreSQL volume. Миграции 007/008 добавляют снимки и ревизии без удаления прежних candidates.

Регуляторный контроль для малого e-commerce внутри MAX: профиль компании → применимость нормативного изменения → объяснение/источник → конкретные действия → выполнение → уведомления → история версий.

Репозиторий продолжает технический путь **S0–S9.5A/B** из development plan. Это hackathon MVP, а не юридическая консультационная система: автоматический результат строится только по утверждённым формализованным правилам, а неоднозначные случаи уходят в `needs_info` / `needs_review`.

## Главное отличие продукта

Это не лента правовых новостей и не «спросить LLM о законе».

```text
official source
  -> ingestion/staging
  -> LLM extraction draft (optional)
  -> human verification
  -> immutable approved legal rule
  -> deterministic rule engine
  -> company-specific impact
  -> action / deadline / status
  -> MAX notification + deep link
```

LLM не участвует в исполнении 7 pilot rules и не может автоматически опубликовать правовой вывод.

---

## Статус спринтов

| Stage | Реализовано | Live acceptance |
|---|---|---|
| S0 | monorepo, PostgreSQL, migrations, domain DSL/evaluator, seed, Docker skeleton | dependency/Docker run pending |
| S1 | MAX webhook, Bridge shell, WebAppData validation, signed session, mini-app deep links | real bot token + HTTPS pending |
| S2 | onboarding, draft, `answeredFields`, immutable profile versions | DB/browser smoke pending |
| S3 | 7 pilot rules + fixtures + regression seed | final legal recheck before demo |
| S4 | mock/GigaChat/DeepSeek extraction adapter + structured schema | provider credentials smoke pending |
| S5 | company-specific applicability, context questions, reassessment | DB/API smoke pending |
| S6 | action materialization/status/audit/history preservation | DB/API smoke pending |
| S7 | durable MAX notifications, retries, reminders, deep links | live MAX delivery pending |
| S8 | responsive mini-app, filters, typed context inputs, loading/error/empty/history | mobile/web MAX QA pending |
| S9 | official-source ingestion staging, candidates, manual publication, reassessment | implemented |
| S9.1 | live GigaChat OAuth/TLS/structured extraction | smoke passed on team Windows/Docker machine |
| S9.2 | resilient multi-source official ingestion + retry + manual official fallback | live multi-source smoke pending |

Подробности: `S0_VALIDATION.md` … `S9_VALIDATION.md`.

---

## Архитектура

```text
apps/
  web/        React/Vite mini-app
  api/        Fastify REST API + MAX auth + admin ingestion API
  bot/        MAX webhook + welcome/open-app flow
  worker/     pg-boss: notifications + scheduled official-source ingestion

packages/
  domain/     Zod schemas + tri-state rule engine
  db/         PostgreSQL repositories, migrations, seed, versioning/audit
  max/        WebAppData validation, signed session, MAX API client, deep links
  llm/        mock / GigaChat / DeepSeek provider adapter
  ingestion/  resilient official-source adapters + normalization + relevance staging
  config/     typed env configuration

seed/v1/
  legal-acts.json
  legal-rules.json
  profile-fixtures.json
  expected-assessments.json
  regulatory-relations.json
  manifest.json
```

### State model

- `verdict`: `applies | not_applicable | needs_info` — относится ли правило;
- `reviewState`: `auto | reviewed | needs_review` — можно ли показывать вывод как окончательный;
- `complianceState`: `unknown | compliant | action_required | not_assessed` — соответствует ли компания проверяемой части требования;
- `executionStatus`: `open | in_progress | completed | dismissed` — состояние action item.

**`applies` не означает нарушение.**

`unknown` не равен `false`; evaluator использует tri-state `true / false / unknown` и short-circuit.

---

## Pilot rules

Core seed содержит 7 карточек:

1. `kkt_online_receipts_v1` — реквизиты чека при интернет-расчёте;
2. `usn_vat_start_2026_v1` — НДС на УСН с 01.01.2026 по доходу 2025;
3. `usn_vat_threshold_during_2026_v1` — превышение порога в течение 2026;
4. `child_goods_marking_v1` — детские товары / маркировка / новая версия срока;
5. `pd_consent_separate_v1` — отдельное согласие на обработку ПДн;
6. `distance_seller_identity_v1` — сведения дистанционного продавца;
7. `digital_ruble_acceptance_v1` — первый этап обязанности принимать цифровые рубли.

Перед финальной демонстрацией источники/редакции этих карточек нужно ещё раз проверить на дату сдачи.

---

# Запуск

## Требования

- Node.js 22+
- npm
- PostgreSQL 16
- Docker + Docker Compose для reproducible run (если используете Docker path)

### 1. Установить зависимости

```bash
npm install
```

После первого успешного install **закоммитьте `package-lock.json`**. В текущем архиве его нет, потому что среда сборки не имеет рабочего доступа к npm registry.

### 2. Настроить env

```bash
cp .env.example .env
```

Для локальной работы без MAX достаточно:

```env
DATABASE_URL=postgresql://regcontrol:regcontrol@localhost:5432/regcontrol
SESSION_SECRET=replace-with-long-random-value
ALLOW_DEV_AUTH=true
ADMIN_TOKEN=replace-with-admin-token
```

### 3. Миграции и seed

```bash
npm run db:migrate
npm run seed
```

Повторный `npm run seed` должен быть idempotent. Уже существующий `(ruleId, version)` нельзя незаметно заменить другим содержимым.

### 4. Запуск dev

В разных терминалах:

```bash
npm run dev:api
npm run dev:web
npm run dev:bot
npm run dev:worker
```

По умолчанию:

- web: `http://localhost:5173`
- API: `http://localhost:3000`
- bot webhook service: `http://localhost:3001`

В browser без MAX mini-app использует `/auth/dev`, если `ALLOW_DEV_AUTH=true` и `NODE_ENV != production`.

---

# Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

Compose поднимает:

```text
postgres -> migrate -> seed -> api / web / bot / worker
```

Для финальной сдачи после установки dependencies нужно проверить build time и reproducibility на чистой машине.

---

# MAX integration — S1/S7

Необходимые env:

```env
MAX_BOT_TOKEN=
MAX_BOT_USERNAME=
MAX_WEBHOOK_SECRET=
MAX_WEBHOOK_URL=https://example.ru/max/webhook
MAX_MINI_APP_URL=https://example.ru/app
```

Production flow:

```text
/start / bot_started
  -> bot sends open-app link
  -> MAX mini-app loads WebAppData
  -> POST /auth/max
  -> server validates signature + auth age
  -> signed app session
  -> GET /company/profile + /impacts
```

Регистрация webhook/subscription:

```bash
npm run bot:subscribe
```

Публичный HTTPS и реальный bot token нужны только для live acceptance; core logic работает без них через dev auth.

---

# Profile / impacts API

Основные user endpoints:

```text
POST /auth/max
POST /auth/dev                # only non-production if enabled
GET  /auth/me

GET  /company/profile
PUT  /company/profile
POST /company/profile/confirm
GET  /company/profile/history

GET  /impacts
GET  /impacts/:id
POST /impacts/:id/answer
POST /impacts/:id/feedback

PATCH /actions/:id
GET   /notifications
GET   /audit
GET   /health
```

### Context questions

Backend отдаёт не только техническое поле, но и тип ввода:

```text
boolean
select
multi_select
number
date
string_list
text
```

Это предотвращает ввод внутренних enum-значений вручную и уменьшает invalid profile updates.

---

# LLM extraction — S4

Доступные providers:

```env
LLM_PROVIDER=mock       # default/offline
LLM_PROVIDER=gigachat
LLM_PROVIDER=deepseek
```

Smoke:

```bash
npm run llm:smoke
```

LLM получает только переданный официальный текст и создаёт **draft**. Draft проходит Zod validation и остаётся candidate до ручного approval.

---

# Official source ingestion — S9

Разовый запуск:

```bash
npm run ingest:once
```

Worker также планирует `pravo-ingest` ежедневно.

Pipeline intentionally staged:

1. fetch official open-data metadata;
2. normalize + hash;
3. score pilot relevance;
4. store `source_documents`;
5. admin selects candidate;
6. admin passes a verified official source fragment to extraction;
7. LLM creates pending candidate;
8. reviewer supplies an approved `legal_rule`;
9. immutable rule is published;
10. affected companies are recalculated;
11. open actions from previous assessment can become `review_required`;
12. applicable regulatory update schedules one deduplicated MAX notification.

Admin API (requires `X-Admin-Token`):

```text
GET  /admin/ingestion-sources
POST /admin/ingest
GET  /admin/ingestion-runs
GET  /admin/source-documents
POST /admin/source-documents/manual
POST /admin/source-documents/:id/extract
GET  /admin/candidates
POST /admin/candidates/:id/reject
POST /admin/candidates/:id/publish
```

Source outage does not remove current verified rules; the user still sees the last approved rule and its `checkedAt` date.

---

## Resilient official-source ingestion — S9.2

The ingestion worker no longer treats `publication.pravo.gov.ru` as a single point of failure. Each source gets its own `ingestion_run`; enabled sources are fetched in parallel, failures are isolated, and the overall run returns `partial` when at least one official source succeeds.

Configured sources by default:

- `publication.pravo.gov.ru` — primary official publication/open-data feed;
- `government.ru/docs/all/` — official Government acts index;
- `nalog.gov.ru/new2026/` — official FNS tax-changes page for the 2026 pilot;
- `cbr.ru/na/` — official Bank of Russia legal-acts index;
- `cbr.ru/PSystem/dr/...` — official Bank of Russia digital-ruble business guidance used by the pilot;
- `zpp.rospotrebnadzor.ru/news/federal/` — official federal consumer-protection publications.

These sources are **not treated as equivalent mirrors**. Their provenance is preserved in `source_documents.source`, and every LLM draft still requires human review before an immutable `legal_rule` can be published.

Transient fetch failures use bounded retries (`INGESTION_RETRIES`, default `2`). A blocked primary portal therefore does not stop FNS/CBR/Government/Rospotrebnadzor ingestion.

For a last-resort operator workflow there is also `POST /admin/source-documents/manual`: an admin may stage verified text copied/downloaded from an official URL. Manual records are marked `manual.<hostname>` and still go through the same candidate/review/publication path.

`POST /admin/source-documents/:id/extract` can now use, in order: explicitly supplied `sourceText`, text already staged from an official page, or an HTML fetch of the document's `official_url`. It never auto-publishes the result.

# Notifications — S7

Notification DB state is durable and deduplicated.

Implemented types:

- `regulatory_update`;
- `deadline_reminder`.

Properties:

- `FOR UPDATE SKIP LOCKED` claim;
- retry after failures;
- terminal state after 5 attempts;
- stale `sending` recovery;
- no external notification rows for `dev-*` users;
- deep link `startapp=impact_<ruleId>`;
- onboarding/profile changes do not spam one message per existing rule.

---

# Проверки

После `npm install`:

```bash
npm test
npm run build:web
npm run db:migrate
npm run seed
npm run seed
```

Дополнительно:

```bash
npm run llm:smoke
npm run ingest:once
```

## Что уже проверено в среде сборки

- TypeScript/TSX syntax parse через `tsc --noCheck`;
- parse всех JSON;
- parse `compose.yaml`;
- отдельные deterministic sanity checks seed/evaluator;
- структура migrations и cumulative source tree.

## Что НЕ проверено здесь

Из-за отсутствия нормального доступа к npm registry / Docker / внешних credentials в этой среде не заявляем как пройденные:

- `npm install`;
- Vitest runtime suite;
- Vite production build;
- реальный PostgreSQL migration/seed run;
- `docker compose up --build`;
- live MAX webhook/WebAppData/message delivery;
- live GigaChat/DeepSeek calls;
- live official-source ingestion.

Это нужно прогнать на машине команды/VPS. Если там обнаружится несовместимость версии dependency или внешнего API, исправляем после smoke-test.

---

# Security boundaries

- MAX, LLM и admin secrets — server-side env only;
- `/auth/dev` отсутствует в production;
- WebAppData проверяется server-side;
- API ownership scoped by company session;
- rule candidates не публикуются автоматически;
- internal business documents не отправляются в LLM в текущем MVP;
- logs/seed не должны содержать credentials;
- confirmed profile/rule versions immutable;
- source failure не превращается в «новое юридическое состояние».

---

# Следующий этап — S10

S10 — submission hardening:

- clean install/build на реальной машине;
- lockfile;
- public HTTPS deploy;
- MAX token + webhook + mini-app attach;
- live end-to-end acceptance mobile/web;
- final README/test script;
- `.env.example`/secrets audit;
- Docker build-time check;
- commit hash/archive checksum;
- презентация PDF и demo script.

## Live GigaChat stage (post-S9)

The LLM layer is intentionally used only for **draft extraction from verified source text**. Applicability to a company remains deterministic and is never delegated to the model.

Current GigaChat integration uses OAuth `POST /api/v2/oauth`, the `https://api.giga.chat/v1` REST base URL and structured output with `response_format.type=json_schema`.

Set in `.env`:

```env
LLM_PROVIDER=gigachat
LLM_MODEL=GigaChat-2-Pro
LLM_TIMEOUT_MS=45000
GIGACHAT_AUTH_KEY=<authorization-key-from-GigaChat-Studio>
GIGACHAT_SCOPE=GIGACHAT_API_PERS
```

Do not commit the authorization key. After changing `.env`, recreate the API/worker containers:

```bash
docker compose up -d --force-recreate api worker
```

Run a live smoke test entirely inside Docker:

```bash
docker compose run --rm worker npm run llm:smoke
```

Or check through the protected admin API:

```bash
curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:3000/admin/llm/status
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:3000/admin/llm/smoke
```

GigaChat API requires the Russian Ministry of Digital Development trust chain. If Node reports a certificate validation error, install the official CA certificates and expose the PEM bundle to the Node process via `NODE_EXTRA_CA_CERTS`. Do not disable TLS verification in production.

## S9.3 — grounded LLM extraction quality gate

The live GigaChat extraction path now rejects ungrounded rule drafts before they become review candidates:

- every condition, exception and action must reference at least one `evidenceIndexes` entry;
- every referenced evidence index must exist;
- every evidence quote must occur verbatim in the staged official source text after whitespace normalization;
- `operatorHint` is constrained to machine-like operators (`eq`, `gt`, `gte`, `lt`, `lte`, `in`, `exists`, date operators, `other`);
- if the first structured response fails the quality gate, the adapter performs one grounded repair pass and validates again;
- if the repaired result still fails, extraction stops with `EXTRACTION_QUALITY_GATE_FAILED` and no candidate is stored;
- sources with multiple dated phases are instructed to keep the earliest phase in the single-rule draft and explicitly preserve later phases in `uncertaintyNotes` for separate review/rules.

New prompt version stored with candidates: `reg-extract-v3-grounded-repair`.
