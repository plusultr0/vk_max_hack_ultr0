# Hotfix 0.9.19.1

Исправляет неполный server-patch 0.9.19, выявленный полным Docker acceptance на сервере.

В hotfix входят только файлы, необходимые для устранения TypeScript ошибок:
- публичные exports интерактивного MAX webhook из `@reg/db`;
- актуальный `packages/db/src/webhook.ts`;
- актуальный MAX client с inline keyboard/callback API;
- актуальный `regulatory-feed.ts` под `recentlyAdded`;
- исправленные типы в PostgreSQL journey regression;
- Linux wrapper `scripts/acceptance.sh`.

`.env`, база данных, seed и migration 013 этим hotfix не заменяются.
После распаковки повторно выполнить `bash scripts/acceptance.sh`. Production запускать только при `ACCEPTANCE_EXIT=0`.
