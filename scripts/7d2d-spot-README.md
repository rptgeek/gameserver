# Game Server Spot Orchestrator (EC2 + S3 state persistence)

This setup is reusable across game servers.

- `scripts/start-game-spot.sh` — generic launch entrypoint
- `scripts/stop-game-spot.sh` — generic stop entrypoint
- `scripts/start-7d2d-spot.sh` — compatibility wrapper for 7d2d
- `scripts/stop-7d2d-spot.sh` — compatibility wrapper for 7d2d
- `scripts/game-profiles/<game>.env` — per-game profile
- `scripts/7d2d-spot-README.md` — this file

## Multi-game S3 layout

State for each game is stored under:

`s3://<WORLD_BUCKET>/<S3_PREFIX>/<GAME_NAME>/state/`

Example:
- bucket: `game-host-state`
- base prefix: `servers`
- game name: `7d2d`
- state path: `s3://game-host-state/servers/7d2d/state/`

For each additional game, add another profile file.

## What `start-game-spot.sh` does

1. Loads a game profile (required keys).
2. Writes EC2 user-data that:
   - restores state from S3 on boot
   - starts periodic S3 backups
   - watches for Spot termination notices
3. Starts a Spot instance with local storage.
4. Saves instance metadata into `scripts/.game-spot/<game>.state`.

## Requirements

1. AWS CLI configured and logged in (SSO is fine).
2. EC2 networking:
   - subnet id
   - security group(s)
   - key pair
3. S3 bucket for world data.

## IAM (minimum)

Instance role attached to the Spot instance:
- `s3:ListBucket`
- `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on the state prefix

Operator role:
- `ec2:DescribeInstances`, `ec2:TerminateInstances`
- `ssm:SendCommand` (to run final backup on stop)

## 7d2d example profile

Edit `scripts/game-profiles/7d2d.env`:

```bash
WORLD_BUCKET=game-host-state
S3_PREFIX=servers
GAME_NAME=7d2d
SUBNET_ID=subnet-xxxxxxxx
SECURITY_GROUP_IDS="sg-xxxxxxxx sg-yyyyyyyy"
KEY_NAME=my-keypair
IAM_INSTANCE_PROFILE=7d2d-ec2-role
GAME_INSTALL_CMD="/opt/steamcmd/steamcmd.sh +login anonymous +force_install_dir /opt/7d2d +app_update 294420 validate +quit"
GAME_START_CMD="cd /opt/7d2d && ./7DaysToDieServer.x86_64 -logfile /var/log/7d2d/server.log -configfile=serverconfig.xml -batchmode -nographics -dedicated"
```

Optional profile overrides:
`AWS_REGION`, `DEFAULT_INSTANCE_TYPE`, `RECOMMENDED_INSTANCE_TYPES`, `VOLUME_SIZE_GIB`, `GAME_HOME`, `STATE_DIR_PATH`, `BACKUP_INTERVAL_MINUTES`, etc.
`RECOMMENDED_INSTANCE_TYPES` is shown by `--list-recommendations` and can be any multi-line string.

You can also add profile-level overrides in your shell; any env var in the profile can be overridden at runtime.

## Start

```bash
./scripts/start-game-spot.sh 7d2d
```

With custom profile path:

```bash
./scripts/start-game-spot.sh /path/to/custom-game.env
```

List recommended sizes and launch:

```bash
./scripts/start-game-spot.sh 7d2d --list-recommendations
```

Select a size explicitly:

```bash
./scripts/start-game-spot.sh 7d2d c7i.2xlarge
```

or:

```bash
./scripts/start-game-spot.sh --size c7i.2xlarge 7d2d
```

Backward-compatible 7d2d entrypoint:

```bash
./scripts/start-7d2d-spot.sh
```

```bash
./scripts/start-7d2d-spot.sh --size c7i.2xlarge
```

## Stop

```bash
./scripts/stop-game-spot.sh 7d2d
```

or:

```bash
./scripts/stop-game-spot.sh i-0123456789abcdef0 7d2d
```

Backward-compatible 7d2d entrypoint:

```bash
./scripts/stop-7d2d-spot.sh
```

State sync behavior:
- Boot restores `s3://$WORLD_BUCKET/$S3_PREFIX/$GAME_NAME/state/` into `$STATE_DIR_PATH`.
- Server saves state on timer and on Spot interruption.
- `stop-game-spot.sh` sends an SSM backup command before terminate when possible.
