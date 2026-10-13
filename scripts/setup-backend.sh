#!/bin/sh
# pi-unica backend setup entry point.
# Installs the pinned `unica` core binary and the four pinned third-party tools
# (bsl-analyzer, v8-runner, rlm-bsl-mcp, rlm-bsl-index) with SHA-256
# verification, generates the runtime manifest, and registers the `unica` MCP
# server in ~/.pi/agent/mcp.json.
#
# Usage:
#   ./scripts/setup-backend.sh [--target linux-x64] [--build-local]
#                              [--skip-core] [--skip-engines] [--force]
#                              [--skip-manifest] [--skip-mcp-config]
#                              [--from-runtime-url <url>] [--dry-run]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/setup-backend.mjs" "$@"
