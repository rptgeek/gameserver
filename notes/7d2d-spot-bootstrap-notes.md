# 7d2d Spot Bootstrap Learnings

- Boot launch is controlled by `scripts/start-game-spot.sh` via EC2 user-data, then `status-game-spot.sh` to inspect status.
- Spot instances are named via the `Name` tag as `${SERVER_NAME}` (7d2d-spot-server in profile env).
- During restore/boot flow, S3 state restore and service restore must happen before server launch:
  - Restore server config from S3 and sync `servers/7d2d/state/`.
  - Start `7d2d-server.service` only after restore + ownership recovery.
- Root cause of repeated boot issues:
  - Restored save/config files could be owned by `root` from prior runs.
  - Server process (`ubuntu`) then hit ownership errors on startup.
- Fix applied in `start-game-spot.sh`:
  - Added `chown -R <SERVICE_USER>` + `chmod -R u+rwX` on state paths after S3 sync.
  - Added same ownership/permission recovery in generated `restore-state.sh`.
  - Added pre-start ownership repair in `start-server.command` for state and home-local share path.
- Important shell detail:
  - In heredocs, variable names used inside bootstrap templates needed escaping because outer script has `set -u`; unresolved variables like `runtime_user`/`chown_user` were failing interpolation.
- Latest boot behavior observed:
  - Service can be blocked in `steamcmd` app_update/verify phase for many minutes.
  - 7d2d became fully `active (running)` after ~8m53s from launch when Steam install completed and service started.
- Non-blocking log noise still seen:
  - `chown: cannot access '/Users/garypope/.local/share/7DaysToDie': No such file or directory`
  - `WARNING: Could not chown all state files as ubuntu`
  - This happened after startup script path normalization and does not block service startup; still worth hardening with existence checks.
- Backup verification:
  - 5-minute backup cadence is configured from the instance profile/config and confirmed by last write behavior in prior checks.
  - Instance stop path uses in-band SSM upload (`/opt/<game>-tools/upload-state.sh`) then terminate.
- Stop behavior:
  - `stop-game-spot.sh` can take game name or instance-id; when only game name is passed it reads state.
  - For older/legacy state, the script can still read `.7d2d-spot/instance.state`.
- Most recent session cleanup:
  - Both running instances were terminated: `i-093a0b4f1c371d3aa` and `i-0d6202bd8b1d6e515` (both moved to `shutting-down` then will go to `terminated`).

Next hardening steps:
- Convert remaining `/Users/.../.local/share/7DaysToDie` ownership attempts into guarded checks so no warnings print when the path is absent.
- Keep `cloud-init` logs and `status-game-spot.sh` polling during first 10–15 minutes to establish a fresh boot baseline and S3 restore timing.
