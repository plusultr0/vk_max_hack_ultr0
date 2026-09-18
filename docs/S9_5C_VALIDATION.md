# S9.5C validation — 2026-09-18

After commit fdb2be1 the Docker API image was rebuilt and both PostgreSQL integration suites passed.

Verified: repeat migrations, immutable source snapshots and revisions, concurrent create/save conflicts, atomic audit rollback, ready validation, revision/hash-bound preview, legacy publication guards, terminal candidate guards, HTTP authentication/history/preview, cookie sessions, Origin and CSRF protection, logout and field catalog. Tests confirmed no publication or notification side effects.

Local API health check passed. GET http://localhost:5173/review returned HTTP 200. This is an HTTP smoke check, not a completed interactive browser acceptance test.

Outstanding: interactive editor acceptance test, confirmed MAX connectivity, webhook setup, atomic publication and outbox. The web image must be rebuilt to deploy the logout fix; the integration run used the rebuilt API image.

Browser smoke check: /review login form rendered, empty key disabled submit, invalid key displayed a Russian error and cleared the field. Browser error/warning logs were empty. Authenticated editor workflows remain pending.
