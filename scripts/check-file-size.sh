#!/bin/bash

set -euo pipefail

MAX_LINES=2000
EXEMPTIONS_FILE="docs/file-size-exemptions.md"

echo "Checking for files larger than ${MAX_LINES} lines..."

large_files_file=$(mktemp)
large_paths_file=$(mktemp)
exemptions_file=$(mktemp)
unexpected_large_file=$(mktemp)
stale_exemptions_file=$(mktemp)

cleanup() {
  rm -f \
    "$large_files_file" \
    "$large_paths_file" \
    "$exemptions_file" \
    "$unexpected_large_file" \
    "$stale_exemptions_file"
}
trap cleanup EXIT

# Collect oversized source files while excluding generated output and dependencies.
find apps packages -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.rs" \) \
  ! -path "*/node_modules/*" \
  ! -path "*/dist/*" \
  ! -path "*/target/*" \
  ! -path "*/.next/*" \
  ! -path "*/build/*" \
  -exec sh -c '
  lines=$(wc -l < "$1")
  if [ "$lines" -gt "'"$MAX_LINES"'" ]; then
    printf "%s\t%s\n" "$1" "$lines"
  fi
' sh {} \; | sort > "$large_files_file"

cut -f1 "$large_files_file" > "$large_paths_file"

if [ -f "$EXEMPTIONS_FILE" ]; then
  sed -n 's/^- `\([^`]*\)`:.*$/\1/p' "$EXEMPTIONS_FILE" | sort > "$exemptions_file"
else
  : > "$exemptions_file"
fi

while IFS="$(printf '\t')" read -r file lines; do
  [ -n "$file" ] || continue
  if ! grep -Fxq "$file" "$exemptions_file"; then
    printf "%s\t%s\n" "$file" "$lines" >> "$unexpected_large_file"
  fi
done < "$large_files_file"

while IFS= read -r file; do
  [ -n "$file" ] || continue
  if ! grep -Fxq "$file" "$large_paths_file"; then
    echo "$file" >> "$stale_exemptions_file"
  fi
done < "$exemptions_file"

if [ -s "$unexpected_large_file" ]; then
  echo "❌ Files exceeding ${MAX_LINES} lines without documented exemption:"
  while IFS="$(printf '\t')" read -r file lines; do
    [ -n "$file" ] || continue
    printf "  - %s: %s lines\n" "$file" "$lines"
  done < "$unexpected_large_file"
  echo
  echo "Please refactor these files or document an exemption in ${EXEMPTIONS_FILE}."
  exit 1
fi

if [ -s "$stale_exemptions_file" ]; then
  echo "❌ Stale file size exemptions found:"
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf "  - %s\n" "$file"
  done < "$stale_exemptions_file"
  echo
  echo "Please remove stale entries from ${EXEMPTIONS_FILE}."
  exit 1
fi

if [ -s "$large_files_file" ]; then
  echo "⚠️  Oversized files covered by documented exemptions:"
  while IFS="$(printf '\t')" read -r file lines; do
    [ -n "$file" ] || continue
    printf "  - %s: %s lines\n" "$file" "$lines"
  done < "$large_files_file"
  echo
fi

echo "✅ File size check passed"
