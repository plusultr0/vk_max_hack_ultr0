#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results
ENV_FILE="/tmp/max-regcontrol-acceptance.env"
printf '\n' > "$ENV_FILE"
set +e
docker compose --env-file "$ENV_FILE" -p max-regcontrol-tests -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests 2>&1 | tee test-results/acceptance.log
status=${PIPESTATUS[0]}
set -e
docker compose --env-file "$ENV_FILE" -p max-regcontrol-tests -f compose.test.yaml down
printf 'ACCEPTANCE_EXIT=%s\n' "$status"
exit "$status"
