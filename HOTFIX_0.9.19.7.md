# Hotfix 0.9.19.7

Acceptance-only fixture synchronization for `journey.integration.ts`.

Root cause: the isolated journey test inserted seed `legal_rules` directly into a disposable schema, bypassing the normal seed/publication path that installs `factModel.definitions`. The runtime then correctly rejected `rule_fact_dependencies` referencing `pd.only_non_automated_processing@1` because that definition was absent in the test schema.

Fix: install the selected journey rules' fact definitions with the same `installFactDefinitions(..., 'human')` path used by production seeding before the fixture inserts and recalculates those rules.

No production runtime logic, migrations, seed data, `.env`, credentials, or persistent database state are changed by this hotfix.
