#!/usr/bin/env bash
# Install the RLM plugin for OpenCode (global, user-level).
set -euo pipefail

PLUGIN_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$PLUGIN_DIR/plugins" "$PLUGIN_DIR/rlm-kernel"

cp "$SRC/plugin/rlm.ts" "$PLUGIN_DIR/plugins/rlm.ts"
cp "$SRC/kernel/kernel.py" "$PLUGIN_DIR/rlm-kernel/kernel.py"

echo "Installed:"
echo "  $PLUGIN_DIR/plugins/rlm.ts"
echo "  $PLUGIN_DIR/rlm-kernel/kernel.py"
echo
echo "Restart opencode to load the plugin (plugins load at startup)."
echo "Optional: RLM_KERNEL_PYTHON=/path/to/python3 to pick the interpreter."