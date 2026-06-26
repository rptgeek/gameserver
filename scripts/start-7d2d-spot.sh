#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ $# -eq 0 ]]; then
  exec "${SCRIPT_DIR}/start-game-spot.sh" "7d2d"
fi
exec "${SCRIPT_DIR}/start-game-spot.sh" "$@"
