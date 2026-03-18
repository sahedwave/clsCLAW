#!/bin/bash
set -e
echo ""
echo "  Codex Local v4"
echo "  =========================="
node --version | grep -qE "v(1[89]|[2-9][0-9])\." || { echo "  Node 18+ required"; exit 1; }
echo "  Node $(node -v) ✓"
command -v docker &>/dev/null && docker info &>/dev/null 2>&1 && echo "  Docker ✓ (full sandbox mode)" || echo "  Docker not found → restricted mode"
echo ""
node src/server.js
