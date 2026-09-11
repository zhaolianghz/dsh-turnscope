#!/usr/bin/env bash
#
# Reproduce the client-side half of the third-party Remote proof.
#
# The resident contract test (`tests/host/adapters/third-party-remote.spec.ts`)
# shows that an ungenerated `TypertRemoteService` is claimed and dispatched by
# the real gateway. It cannot show the other half — that a third-party *client*
# plugin, loaded by the real web app in a real browser, can reach `/api`. That
# needs a booted DSH web profile and a browser, so it lives here as a script
# that builds both, runs one call, and asserts the answer.
#
# What it proves, in order:
#   1. our package appears in the served `window.__DSH_BOOT__` graph, so the
#      client half was discovered and its bundle route was mounted;
#   2. a client plugin with `inject: ['connection']` actually activates, i.e.
#      the first-party `connection` service is injectable by a third party;
#   3. `connection.rpc.call('/api', …)` completes a round trip to the real host
#      service, so the transport is not a host-only story.
#
# Preconditions: a working `dsh` on PATH and at least one existing profile that
# already has `@deepseek-ai/dsh-web-app` installed. We reuse that profile's
# shared `node_modules` by symlink rather than re-installing the ~150-package
# web stack into a scratch home. Nothing outside $WORK is written.
#
# Usage: run.sh [/path/to/turnscope-repo]
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_NODE_MODULES="${DSH_SHARED_NODE_MODULES:-$HOME/.dsh/profiles/node_modules}"
PORT="${PORT:-38517}"
CDP_PORT="${CDP_PORT:-9333}"

[ -f "$REPO/lib/client.js" ] || { echo "no built client bundle in $REPO — run pnpm build first" >&2; exit 1; }
[ -d "$SHARED_NODE_MODULES/@deepseek-ai/dsh-web-app" ] || {
  echo "no dsh-web-app in $SHARED_NODE_MODULES — install it into a profile first" >&2
  exit 1
}

WORK="$(mktemp -d)"
CHROME_PID=""
DSH_PID=""
cleanup() {
  [ -n "$CHROME_PID" ] && kill "$CHROME_PID" 2>/dev/null || true
  pkill -f "user-data-dir=$WORK/chrome" 2>/dev/null || true
  [ -n "$DSH_PID" ] && kill "$DSH_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PROFILE_DIR="$WORK/home/profiles/ts-smoke"
mkdir -p "$PROFILE_DIR/node_modules/@zhaolianghz"
# The upward `node_modules` walk is what we exploit: a symlink here puts the
# whole shared install within reach without installing anything.
ln -s "$SHARED_NODE_MODULES" "$WORK/home/profiles/node_modules"
ln -s "$REPO" "$PROFILE_DIR/node_modules/@zhaolianghz/dsh-turnscope"

# ---------------------------------------------------------------------------
# The probe: a throwaway third-party client plugin whose only job is to say, on
# the page, whether `connection` was injected and whether `/api` answered.
# ---------------------------------------------------------------------------
PROBE="$WORK/probe"
mkdir -p "$PROBE"
ln -s "$PROBE" "$PROFILE_DIR/node_modules/@zhaolianghz/dsh-connection-probe"
cp "$HERE/probe-client.js" "$PROBE/client.js"
cat > "$PROBE/package.json" <<'JSON'
{
  "name": "@zhaolianghz/dsh-connection-probe",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": ["@deepseek-ai/dsh-client-runtime"],
      "platform": "web",
      "immediately": true
    }
  }
}
JSON
cat > "$PROBE/index.js" <<'JS'
export const name = '@zhaolianghz/dsh-connection-probe'
export function apply() {}
JS
cat > "$PROBE/cordis.patch.yml" <<'YML'
- insert:
    - id: ts-probe
      name: '@zhaolianghz/dsh-connection-probe'
YML

# `dataDir` is pinned because the default is `$DSH_HOME/turnscope` and this run
# is not the user's data.
cat > "$WORK/patch.yml" <<'YML'
- id: turnscope
  config:
    dataDir: PLACEHOLDER_DATA_DIR
YML
sed -i.bak "s|PLACEHOLDER_DATA_DIR|$WORK/turnscope-data|" "$WORK/patch.yml"

cat > "$WORK/home/profiles/ts-smoke/package.json" <<'JSON'
{
  "name": "dsh-profile-ts-smoke",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@zhaolianghz/dsh-connection-probe",
        "@zhaolianghz/dsh-turnscope"
      ]
    }
  }
}
JSON
printf '[]\n' > "$PROFILE_DIR/cordis.yml"
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"

echo "== composed tree contains our entries =="
DSH_HOME="$WORK/home" dsh --profile ts-smoke --patch "$WORK/patch.yml" --dump-config \
  | grep -E "^- (id|  name):|turnscope|connection-probe" | tail -6

echo "== booting dsh web on :$PORT =="
DSH_HOME="$WORK/home" dsh --profile ts-smoke --patch "$WORK/patch.yml" \
  --port "$PORT" --no-open > "$WORK/dsh.log" 2>&1 &
DSH_PID=$!
disown "$DSH_PID" 2>/dev/null || true
for _ in $(seq 1 60); do
  curl -sf -o "$WORK/index.html" "http://127.0.0.1:$PORT/" && break
  sleep 1
done
curl -sf -o "$WORK/index.html" "http://127.0.0.1:$PORT/" || { cat "$WORK/dsh.log"; exit 1; }

echo "== our client entries in window.__DSH_BOOT__ =="
node "$HERE/check-boot.mjs" "$WORK/index.html"

echo "== driving a real browser =="
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-first-run \
  --user-data-dir="$WORK/chrome" --remote-debugging-port="$CDP_PORT" \
  about:blank > "$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
disown "$CHROME_PID" 2>/dev/null || true
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break
  sleep 1
done

node "$HERE/drive.mjs" "$CDP_PORT" "http://127.0.0.1:$PORT/" | tee "$WORK/report.txt"

echo "== verdict =="
grep -q 'apply() ran' "$WORK/report.txt" || { echo "FAIL: connection was not injected" >&2; exit 1; }
grep -q '"ok":true' "$WORK/report.txt" || { echo "FAIL: the gateway did not answer" >&2; exit 1; }
echo "PASS: a third-party client plugin injected \`connection\` and completed a /api round trip"
