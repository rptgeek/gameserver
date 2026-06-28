#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGE="${STAGE:-dev}"
PROJECT_NAME="${PROJECT_NAME:-gameserver}"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
AWS_PROFILE="${AWS_PROFILE:-}"
FRONTEND_DIR="${FRONTEND_DIR:-frontend}"
AUTO_INVALIDATE="${AUTO_INVALIDATE:-1}"

STACK_NAME="${PROJECT_NAME}-${STAGE}"

PROFILE_ARGS=()
if [[ -n "${AWS_PROFILE}" ]]; then
  PROFILE_ARGS+=(--profile "$AWS_PROFILE")
fi

run_aws() {
  aws --region "$AWS_REGION" "${PROFILE_ARGS[@]}" "$@"
}

require_output() {
  local key="$1"
  local value
  value=$(run_aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='$key'].OutputValue" --output text)
  if [[ -z "$value" || "$value" == "None" ]]; then
    echo "Missing CloudFormation output '$key' for stack $STACK_NAME"
    exit 1
  fi
  echo "$value"
}

echo "Preparing frontend deploy for ${STACK_NAME} in ${AWS_REGION}..."
cd "$ROOT_DIR"

echo "Resolving stack outputs..."
FRONTEND_BUCKET=$(require_output FrontendBucketName)
API_BASE_URL=$(require_output ApiBaseUrl)
CLOUDFRONT_URL=$(require_output CloudFrontUrl)
COGNITO_USER_POOL_ID=$(require_output UserPoolId)
COGNITO_USER_POOL_CLIENT_ID=$(require_output UserPoolClientId)
COGNITO_DOMAIN=$(require_output CognitoDomain)

echo "Building frontend with Cognito/API integration values..."
cd "$ROOT_DIR/$FRONTEND_DIR"
VITE_API_BASE_URL="${VITE_API_BASE_URL:-$API_BASE_URL}" \
VITE_COGNITO_USER_POOL_ID="${VITE_COGNITO_USER_POOL_ID:-$COGNITO_USER_POOL_ID}" \
VITE_COGNITO_USER_POOL_CLIENT_ID="${VITE_COGNITO_USER_POOL_CLIENT_ID:-$COGNITO_USER_POOL_CLIENT_ID}" \
VITE_COGNITO_REGION="${VITE_COGNITO_REGION:-$AWS_REGION}" \
VITE_COGNITO_DOMAIN="${VITE_COGNITO_DOMAIN:-$COGNITO_DOMAIN}" \
VITE_COGNITO_REDIRECT_SIGN_IN="${VITE_COGNITO_REDIRECT_SIGN_IN:-$CLOUDFRONT_URL}" \
VITE_COGNITO_REDIRECT_SIGN_OUT="${VITE_COGNITO_REDIRECT_SIGN_OUT:-$CLOUDFRONT_URL}" \
VITE_COGNITO_OAUTH_SCOPES="${VITE_COGNITO_OAUTH_SCOPES:-openid email profile}" \
npm run build

echo "Syncing frontend assets to s3://$FRONTEND_BUCKET..."
run_aws s3 sync dist/ "s3://$FRONTEND_BUCKET" --delete

if [[ "$AUTO_INVALIDATE" == "1" ]]; then
  CLOUDFRONT_DOMAIN="${CLOUDFRONT_URL#https://}"
  DISTRIBUTION_ID=$(run_aws cloudfront list-distributions --query "DistributionList.Items[?DomainName=='$CLOUDFRONT_DOMAIN'].Id" --output text)

  if [[ -n "$DISTRIBUTION_ID" && "$DISTRIBUTION_ID" != "None" ]]; then
    echo "Invalidating CloudFront distribution $DISTRIBUTION_ID..."
    run_aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*'
  else
    echo "CloudFront distribution not found for domain $CLOUDFRONT_DOMAIN; skipping invalidation."
  fi
fi

echo "Frontend deploy complete."
