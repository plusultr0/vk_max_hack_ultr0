# S9.6 — atomic review publication and transactional outbox

Implemented and validated on 2026-09-18. This stage publishes a reviewed bundle,
not arbitrary client-supplied legal rules. No real candidate was published during validation.

## Contract

`POST /admin/candidates/:id/review/:revision/publish`

```json
{
  "contentHash": "<64-character lowercase SHA-256 of the saved review>",
  "reviewerNote": "Optional reviewer note",
  "relation": {
    "type": "amends",
    "effectiveFrom": "2026-09-18",
    "evidenceRef": "Optional evidence reference"
  }
}
```

Only `contentHash` is required. `relation` is optional; supported types are
`amends`, `supersedes`, `extends`, `cancels`. When supplied, **every included rule**
must have a previous version (`version - 1`); otherwise the whole transaction fails.
There is no implicit skipping of missing predecessors.

Authentication uses the existing admin guard: cookie requests require the
HttpOnly/SameSite=Strict session, allowed Origin and matching `X-Review-CSRF`.
Existing server scripts may continue to use `X-Admin-Token` without cookie CSRF.
Actor identity is server-assigned (`admin-token`); `actorId`, `approvedRule` and
other unknown request fields are rejected. No credentials are placed in outbox data.

Success is HTTP 201 and includes `publicationId`, `eventId`, candidate/revision/hash,
snapshot identity, published rule identities/hashes and `outboxStatus: "pending"`.
Common errors:

| Status | Error |
| --- | --- |
| 400 | Invalid/unknown input, invalid revision or calendar date |
| 403 | Missing authentication, invalid session, Origin or CSRF |
| 404 | Candidate or review not found |
| 409 | `REVIEW_REVISION_CONFLICT`, `REVIEW_CONTENT_HASH_MISMATCH`, `CANDIDATE_ALREADY_REVIEWED` |
| 409 | `REVIEW_SOURCE_SNAPSHOT_REQUIRED`, `IMMUTABLE_RULE_VERSION_CONFLICT`, `LEGAL_ACT_SOURCE_CONFLICT` |
| 422 | `REVIEW_NOT_READY`, `REVIEW_SOURCE_SNAPSHOT_INVALID`, `REVIEW_COMPILATION_INVALID`, `REVIEW_COMPILATION_MISMATCH`, `RELATION_PREVIOUS_VERSION_REQUIRED` |

Repeated or concurrent publication of one candidate returns one success and then
409 `CANDIDATE_ALREADY_REVIEWED`. It does not duplicate legal rules, audit or outbox.

## Transaction and validation

`packages/db/src/publication.ts` exports `publishReadyReviewRevision`.
Migration `009_review_publication_outbox.sql` adds:

- `review_publications`: one publication per candidate, linked by foreign keys to
  the precise immutable review revision and source snapshot.
- `review_publication_rules`: all phase/rule/version links and their compiled
  evidence, scope and temporal policy. A rule version belongs to at most one publication.
- `outbox_events`: event id/type, publication aggregate id, JSON payload, constrained
  status, attempts, available/processed timestamps and unique idempotency key.

The transaction locks candidate, review head and current revision. The candidate
must still be pending and the requested **current** revision must be ready.
Both client hash and recomputed document hash must match the stored hash.
The snapshot must exist, belong to the candidate's source document and match its
stored text hash; extraction validation checks snapshot content/provenance.

Compilation is reproduced using the saved checked date and compared canonically
with the complete stored compilation. Compiler drift/corruption fails closed.
Publication recompiles at the server's current UTC date and permits no compiler
issues (including structural/provenance errors). Rules are derived exclusively
from this compilation, marked reviewed, stripped of the preview tag and rehashed.

One transaction inserts/validates the legal act, inserts every included legal
rule and optional relation, saves publication/snapshot links, approves the candidate,
inserts audit `review.published` and exactly one
`review.published` outbox event per bundle, then commits. Any failure rolls back
all of these writes. Existing rule versions are never overwritten or silently reused.
An existing act may be reused only with the same official URL and source text hash.

Act title/URL/hash come from the immutable snapshot. Number and publication date
remain null and issuer remains unspecified: these fields are not captured in the
snapshot, so copying them from a potentially newer staging row would be unsafe.
The mutable source document's state is not changed or implicitly approved.

Multi-rule candidates leave legacy singular `approved_rule_id/version` null;
the complete authoritative bundle is in `review_publication_rules`.
The old `/admin/candidates/:id/publish` remains authenticated and cannot publish
a candidate that has a review draft, including through direct repository calls.

## Verification

Passed against the current sources:

- `npm run typecheck`.
- Frontend TypeScript and `npm run build:web`.
- `npm test`: 82 unit tests (including the PostgreSQL INTEGER version bound).
- `docker build -t max-regcontrol-s96-check .`, followed by typecheck, unit tests
  and the production Vite build inside that image.
- `npm run test:integration`: grounding, review and publication/outbox suites
  against PostgreSQL 16 in a disposable Docker container, with random isolated schemas.
  Every suite applies all migrations twice.

The new suite covers draft/stale/missing revisions, wrong request/stored hashes,
missing/corrupt snapshots, broken provenance, tampered compilation, terminal
candidates, multi-rule publication, concurrent/sequential duplicate refusal,
unique outbox keys, snapshot links, rule hashes, audit/outbox-trigger rollback,
rule/act conflicts, relation validation and successful version relations, mutable
source drift isolation and blocking legacy recalculation of bundle identities.
Actual HTTP tests cover cookie and token authentication, missing/wrong Origin/CSRF,
invalid inputs, server-derived actor, legacy guard, success and duplicate refusal.
No impact assessments or notifications are created by publication itself.

## Deliberate limitations / next steps

- Outbox **producer only**. No dispatcher, claim/lease loop, retry/backoff,
  dead-letter handling, retention or exactly-once downstream side effects yet.
  Events remain pending; attempts stay zero until a consumer is implemented.
- No automatic recalculation, MAX notification, webhook or network call occurs
  during/after the publication transaction. Future consumers need deduplication.
- No publication button or result/history view has been added to `/review`.
- Shared admin principal remains; per-user authorization/audit attribution is future work.
- Compiler changes require a newly saved/revalidated ready revision, not a bypass.
- Different source content cannot reuse an existing act id; automatic act
  versioning/merging and per-phase relation choices are not implemented.
- The compiler's scope/temporal metadata is retained, but downstream evaluator
  support for the full published bundle is outside this producer-only stage.
  Company recalculation excludes every rule identity linked to a review
  publication (including earlier versions); explicit legacy recalculation fails
  with `REVIEW_BUNDLE_RECALCULATION_NOT_IMPLEMENTED`. Pending outbox events alone
  would not prevent the legacy evaluator from ignoring scope/expiry safeguards.
  A future bundle-aware activation/consumer must deliberately replace this guard.
- Application database deployment and any real publication require a separate
  operational action. Validation used synthetic fixtures only.
- MAX token verification and authenticated editor browser acceptance remain pending.

The tracked local `.env` was neither changed nor included in Docker build context;
tests used generated credentials and a disposable database.
