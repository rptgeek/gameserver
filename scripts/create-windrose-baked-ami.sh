#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAME_PROFILES_DIR="${GAME_PROFILES_DIR:-${SCRIPT_DIR}/game-profiles}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/create-windrose-baked-ami.sh INSTANCE_ID [options]

Options:
  --profile NAME       Read AWS_REGION and WORLD_BUCKET from game-profiles/NAME.env.
                       Defaults to windrose.
  --region REGION      Override AWS region.
  --bucket BUCKET      Override world-state S3 bucket.
  --world-prefix PREFIX
                       Override the world prefix. Defaults to the instance WorldPrefix tag.
  --name NAME          Override AMI name.
  --wait               Wait until the AMI is available.
  -h, --help           Show this help.

The Game Fleet backend will use AMIs tagged with the matching WindroseDeploymentId,
BootstrapSchemaVersion, MonitorPatchVersion, and WindroseDockerImage values.
USAGE
}

INSTANCE_ID="${1:-}"
if [[ "${INSTANCE_ID}" == "-h" || "${INSTANCE_ID}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == --* ]]; then
  usage >&2
  exit 1
fi
shift

PROFILE_NAME="windrose"
REGION_OVERRIDE=""
BUCKET_OVERRIDE=""
WORLD_PREFIX_OVERRIDE=""
AMI_NAME_OVERRIDE=""
WAIT_FOR_AMI=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE_NAME="${2:?Missing value for --profile}"
      shift 2
      ;;
    --region)
      REGION_OVERRIDE="${2:?Missing value for --region}"
      shift 2
      ;;
    --bucket)
      BUCKET_OVERRIDE="${2:?Missing value for --bucket}"
      shift 2
      ;;
    --world-prefix)
      WORLD_PREFIX_OVERRIDE="${2:?Missing value for --world-prefix}"
      shift 2
      ;;
    --name)
      AMI_NAME_OVERRIDE="${2:?Missing value for --name}"
      shift 2
      ;;
    --wait)
      WAIT_FOR_AMI=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

PROFILE_PATH="${GAME_PROFILES_DIR}/${PROFILE_NAME}.env"
if [[ -f "${PROFILE_PATH}" ]]; then
  # shellcheck disable=SC1090
  source "${PROFILE_PATH}"
fi

AWS_REGION="${REGION_OVERRIDE:-${AWS_REGION:-us-east-1}}"
WORLD_BUCKET="${BUCKET_OVERRIDE:-${WORLD_BUCKET:-}}"
if [[ -z "${WORLD_BUCKET}" ]]; then
  echo "WORLD_BUCKET is required via profile or --bucket." >&2
  exit 1
fi

WORLD_PREFIX="${WORLD_PREFIX_OVERRIDE:-}"
if [[ -z "${WORLD_PREFIX}" ]]; then
  WORLD_PREFIX="$(
    aws ec2 describe-instances \
      --region "${AWS_REGION}" \
      --instance-ids "${INSTANCE_ID}" \
      --query 'Reservations[0].Instances[0].Tags[?Key==`WorldPrefix`].Value | [0]' \
      --output text
  )"
fi
if [[ -z "${WORLD_PREFIX}" || "${WORLD_PREFIX}" == "None" ]]; then
  echo "Could not resolve WorldPrefix from instance tag. Pass --world-prefix." >&2
  exit 1
fi

DEPLOYMENT_ID="$(
  aws s3 cp "s3://${WORLD_BUCKET}/${WORLD_PREFIX}/config/windrose/ServerDescription.json" - \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("DeploymentId", ""))'
)"
if [[ -z "${DEPLOYMENT_ID}" ]]; then
  echo "Could not read DeploymentId from s3://${WORLD_BUCKET}/${WORLD_PREFIX}/config/windrose/ServerDescription.json." >&2
  exit 1
fi

BOOTSTRAP_SCHEMA_VERSION="2026-07-28-fast-ami-v1"
MONITOR_PATCH_VERSION="2026-07-27-source-footer-v1"
WINDROSE_DOCKER_IMAGE="windroseserver/windroseserver:latest"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
AMI_NAME="${AMI_NAME_OVERRIDE:-windrose-${DEPLOYMENT_ID}-${TIMESTAMP}}"

AMI_ID="$(
  aws ec2 create-image \
    --region "${AWS_REGION}" \
    --instance-id "${INSTANCE_ID}" \
    --name "${AMI_NAME}" \
    --description "Windrose baked game-server AMI for deployment ${DEPLOYMENT_ID}" \
    --tag-specifications \
      "ResourceType=image,Tags=[{Key=ManagedBy,Value=7d2d-console},{Key=GameId,Value=windrose},{Key=AmiRole,Value=game-server},{Key=WindroseDeploymentId,Value=${DEPLOYMENT_ID}},{Key=WindroseDockerImage,Value=${WINDROSE_DOCKER_IMAGE}},{Key=BootstrapSchemaVersion,Value=${BOOTSTRAP_SCHEMA_VERSION}},{Key=MonitorPatchVersion,Value=${MONITOR_PATCH_VERSION}},{Key=SourceInstanceId,Value=${INSTANCE_ID}},{Key=WorldPrefix,Value=${WORLD_PREFIX}}]" \
      "ResourceType=snapshot,Tags=[{Key=ManagedBy,Value=7d2d-console},{Key=GameId,Value=windrose},{Key=AmiRole,Value=game-server},{Key=WindroseDeploymentId,Value=${DEPLOYMENT_ID}},{Key=SourceInstanceId,Value=${INSTANCE_ID}}]" \
    --query ImageId \
    --output text
)"

echo "Created Windrose baked AMI request: ${AMI_ID}"
echo "DeploymentId: ${DEPLOYMENT_ID}"
echo "WorldPrefix: ${WORLD_PREFIX}"

if [[ "${WAIT_FOR_AMI}" == "1" ]]; then
  echo "Waiting for ${AMI_ID} to become available..."
  aws ec2 wait image-available --region "${AWS_REGION}" --image-ids "${AMI_ID}"
  echo "AMI available: ${AMI_ID}"
fi
