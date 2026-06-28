# Game Server Spot Orchestrator (EC2 + S3 state persistence)

This setup is reusable across game servers.

- `scripts/start-game-spot.sh` — generic launch entrypoint
- `scripts/stop-game-spot.sh` — generic stop entrypoint
- `scripts/start-7d2d-spot.sh` — compatibility wrapper for 7d2d
- `scripts/stop-7d2d-spot.sh` — compatibility wrapper for 7d2d
- `scripts/start-windrose-spot.sh` — compatibility wrapper for windrose
- `scripts/stop-windrose-spot.sh` — compatibility wrapper for windrose
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

Profiles included in this repo:
- `scripts/game-profiles/7d2d.env`
- `scripts/game-profiles/7d2d-east1.env`
- `scripts/game-profiles/7d2d-west2.env`
- `scripts/game-profiles/windrose.env`

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
IAM_INSTANCE_PROFILE=example-game-server-role
GAME_INSTALL_CMD="/opt/steamcmd/steamcmd.sh +login anonymous +force_install_dir /opt/7d2d +app_update 294420 validate +quit"
GAME_START_CMD="cd /opt/7d2d && ./7DaysToDieServer.x86_64 -logfile /var/log/7d2d/server.log -configfile=serverconfig.xml -batchmode -nographics -dedicated"
```

Optional profile overrides:
`AWS_REGION`, `DEFAULT_INSTANCE_TYPE`, `RECOMMENDED_INSTANCE_TYPES`, `VOLUME_SIZE_GIB`, `GAME_HOME`, `STATE_DIR_PATH`, `BACKUP_INTERVAL_MINUTES`, etc.
`RECOMMENDED_INSTANCE_TYPES` is shown by `--list-recommendations` and can be any multi-line string.

Optional server config overrides:

- `GAMECONFIG_S3_KEY` (defaults to `${WORLD_PREFIX}/config/serverconfig.xml`)
- `GAMECONFIG_LOCAL_PATH` (defaults to `${GAME_HOME}/serverconfig.xml`)

The script syncs `${GAMECONFIG_S3_KEY}` into `${GAMECONFIG_LOCAL_PATH}` on startup and uploads it on graceful backup/stop. If no file exists in S3, a local default is created with:

```xml
<ServerSettings>
  <property name="BloodMoonFrequency" value="7" />
  <property name="BloodMoonRange" value="2" />
  <property name="DropOnDeath" value="2" />
  <property name="PlayerKillingMode" value="2" />
  <property name="AirDropMarker" value="true" />
</ServerSettings>
```

You can update the S3 config file directly and next launch will pick it up:

```bash
aws s3 cp scripts/configs/7d2d/serverconfig.xml s3://gameserver-state-example/servers/7d2d/config/serverconfig.xml
```

You can also add profile-level overrides in your shell; any env var in the profile can be overridden at runtime.

## Start

```bash
./scripts/start-game-spot.sh 7d2d
```

You can also launch via additional profile names:

```bash
./scripts/start-game-spot.sh 7d2d-east1
./scripts/start-game-spot.sh 7d2d-west2
./scripts/start-game-spot.sh 7d2d-east1 --branch latest_experimental
```

Launch on a specific branch:

```bash
./scripts/start-game-spot.sh 7d2d --branch latest_experimental
./scripts/start-game-spot.sh 7d2d --branch public
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

Shortcut aliases for 7d2d branch selection:

```bash
./scripts/start-7d2d-spot.sh --branch latest
./scripts/start-7d2d-spot.sh --branch public
```

## Windrose example profile

Edit `scripts/game-profiles/windrose.env` to set your Windrose profile values:

```bash
WORLD_BUCKET=gameserver-state-example
S3_PREFIX=servers
GAME_NAME=windrose
AWS_REGION=us-east-1
AMI_ID=ami-xxxxxxxxxxxxxxxxx
SUBNET_ID=subnet-xxxxxxxxxxxxxxxxx
SECURITY_GROUP_IDS="sg-xxxxxxxxxxxxxxxxx"
GAME_UDP_PORTS="27015"
GAME_TCP_PORTS="27015,80"
GAME_INGRESS_CIDR="0.0.0.0/0"
KEY_NAME=example-key
IAM_INSTANCE_PROFILE=example-game-server-role
DEFAULT_INSTANCE_TYPE=c7i.xlarge
GAME_INSTALL_CMD='/opt/steamcmd/steamcmd.sh +@sSteamCmdForcePlatformType linux +force_install_dir /opt/windrose +login anonymous +app_update 4129620 validate +quit'
GAME_START_CMD="cd /opt/windrose && ./WindroseServer.x86_64 -logfile /var/log/windrose/server.log -batchmode -nographics -dedicated"
```

Launch Windrose:

```bash
./scripts/start-game-spot.sh windrose
./scripts/start-windrose-spot.sh
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

Windrose stop examples:

```bash
./scripts/stop-game-spot.sh windrose
./scripts/stop-windrose-spot.sh
```

State sync behavior:
- Boot restores `s3://$WORLD_BUCKET/$S3_PREFIX/$GAME_NAME/state/` into `$STATE_DIR_PATH`.
  `$STATE_DIR_PATH` is linked to the game save root in `$STATE_LINK` (or resolved from the service user home), which for 7d2d is usually:
  `~/<service-user>/.local/share/7DaysToDie`.
- Server saves state on timer, on graceful service stop, and on shutdown/Spot notice.
- `stop-game-spot.sh` sends an in-band SSM backup command before terminate when possible.
- `STOP_TIMEOUT_SECONDS` can be set (default `30`) to control how long the server is given to stop before hard kill on shutdown.

Note: reclaim events that arrive with no in-VM termination notice are inherently hard to capture perfectly; periodic backups reduce loss, and this now includes shutdown hooks for the server process and OS shutdown path.
