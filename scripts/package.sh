#!/bin/sh
# pi-unica packaging entry point.
# Assembles portable single-file archives into dist/ (see package.mjs for the
# full layout and SHA-256 verification logic).
#
# Usage:
#   ./scripts/package.sh [--target linux-x64|win-x64] [--all] [--universal]
#                        [--version v0.12.0]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/package.mjs" "$@"
