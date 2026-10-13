#!/bin/sh
# pi-unica packaging entry point.
# Assembles portable single-file archives into dist/ (see package.mjs for the
# full layout and SHA-256 verification logic). The archives carry the pinned
# version in their name: dist/pi-unica-0.13.0-<target>.tar.gz.
#
# Usage:
#   ./scripts/package.sh [--target linux-x64|win-x64] [--all] [--universal]
#                        [--version v0.13.0] [--build-local]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/package.mjs" "$@"
