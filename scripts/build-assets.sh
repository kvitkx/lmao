#!/bin/sh
# Copy the files the page loads from /static out of node_modules: Alpine and
# the font files, all pinned by package-lock.json.
# Usage: build-assets.sh NODE_MODULES_DIR STATIC_DIR
# Runs in the node image (busybox sh), so it does not use scripts/lib.sh.
set -eu

modules="${1:?Usage: build-assets.sh NODE_MODULES_DIR STATIC_DIR}"
static="${2:?Usage: build-assets.sh NODE_MODULES_DIR STATIC_DIR}"

mkdir -p "$static/css" "$static/vendor" "$static/fonts"

cp "$modules/alpinejs/dist/cdn.min.js" "$static/vendor/alpine.min.js"

inter="$modules/@fontsource/inter/files"
plex="$modules/@fontsource/ibm-plex-mono/files"

cp "$inter/inter-latin-100-normal.woff2" "$static/fonts/inter-latin-100.woff2"
cp "$inter/inter-latin-300-normal.woff2" "$static/fonts/inter-latin-300.woff2"
cp "$inter/inter-cyrillic-300-normal.woff2" "$static/fonts/inter-cyrillic-300.woff2"
cp "$plex/ibm-plex-mono-latin-300-normal.woff2" "$static/fonts/ibm-plex-mono-latin-300.woff2"
cp "$plex/ibm-plex-mono-cyrillic-300-normal.woff2" "$static/fonts/ibm-plex-mono-cyrillic-300.woff2"