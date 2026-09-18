# S9.5C validation — 2026-09-18

After commit fdb2be1 the Docker API image was rebuilt and both PostgreSQL integration suites passed.

Verified: repeat migrations, immutable source snapshots and revisions, concurrent create/save conflicts, atomic audit rollback, ready validation, revision/hash-bound preview, legacy publication guards, terminal candidate guards, HTTP authentication/history/preview, cookie sessions, Origin and CSRF protection, logout and field catalog. Tests confirmed no publication or notification side effects.

Local API health check passed. GET http://localhost:5173/review returned HTTP 200. This is an HTTP smoke check, not a completed interactive browser acceptance test.

Outstanding: interactive editor acceptance test, confirmed MAX connectivity, webhook setup, atomic publication and outbox. The web image must be rebuilt to deploy the logout fix; the integration run used the rebuilt API image.

Browser smoke check: /review login form rendered, empty key disabled submit, invalid key displayed a Russian error and cleared the field. Browser error/warning logs were empty. Authenticated editor workflows remain pending.

Runtime follow-up: local API /health returned 200 with database ok; /review returned 200. MAX token verification was attempted without exposing the token, but the network command was rejected by the approval service before execution, so token validity remains unconfirmed.

## S9.6 follow-up — 2026-09-18

Atomic publication of the current ready review revision and the transactional
outbox producer are now implemented; see `S9_6_PUBLICATION_OUTBOX.md`.
The earlier “atomic publication and outbox” outstanding item is superseded by
this follow-up. The S9.5C editor itself still has no publication button.

Backend/frontend TypeScript, all 82 unit tests, Docker image build and production
web build passed. Grounding/review integration suites continue to pass alongside
the new PostgreSQL/API publication suite, including rollback, concurrency,
snapshot/hash/compilation guards, auth/Origin/CSRF and legacy-publish protection.
Validation used only synthetic data in disposable schemas/containers.

Still pending: outbox consumer/delivery and retries, downstream bundle handling,
publication UI, authenticated editor browser acceptance, MAX token validation
and webhook setup. No real regulatory rule was automatically published.
