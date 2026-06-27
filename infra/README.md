# 7d2d Infrastructure (CDK)

This folder contains a TypeScript AWS CDK scaffold for the deployment baseline requested in subtask 3.

## What is provisioned

- Cognito User Pool with hosted UI client/domain and callback/logout placeholders.
- API Gateway HTTP API with Cognito JWT authorizer and proxy integration to backend.
- ECS Fargate backend service behind ALB (supports long-running backend calls and streaming-style traffic patterns through container runtime).
- S3 website bucket with CloudFront distribution for frontend hosting.
- DynamoDB tables:
  - `games`
  - `instances`
  - `operations`
  - `config_history`
- IAM task role policy scope for EC2, SSM, CloudWatch and DynamoDB.
- Stack outputs for API endpoint and CloudFront URL.

## 5-10 step deployment

1. Set deployment context
   - `export STAGE=dev`
   - `export AWS_PROFILE=<your-profile>` (optional)
   - `export FRONTEND_DOMAIN_NAME=frontend.example.com` (optional, placeholder for hosted UI callbacks/domain hints)
2. Install dependencies
   - `cd infra`
   - `npm install`
3. (Optional) tune environment placeholders
   - `export BACKEND_IMAGE=123456789012.dkr.ecr.us-east-1.amazonaws.com/backend:latest`
   - `export COGNITO_DOMAIN_PREFIX=7d2d-dev-auth`
   - `export API_ALLOWED_ORIGINS=http://localhost:3000,https://frontend.example.com`
   - `export BACKEND_CONTAINER_ENV='{"LOG_LEVEL":"debug","FEATURE_FLAG_X":"true"}'`
4. Bootstrap AWS account (if first time)
   - `./bin/deploy.sh --bootstrap`
5. Validate synthesized template
   - `npx cdk synth --context stage=$STAGE`
6. Deploy the stack
   - `./bin/deploy.sh`
7. Upload frontend assets to S3
   - `aws s3 sync <frontend-dist-path> s3://$(aws cloudformation describe-stacks --stack-name 7d2d-dev --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" --output text) --delete`
8. Point frontend domain to CloudFront output and test callbacks
   - Use output `CloudFrontUrl` for static hosting and update OAuth callback/logout URLs.
9. Update backend env with runtime values
   - Set real Cognito/API/DB variables by editing your CI/CD env list and redeploying if required.

## Parameterized placeholders

The stack reads values from both environment variables and `cdk.json` context:

- `STAGE`, `PROJECT_NAME`
- `FRONTEND_DOMAIN_NAME`, `API_DOMAIN_NAME`, `COGNITO_DOMAIN_PREFIX`
- `COGNITO_CALLBACK_URLS`, `COGNITO_LOGOUT_URLS`, `API_ALLOWED_ORIGINS`
- `BACKEND_IMAGE`, `BACKEND_CONTAINER_PORT`, `BACKEND_CPU`, `BACKEND_MEMORY_MIB`, `BACKEND_DESIRED_COUNT`, `BACKEND_HEALTH_CHECK_PATH`
- `BACKEND_CONTAINER_ENV` for backend container environment overrides

## Logs migration note (bootstrap runtime -> CloudWatch Logs)

- Backend container logs are already routed through ECS `awslogs` to `/aws/ecs/<project>-<stage>-backend` with 7-day retention.
- If bootstrap/runtime init logic currently writes to local files, migrate to stdout or explicit logging by:
  - Keeping bootstrap output in `console.log`/`console.error`, and
  - Ensuring bootstrap command runs in the same ECS task definition that uses the `awslogs` log driver.
- For stricter migration, add a bootstrap wrapper command that streams structured JSON to stdout so existing CW Logs insight queries can be reused without parsing file artifacts.

