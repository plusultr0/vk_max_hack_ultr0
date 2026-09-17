# S9.2 — resilient multi-source official ingestion

## Goal

Remove `publication.pravo.gov.ru` as a single point of failure without weakening provenance or allowing LLM auto-publication.

## Source policy

Priority / role:

1. `publication.pravo.gov.ru` — primary official publication/open-data source.
2. `government.ru` — official Government document index.
3. `nalog.gov.ru` — official FNS regulatory/tax-change source for pilot scope.
4. `cbr.ru` — official Bank of Russia legal-acts source.
5. `cbr.ru.digital-ruble` — official Bank of Russia digital-ruble business guidance for the pilot.
6. `zpp.rospotrebnadzor.ru` — official federal consumer-protection source.
7. manual official fallback — verified text + official URL submitted by an admin.

These are independent sources, not interchangeable mirrors. The source hostname and URL remain attached to every staged document.

## Failure behavior

- Each source receives its own `ingestion_runs` row and enabled sources are fetched in parallel.
- Network/TLS/HTTP/parser failure in one source does not abort the remaining sources.
- `npm run ingest:once` returns `status=partial` if at least one source succeeds and at least one fails.
- It fails only when every enabled source fails.
- Approved legal rules are not deleted or mutated when an ingestion source is unavailable.
- Bounded fetch retries are controlled by `INGESTION_RETRIES` (default 2).

## Extraction behavior

For `POST /admin/source-documents/:id/extract`, source text is resolved in this order:

1. explicit admin `sourceText`;
2. official page text captured during staging;
3. a fresh HTML/text fetch from the staged `official_url`.

The LLM output remains a `legal_rule_candidate`. Human review is still required before publication.

## Manual official fallback

`POST /admin/source-documents/manual` requires:

- `title`;
- `officialUrl`;
- `sourceText`;

Optional: `issuer`, `number`, `publicationDate`.

The record is staged under `manual.<hostname>` and continues through the same relevance -> extraction -> candidate -> review -> publish pipeline.

## Acceptance checklist

1. With `publication.pravo.gov.ru` unavailable, run `npm run ingest:once`.
2. At least one fallback source succeeds and overall status is `partial`.
3. `/admin/ingestion-runs` contains separate success/failure rows per source.
4. `/admin/source-documents?state=candidate` contains documents from successful official fallbacks.
5. Extract one candidate using GigaChat.
6. Confirm the response includes `sourceTextOrigin` and a structured draft.
7. Publish only after manual review.
8. Re-run ingestion and verify no duplicate `(source, external_id)` rows are created.

## Current limitation

HTML index parsers are intentionally conservative and may need source-specific selector tuning if an official site changes its markup. This is observable as an isolated failed ingestion run; it does not corrupt approved rules.
