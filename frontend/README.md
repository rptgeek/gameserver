# 7d2d Frontend (Vite + React + TypeScript)

This frontend implements:

- Cognito sign-in / sign-out with AWS Amplify Hosted UI (`signInWithRedirect`).
- Game + instance dashboard with filtering and instance actions.
- Instance detail panel with Overview, Bootstrap Logs, Server Logs, and Config tabs.
- Operations polling against `/v1/operations/{id}` after start/stop/restart/terminate/config actions.
- Raw JSON config editor (`apply` and `applyAndRestart` modes).
- Logs viewer with pagination token support and optional live streaming.
- Add-instance modal and global toast notifications.

## Environment variables

Create `.env.local` (or set in your shell) with:

- `VITE_API_BASE_URL` (default: `/api`)
- `VITE_COGNITO_REGION`
- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_USER_POOL_CLIENT_ID`
- `VITE_COGNITO_DOMAIN`
- `VITE_COGNITO_REDIRECT_SIGN_IN` (optional, defaults to app origin)
- `VITE_COGNITO_REDIRECT_SIGN_OUT` (optional, defaults to app origin)
- `VITE_COGNITO_OAUTH_SCOPES` (optional, defaults `openid email profile`)

## API contract expected by the UI

The app expects these endpoints:

- `GET /v1/games`
- `GET /v1/instances` (`gameId` optionally filtered)
- `GET /v1/instances/{instanceId}`
- `POST /v1/instances/{instanceId}/start`
- `POST /v1/instances/{instanceId}/stop`
- `POST /v1/instances/{instanceId}/restart`
- `POST /v1/instances/{instanceId}/terminate`
- `GET /v1/operations/{operationId}`
- `GET /v1/instances/{instanceId}/config`
- `PATCH /v1/instances/{instanceId}/config`
- `GET /v1/instances/{instanceId}/logs/{bootstrap|server}`
- `GET /v1/instances/{instanceId}/logs/{bootstrap|server}/stream`
- `POST /v1/instances`

JWTs are read from Amplify session and sent as `Authorization: Bearer <token>`.

## Run

```bash
cd frontend
npm install
npm run dev
```

For production:

```bash
npm run build
```

## Notes

- Logs endpoint pagination expects `nextToken` in the response to continue reading.
- Live mode uses `/stream` and appends lines as they arrive; auto-refresh is disabled automatically while streaming.
- If the Cognito variables are not configured, the UI still renders but sign-in is disabled by environment validation.
