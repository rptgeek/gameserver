# Control Plane Architecture

This document defines the v1 control plane contract for the game spot orchestrator (`start-game-spot.sh`, `stop-game-spot.sh`, `status-game-spot.sh`) and the migration path toward a managed API layer.

## Scope

- Single control-plane surface for launching/stopping game instances.
- Multi-game abstraction driven by profile files in `scripts/game-profiles/`.
- State persistence through S3 state buckets.
- Runtime operations executed on EC2 Spot instances via AWS APIs + SSM.

## Core Actors

- `client` (human or automation) calls the control-plane API.
- `control-plane` validates requests, resolves profile/model, and orchestrates AWS calls.
- `aws-ec2` manages Spot instance lifecycle.
- `aws-ssm` executes in-VM backup hooks.
- `instance runtime` executes bootstrap script and systemd services.
- `state store` uses `scripts/.game-spot/*.state` plus S3 world/state prefixes.

## Multi-Game Profile Model

`GameProfile` is the authoritative contract for a game deployment.

### Profile contract (required)

- `GAME_NAME` (string)
- `WORLD_BUCKET` (string)
- `S3_PREFIX` (string)
- `SUBNET_ID` (string)
- `SECURITY_GROUP_IDS` (string list)
- `KEY_NAME` (string)
- `IAM_INSTANCE_PROFILE` (string)
- `GAME_INSTALL_CMD` (string)
- `GAME_START_CMD` (string)
- `INSTANCE_TYPE` or `DEFAULT_INSTANCE_TYPE` (string)

### Profile contract (optional, extensibility points)

- `AMI_ID` (explicit AMI override)
- `AWS_REGION`
- `WORLD_BUCKET_REGION`
- `VOLUME_SIZE_GIB`
- `STATE_DIR_PATH`
- `STATE_LINK`
- `GAME_HOME`
- `GAME_UDP_PORTS` / `GAME_TCP_PORTS`
- `GAME_INGRESS_CIDR`
- `BACKUP_INTERVAL_MINUTES`
- `BACKUP_BOOT_OFFSET_MINUTES`
- `STEAM_BETA_BRANCH`, `STEAM_BETA_PASSWORD`
- `GAMECONFIG_S3_KEY`, `GAMECONFIG_LOCAL_PATH`
- `ENSURE_PROFILE_SECURITY_GROUP_RULES`
- Any custom environment variable required by bootstrap scripts.

Profiles are loaded from:

- `scripts/game-profiles/<GAME_NAME>.env`
- or explicit profile path passed to launch API.

Template inheritance is achieved by:
- repo-level defaults in script
- profile env
- API request overrides

### Supported extension points

1. Add a new game by adding a new profile file.
2. Add engine-specific behavior by changing `GAME_INSTALL_CMD` and/or `GAME_START_CMD`.
3. Add additional env vars and consume them through user-data templates and instance bootstrap tools.
4. Add ports and security controls using `GAME_UDP_PORTS`, `GAME_TCP_PORTS`, and `GAME_INGRESS_CIDR`.
5. Add migration or compliance policy externally by wrapping control-plane calls (for example, gatekeepers, approval steps, policy engines).

## State Contracts

### Persisted control-plane state file (`scripts/.game-spot/<game>.state`)

At launch, the control plane writes:

- `GAME_NAME`
- `GAME_SERVICE`
- `INSTANCE_ID`
- `AWS_REGION`
- `WORLD_BUCKET`
- `S3_PREFIX`
- `SELECTED_INSTANCE_TYPE`

This file is used by CLI-based status/stop operations and is treated as a process-local cache for the currently active instance metadata.

### Runtime contract

- EC2 instance metadata: `InstanceId`, `State`, networking, launch time, AZ.
- Service metadata: `${GAME_SERVICE}-server.service`, `${GAME_SERVICE}-watchdog.service`.
- Instance lifecycle events and backup operation statuses.

## API vs Script Backing

The API layer is conceptually a thin adapter over existing scripts and should map:

- `POST /instances` -> `start-game-spot.sh` equivalent
- `POST /instances/{id}/stop` -> `stop-game-spot.sh`
- `GET /instances/{id}` and logs -> `status-game-spot.sh` and AWS APIs

This permits incremental migration: scripts remain executable while API schemas and contracts are enforced centrally.

## Failure and recovery boundaries

- If control-plane write to `.game-spot` fails, instance launch should be treated as `PROVISIONED_UNTRACKED` and surfaced as reconciliation debt.
- If S3 restore/ownership fix fails, bootstrap should continue to service start only if non-fatal and emit recoverable state (`DEGRADED_RESTORE`).
- Spot interruption events are expected; backup hooks are mandatory for best-effort recovery (`stop + spot-watchdog + backup.timer`).
