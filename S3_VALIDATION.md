# S3 validation — prepared regulatory dataset

Дата: 16.09.2026

Статус: **реализовано как воспроизводимый seed; финальная юридическая перепроверка перед публичной демонстрацией всё равно обязательна.**

## Что лежит в `seed/v1`

- 7 core rules для малого e-commerce;
- 6 связанных legal acts/source records;
- 5 profile fixtures;
- expected assessments;
- regression relation для изменения срока маркировки;
- manifest с версией набора.

Core rules:

1. `kkt_online_receipts_v1`;
2. `usn_vat_start_2026_v1`;
3. `usn_vat_threshold_during_2026_v1`;
4. `child_goods_marking_v1`;
5. `pd_consent_separate_v1`;
6. `distance_seller_identity_v1`;
7. `digital_ruble_acceptance_v1`.

## Технические свойства

- `(ruleId, version)` immutable;
- `seedHash` вычисляется из canonical JSON;
- повторный seed должен быть no-op;
- изменение уже существующей версии с другим hash приводит к `IMMUTABLE_RULE_VERSION_CONFLICT`;
- synthetic regression fixture не публикуется как отдельный правовой факт;
- rule engine не зависит от LLM.

## Корректировки, учтённые в seed

- `unknown` не превращается в `false`;
- KKT с `usesKkt=false` уходит в `needs_review`, а не в ложное `not_applicable`;
- у USN правил отдельно спрашивается совмещение режимов;
- дата превышения порога НДС вычисляет первое число следующего месяца;
- версия правила маркировки сохраняет старую историю и переносит актуальный срок;
- применимость (`verdict`) отделена от соответствия (`complianceState`).

## Acceptance после установки зависимостей

```bash
npm run db:migrate
npm run seed
npm run seed
npm test
```

Ожидается: второй seed не создаёт дубликатов, а контрольная матрица evaluator проходит без расхождений.
