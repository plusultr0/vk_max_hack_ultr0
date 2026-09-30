# Hotfix 0.9.19.6

Fixes the remaining lifecycle acceptance failure where a `regulatory_update` notification row deleted after a partial delivery was not recreated by a regulatory recalculation even though the current assessment already existed.

## Change

`packages/db/src/runtime.ts` now rebuilds regulatory notification intent from the exact `currentIds` selected by the same recalculation transaction. It no longer performs a second lookup by calculation identity.

The repair is still limited to `reason === 'regulatory_update'`, active assessments, verdicts `applies` / `needs_info`, and non-dev MAX users. Normal profile/manual recalculation therefore does not create regulatory-update spam.

## Safety

- no `.env`
- no migrations
- no seed changes
- no database schema changes
- notification upsert remains deduplicated by `regulatory:<company>:<rule>:<version>`

## Local verification available in this environment

- `runtime.ts` TypeScript transpile: OK
- offline core: 229/229
- offline chatbot: 10/10

Full PostgreSQL lifecycle acceptance must be rerun on the server because PostgreSQL/Docker are not available in the build environment used for this hotfix.
