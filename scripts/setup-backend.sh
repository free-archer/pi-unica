#!/bin/sh
# pi-unica backend setup entry point.
# Builds the Rust `unica` binary, downloads the four pinned third-party tools
# (bsl-analyzer, v8-runner, rlm-bsl-mcp, rlm-bsl-index) with SHA-256
# verification, generates the runtime manifest, and registers the `unica` MCP
# server in ~/.pi/agent/mcp.json.
#
# Usage:
#   ./scripts/setup-backend.sh [--target linux-x64] [--skip-build]
#                              [--skip-download] [--skip-mcp-config]
#                              [--from-runtime-url <url>] [--dry-run]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/setup-backend.mjs" "$@"
