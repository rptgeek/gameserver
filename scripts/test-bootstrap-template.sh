#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${SCRIPT_DIR}/../infra/assets/bootstrap.sh.tmpl"

bash -n "${TEMPLATE_PATH}"

awk '
  /cat > "\/opt\/\$\{GAME_SERVICE\}-tools\/start-server.command" <<'\''EOS'\''/ {
    in_start_server = 1
  }
  in_start_server && /^EOS$/ {
    in_start_server = 0
    next
  }
  /^run_baked_ami_builder\(\)/ {
    function_count += 1
    if (in_start_server) {
      print "run_baked_ami_builder must be in the main bootstrap scope" > "/dev/stderr"
      exit 1
    }
  }
  END {
    if (function_count != 1) {
      print "expected exactly one run_baked_ami_builder definition" > "/dev/stderr"
      exit 1
    }
  }
' "${TEMPLATE_PATH}"

grep -Fq 'cat >> "/opt/${GAME_SERVICE}-tools/start-server.command" <<'\''EOS'\''' "${TEMPLATE_PATH}"

echo "Bootstrap template validation passed."
