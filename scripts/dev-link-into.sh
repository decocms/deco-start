#!/usr/bin/env bash
#
# dev-link-into.sh — rebuild this repo's dist/ and overlay it into a consumer's
# node_modules. Workaround for Turbopack ignoring subpath exports through
# symlinks (see CONTRIBUTING.md → "Testing against a real consumer").
#
# Usage:
#   ./scripts/dev-link-into.sh <consumer-path>
#
# Example:
#   ./scripts/dev-link-into.sh ~/code/my-storefront
#
# Safe to re-run; the target dist/ is rm'd before the copy.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <consumer-path>" >&2
  exit 2
fi

CONSUMER="$1"
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$CONSUMER/node_modules/@decocms/start/dist"

if [[ ! -d "$CONSUMER" ]]; then
  echo "error: consumer path does not exist: $CONSUMER" >&2
  exit 1
fi

if [[ ! -d "$CONSUMER/node_modules/@decocms/start" ]]; then
  echo "error: @decocms/start is not installed in $CONSUMER" >&2
  echo "       run 'bun install' (or your package manager) in the consumer first." >&2
  exit 1
fi

echo "→ building @decocms/start in $SOURCE_ROOT"
(cd "$SOURCE_ROOT" && bun run build)

echo "→ overlaying $SOURCE_ROOT/dist into $TARGET_DIR"
rm -rf "$TARGET_DIR"
cp -R "$SOURCE_ROOT/dist" "$TARGET_DIR"

echo "✓ done. Restart the consumer's dev server to pick up the change."
