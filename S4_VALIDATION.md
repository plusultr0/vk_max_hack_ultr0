# S4 validation — LLM extraction adapter

Status: **implemented, external-provider smoke test pending credentials/network**.

## Implemented

- `@reg/llm` is a provider-neutral package.
- Shared `RegulatoryExtractionSchema` validates all structured output with Zod.
- `MockLlmProvider` gives a deterministic offline smoke path.
- `GigaChatProvider` implements OAuth token acquisition, token caching and structured `json_schema` output.
- `DeepSeekProvider` uses the OpenAI-compatible chat endpoint and JSON output, then applies the same local Zod validation.
- `extractRegulatoryDraft()` uses one strict source-grounded prompt for both providers.
- Worker has `llm:smoke` and defaults to `LLM_PROVIDER=mock`.
- No LLM output is inserted into `legal_rules` or treated as verified law automatically.

## Security / correctness boundaries

1. API keys are server-side environment variables only.
2. The prompt explicitly forbids filling gaps from model memory.
3. Output must contain source evidence indexes and uncertainty notes.
4. Provider output is parsed as JSON and then validated locally.
5. LLM is only an **extraction draft** stage. The deterministic evaluator still runs only approved rules.
6. Internal business documents are not sent to providers in this stage.

## Offline checks possible in this environment

- package manifests parse as JSON;
- source files are present;
- compose/env expose the S4 provider configuration;
- mock provider has an automated test;
- worker has a deterministic mock smoke command.

## Checks blocked here

The current execution environment cannot reach the npm registry, so dependencies could not be installed and the Vitest suite/build could not be executed end-to-end. Real GigaChat/DeepSeek calls also require credentials and internet access.

When dependencies/credentials are available:

```bash
npm install
npm test
LLM_PROVIDER=mock npm run llm:smoke --workspace @reg/worker
```

GigaChat smoke:

```bash
LLM_PROVIDER=gigachat \
GIGACHAT_AUTH_KEY='<key>' \
npm run llm:smoke --workspace @reg/worker
```

DeepSeek smoke:

```bash
LLM_PROVIDER=deepseek \
DEEPSEEK_API_KEY='<key>' \
npm run llm:smoke --workspace @reg/worker
```

A real S4 acceptance run should compare extraction from the manually verified 5–7 pilot source fragments against the approved rule markup. Provider selection must be based on extraction correctness/evidence quality, not writing style.
