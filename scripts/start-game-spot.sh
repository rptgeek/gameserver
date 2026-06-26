#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAME_PROFILES_DIR="${GAME_PROFILES_DIR:-${SCRIPT_DIR}/game-profiles}"
STATE_DIR="${STATE_DIR:-${SCRIPT_DIR}/.game-spot}"
mkdir -p "$STATE_DIR"

usage() {
  cat <<'USAGE'
Usage:
  ./start-game-spot.sh [profile-or-path] [instance-size] [options]

  profile-or-path:
    - defaults to 7d2d when omitted
    - accepts a profile name (7d2d) or explicit profile path (./path/to/profile.env)
  instance-size:
    - optional EC2 instance type (e.g., c7i.xlarge, c7i.2xlarge)
    - can also be provided via --size or --instance-type

Options:
  --size TYPE, --instance-type TYPE
                        Select instance size for this launch
  --branch BRANCH       Select Steam beta/testing branch for install.
                        Values:
                        - latest_experimental (aka latest, latest-experimental,
                          expermental, experimental)
                        - public / stable / default (general release)
                        - any explicit branch name
  --list-recommendations
                        Print recommended sizes and continue launch
  -h, --help            Show this help
USAGE
}

PROFILE_ARG="7d2d"
INSTANCE_TYPE_CLI=""
SHOW_RECOMMENDED=0
PROFILE_SET=0
STEAM_BETA_BRANCH_CLI=""
BRANCH_OVERRIDE_SET=0

while [[ $# -gt 0 ]]; do
  arg="$1"
  shift
  case "$arg" in
    --size|--instance-type)
      if [[ $# -eq 0 ]]; then
        echo "Missing value for $arg" >&2
        usage
        exit 1
      fi
      INSTANCE_TYPE_CLI="$1"
      shift
      ;;
    --branch|--beta-branch|--channel)
      if [[ $# -eq 0 ]]; then
        echo "Missing value for $arg" >&2
        usage
        exit 1
      fi
      BRANCH_RAW="$1"
      shift
      BRANCH_OVERRIDE_SET=1
      case "${BRANCH_RAW,,}" in
        latest|latest_experimental|latest-experimental|latestexperimental|latest_expermental|experimental|beta)
          STEAM_BETA_BRANCH_CLI="latest_experimental"
          ;;
        public|stable|release|default|general|current)
          STEAM_BETA_BRANCH_CLI=""
          ;;
        *)
          STEAM_BETA_BRANCH_CLI="$BRANCH_RAW"
          ;;
      esac
      ;;
    --list-recommendations|--recommended)
      SHOW_RECOMMENDED=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      break
      ;;
    --*)
      echo "Unknown option: $arg" >&2
      usage
      exit 1
      ;;
    *)
      if [[ "$PROFILE_SET" -eq 0 ]]; then
        PROFILE_ARG="$arg"
        PROFILE_SET=1
      elif [[ -z "$INSTANCE_TYPE_CLI" ]]; then
        INSTANCE_TYPE_CLI="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        usage
        exit 1
      fi
      ;;
  esac
done

if [[ -f "$PROFILE_ARG" ]]; then
  PROFILE_PATH="$PROFILE_ARG"
  PROFILE_NAME="${PROFILE_PATH##*/}"
  PROFILE_NAME="${PROFILE_NAME%.env}"
else
  PROFILE_PATH="${GAME_PROFILES_DIR}/${PROFILE_ARG}.env"
  PROFILE_NAME="$PROFILE_ARG"
fi

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "Profile not found: $PROFILE_PATH" >&2
  exit 1
fi

set -a
. "$PROFILE_PATH"
set +a

if [[ "$BRANCH_OVERRIDE_SET" -eq 1 ]]; then
  STEAM_BETA_BRANCH="$STEAM_BETA_BRANCH_CLI"
fi

if [[ -z "${GAME_NAME:-}" ]]; then
  GAME_NAME="$PROFILE_NAME"
fi

: "${RECOMMENDED_INSTANCE_TYPES:=c7i.xlarge # economy (4vCPU/8GiB)\nc7i.2xlarge # recommended (8vCPU/16GiB)\nc7i.4xlarge # heavy (16vCPU/32GiB)}"
: "${WORLD_BUCKET:?WORLD_BUCKET must be set in profile or environment}"
: "${S3_PREFIX:?S3_PREFIX must be set in profile or environment}"
: "${SUBNET_ID:?SUBNET_ID must be set in profile or environment}"
: "${SECURITY_GROUP_IDS:?SECURITY_GROUP_IDS must be set in profile or environment}"
: "${KEY_NAME:?KEY_NAME must be set in profile or environment}"
: "${IAM_INSTANCE_PROFILE:?IAM_INSTANCE_PROFILE must be set in profile or environment}"
: "${GAME_INSTALL_CMD:?GAME_INSTALL_CMD must be set in profile or environment}"
: "${GAME_START_CMD:?GAME_START_CMD must be set in profile or environment}"

AWS_REGION="${AWS_REGION:-us-east-1}"
PROFILE_DEFAULT_INSTANCE_TYPE="${DEFAULT_INSTANCE_TYPE:-c7i.xlarge}"
INSTANCE_TYPE="${INSTANCE_TYPE_CLI:-${INSTANCE_TYPE:-$PROFILE_DEFAULT_INSTANCE_TYPE}}"
if id -u ec2-user >/dev/null 2>&1; then
  SERVICE_USER="ec2-user"
elif id -u ubuntu >/dev/null 2>&1; then
  SERVICE_USER="ubuntu"
else
  SERVICE_USER="root"
fi
VOLUME_SIZE_GIB="${VOLUME_SIZE_GIB:-80}"
STATE_DIR_PATH="${STATE_DIR_PATH:-/srv/${GAME_NAME}-state}"
STATE_LINK="${STATE_LINK:-/home/ec2-user/.local/share/${GAME_NAME}}"
GAME_HOME="${GAME_HOME:-/opt/${GAME_NAME}}"
GAME_SERVICE="${GAME_NAME//[^A-Za-z0-9-]/-}"
GAME_SERVICE="${GAME_SERVICE,,}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES:-10}"
BACKUP_BOOT_OFFSET_MINUTES="${BACKUP_BOOT_OFFSET_MINUTES:-${BACKUP_INTERVAL_MINUTES}}"
WORLD_BUCKET_REGION="${WORLD_BUCKET_REGION:-$AWS_REGION}"
	MAX_SPOT_PRICE="${MAX_SPOT_PRICE:-}"
	SPOT_PRICE_BUMP_PERCENT="${SPOT_PRICE_BUMP_PERCENT:-25}"
GAME_STATE_PREFIX="${S3_PREFIX%/}/${GAME_NAME}"
WORLD_PREFIX="${GAME_STATE_PREFIX}"
SERVER_NAME="${SERVER_NAME:-${GAME_NAME}-spot-server}"

if [[ "$SHOW_RECOMMENDED" -eq 1 ]]; then
  echo "Recommended instance types for ${GAME_NAME}:"
  printf '%s\n' "$RECOMMENDED_INSTANCE_TYPES" | sed '/^[[:space:]]*$/d' | sed 's/^/ - /'
fi
echo "Selected instance type: ${INSTANCE_TYPE}"

read -r -a SECURITY_GROUP_ID_ARRAY <<< "$SECURITY_GROUP_IDS"

aws_cmd=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_cmd+=(--profile "$AWS_PROFILE")
fi

if ! which base64 >/dev/null 2>&1; then
  echo "base64 is required." >&2
  exit 1
fi

if [[ -n "${AMI_ID:-}" ]]; then
	  AMI="${AMI_ID}"
	else
	  AMI="$(
    "${aws_cmd[@]}" ssm get-parameter \
      --region "$AWS_REGION" \
      --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" \
      --query "Parameter.Value" \
      --output text
  )"
fi

# If MAX_SPOT_PRICE is not explicitly set, use the latest spot price for the selected
# instance type/AZ and add a safety margin so spot interruptions from outbid/low bid
# are less likely.
if [[ -z "${MAX_SPOT_PRICE}" ]]; then
  SUBNET_AZ="$(
    "${aws_cmd[@]}" ec2 describe-subnets \
      --region "$AWS_REGION" \
      --subnet-ids "$SUBNET_ID" \
      --query "Subnets[0].AvailabilityZone" \
      --output text \
      2>/dev/null || true
  )"

  if [[ -n "${SUBNET_AZ}" && "${SUBNET_AZ}" != "None" ]]; then
    CURRENT_SPOT_PRICE="$(
      "${aws_cmd[@]}" ec2 describe-spot-price-history \
        --region "$AWS_REGION" \
        --instance-types "$INSTANCE_TYPE" \
        --product-descriptions "Linux/UNIX" \
        --availability-zone "$SUBNET_AZ" \
        --query "SpotPriceHistory[0].SpotPrice" \
        --output text \
        2>/dev/null || true
    )"
    if [[ -n "${CURRENT_SPOT_PRICE}" && "${CURRENT_SPOT_PRICE}" != "None" ]]; then
      MAX_SPOT_PRICE="$(awk -v p="$CURRENT_SPOT_PRICE" -v b="$SPOT_PRICE_BUMP_PERCENT" 'BEGIN { printf "%.6f", p * (1 + b / 100) }')"
      echo "Auto spot max price set to ${MAX_SPOT_PRICE} (${SPOT_PRICE_BUMP_PERCENT}% above current spot @ ${SUBNET_AZ} / ${INSTANCE_TYPE})."
    fi
  fi
fi

if [[ -z "${AMI}" || "${AMI}" == "None" ]]; then
  echo "Could not resolve AMI_ID" >&2
  exit 1
fi

AMI_ROOT_DEVICE_NAME="$(
  "${aws_cmd[@]}" ec2 describe-images \
    --region "$AWS_REGION" \
    --image-ids "$AMI" \
    --query "Images[0].RootDeviceName" \
    --output text
)"
ROOT_DEVICE_NAME="${ROOT_DEVICE_NAME:-${AMI_ROOT_DEVICE_NAME:-/dev/xvda}}"
if [[ -z "$ROOT_DEVICE_NAME" || "$ROOT_DEVICE_NAME" == "None" ]]; then
  ROOT_DEVICE_NAME="/dev/xvda"
fi

TMP_USER_DATA="$(mktemp)"
trap 'rm -f "$TMP_USER_DATA"' EXIT

GAME_INSTALL_B64="$(printf '%s' "$GAME_INSTALL_CMD" | base64 -w0)"
GAME_START_B64="$(printf '%s' "$GAME_START_CMD" | base64 -w0)"

cat > "$TMP_USER_DATA" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export AWS_DEFAULT_REGION="${WORLD_BUCKET_REGION}"

WORLD_BUCKET="${WORLD_BUCKET}"
WORLD_PREFIX="${WORLD_PREFIX}"
STATE_DIR_PATH="${STATE_DIR_PATH}"
STATE_LINK="${STATE_LINK}"
STEAM_BETA_BRANCH="${STEAM_BETA_BRANCH}"
STEAM_BETA_PASSWORD="${STEAM_BETA_PASSWORD}"
GAME_HOME="${GAME_HOME}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES}"
BACKUP_BOOT_OFFSET_MINUTES="${BACKUP_BOOT_OFFSET_MINUTES}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-15}"
GAME_INSTALL_CMD_B64="${GAME_INSTALL_B64}"
GAME_START_CMD_B64="${GAME_START_B64}"
GAME_SERVICE="${GAME_SERVICE}"
GAME_NAME="${GAME_NAME}"
SERVICE_USER="${SERVICE_USER}"
STATE_TOOLS_DIR="/opt/\${GAME_SERVICE}-tools"

decode() {
  printf '%s' "\$1" | base64 -d
}

mkdir -p "/var/log/\${GAME_NAME}" "\${STATE_TOOLS_DIR}"

if command -v yum >/dev/null 2>&1; then
  yum -y update
  yum -y install ca-certificates tar gzip glibc
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates tar gzip curl
  dpkg --add-architecture i386 || true
  apt-get update
  apt-get install -y libc6:i386 libstdc++6:i386 || true
else
  echo "No supported package manager found (yum/apt)." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  if command -v yum >/dev/null 2>&1; then
    yum -y install curl-minimal || yum -y install curl || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get install -y curl || true
  fi
fi

if ! command -v aws >/dev/null 2>&1; then
  if command -v yum >/dev/null 2>&1; then
    yum -y install awscli || true
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get install -y awscli || true
  fi
fi

mkdir -p "\${STATE_DIR_PATH}"
mkdir -p "\${STATE_LINK%/*}"
ln -sfn "\${STATE_DIR_PATH}" "\${STATE_LINK}"

restore_state() {
  aws s3 sync "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" "\${STATE_DIR_PATH}/" || true
}

upload_state() {
  aws s3 sync "\${STATE_DIR_PATH}/" "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" --delete
}

install_game() {
  mkdir -p /opt/steamcmd "\${GAME_HOME%/*}"
  if [[ ! -x /opt/steamcmd/steamcmd.sh ]]; then
    curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd_linux.tar.gz
    tar -xzf /tmp/steamcmd_linux.tar.gz -C /opt/steamcmd
    chmod +x /opt/steamcmd/steamcmd.sh
  fi

  eval "\$(decode "\$GAME_INSTALL_CMD_B64")"
}

cat > "\${STATE_TOOLS_DIR}/restore-state.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
aws s3 sync "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" "\${STATE_DIR_PATH}/" || true
EOS

cat > "\${STATE_TOOLS_DIR}/upload-state.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
aws s3 sync "\${STATE_DIR_PATH}/" "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" --delete || true
EOS

cat > "\${STATE_TOOLS_DIR}/stop-server.command" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-15}"

game_pids="\$(pgrep -f "7DaysToDieServer.x86_64" || true)"
if [[ -n "\${game_pids}" ]]; then
  while IFS= read -r game_pid; do
    kill -s TERM "\${game_pid}" 2>/dev/null || true
  done <<< "\${game_pids}"
  sleep "${STOP_TIMEOUT_SECONDS}"
fi

remaining="\$(pgrep -f "7DaysToDieServer.x86_64" || true)"
if [[ -n "\${remaining}" ]]; then
  while IFS= read -r game_pid; do
    kill -s KILL "\${game_pid}" 2>/dev/null || true
  done <<< "\${remaining}"
fi

"/opt/\${GAME_SERVICE}-tools/upload-state.sh" || true
EOS

cat > "\${STATE_TOOLS_DIR}/start-server.command" <<'START_SERVER_CMD'
#!/usr/bin/env bash
set -euo pipefail

decode() {
  printf '%s' "\$1" | base64 -d
}

ensure_steamclient() {
  local steam_lib="/opt/steamcmd/linux64/steamclient.so"
  if [[ ! -f "\$steam_lib" ]]; then
    steam_lib="/opt/steamcmd/linux32/steamclient.so"
  fi
  if [[ ! -f "\$steam_lib" ]]; then
    return 0
  fi

  local runtime_user="\${USER:-\$(whoami)}"
  local user_home="\${HOME:-}"
  if [[ -z "\$user_home" || ! -d "\$user_home" ]]; then
    user_home="\$(getent passwd "\$runtime_user" | cut -d: -f6 || true)"
  fi
  if [[ -n "\$user_home" ]]; then
    mkdir -p "\$user_home/.steam/sdk64"
    ln -sf "\$steam_lib" "\$user_home/.steam/sdk64/steamclient.so"
  fi
}

runtime_user="\${USER:-\$(whoami)}"
export HOME="\${HOME:-\$(getent passwd \"\$runtime_user\" | cut -d: -f6 || true)}"
export USER="\$runtime_user"
ensure_steamclient

GAME_START_CMD_B64="${GAME_START_B64}"
eval "\$(decode "\$GAME_START_CMD_B64")"
START_SERVER_CMD

cat > "\${STATE_TOOLS_DIR}/spot-watchdog.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
NOTICE_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
while true; do
  if notice="\$(curl -fsS --max-time 1 "\$NOTICE_URL" || true)"; then
    if [[ "\$notice" == *\"action\"* ]]; then
      /opt/\${GAME_SERVICE}-tools/upload-state.sh || true
      /usr/bin/systemctl stop "\${GAME_SERVICE}-server.service" || true
      /usr/sbin/shutdown -h now "Spot termination notice"
      exit 0
    fi
  fi
  sleep 15
done
EOS

chmod +x "/opt/\${GAME_SERVICE}-tools/restore-state.sh" \
  "/opt/\${GAME_SERVICE}-tools/upload-state.sh" \
  "/opt/\${GAME_SERVICE}-tools/stop-server.command" \
  "/opt/\${GAME_SERVICE}-tools/spot-watchdog.sh" \
  "/opt/\${GAME_SERVICE}-tools/start-server.command"

cat > "/etc/systemd/system/\${GAME_SERVICE}-server.service" <<SERVER_SERVICE
[Unit]
Description=\${GAME_NAME} dedicated server
After=network.target

[Service]
Type=simple
User=\${SERVICE_USER}
WorkingDirectory=\${GAME_HOME}
ExecStart=/opt/\${GAME_SERVICE}-tools/start-server.command
ExecStop=/opt/\${GAME_SERVICE}-tools/stop-server.command
ExecStopPost=/opt/\${GAME_SERVICE}-tools/upload-state.sh
Restart=always
RestartSec=5
TimeoutStopSec=120
KillMode=control-group

[Install]
WantedBy=multi-user.target
SERVER_SERVICE

mkdir -p "/var/log/\${GAME_NAME}"
if id -u "\${SERVICE_USER}" >/dev/null 2>&1; then
  chown "\${SERVICE_USER}:\${SERVICE_USER}" "/var/log/\${GAME_NAME}"
fi

cat > "/etc/systemd/system/\${GAME_SERVICE}-watchdog.service" <<WATCHDOG_SERVICE
[Unit]
Description=Spot interruption watcher for \${GAME_NAME}
After=network.target

[Service]
Type=simple
ExecStart=/opt/\${GAME_SERVICE}-tools/spot-watchdog.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
WATCHDOG_SERVICE

cat > "/etc/systemd/system/\${GAME_SERVICE}-shutdown-save.service" <<SHUTDOWN_SAVE_SERVICE
[Unit]
Description=\${GAME_NAME} state save on shutdown/reboot
DefaultDependencies=no
After=network-online.target
Before=shutdown.target reboot.target halt.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/true
ExecStop=/opt/\${GAME_SERVICE}-tools/upload-state.sh
RemainAfterExit=true
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
SHUTDOWN_SAVE_SERVICE

cat > "/etc/systemd/system/\${GAME_SERVICE}-backup.service" <<BACKUP_SERVICE
[Unit]
Description=\${GAME_NAME} periodic backup

[Service]
Type=oneshot
ExecStart=/opt/\${GAME_SERVICE}-tools/upload-state.sh
BACKUP_SERVICE

cat > "/etc/systemd/system/\${GAME_SERVICE}-backup.timer" <<BACKUP_TIMER
[Unit]
Description=\${GAME_NAME} state backup timer

[Timer]
OnBootSec=\${BACKUP_BOOT_OFFSET_MINUTES}min
OnUnitActiveSec=\${BACKUP_INTERVAL_MINUTES}min
Persistent=true

[Install]
WantedBy=timers.target
BACKUP_TIMER

systemctl daemon-reload
restore_state
install_game

systemctl enable "\${GAME_SERVICE}-server.service" "\${GAME_SERVICE}-watchdog.service" "\${GAME_SERVICE}-shutdown-save.service"
systemctl start "\${GAME_SERVICE}-server.service"
systemctl enable --now "\${GAME_SERVICE}-backup.timer"

cat <<INFO
\${GAME_NAME} Spot instance bootstrap complete.
Game files: \${GAME_HOME}
Persistent state directory: \${STATE_DIR_PATH}
State prefix: \${WORLD_PREFIX}
INFO
EOF

RUN_ARGS=(
  "--region" "$AWS_REGION"
  "--image-id" "$AMI"
  "--instance-type" "$INSTANCE_TYPE"
  "--key-name" "$KEY_NAME"
  "--subnet-id" "$SUBNET_ID"
  "--security-group-ids" "${SECURITY_GROUP_ID_ARRAY[@]}"
  "--count" "1"
  "--user-data" "file://$TMP_USER_DATA"
  "--tag-specifications" "ResourceType=instance,Tags=[{Key=Name,Value=${SERVER_NAME}}]"
  "--instance-market-options" "MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate${MAX_SPOT_PRICE:+,MaxPrice=$MAX_SPOT_PRICE}}"
  "--block-device-mappings" '[{"DeviceName":"'$ROOT_DEVICE_NAME'","Ebs":{"DeleteOnTermination":true,"VolumeSize":'${VOLUME_SIZE_GIB}',"VolumeType":"gp3","Encrypted":true}}]'
)

RUN_ARGS+=("--iam-instance-profile" "Name=${IAM_INSTANCE_PROFILE}")

INSTANCE_ID="$(
  "${aws_cmd[@]}" ec2 run-instances "${RUN_ARGS[@]}" \
    --query "Instances[0].InstanceId" \
    --output text
)"

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "Failed to launch spot instance." >&2
  exit 1
fi

STATE_FILE="${STATE_DIR}/${GAME_SERVICE}.state"
(
  cat <<STATE
GAME_NAME=${GAME_NAME}
GAME_SERVICE=${GAME_SERVICE}
INSTANCE_ID=${INSTANCE_ID}
AWS_REGION=${AWS_REGION}
WORLD_BUCKET=${WORLD_BUCKET}
S3_PREFIX=${S3_PREFIX}
SELECTED_INSTANCE_TYPE=${INSTANCE_TYPE}
STATE
) > "$STATE_FILE"

cat <<INFO
Launched Spot instance ${INSTANCE_ID} in ${AWS_REGION}.
Selected instance type: ${INSTANCE_TYPE}
State file: ${STATE_FILE}
Check status: ${aws_cmd[*]} ec2 describe-instances --region ${AWS_REGION} --instance-ids ${INSTANCE_ID}
INFO
