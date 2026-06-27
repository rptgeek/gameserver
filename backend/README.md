# Web Console API (Backend)

Node.js + TypeScript service for the console control plane.

## Setup

```bash
cd /Users/garypope/Projects/Jajoga/7d2d/backend
npm install
npm run build
npm run start
```

Default local port: `3000` unless `PORT` is set.

## Environment Variables

### General

- `PORT` - HTTP port (default `3000`).
- `NODE_ENV` - runtime environment.
- `AWS_REGION` or `AWS_DEFAULT_REGION` - AWS region for AWS SDK clients.

### Cognito / Auth

- `AUTH_DISABLED` - set `true` to skip token verification for local development.
- `COGNITO_REGION` - region where user pool exists.
- `COGNITO_USER_POOL_ID` - Cognito user pool ID for JWKS verification.
- `COGNITO_CLIENT_ID` - Cognito App Client ID for `aud` verification.
- `COGNITO_ISSUER` - optional issuer override.
- `DEFAULT_AUTH_ROLE` - role assigned when `AUTH_DISABLED=true` (default `admin`).

`custom:role` JWT claim is used for RBAC.

### DynamoDB

- `DYNAMO_TABLE_GAMES` - default `games`
- `DYNAMO_TABLE_INSTANCES` - default `instances`
- `DYNAMO_TABLE_OPERATIONS` - default `operations`
- `DYNAMO_TABLE_CONFIG_HISTORY` - default `config_history`

### EC2

- `EC2_DEFAULT_INSTANCE_TYPE` - default AMI launch type (default `t3.micro`)
- `EC2_DEFAULT_AMI_ID` - required unless AMI is supplied per create request
- `EC2_DEFAULT_SUBNET_ID`
- `EC2_DEFAULT_SECURITY_GROUP_IDS` - comma-separated list

### SSM

- `SSM_BOOTSTRAP_DOCUMENT` - default `7d2d-bootstrap`
- `SSM_UPDATE_DOCUMENT` - default `7d2d-update`

### Logs

- `CW_LOG_GROUP_SERVER_PREFIX` - default `/7d2d/server`
- `CW_LOG_GROUP_BOOTSTRAP_PREFIX` - default `/7d2d/bootstrap`

## API Endpoints

All endpoints return JSON.

- `GET /health`
- `GET /v1/games`
- `GET /v1/instances`
- `GET /v1/instances/:instanceId`
- `POST /v1/instances`
  - Accepts a single definition object or `{ instances: [...] }` for bulk creation.
  - Supports `idempotency-key` header to deduplicate requests.
- `POST /v1/instances/:instanceId/action` with `{ action: start|stop|restart|terminate|reboot }`
  - `restart` and `terminate` require `custom:role=admin`.
- `GET /v1/instances/:instanceId/status`
- `GET /v1/instances/:instanceId/logs?source=bootstrap|server&nextToken&limit`
- `POST /v1/instances/:instanceId/logs/stream`
- `GET /v1/instances/:instanceId/config`
- `PATCH /v1/instances/:instanceId/config`
  - Supports optional `action: bootstrap|update` to launch SSM command documents.
- `GET /v1/operations/:operationId`

## Notes

- Uses AWS SDK v3 clients for EC2, SSM, CloudWatch Logs, and DynamoDB.
- Operations are stored in DynamoDB and keyed by operation id.
- Idempotency keys are persisted in the `operations` table using an `idempotency#<KEY>` record that points to an operation id.
- `/v1/instances/:instanceId/status` falls back to EC2 instance state if command state records are unavailable.
