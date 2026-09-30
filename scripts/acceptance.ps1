# Run from any directory; the application's .env is not read or rewritten.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$code = 1
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker is required. Start Docker Desktop and retry."
    }
    New-Item -ItemType Directory -Force test-results | Out-Null
    & docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from tests 2>&1 |
        Tee-Object -FilePath test-results/acceptance.log
    $code = $LASTEXITCODE
}
finally {
    & docker compose --env-file .env.test.example -p max-regcontrol-tests -f compose.test.yaml down
    Pop-Location
}
exit $code
