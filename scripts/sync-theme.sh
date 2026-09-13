#!/usr/bin/env bash
# Propagates shared/theme/roviq-tokens.css into every portal that shares the navy/copper theme.
# Run this after editing the source file. tow is intentionally excluded -- it has its own theme.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SOURCE="shared/theme/roviq-tokens.css"
PORTALS=(web ops partner diagnostic parts-portal)

for portal in "${PORTALS[@]}"; do
  cp "$SOURCE" "$portal/src/roviq-tokens.css"
  echo "synced -> $portal/src/roviq-tokens.css"
done
