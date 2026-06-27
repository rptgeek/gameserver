#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAME_PROFILES_DIR="${GAME_PROFILES_DIR:-${SCRIPT_DIR}/game-profiles}"
STATE_DIR="${STATE_DIR:-${SCRIPT_DIR}/.game-spot}"

usage() {
  cat <<'USAGE'
Usage:
  ./status-game-spot.sh [game_name|instance-id] [options]

Options:
  --profile NAME       Use profile from game-profiles/NAME.env (e.g. 7d2d-east1)
  --region REGION      AWS region to query (defaults to AWS_REGION/profile region)
  Examples:
  ./status-game-spot.sh 7d2d
  ./status-game-spot.sh i-0123456789abcdef0
  ./status-game-spot.sh 7d2d --lines 120 --cloud-init-lines 200
  ./status-game-spot.sh 7d2d --profile 7d2d-east1
  ./status-game-spot.sh 7d2d --region us-west-2
USAGE
}

LOG_LINES="${LOG_LINES:-80}"
CLOUD_INIT_LINES="${CLOUD_INIT_LINES:-120}"
TARGET="7d2d"
PROFILE_OVERRIDE=""
REGION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --profile" >&2
        usage
        exit 1
      fi
      PROFILE_OVERRIDE="$2"
      shift 2
      ;;
    --region)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --region" >&2
        usage
        exit 1
      fi
      REGION_OVERRIDE="$2"
      shift 2
      ;;
    --lines|-l)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --lines" >&2
        usage
        exit 1
      fi
      LOG_LINES="$2"
      shift 2
      ;;
    --cloud-init-lines)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --cloud-init-lines" >&2
        usage
        exit 1
      fi
      CLOUD_INIT_LINES="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      TARGET="$1"
      shift
      ;;
  esac
done

aws_cmd=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_cmd+=(--profile "$AWS_PROFILE")
fi

GAME_PROFILES_DIR="${GAME_PROFILES_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/game-profiles}"
if [[ -n "${PROFILE_OVERRIDE}" ]]; then
  if [[ -f "$PROFILE_OVERRIDE" ]]; then
    PROFILE_PATH="$PROFILE_OVERRIDE"
  else
    PROFILE_PATH="${GAME_PROFILES_DIR}/${PROFILE_OVERRIDE}.env"
  fi

  if [[ ! -f "$PROFILE_PATH" ]]; then
    echo "Profile not found: ${PROFILE_PATH}" >&2
    exit 1
  fi

  set -a
  . "$PROFILE_PATH"
  set +a
fi

GAME_NAME=""
INSTANCE_ID=""

if [[ "${TARGET}" == i-* ]]; then
  INSTANCE_ID="$TARGET"
else
  GAME_NAME="$TARGET"
  PROFILE_PATH="${GAME_PROFILES_DIR}/${GAME_NAME}.env"
  if [[ -f "$PROFILE_PATH" ]]; then
    set -a
    . "$PROFILE_PATH"
    set +a
  fi
  GAME_SERVICE="${GAME_NAME//[^A-Za-z0-9-]/-}"
  GAME_SERVICE="${GAME_SERVICE,,}"
  STATE_FILE="${STATE_FILE:-${STATE_DIR}/${GAME_SERVICE}.state}"
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi
fi

if [[ -z "${GAME_NAME:-}" ]]; then
  GAME_NAME="7d2d"
  GAME_SERVICE="${GAME_NAME//[^A-Za-z0-9-]/-}"
  GAME_SERVICE="${GAME_SERVICE,,}"
fi

if [[ -z "${INSTANCE_ID:-}" ]]; then
  echo "No instance id found. Start/restore server first or pass an instance id."
  echo "No instance id found." >&2
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"
REGION_ARGS=(--region "$REGION")

echo "=== EC2 instance status (${INSTANCE_ID}) ==="
"${aws_cmd[@]}" "${REGION_ARGS[@]}" ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query "Reservations[].Instances[].{Id:InstanceId,State:State.Name,PublicIp:PublicIpAddress,PrivateIp:PrivateIpAddress,Type:InstanceType,AZ:Placement.AvailabilityZone,LaunchTime:LaunchTime,SecurityGroups:join('; ', SecurityGroups[].GroupId)}" \
  --output table

INSTANCE_STATE="$(
  "${aws_cmd[@]}" "${REGION_ARGS[@]}" ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[].Instances[].State.Name" \
    --output text
)"

if [[ "${INSTANCE_STATE}" != "running" ]]; then
  echo "Instance is not running; skipping live service log checks."
  exit 0
fi

SERVICE="${GAME_SERVICE}-server.service"
SSM_COMMAND="echo '=== service ==='; systemctl is-active ${SERVICE} || true; systemctl status ${SERVICE} --no-pager || true; echo; echo '=== process ==='; pgrep -af ${GAME_NAME} || pgrep -af 7Days || true; echo; echo '=== tail (${LOG_LINES} lines) ==='; journalctl -u ${SERVICE} --no-pager -n ${LOG_LINES} || true; echo; echo '=== cloud-init tail (${CLOUD_INIT_LINES} lines) ==='; tail -n ${CLOUD_INIT_LINES} /var/log/cloud-init-output.log || true"

COMMAND_ID="$("${aws_cmd[@]}" "${REGION_ARGS[@]}" ssm send-command \
  --document-name AWS-RunShellScript \
  --instance-ids "$INSTANCE_ID" \
  --comment "${GAME_NAME} status check" \
  --parameters "{\"commands\":[\"${SSM_COMMAND}\"]}" \
  --query Command.CommandId --output text)"

for _ in $(seq 1 30); do
  STATUS="$("${aws_cmd[@]}" "${REGION_ARGS[@]}" ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query Status \
    --output text 2>/dev/null || true)"

  if [[ "$STATUS" == "Success" || "$STATUS" == "Failed" || "$STATUS" == "Cancelled" || "$STATUS" == "TimedOut" ]]; then
    break
  fi
  sleep 2
done

echo
echo "=== SSM command output (${COMMAND_ID}) ==="
"${aws_cmd[@]}" "${REGION_ARGS[@]}" ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "StandardOutputContent" \
  --output text

ERR_OUTPUT="$("${aws_cmd[@]}" "${REGION_ARGS[@]}" ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query "StandardErrorContent" \
  --output text 2>/dev/null || true)"
if [[ -n "${ERR_OUTPUT}" ]]; then
  echo
  echo "=== SSM command error output ==="
  echo "${ERR_OUTPUT}"
fi
