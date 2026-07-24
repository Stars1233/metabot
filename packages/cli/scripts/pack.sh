#!/usr/bin/env bash
# Bundle the metabot CLI into a self-contained tarball + sync the installer
# script. Output lands under `packages/server/static/cli/`, which is published
# to the server's static dir at install time. The tarball + script
# are served anonymously at `<host>/cli/{latest.tgz,install.sh}`.
#
# Inputs (resolved at runtime):
#   - packages/cli/src/index.ts (+ scripts/standalone-entry.ts wrapper)
#   - packages/cli/install-cli.sh
#   - packages/skills/metabot/ (complete Skill bundle)
#   - root package.json version
#
# Outputs:
#   - packages/server/static/cli/latest.tgz  (atomic write via .new + mv)
#   - packages/server/static/cli/install.sh  (atomic copy)
#
# Assumes `tsc -b` has already produced dist/ for the workspace deps esbuild
# resolves through (`@xvirobotics/cli-core`, `metamemory`, `skill-hub` all
# point at dist/index.js via "main"). Root build script orders this step
# after `tsc -b --force`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$CLI_PKG_DIR/../.." && pwd)"
SERVER_STATIC_DIR="$REPO_ROOT/packages/server/static/cli"
SKILL_SRC_DIR="$REPO_ROOT/packages/skills/metabot"

STAGE_DIR="$CLI_PKG_DIR/dist-pack"
TARBALL_NAME="latest.tgz"

VERSION="$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').version)")"

echo "==> Cleaning stage dir: $STAGE_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/skills/metabot"

# esbuild is hoisted into the root node_modules (Vite brings it in). We resolve
# the binary explicitly so this script doesn't depend on PATH or a workspace
# install having happened in packages/cli/.
ESBUILD_BIN="$REPO_ROOT/node_modules/.bin/esbuild"
if [[ ! -x "$ESBUILD_BIN" ]]; then
  echo "error: esbuild not found at $ESBUILD_BIN — run 'npm install' at repo root first" >&2
  exit 1
fi

echo "==> Bundling CLI with esbuild (target=node22, format=esm)"
"$ESBUILD_BIN" \
  "$CLI_PKG_DIR/scripts/standalone-entry.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --banner:js='#!/usr/bin/env node' \
  --outfile="$STAGE_DIR/bundle.mjs" \
  --log-level=warning

chmod +x "$STAGE_DIR/bundle.mjs"

echo "==> Writing tarball package.json (no deps, bin=metabot)"
cat > "$STAGE_DIR/package.json" <<EOF
{
  "name": "metabot-cli",
  "version": "$VERSION",
  "description": "metabot — CLI dispatcher (self-contained bundle).",
  "type": "module",
  "bin": { "metabot": "./bundle.mjs" },
  "files": ["bundle.mjs", "skills"],
  "engines": { "node": ">=20" }
}
EOF

echo "==> Copying complete bundled metabot Skill"
cp -R "$SKILL_SRC_DIR/." "$STAGE_DIR/skills/metabot/"

echo "==> Running npm pack in stage dir"
mkdir -p "$SERVER_STATIC_DIR"
PACKED_FILE="$(cd "$STAGE_DIR" && npm pack --silent)"
PACKED_PATH="$STAGE_DIR/$PACKED_FILE"

# Atomic publish: write the .new sibling, then mv. rsync mid-deploy can't catch
# a half-written tarball this way.
echo "==> Publishing to $SERVER_STATIC_DIR/$TARBALL_NAME (atomic)"
mv "$PACKED_PATH" "$SERVER_STATIC_DIR/$TARBALL_NAME.new"
mv "$SERVER_STATIC_DIR/$TARBALL_NAME.new" "$SERVER_STATIC_DIR/$TARBALL_NAME"

# Sync the installer script as well — single source of truth lives next to the
# CLI sources so changes flow through the same MR.
echo "==> Publishing install.sh"
cp "$CLI_PKG_DIR/install-cli.sh" "$SERVER_STATIC_DIR/install.sh.new"
mv "$SERVER_STATIC_DIR/install.sh.new" "$SERVER_STATIC_DIR/install.sh"
chmod +x "$SERVER_STATIC_DIR/install.sh"

# Clean up stage dir — keeps `npm run clean` minimal.
rm -rf "$STAGE_DIR"

SIZE="$(ls -lh "$SERVER_STATIC_DIR/$TARBALL_NAME" | awk '{print $5}')"
echo "==> Done. metabot-cli@$VERSION → $SERVER_STATIC_DIR/$TARBALL_NAME ($SIZE)"
