# 0.9.16 — regulatory feed completeness

## What changed

- Fixed the meaning of the `new` feed filter: it now uses the timestamp when a rule was added to the service, not the publication date of the underlying legal act.
- Seed-installed rules now have a real `addedAt` via `legal_rules.created_at`; publication-pipeline rules keep `review_publications.created_at`.
- Renamed the UI option to `Добавлены в сервис за последние 90 дней` to avoid implying that the law itself was necessarily published during that period.
- The feed card now shows both the service-addition date and, when available, the official publication date.
- `new` and `upcoming` are catalog/timeline filters, so they can show a rule even when the current company is `not_applicable`; the card still clearly shows the personal verdict. `relevant` remains personalized and excludes `not_applicable`.
- MAX bot change summaries prefer the service-addition timestamp for the same semantics.

No legal dates were fabricated and no existing immutable legal-rule version was changed.
