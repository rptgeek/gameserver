# Operational Runbook and State Model

## Instance lifecycle state machine

The runtime lifecycle is driven by EC2 + systemd + control-plane orchestration.

### Lifecycle states

- `NONE` — no instance tracked for the game.
- `REQUESTED` — API accepted start request.
- `LAUNCHING_EC2` — Spot run request submitted.
- `BOOTSTRAPPING` — user-data executing, restores/syncs state from S3.
- `SERVER_RESTORE` — state restore and ownership normalization in progress.
- `GAME_INSTALLING` — Steam install/update in progress.
- `SERVER_STARTING` — systemd `*-server.service` started.
- `SERVER_ACTIVE` — service healthy, backups scheduled.
- `DEGRADED_BACKUP` — runtime degraded (restore/upload warning).
- `STOPPING` — stop API/termination in progress.
- `SPOT_INTERRUPTION` — reclaim notice/termination notice received.
- `STOPPED` — instance terminated and no active tracking.
- `TERMINATED` — AWS termination completed.
- `FAILED` — unrecoverable start/restore/install/runtime error.

### Lifecycle transitions

1. `NONE -> REQUESTED` on valid start request.
2. `REQUESTED -> LAUNCHING_EC2` after profile+permission validation.
3. `LAUNCHING_EC2 -> BOOTSTRAPPING` once instance transitions out of `pending`.
4. `BOOTSTRAPPING -> SERVER_RESTORE -> GAME_INSTALLING -> SERVER_STARTING`.
5. `SERVER_STARTING -> SERVER_ACTIVE` when `systemctl is-active <game-service>.service` returns `active`.
6. `SERVER_ACTIVE -> STOPPING` on stop request.
7. `SERVER_ACTIVE -> SPOT_INTERRUPTION` when spot notice or termination notice appears.
8. `SERVER_ACTIVE -> DEGRADED_BACKUP` when backup hooks fail but process remains active.
9. `STOPPING/SPOT_INTERRUPTION -> STOPPED` after SSM backup attempt and terminate.
10. `STOPPED -> TERMINATED` when AWS shows terminal state.
11. Any non-recoverable pre-`SERVER_ACTIVE` path to `FAILED`.

### Operation state model

All tracked operations use this state machine:

- `accepted` — request accepted and queued.
- `running` — control-plane action in progress.
- `succeeded` — action completed.
- `failed` — final error.
- `retrying` — automatic retry scheduled.
- `cancelled` — superseded/aborted by another request.
- `blocked` — waiting on required manual input or dependency (for example, stale state conflict).

## Log source mapping and retention

| Source | Location / collector | Notes | Retention |
| --- | --- | --- | --- |
| bootstrap | `/var/log/cloud-init-output.log` (instance) | Cloud-init user-data execution, restore/install/install errors, permissions repair logs | 14 days local + optional central export |
| runtime service | `journalctl -u ${GAME_SERVICE}-server.service` | Game process start/stop/restart lifecycle | 14 days |
| bootstrap service | `journalctl -u ${GAME_SERVICE}-watchdog.service` | Spot interruption watcher events | 30 days |
| shutdown hook | `journalctl -u ${GAME_SERVICE}-shutdown-save.service` | Forced shutdown backup trigger path | 30 days |
| periodic backup | `journalctl -u ${GAME_SERVICE}-backup.timer` and `${GAME_SERVICE}-backup.service` | Backup cadence and failures | 90 days |
| in-band backup command | AWS SSM command output via `get-command-invocation` | Stop-triggered upload attempt (`/opt/${GAME_SERVICE}-tools/upload-state.sh`) | 30 days |
| status/ops API | Aggregated result object (`/v1/instances`, `/v1/operations`) | Source of truth for incident review | 90 days |
| state backup artifacts | `s3://$WORLD_BUCKET/$S3_PREFIX/$GAME_NAME/state/` | `sync` restore source/target + server saves | Bucket policy-driven |

## Retention policy

- Cloud-init and game service logs: minimum 14 days.
- Operational/audit-facing logs: minimum 30 days.
- SSM command logs and operation events: 90 days by default.
- Game state objects in S3: versioned with lifecycle rule retaining recent state for recovery and removing aged objects per policy (for example 30–90 days).
- Server/service logs should not be purged from instance immediately; collect on demand before termination when possible.

## Status and health checks

- `status-game-spot.sh` currently maps to:
  - EC2 instance state via `describe-instances`.
  - service/process status via SSM `systemctl/journalctl/pgrep`.
- Recommended control-plane health checks:
  - `describe-instances` state is `running`.
  - service `active`.
  - last startup log line not older than expected for deployment age.
  - successful backups observed in last interval (`BACKUP_INTERVAL_MINUTES` ± 2).

## Runbook: 0, 1, and 2+ active instances for same game

### Case A: 0 active instances

1. Validate profile/environment variables.
2. Validate SG/AZ and `IAM_INSTANCE_PROFILE`.
3. Start launch flow.
4. Record operation and write `.game-spot/<game>.state`.
5. Confirm `BOOTSTRAPPING -> SERVER_ACTIVE` before unblocking.

### Case B: 1 active instance

1. Read current instance from `.game-spot/<game>.state`.
2. Validate instance exists and matches game/profile.
3. If request is informational, return current status.
4. If request is restart:
   - perform stop flow (including graceful SSM backup) when same game+profile policy requires seriality.
   - wait for `STOPPED` or bounded timeout then start new.
5. If request parameters are compatible (`allowDuplicate=true` and explicit), proceed only with operator approval.

### Case C: 2+ active instances

1. Mark operation state `blocked`.
2. Do not start new capacity by default.
3. Enumerate instances by:
   - AWS `describe-instances` filtered by `tag:Name` and game service.
4. Determine canonical instance:
   - newest active if one newer boot and same profile.
   - older duplicates treated as strays unless tagged `retain=true`.
5. Remediation:
   - stop or terminate confirmed duplicates one-by-one via stop flow.
   - run backup on running strays before termination when possible.
6. After cleanup returns to 0/1 active state, resume request or fail explicitly with operator checklist.

## Multi-game operation runbook notes

- Use per-game state files to avoid cross-game conflicts.
- Avoid using `STATE_LINK` overrides unless migration requires preserving legacy data paths.
- Use profile-specific networking values, especially UDP/TCP ports for each title.

## Migration from legacy `.game-spot/*.state` scripts

### Goal

Continue supporting existing state and migration points without downtime.

### Inputs

- New state: `scripts/.game-spot/<game>.state`
- Legacy state fallback (currently used for 7d2d compatibility): `scripts/.7d2d-spot/instance.state`

### Procedure

1. On stop/status request:
   - read `${GAME_NAME}` state file.
   - if not found and `gameName == 7d2d`, read legacy `.7d2d-spot/instance.state`.
2. Normalize output into canonical in-memory state with fields:
   - `gameName`, `instanceId`, `region`, `selectedInstanceType`.
3. If both legacy and new state exist:
   - prefer `scripts/.game-spot/<game>.state`.
   - preserve legacy as audit metadata and mark `SOURCE=legacy` in operation log.
4. On successful stop/termination with game target:
   - delete only the canonical game state file after API-controlled cleanup.
5. After first successful control-plane-run with new state file:
   - recommend creating migration artifact and alerting that legacy path is now read-only.
6. Optional cleanup window:
   - keep `.7d2d-spot/instance.state` for 30 days with no read/write by control-plane.
   - remove once dual-write validation is complete.

## Incident response: quick triage

- If bootstrap or game install exceeds normal window:
  - check cloud-init output first.
  - check `install-state` and IAM role permissions.
  - check service logs for ownership errors and port bind errors.
- If SSM backup fails:
  - verify instance role path and command output.
  - trigger manual backup from terminal if needed.
- If stop path hangs:
  - confirm spot instance is still reachable by SSM.
  - if unrecoverable, force terminate via EC2 and run reconciliation task.
