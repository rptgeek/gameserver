#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAME_PROFILES_DIR="${GAME_PROFILES_DIR:-${SCRIPT_DIR}/game-profiles}"
STATE_DIR="${STATE_DIR:-${SCRIPT_DIR}/.game-spot}"

aws_cmd=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_cmd+=(--profile "$AWS_PROFILE")
fi

TARGET="${1:-}"
if [[ "${TARGET}" == i-* ]]; then
  INSTANCE_ID="$TARGET"
  GAME_NAME="${2:-${GAME_NAME:-}}"
elif [[ -n "${TARGET}" ]]; then
  GAME_NAME="$TARGET"
  INSTANCE_ID="${2:-}"
else
  GAME_NAME="${GAME_NAME:-}"
  INSTANCE_ID="${INSTANCE_ID:-}"
fi

if [[ -z "${GAME_NAME}" && -z "${INSTANCE_ID}" ]]; then
  echo "Usage: ./stop-game-spot.sh <game_name>|<instance-id> [instance-id]" >&2
  echo "Example: ./stop-game-spot.sh 7d2d" >&2
  echo "Example: ./stop-game-spot.sh i-0123456789abcdef0 7d2d" >&2
  exit 1
fi

if [[ -n "${GAME_NAME:-}" ]]; then
  PROFILE_PATH="${GAME_PROFILES_DIR}/${GAME_NAME}.env"
  if [[ -f "$PROFILE_PATH" ]]; then
    set -a
    . "$PROFILE_PATH"
    set +a
  fi
fi

if [[ -z "${GAME_NAME:-}" && -n "${INSTANCE_ID:-}" ]]; then
  echo "No game name provided. Backup-before-stop requires GAME_NAME for in-band SSM command path." >&2
fi

GAME_SERVICE="${GAME_NAME//[^A-Za-z0-9-]/-}"
GAME_SERVICE="${GAME_SERVICE,,}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/${GAME_SERVICE}.state}"

if [[ -z "${INSTANCE_ID}" && -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

if [[ -z "${INSTANCE_ID:-}" && "${GAME_NAME:-}" == "7d2d" ]]; then
  LEGACY_STATE_FILE="${SCRIPT_DIR}/.7d2d-spot/instance.state"
  if [[ -f "$LEGACY_STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    . "$LEGACY_STATE_FILE"
  fi
fi

if [[ -z "${INSTANCE_ID:-}" ]]; then
  echo "No instance id found." >&2
  exit 1
fi

REGION="${AWS_REGION:-us-east-1}"
REGION_ARGS=(--region "$REGION")

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1, printing actions for ${INSTANCE_ID}" >&2
  echo "${aws_cmd[*]} ec2 describe-instances --region ${REGION} --instance-ids ${INSTANCE_ID}"
  exit 0
fi

INSTANCE_STATE="$( \
  "${aws_cmd[@]}" "${REGION_ARGS[@]}" ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --query "Reservations[].Instances[].State.Name" \
    --output text \
  )" || INSTANCE_STATE=""

if [[ -n "${GAME_NAME:-}" && ( "${INSTANCE_STATE}" == "running" || "${INSTANCE_STATE}" == "pending" ) ]]; then
  UPLOAD_COMMAND="/opt/${GAME_SERVICE}-tools/upload-state.sh"
  echo "Requesting in-band backup on ${INSTANCE_ID} via SSM."
  "${aws_cmd[@]}" "${REGION_ARGS[@]}" ssm send-command \
    --document-name AWS-RunShellScript \
    --instance-ids "$INSTANCE_ID" \
    --comment "${GAME_NAME} graceful backup before stop" \
    --parameters commands="[\"${UPLOAD_COMMAND}\"]" >/tmp/game-spot-stop-cmd.out 2>&1 || true
fi

echo "Terminating ${INSTANCE_ID}."
"${aws_cmd[@]}" "${REGION_ARGS[@]}" ec2 terminate-instances \
  --instance-ids "$INSTANCE_ID" >/dev/null

if [[ "${DELETE_STATE_FILE:-1}" != "0" && -n "${GAME_NAME:-}" ]]; then
  rm -f "$STATE_FILE"
fi

echo "Instance ${INSTANCE_ID} termination requested."
