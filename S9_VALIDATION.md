# S9 validation — official-source ingestion, versioning and resilience

Дата: 16.09.2026

Статус: **основной S9 pipeline реализован; live ingestion и внешние LLM/MAX вызовы ожидают сеть/credentials.**

## 1. Автоматический ingestion официального источника

Создан `@reg/ingestion` и ежедневная worker job для открытого набора `publication.pravo.gov.ru`.

Pipeline:

```text
official open-data landing
  -> resolve CSV URL
  -> fetch CSV
  -> parse/normalize rows
  -> hash raw row
  -> relevance scoring for pilot
  -> source_documents staging
  -> human/admin review pipeline
```

Данные из ingestion **не становятся legal_rule автоматически**.

## 2. Staging и freshness

Миграция `006_ingestion.sql` добавляет:

- `ingestion_runs`;
- `source_documents`;
- `legal_rule_candidates`.

Для source document сохраняются:

- официальный URL;
- URL dataset;
- hash;
- first/last seen;
- дата публикации;
- relevance score/terms;
- review state.

Если уже reviewed source row приходит с **изменившимся raw hash**, предыдущий `approved/rejected` state не замораживается навсегда: документ возвращается в текущий relevance-driven review state и требует повторного просмотра.

## 3. LLM не является источником истины

Admin endpoint extraction требует передать **проверенный официальный текст/фрагмент**. Одних metadata из CSV недостаточно.

```text
source document
  -> verified source text
  -> GigaChat/DeepSeek/mock extraction draft
  -> Zod validation
  -> legal_rule_candidate (pending)
  -> explicit human approval
  -> immutable approved legal_rule
  -> deterministic reassessment
```

LLM draft не публикуется сам.

## 4. Publication / rule versioning

`POST /admin/candidates/:id/publish`:

- валидирует approved rule доменной схемой;
- вычисляет canonical `seedHash`;
- не позволяет молча изменить существующий `(ruleId, version)`;
- может записать relation `amends / supersedes / extends / cancels`;
- создаёт missing `legal_act` из staged official source;
- переводит candidate/source в approved;
- запускает reassessment этой версии для всех компаний с confirmed profile.

При reassessment:

- старые assessments сохраняются;
- completed actions сохраняются;
- старые незавершённые actions получают `review_required=true`;
- новый assessment ссылается на предыдущий;
- для новой релевантной версии планируется MAX `regulatory_update` notification.

## 5. Failure / retry behavior

- ingestion работает отдельной `pg-boss` queue;
- queue имеет retry/backoff;
- неуспешный ingestion run фиксируется как `failed` с ошибкой;
- failure внешнего источника не удаляет существующие verified rules и assessments;
- пользователю продолжают показываться последние проверенные карточки и `checkedAt`;
- notification dispatcher хранит durable state и имеет retry/terminal handling;
- stale notification claims восстанавливаются.

## 6. Admin/API поверхность

Реализовано:

```text
POST /admin/ingest
GET  /admin/ingestion-runs
GET  /admin/source-documents
POST /admin/source-documents/:id/extract
GET  /admin/candidates
POST /admin/candidates/:id/reject
POST /admin/candidates/:id/publish
```

Все admin endpoints защищены `X-Admin-Token`.

## 7. Worker

- ежедневный `pravo-ingest` запланирован на 05:15 Europe/Moscow;
- notification dispatcher запускается периодически;
- отдельная команда `npm run ingest:once` позволяет smoke-test ingestion вручную.

## 8. Тесты/проверки

Добавлен `packages/ingestion/src/ingestion.test.ts`:

- semicolon + quoted CSV;
- разрешение CSV URL из landing page;
- нормализация минимального dataset row;
- relevance scoring.

В текущем runtime npm registry недоступен, поэтому Vitest физически не запущен. Выполнены:

- syntax-only TypeScript/TSX check — OK;
- parse всех JSON — OK;
- parse `compose.yaml` — OK;
- deterministic seed sanity checks ранее — OK.

## Live acceptance для S9

После установки dependencies и настройки БД/сети:

1. `npm run db:migrate && npm run seed`;
2. `npm run ingest:once`;
3. проверить `ingestion_runs` и `source_documents`;
4. выбрать candidate source;
5. передать проверенный официальный fragment в `/extract`;
6. убедиться, что draft остаётся `pending`;
7. вручную approve новую rule version;
8. проверить, что старые assessments/actions не удалились;
9. проверить новый assessment + `review_required` на старом open action;
10. с MAX token проверить ровно одно regulatory-update уведомление и deep link.
