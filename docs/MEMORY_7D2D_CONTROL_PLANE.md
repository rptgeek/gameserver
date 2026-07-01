# Memory: 7D2D Game Server Control Plane

This note is intended for MemPalace and future agents working on this project.
It captures how the 7 Days to Die server system works, what has been built, and
how to reuse the pattern for a Windrose server.

## Project Identity

- Repo: `/Users/garypope/Projects/Jajoga/7d2d`
- Git remote: `https://github.com/rptgeek/gameserver.git`
- Active branch at time of this note: `master`
- Latest pushed feature commit: `356fc26 Add saved world copy and delete actions`
- Live AWS stack name: `gameserver-dev`
- CloudFront frontend URL: `https://d151ne23hwzren.cloudfront.net/`
- API Gateway base URL from latest CDK deploy: `https://xxwkjgwnvi.execute-api.us-east-1.amazonaws.com`
- Cognito user pool: `us-east-1_lWxhNVTM5`
- Cognito app client: `5i2k03r3stlgr700sud74lsjgv`
- Frontend bucket: `gameserver-dev-frontend-153550591373`
- AWS account observed during deploy: `153550591373`
- Primary stage: `dev`
- Important naming detail: CDK cannot use stack id `7d2d-dev` because stack names must start with a letter. Use `PROJECT_NAME=gameserver` for deploys, even though the project manages 7D2D.

## Current Deployment State

Backend/CDK deployment succeeded for `gameserver-dev` after running:

```bash
cd infra
PROJECT_NAME=gameserver ./bin/deploy.sh dev
```

The first attempted deploy with `PROJECT_NAME=7d2d` failed before AWS changes because `7d2d-dev` is an invalid CloudFormation stack name.

Frontend deploy was attempted with:

```bash
PROJECT_NAME=gameserver scripts/deploy-frontend.sh
```

It failed while resolving stack outputs with:

```text
Could not connect to the endpoint URL: "https://cloudformation.us-east-1.amazonaws.com/"
```

This was a local/AWS connectivity failure, not a build failure. Earlier frontend build passed with `npm run build --prefix frontend`.

## What The System Does

This repo is a multi-game spot-instance control plane. It started around 7 Days to Die but has been generalized so other dedicated servers can use the same launch, stop, backup, restore, logging, and frontend workflows.

Main pieces:

- `frontend/`: Vite React admin console.
- `backend/`: Express API packaged as an AWS Lambda behind API Gateway.
- `infra/`: AWS CDK stack for Cognito, API Gateway, Lambda, DynamoDB, S3 frontend hosting, and CloudFront.
- `scripts/`: legacy/manual spot-server scripts and game profile files.
- `infra/assets/bootstrap.sh.tmpl`: runtime bootstrap template bundled into the backend Lambda.
- `docs/ARCHITECTURE.md` and `docs/OPERATIONAL.md`: architecture and operational state model.

The control plane launches EC2 Spot instances for game servers, restores saved state from S3, starts the game under systemd, streams logs to CloudWatch, supports SSM operations, and syncs state back to S3 on backup/stop.

## AWS Resources

The `gameserver-dev` CDK stack provisions:

- Cognito user pool and hosted UI client.
- API Gateway HTTP API with Cognito JWT authorization.
- Lambda backend function `gameserver-dev-backend`.
- DynamoDB tables:
  - games
  - instances
  - operations
  - config_history
  - instance_config
- SSM command documents:
  - `gameserver-dev-7d2d-bootstrap`
  - `gameserver-dev-7d2d-update`
  - `gameserver-dev-7d2d-backup`
- CloudWatch log retention for `/7d2d/bootstrap` and `/7d2d/server`.
- Private frontend S3 bucket behind CloudFront.

The backend Lambda environment includes table names, Cognito values, stage/app names, and SSM document names. The Lambda bundles `infra/assets/bootstrap.sh.tmpl` so launches do not depend on reading the template from the repo at runtime.

## Backend Model

Backend storage uses generic DynamoDB items keyed by `pk`.

Important record shapes:

- Game records: `kind: "game"`.
- Game profile records: `pk = game-profile#<gameId>#<profileId>`, `kind: "game-profile"`.
- Saved world records: `pk = game-world#<gameId>#<worldId>`, `kind: "game-world"`.
- Instance records: include AWS instance id, selected game/profile/world, runtime state, networking, S3 world prefix, and operation metadata.
- Operation records: track async control-plane actions.

World records now include:

- `worldId`
- `name`
- `description`
- `worldSeed`
- `worldPrefix`
- `currentInstanceId`
- `currentInstanceGameId`
- `lockedAt`
- `lastBackupAt`
- `saveVersion`
- `saveVersionUpdatedAt`

The repository helper now has `delete(pk)` for DynamoDB deletes.

## Backend API Surface

Relevant API routes include:

- `GET /health`
- `GET /v1/games`
- `GET /v1/games/:gameId/profiles`
- `POST /v1/games/:gameId/profiles`
- `GET /v1/games/:gameId/worlds`
- `POST /v1/games/:gameId/worlds`
- `POST /v1/games/:gameId/worlds/:worldId/copy`
- `DELETE /v1/games/:gameId/worlds/:worldId`
- `GET /v1/games/:gameId/worlds/:worldId/server-config`
- `PUT /v1/games/:gameId/worlds/:worldId/server-config`
- `GET /v1/instances`
- `POST /v1/instances`
- `GET /v1/instances/:instanceId`
- action routes for start/stop/restart/reboot/terminate/backup/logs/player status/config/console commands.

The saved-world copy route:

- Finds source world by `gameId` and `worldId`.
- Resolves the source S3 world prefix.
- Creates a new UUID world id.
- Creates a sibling S3 prefix under the same base path.
- Copies all S3 objects from source prefix to target prefix.
- Writes a new world record.
- Clears runtime lock fields so the clone is not marked running.

The saved-world delete route:

- Refuses delete when an active/non-terminal instance still references the world.
- Allows stale lock cleanup when the referenced instance is terminal.
- Deletes S3 objects under the world prefix.
- Deletes the DynamoDB world record.

CDK IAM grants backend Lambda `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, and `s3:ListBucket` so saved-world copy/delete can manage S3 world prefixes.

## Frontend Console

The React admin console supports:

- Sign-in/sign-out through Cognito.
- Game filtering.
- Saved worlds panel.
- Instance list and detail view.
- Instance operations: start, stop, restart, reboot, terminate.
- Bootstrap/server logs.
- Telnet-style server console commands through backend/SSM path.
- Config editing.
- World serverconfig.xml editing.
- Player count/status display.
- Active server association for each saved world.

Saved-world cards now show:

- World name and description.
- Runtime status.
- Bucket.
- S3 path.
- Last backup.
- Public IP.
- Player count.
- Server version.
- Last player check.
- Configure & launch.
- View running server / View last launch.
- Copy.
- Delete.

Copy asks for a new world name with `window.prompt`, calls the backend copy endpoint, and inserts the cloned world into local state. Delete uses `window.confirm`, disables while active, calls the backend delete endpoint, removes the world from local state, and clears selected launch form state if that world was selected.

## Game Profile Contract

Game behavior is driven by profiles in `scripts/game-profiles/`.

Required or important fields:

- `WORLD_BUCKET`
- `S3_PREFIX`
- `GAME_NAME`
- `AWS_REGION`
- `AMI_ID`
- `SUBNET_ID`
- `SECURITY_GROUP_IDS`
- `GAME_UDP_PORTS`
- `GAME_TCP_PORTS`
- `GAME_INGRESS_CIDR`
- `ENSURE_PROFILE_SECURITY_GROUP_RULES`
- `KEY_NAME`
- `IAM_INSTANCE_PROFILE`
- `DEFAULT_INSTANCE_TYPE`
- `BACKUP_INTERVAL_MINUTES`
- `STATE_DIR_PATH`
- `STATE_LINK`
- `GAME_HOME`
- `STEAM_BETA_BRANCH`
- `STEAM_BETA_PASSWORD`
- `GAME_INSTALL_CMD`
- `GAME_START_CMD`
- optional `GAMECONFIG_S3_KEY`
- optional `GAMECONFIG_LOCAL_PATH`

Profile records can also carry launch/network settings into the backend API. The saved-world S3 prefix is usually:

```text
<S3_PREFIX>/<gameId>/<worldId>
```

State is stored under:

```text
s3://<WORLD_BUCKET>/<worldPrefix>/state/
```

World config is stored under:

```text
s3://<WORLD_BUCKET>/<worldPrefix>/config/serverconfig.xml
```

## 7D2D Profile

The 7D2D profile currently lives at `scripts/game-profiles/7d2d.env`.

Important 7D2D values:

- `GAME_NAME=7d2d`
- `WORLD_BUCKET=gameserver-state-example`
- `S3_PREFIX=servers`
- `GAMECONFIG_S3_KEY=servers/7d2d/config/serverconfig.xml`
- UDP ports: `26900,26901,26902,26903`
- TCP ports: `26900,8081`
- Default instance: `c7i.xlarge`
- Backup interval: 5 minutes
- State dir: `/srv/7d2d-state`
- Game home: `/opt/7d2d`
- Steam app id: `294420`
- Steam beta branch defaults to `latest_experimental`
- Start command:

```bash
cd /opt/7d2d && ./7DaysToDieServer.x86_64 -logfile /var/log/7d2d/server.log -configfile=serverconfig.xml -batchmode -nographics -dedicated
```

7D2D-specific extras:

- `serverconfig.xml` matters and is managed through S3 and the frontend.
- The UI exposes a serverconfig editor for selected saved worlds.
- The backend can retrieve/edit `serverconfig.xml` from each world prefix.
- Player counts and version are parsed from server logs/status output.

## Runtime Bootstrap

The bootstrap template handles the instance-side work:

- Creates runtime directories and logs.
- Installs or updates SteamCMD/game files.
- Restores saved world state from S3.
- Applies ownership/permissions.
- Starts systemd services.
- Sets up backup timers/services.
- Sets up spot interruption handling.
- Uploads state back to S3.
- Uploads config back to S3 where applicable.
- Streams bootstrap and server logs to CloudWatch.

The common pattern is:

1. Launch EC2 Spot instance with generated user-data from profile + selected world.
2. Download/restore state from `s3://WORLD_BUCKET/WORLD_PREFIX/state/`.
3. Install/update game via `GAME_INSTALL_CMD`.
4. Start dedicated server via `GAME_START_CMD`.
5. Schedule periodic backup using `BACKUP_INTERVAL_MINUTES`.
6. On stop/spot termination, run upload-state hook and terminate.

## Instance Lifecycle

Operational states described in `docs/OPERATIONAL.md`:

- `NONE`
- `REQUESTED`
- `LAUNCHING_EC2`
- `BOOTSTRAPPING`
- `SERVER_RESTORE`
- `GAME_INSTALLING`
- `SERVER_STARTING`
- `SERVER_ACTIVE`
- `DEGRADED_BACKUP`
- `STOPPING`
- `SPOT_INTERRUPTION`
- `STOPPED`
- `TERMINATED`
- `FAILED`

The backend normalizes stopped/shutting-down/terminated EC2 instances to `status: "terminated"` and clears `publicIp` so the frontend does not keep showing stale active servers.

## Legacy Scripts

Legacy scripts still exist and are useful for manual workflows:

- `scripts/start-game-spot.sh`
- `scripts/stop-game-spot.sh`
- `scripts/status-game-spot.sh`
- game-specific wrappers such as `start-7d2d-spot.sh`
- Windrose scripts exist or are partially present, including `stop-windrose-spot.sh`.

The architecture direction is API-first, with scripts retained as operational fallback/manual tools.

## Windrose Server Plan

Windrose should reuse the same control-plane pattern as 7D2D where possible:

- Add/verify a game record for `windrose`.
- Add/verify a launch profile record derived from `scripts/game-profiles/windrose.env`.
- Use the same DynamoDB tables and API routes.
- Use the same frontend saved-world panel, launch modal, instance list, operations, logs, and backups.
- Use the same S3 layout:

```text
s3://gameserver-state-example/servers/windrose/<worldId>/state/
```

- Use the same copy/delete world mechanics.
- Use the same EC2 Spot + SSM + CloudWatch + S3 backup flow.

Current Windrose profile values:

- `GAME_NAME=windrose`
- `WORLD_BUCKET=gameserver-state-example`
- `S3_PREFIX=servers`
- `AWS_REGION=us-east-1`
- UDP ports: `27015`
- TCP ports: `27015,80`
- Default instance: `c7i.xlarge`
- Backup interval: 5 minutes
- State dir: `/srv/windrose-state`
- Game home: `/opt/windrose`
- Steam app id: `4129620`
- Start command:

```bash
cd /opt/windrose && ./WindroseServer.x86_64 -logfile /var/log/windrose/server.log -batchmode -nographics -dedicated
```

Things to validate for Windrose:

- Confirm the correct Linux dedicated server binary name and path.
- Confirm the Steam app id `4129620` is correct and available through anonymous SteamCMD login.
- Confirm required UDP/TCP ports. Current profile uses UDP `27015` and TCP `27015,80`, but this may need game-specific adjustment.
- Confirm whether Windrose needs a config file equivalent to 7D2D `serverconfig.xml`.
- If it has config, decide its S3 key and local path and add profile fields like `GAMECONFIG_S3_KEY` and `GAMECONFIG_LOCAL_PATH`.
- Confirm whether the generic bootstrap can start it with current command or whether game-specific pre-start config generation is needed.
- Confirm state directory layout after first successful boot and adjust `STATE_DIR_PATH` or symlink behavior if needed.
- Confirm log format if player count/version parsing should work.
- Confirm security group rules are applied for Windrose ports.

Recommended Windrose MVP:

1. Seed or create the `windrose` game/profile in DynamoDB.
2. Launch a Windrose saved world using the existing API/UI.
3. Watch bootstrap logs.
4. Verify SteamCMD install completes.
5. Verify systemd service starts.
6. Verify process binds expected ports.
7. Verify backup sync writes to `servers/windrose/<worldId>/state/`.
8. Stop the instance through the UI and confirm backup/termination.
9. Relaunch the same saved world and confirm restore.
10. Only then add game-specific config editing if Windrose needs it.

## Known Gaps And Risks

- Frontend deploy did not complete because local AWS CloudFormation endpoint access failed after backend deploy.
- Backend TypeScript strict build currently fails on existing baseline issues, although CDK Lambda bundling/deploy succeeded. Baseline issues include serverless-express import shape, AWS enum typing, old `req.params` typing, and model fields used before being declared.
- CDK `projectName` default in `infra/cdk.json` is `7d2d`, which produces invalid stack id `7d2d-dev`. Use `PROJECT_NAME=gameserver` or change the CDK naming strategy.
- Current log retention in infra is 3 days for `/7d2d/bootstrap` and `/7d2d/server`, while operational docs recommend longer retention for some logs.
- The 7D2D config editing flow is game-specific. Windrose should not inherit `serverconfig.xml` assumptions unless it has an equivalent config file.
- Generic player count/version parsing may not apply to Windrose until log/status parsing is adapted.

## Deploy Commands

Backend/CDK:

```bash
cd /Users/garypope/Projects/Jajoga/7d2d/infra
PROJECT_NAME=gameserver ./bin/deploy.sh dev
```

Frontend:

```bash
cd /Users/garypope/Projects/Jajoga/7d2d
PROJECT_NAME=gameserver scripts/deploy-frontend.sh
```

Useful stack check:

```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE IMPORT_COMPLETE --query "StackSummaries[?contains(StackName, 'gameserver')].[StackName,StackStatus]" --output table
```

## Recent Work Summary

Recent completed work includes:

- Environment identifier sanitization.
- Game fleet console controls.
- Player count and idle shutdown support.
- Saved-world launch and config editing.
- Bootstrap log shipping and SteamCMD runtime fixes.
- Backend Lambda bundling of bootstrap template.
- Region-aware launch profiles.
- DynamoDB table key alignment.
- Fixes for world/profile key drift.
- API CORS/OPTIONS handling.
- Saved-world copy and delete API/client/UI.
- Instance lifecycle normalization for stopped/terminated EC2 states.
