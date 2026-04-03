#!/bin/bash
set -e
echo ""
echo "  clsClaw Local v4"
echo "  =========================="
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js was not found in PATH"
  echo "  Install Node.js 18+ and re-run this script"
  exit 1
fi
if [ ! -f src/server.js ]; then
  echo "  Run this script from the clsClaw directory"
  exit 1
fi
node --version | grep -qE "v(1[89]|[2-9][0-9])\." || { echo "  Node 18+ required"; exit 1; }
echo "  Node $(node -v) ✓"
command -v docker &>/dev/null && docker info &>/dev/null 2>&1 && echo "  Docker ✓ (full sandbox mode)" || echo "  Docker not found → restricted mode"
echo ""
echo "  Server starting at http://localhost:3737"
node src/server.js
