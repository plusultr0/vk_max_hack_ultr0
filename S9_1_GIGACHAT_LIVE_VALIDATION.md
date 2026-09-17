# S9.1 — GigaChat live-ready validation

## Implemented

- Updated GigaChat REST base URL remains `https://api.giga.chat/v1`.
- OAuth uses `POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth` with `Authorization: Basic`, `RqUID` UUID and configured scope.
- Access token is cached until shortly before expiry.
- GigaChat structured extraction now uses `response_format.type=json_schema` with a strict schema matching `RegulatoryExtractionSchema`.
- LLM request timeout is configurable with `LLM_TIMEOUT_MS`.
- TLS verification failures produce an actionable error; production TLS verification is not disabled.
- Admin endpoints added: `GET /admin/llm/status`, `POST /admin/llm/smoke`.
- Worker smoke test calls the selected provider end-to-end.
- Extraction prompt explicitly prohibits company applicability decisions and unsupported legal inference.
- Prompt version changed to `reg-extract-v2-json-schema`.
- Dependency fixes from the first Windows run are folded into source: TypeScript 5.8.3 and Zod 3.25.76.

## Still requires external credentials

A real live test cannot be completed without `GIGACHAT_AUTH_KEY`. Keep `LLM_PROVIDER=mock` until the key is available.

## Local acceptance

1. Set `LLM_PROVIDER=gigachat`, `LLM_MODEL=GigaChat-2-Pro`, `GIGACHAT_AUTH_KEY=...`.
2. Rebuild/recreate API and worker.
3. Run `docker compose run --rm worker npm run llm:smoke`.
4. Expect JSON with `provider: gigachat`, model, and a schema-valid `result`.
5. Call `/admin/llm/status`; verify `configured=true` without exposing secrets.
6. If TLS validation fails, configure the official CA chain via `NODE_EXTRA_CA_CERTS`.

## Safety boundary

LLM output remains a draft. It is not published automatically. A candidate must pass schema validation and explicit admin review before becoming a deterministic rule.
