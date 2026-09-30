#!/bin/sh
# Separate Compose project, ephemeral DB, synthetic API fixtures, no real keys.
set -eu
npm run check
npm run test:chatbot-offline
npm run test:integration
mkdir -p test-results
npm run dev:web > test-results/vite-browser.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT INT TERM
node --input-type=module <<'JS'
let ready=false;
for(let i=0;i<80;i++){
  try { if((await fetch('http://127.0.0.1:5173')).ok){ready=true;break;} } catch {}
  await new Promise(r=>setTimeout(r,500));
}
if(!ready)throw new Error('VITE_BROWSER_START_TIMEOUT');
JS
python3 tests/browser/regression.py --base-url http://127.0.0.1:5173 --chromium /usr/bin/chromium --output test-results/browser
python3 tests/layout/check_layout.py --chromium /usr/bin/chromium --output test-results/layout
