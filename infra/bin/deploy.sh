#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

STAGE="${STAGE:-${1:-dev}}"
AWS_PROFILE="${AWS_PROFILE:-}"
CDK_CONTEXT_ARGS=(
  --context stage="${STAGE}"
  --context projectName="${PROJECT_NAME:-7d2d}"
)

if [[ -n "${FRONTEND_DOMAIN_NAME:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context frontendDomainName="$FRONTEND_DOMAIN_NAME")
fi
if [[ -n "${API_DOMAIN_NAME:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context apiDomainName="$API_DOMAIN_NAME")
fi
if [[ -n "${BACKEND_IMAGE:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendImage="$BACKEND_IMAGE")
fi
if [[ -n "${BACKEND_CONTAINER_PORT:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendContainerPort="$BACKEND_CONTAINER_PORT")
fi
if [[ -n "${BACKEND_CPU:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendCpu="$BACKEND_CPU")
fi
if [[ -n "${BACKEND_MEMORY_MIB:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendMemoryMiB="$BACKEND_MEMORY_MIB")
fi
if [[ -n "${BACKEND_DESIRED_COUNT:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendDesiredCount="$BACKEND_DESIRED_COUNT")
fi
if [[ -n "${BACKEND_HEALTH_CHECK_PATH:-}" ]]; then
  CDK_CONTEXT_ARGS+=(--context backendHealthCheckPath="$BACKEND_HEALTH_CHECK_PATH")
fi

PROFILE_FLAG=()
if [[ -n "${AWS_PROFILE}" ]]; then
  PROFILE_FLAG=(--profile "$AWS_PROFILE")
fi

if command -v cdk >/dev/null 2>&1; then
  CDK_CMD=cdk
else
  CDK_CMD="npx cdk"
fi

if [[ "${2:-}" == "--bootstrap" ]]; then
  $CDK_CMD "${PROFILE_FLAG[@]}" bootstrap "${CDK_CONTEXT_ARGS[@]}"
fi

npm install
$CDK_CMD synth "${CDK_CONTEXT_ARGS[@]}" "${PROFILE_FLAG[@]}"
$CDK_CMD deploy "${CDK_CONTEXT_ARGS[@]}" "${PROFILE_FLAG[@]}" --require-approval never
