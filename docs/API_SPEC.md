# API Specification: Spot Control Plane (v1)

## Contract summary

- Base path: `/v1`
- Transport: HTTPS + JSON
- Auth: Cognito bearer token in `Authorization: Bearer <JWT>`
- All mutating calls are asynchronous and return an `operationId`.
- `requestId` header enables idempotent retries.

## Error envelope

All errors return:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "human readable detail",
    "details": {}
  }
}
```

## Data contracts

### `GameProfileRef`

```json
{
  "gameName": "7d2d",
  "profile": "7d2d",
  "region": "us-east-1",
  "source": "file|path",
  "createdAt": "2026-06-27T00:00:00Z",
  "version": "string"
}
```

### `StartInstanceRequest`

```json
{
  "gameName": "7d2d",
  "profile": "7d2d",
  "instanceType": "c7i.xlarge",
  "region": "us-east-1",
  "branch": "latest_experimental",
  "allowDuplicate": false,
  "dryRun": false,
  "metadata": {
    "ticket": "SR-2048",
    "requestedBy": "ops-123"
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### `StartInstanceResponse`

```json
{
  "operationId": "op-7d2d-start-20260627-001",
  "state": "accepted",
  "gameName": "7d2d",
  "requestedInstanceType": "c7i.xlarge",
  "requestId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### `InstanceState`

```json
{
  "instanceId": "i-0123456789abcdef0",
  "gameName": "7d2d",
  "gameService": "7d2d",
  "awsRegion": "us-east-1",
  "state": "running",
  "lifecycleState": "SERVER_ACTIVE",
  "publicIp": "203.0.113.10",
  "privateIp": "10.0.1.10",
  "instanceType": "c7i.xlarge",
  "availabilityZone": "us-east-1a",
  "launchTime": "2026-06-27T14:03:22Z",
  "statusService": "active"
}
```

### `InstanceOperation`

```json
{
  "operationId": "op-7d2d-stop-20260627-002",
  "type": "start|stop|status|backup",
  "targetInstanceId": "i-0123456789abcdef0",
  "gameName": "7d2d",
  "state": "running|succeeded|failed|cancelled|blocked",
  "createdBy": "ops-user-id",
  "createdAt": "2026-06-27T14:04:00Z",
  "updatedAt": "2026-06-27T14:04:03Z",
  "errorCode": "STATE_CONFLICT|AWS_ERROR|UNKNOWN",
  "retryable": true
}
```

### `LegacyInstanceState`

```json
{
  "GAME_NAME": "7d2d",
  "GAME_SERVICE": "7d2d",
  "INSTANCE_ID": "i-0123456789abcdef0",
  "AWS_REGION": "us-east-1",
  "WORLD_BUCKET": "gameserver-state-example",
  "S3_PREFIX": "servers",
  "SELECTED_INSTANCE_TYPE": "c7i.xlarge"
}
```

This mirrors current state-file format used during migration.

## Endpoints

### 1) `POST /v1/instances`

Starts a game instance.

#### Request

- body: `StartInstanceRequest`
- idempotency: optional `Idempotency-Key` header or `requestId` body field

#### Success

- `202 Accepted`

```json
{
  "operationId": "op-7d2d-start-20260627-001",
  "state": "running"
}
```

#### Errors

- `409 INSTANCE_LIMIT_EXCEEDED`
- `409 STATE_CONFLICT`
- `400 INVALID_INSTANCE_TYPE`

### 2) `GET /v1/instances`

Returns all instances tracked by control-plane for all games.

#### Success

- `200 OK` with array of `InstanceState`.

### 3) `GET /v1/instances/{instanceId}`

Returns full `InstanceState` plus `lastOperations`.

- `200 OK` success
- `404 INSTANCE_NOT_FOUND` when AWS has no matching instance and no cached state

### 4) `POST /v1/instances/{instanceId}:stop`

Stops an active instance and issues SSM in-band backup when possible.

```json
{
  "graceful": true,
  "timeoutSeconds": 30,
  "deleteStateFile": true,
  "force": false
}
```

- `202 Accepted` success
- `409 INSTANCE_ALREADY_STOPPED` for already-stopped states
- `400 INVALID_INSTANCE_ID` on malformed ids

### 5) `POST /v1/games/{gameName}:migrate-legacy`

Performs control-plane migration from legacy state sources.

```json
{
  "source": "auto|legacy-dot7d2d|state-file",
  "dryRun": false
}
```

- `200 OK` with migration result summary
- `404 LEGACY_STATE_NOT_FOUND`

### 6) `GET /v1/operations/{operationId}`

Returns `InstanceOperation`.

- `200 OK` success
- `404 OPERATION_NOT_FOUND`

### 7) `GET /v1/instances/{instanceId}/logs`

Returns log snapshots by source:

```
source=cloud-init|runtime|journal|ssm
tail=120
```

- `200 OK` success
- `404 LOG_SOURCE_NOT_CONFIGURED`

## Error code matrix

| HTTP | Code | Meaning | Retry |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | malformed request or missing required fields | no |
| 400 | `INVALID_GAME` | game or profile unknown | no |
| 401 | `AUTH_REQUIRED` | missing/invalid token | no |
| 403 | `FORBIDDEN` | token valid but insufficient action permission | no |
| 404 | `INSTANCE_NOT_FOUND` | instance id missing in AWS and cache | no |
| 404 | `GAME_NOT_FOUND` | no matching profile or state | no |
| 409 | `STATE_CONFLICT` | start request when active instance exists and `allowDuplicate=false` | maybe |
| 409 | `INSTANCE_LIMIT_EXCEEDED` | 2+ active instances for same game without explicit allow duplicate | operator decision |
| 409 | `INSTANCE_ALREADY_STOPPING` | stop requested while stop already in progress | no |
| 409 | `OPERATION_ALREADY_RUNNING` | duplicate non-idempotent request | maybe |
| 409 | `RESOURCE_STALE` | stale `.game-spot` state references missing instance | after reconciliation |
| 429 | `RATE_LIMITED` | request throttled | yes |
| 500 | `INTERNAL_ERROR` | unexpected control-plane failure | maybe |
| 502 | `AWS_PROVIDER_ERROR` | AWS API / SSM failure | yes |
| 503 | `SERVICE_BUSY` | stop/repair in progress lock held | retry later |
| 503 | `CLOUD_INIT_TIMEOUT` | bootstrap never reached service start window | yes |

## Response codes

- `200` GET success / synchronous reads.
- `202` mutating operations accepted asynchronously.
- `400/401/403/404/409/429/500/502/503` as above.
