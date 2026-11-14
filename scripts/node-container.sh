#!/usr/bin/env bash
# Run pnpm commands for a Chomp checkout inside a throwaway Node container.
#   scripts/node-container.sh <checkout-dir> '<shell commands>'
# Install scripts, the build and the tests run with no sudo, no host env (no prod
# DB_PATH) and no filesystem beyond the checkout and a pnpm store cache. The image
# pins prod's Node version so native modules (better-sqlite3) match the host ABI.
set -euo pipefail
dir=$(realpath "$1")
store="$HOME/.cache/chomp-ci/pnpm-store"
mkdir -p "$store"
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e CI=true -e COREPACK_HOME=/tmp/corepack -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -v "$dir:/src" -v "$store:/store" -w /src \
  node:24.13.1-bookworm \
  bash -euo pipefail -c '
    mkdir -p /tmp/bin && corepack enable --install-directory /tmp/bin && export PATH=/tmp/bin:$PATH
    pnpm install --frozen-lockfile --store-dir /store --config.confirmModulesPurge=false --reporter=silent
    '"$2"
