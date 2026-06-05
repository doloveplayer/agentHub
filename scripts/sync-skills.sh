#!/usr/bin/env bash
set -euo pipefail

# Sync preset skill source directories from local ~/.claude/plugins
# to apps/api/skill-bundle/ for deployment portability.
#
# Run this after adding/updating skills in ~/.claude/plugins.

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="$PROJECT_ROOT/apps/api/skill-bundle"
PRESET_FILE="$PROJECT_ROOT/apps/api/src/presetSkills.ts"

if [ ! -f "$PRESET_FILE" ]; then
  echo "✗ presetSkills.ts not found"
  exit 1
fi

mkdir -p "$BUNDLE_DIR"

COUNT=0
for dir in $(grep "sourceDir: '/" "$PRESET_FILE" | sed "s/.*sourceDir: '//;s/',//"); do
  name=$(basename "$dir")
  if [ -d "$dir" ]; then
    cp -r "$dir" "$BUNDLE_DIR/$name"
    echo "  ✓ $name"
    COUNT=$((COUNT + 1))
  else
    echo "  ⚠ $name — source not found: $dir"
  fi
done

echo ""
echo "Synced $COUNT skill(s) to $BUNDLE_DIR/"
