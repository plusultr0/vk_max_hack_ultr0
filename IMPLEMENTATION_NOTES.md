# Текущие изменения S9.9

См. `S9_9_IMPLEMENTATION.md` и `S9_9_VALIDATION.md`. Старые записи ниже сохранены как история решений. Обязательный human review теперь заменён машинными gates для поддерживаемых случаев; review остаётся fallback. Профили, snapshots и история не удалялись. Рабочий `.env` не изменён.

---

# Implementation notes — cumulative through S9

Дата: 16.09.2026

Этот файл фиксирует технические решения/корректировки, которые важно не потерять при дальнейшем рефакторинге.

## 1. KKT: correction to spec 06

В исходном JSON-примере KKT applicability требовала `usesKkt=true`, но acceptance одновременно требовал `internetSettlement=true + usesKkt=false -> needs_review`.

Runtime seed использует `known usesKkt` в scope, а значение `false` ловится manual-review gate. Это делает acceptance достижимым и не расширяет юридический смысл карточки.

## 2. Required unknown fact vs `exists`

Для факта, который **нужно знать**, DSL использует `known`, а не `exists`.

- missing/null -> `unknown` + `missingFields`;
- `false` -> известный `false`;
- `0` -> известный `0`;
- `[]` -> известный пустой список.

Иначе обязательное неизвестное поле могло ошибочно превратиться в `not_applicable`.

## 3. Profile versions are immutable

Base onboarding работает через draft. После confirm создаётся новая version. Context question также создаёт новую confirmed version; старый profile/assessment сохраняется.

## 4. Applies != violation

Не смешивать:

```text
verdict
reviewState
complianceState
executionStatus
```

UI может показывать `applies + compliant`, `applies + action_required` или `applies + unknown`.

## 5. LLM boundary

LLM не запускается внутри deterministic evaluator.

Допустимый pipeline:

```text
official source -> extraction draft -> schema validation -> review -> approved rule -> evaluator
```

Не добавлять auto-publish LLM output без отдельного продуктового решения.

## 6. Ingestion changed-row behavior

Если row из официального open dataset с тем же external id меняет `raw_hash`, предыдущий `approved/rejected` source review не сохраняется автоматически. Он возвращается в актуальный relevance-driven review state, чтобы изменившийся источник был просмотрен заново.

## 7. Regulatory update history

При новой approved rule version:

- предыдущие assessments не удалять;
- completed action не отменять;
- old open/in-progress action -> `review_required=true`;
- new assessment references previous;
- new applicable rule version может создать deduplicated `regulatory_update` notification.

## 8. Typed context questions

Backend hydration возвращает input metadata для известных profile fields. Не возвращать только raw field name, иначе enum/date/array ответы легко ломают Zod profile parsing.

## 9. Reminder timezone

Regulatory deadline — calendar date. MVP reminder планируется на 09:00 `+03:00` (Moscow) за 3 дня, либо immediately if deadline ближе. При масштабировании на регионы timezone нужно сделать настройкой компании.

## 10. External runtime is still pending

В текущей environment не удалось получить npm dependencies. Поэтому syntax/static checks не заменяют real runtime acceptance. Первое действие на машине команды — clean `npm install`, lockfile, tests, migrations, build, Docker, затем live MAX.

## S9.2 resilient source policy

`publication.pravo.gov.ru` is no longer a single point of failure. The worker ingests enabled official sources independently and records a separate `ingestion_runs` row for each. Government/FNS/Bank of Russia/Rospotrebnadzor sources are supplements/fallbacks with preserved provenance, not equivalent mirrors. A partial source outage must not mutate or delete approved rules. Manual official-source staging is available as a last-resort operator path and still requires candidate review before publication.

## S9.3 — extraction grounding correction

The first live Bank of Russia extraction proved that JSON-schema shape alone is not enough: GigaChat returned valid `evidence` items while leaving `evidenceIndexes` empty on conditions, exceptions and actions. S9.3 adds a deterministic post-LLM quality gate and a single repair pass. A draft is never staged as a candidate unless all evidence links resolve and every quoted fragment is grounded verbatim in the supplied official source text.
