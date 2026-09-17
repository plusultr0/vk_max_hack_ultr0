# S9.3 — Grounded extraction validation

## Trigger

The first live GigaChat run against the official Bank of Russia digital-ruble page returned structurally valid JSON, but all `conditions[*].evidenceIndexes`, `exceptions[*].evidenceIndexes`, and `actionDrafts[*].evidenceIndexes` were empty even though `evidence` was populated.

This is unacceptable for review/publishing because a reviewer cannot deterministically trace each extracted claim back to the source.

## Changes

1. `evidenceIndexes` now has `minItems: 1` in the JSON schema and `.min(1)` in the Zod schema for conditions, exceptions, and actions.
2. `operatorHint` is constrained to a fixed machine-readable enum.
3. A deterministic quality gate verifies:
   - evidence index uniqueness;
   - every reference resolves;
   - every source-dependent item has at least one reference;
   - every evidence quote is a verbatim substring of the staged official source after whitespace normalization.
4. Failed first-pass extractions receive one LLM repair pass with the original source, previous draft, and explicit quality issues.
5. A second failure aborts extraction with `EXTRACTION_QUALITY_GATE_FAILED`; the API does not save a candidate.
6. Prompt version becomes `reg-extract-v3-grounded-repair`.
7. Multi-phase sources are instructed to keep the earliest phase in the single-rule draft and enumerate later phases in `uncertaintyNotes` so they are not silently lost.

## Expected live smoke

Repeat extraction for the staged Bank of Russia digital-ruble source. Expected:

- non-empty evidence links on every condition, exception, and action;
- machine-readable operator hints (for example `gt`, `eq`);
- later 2027/2028 phases mentioned in `uncertaintyNotes` if present in the staged source text;
- no candidate saved if grounding cannot be repaired.
