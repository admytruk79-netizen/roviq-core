#!/usr/bin/env bash
# Propagates shared/theme/roviq-tokens.css into every portal that shares the navy/copper theme,
# and shared/brand/ (the ROVIQ logo) into every app.
# Run this after editing the source file. tow is intentionally excluded -- it has its own theme.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SOURCE="shared/theme/roviq-tokens.css"
PORTALS=(web ops partner diagnostic parts-portal service)

for portal in "${PORTALS[@]}"; do
  cp "$SOURCE" "$portal/src/roviq-tokens.css"
  echo "synced -> $portal/src/roviq-tokens.css"
done

# Brand files (logo lockup, mark, app icon) go to every app, tow and fleet included.
for app in web ops partner diagnostic parts-portal service tow fleet; do
  mkdir -p "$app/src/brand" "$app/public"
  cp shared/brand/*.svg "$app/src/brand/"
  cp shared/brand/favicon.svg "$app/public/favicon.svg"
  echo "brand  -> $app"
done
# The static portal launcher uses the dark lockup and the app icon directly.
cp shared/brand/roviq-lockup-dark.svg shared/brand/favicon.svg portals/
