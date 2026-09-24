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
#      service, so the transport is not a host-only story;
#   4. `turnscope/listTurns` — our own registered descriptor, called with the
#      envelope our browser bundle sends — answers from the real host, which is
#      the host half of the client API proved in the same process that calls it.
#
# Preconditions: a working `dsh` on PATH and `@deepseek-ai/dsh-web-app`
# available in the project's pinned install, a DSH profile, or
# DSH_SHARED_NODE_MODULES. We reuse those dependencies by symlink rather than
# installing the web stack into a scratch home. Nothing outside $WORK is written.
#
# Usage: run.sh [/path/to/turnscope-repo]
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${DSH_SHARED_NODE_MODULES:-}" ]; then
  SHARED_NODE_MODULES="$DSH_SHARED_NODE_MODULES"
elif [ -d "$REPO/node_modules/@deepseek-ai/dsh" ]; then
  DSH_PACKAGE="$(realpath "$REPO/node_modules/@deepseek-ai/dsh")"
  SHARED_NODE_MODULES="$(dirname "$(dirname "$DSH_PACKAGE")")"
else
  SHARED_NODE_MODULES="$HOME/.dsh/profiles/node_modules"
fi
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
      "inject": ["@deepseek-ai/dsh-client-connection"],
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

# ---------------------------------------------------------------------------
# The fixture: a workspace, so that the page can open a session.
#
# Our client plugin is not `immediately: true`; its `conversation.view`
# contribution only lands once that view is mounted, which needs an open
# session, which the app refuses without a workspace. The picker on the landing
# page opens a directory dialog CDP cannot drive, so the workspace is registered
# host-side through the published `ctx.workspaceRegistry.create`.
#
# The directory is a scratch git repo rather than $REPO: a session's cwd becomes
# the workspace root, and pointing the real app at our own checkout invites it to
# write there.
# ---------------------------------------------------------------------------
SEED_WORKSPACE="$WORK/workspace"
mkdir -p "$SEED_WORKSPACE"
git -C "$SEED_WORKSPACE" init -q
git -C "$SEED_WORKSPACE" -c user.email=smoke@example.invalid -c user.name=smoke \
  commit -q --allow-empty -m 'empty baseline'

SEED="$WORK/seed"
mkdir -p "$SEED"
ln -s "$SEED" "$PROFILE_DIR/node_modules/@zhaolianghz/dsh-ts-seed-workspace"
cp "$HERE/seed-workspace.js" "$SEED/index.js"
cat > "$SEED/package.json" <<'JSON'
{
  "name": "@zhaolianghz/dsh-ts-seed-workspace",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
JSON
cat > "$SEED/cordis.patch.yml" <<'YML'
- insert:
    - id: ts-seed-workspace
      name: '@zhaolianghz/dsh-ts-seed-workspace'
YML

# `dataDir` is pinned because the default is `$DSH_HOME/turnscope` and this run
# is not the user's data.
cat > "$WORK/patch.yml" <<'YML'
- id: turnscope
  config:
    dataDir: PLACEHOLDER_DATA_DIR
YML
sed -i.bak "s|PLACEHOLDER_DATA_DIR|$WORK/turnscope-data|" "$WORK/patch.yml"

# The probe sends the *current* API version, read out of the source rather than
# written twice: a harness that hard-coded a stale number would pass while the
# real client bundle was being refused.
API_VERSION="$(grep -oE 'API_VERSION = [0-9]+' "$REPO/src/shared/contracts/api.ts" | grep -oE '[0-9]+$')"
[ -n "$API_VERSION" ] || { echo "could not read API_VERSION from $REPO/src/shared/contracts/api.ts" >&2; exit 1; }
sed -i.bak "s/PLACEHOLDER_API_VERSION/$API_VERSION/" "$PROBE/client.js"

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
        "@zhaolianghz/dsh-ts-seed-workspace",
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
DSH_HOME="$WORK/home" TS_SEED_WORKSPACE="$SEED_WORKSPACE" \
  dsh --profile ts-smoke --patch "$WORK/patch.yml" \
  --port "$PORT" --no-open > "$WORK/dsh.log" 2>&1 &
DSH_PID=$!
disown "$DSH_PID" 2>/dev/null || true
for _ in $(seq 1 60); do
  APP_URL="$(sed -n 's/^dsh web: \(http:\/\/127\.0\.0\.1:[0-9]*\/?token=[^[:space:]]*\).*/\1/p' "$WORK/dsh.log" | head -1)"
  [ -n "$APP_URL" ] && break
  sleep 1
done
[ -n "${APP_URL:-}" ] || { echo "DSH did not report its Web address" >&2; exit 1; }
curl -sfL -c "$WORK/cookies.txt" -b "$WORK/cookies.txt" -o "$WORK/index.html" "$APP_URL" || {
  echo "DSH did not serve the authenticated Web page" >&2
  exit 1
}

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

if [ -n "${INSPECT:-}" ]; then
  # Reconnaissance mode: dump what the page renders instead of asserting the
  # round trip. Nothing below this block runs, so the proof's verdict cannot be
  # affected by an exploratory edit to `inspect.mjs`.
  node "$HERE/inspect.mjs" "$CDP_PORT" "$APP_URL"
  exit 0
fi

node "$HERE/drive.mjs" "$CDP_PORT" "$APP_URL" | tee "$WORK/report.txt"

echo "== verdict =="
grep -q 'apply() ran' "$WORK/report.txt" || { echo "FAIL: connection was not injected" >&2; exit 1; }
grep -q 'PROBE: rpc resolved -> {"ok":true' "$WORK/report.txt" || { echo "FAIL: the gateway did not answer" >&2; exit 1; }
grep -q '"turns":\[\]' "$WORK/report.txt" || { echo "FAIL: turnscope/listTurns did not answer with an empty page" >&2; exit 1; }
# The tab is asserted by its translated label, because the failure this caught was
# a tab that existed and read `view.title`. Matching the key would have passed.
grep -q '轮次' "$WORK/report.txt" || { echo "FAIL: no tab labelled 轮次 in the conversation view" >&2; exit 1; }
grep -q 'clicked the turnscope tab' "$WORK/report.txt" || { echo "FAIL: the turnscope tab could not be opened" >&2; exit 1; }
grep -q '"panel":"present"' "$WORK/report.txt" || { echo "FAIL: the panel did not render behind its tab" >&2; exit 1; }
echo "PASS: a third-party client plugin injected \`connection\`, completed a /api round trip,"
echo "      reached the turnscope host face from the page, and rendered its panel"
echo "      behind a translated tab in the real conversation view"
