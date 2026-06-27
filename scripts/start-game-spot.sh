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

  Optional profile preset:
  --profile NAME       Use profile from game-profiles/NAME.env

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
  --profile NAME        Equivalent to passing a profile name/path argument
  -h, --help            Show this help
USAGE
}

PROFILE_ARG="7d2d"
PROFILE_OVERRIDE=""
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
    --profile)
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --profile" >&2
        usage
        exit 1
      fi
      PROFILE_OVERRIDE="$1"
      shift
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

if [[ -n "${PROFILE_OVERRIDE}" ]]; then
  PROFILE_ARG="${PROFILE_OVERRIDE}"
fi

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
SERVICE_USER="${SERVICE_USER:-auto}"
VOLUME_SIZE_GIB="${VOLUME_SIZE_GIB:-80}"
STATE_DIR_PATH="${STATE_DIR_PATH:-/srv/${GAME_NAME}-state}"
STATE_LINK="${STATE_LINK:-}"
GAME_HOME="${GAME_HOME:-/opt/${GAME_NAME}}"
GAME_SERVICE="${GAME_NAME//[^A-Za-z0-9-]/-}"
GAME_SERVICE="${GAME_SERVICE,,}"
GAME_HOME="${GAME_HOME:-/opt/${GAME_SERVICE}}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES:-10}"
BACKUP_BOOT_OFFSET_MINUTES="${BACKUP_BOOT_OFFSET_MINUTES:-${BACKUP_INTERVAL_MINUTES}}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
WORLD_BUCKET_REGION="${WORLD_BUCKET_REGION:-$AWS_REGION}"
MAX_SPOT_PRICE="${MAX_SPOT_PRICE:-}"
SPOT_PRICE_BUMP_PERCENT="${SPOT_PRICE_BUMP_PERCENT:-25}"
GAME_STATE_PREFIX="${S3_PREFIX%/}/${GAME_NAME}"
WORLD_PREFIX="${GAME_STATE_PREFIX}"
SERVER_NAME="${SERVER_NAME:-${GAME_NAME}-spot-server}"
ENSURE_PROFILE_SECURITY_GROUP_RULES="${ENSURE_PROFILE_SECURITY_GROUP_RULES:-1}"
GAME_UDP_PORTS="${GAME_UDP_PORTS:-26900,26901,26902,26903}"
GAME_TCP_PORTS="${GAME_TCP_PORTS:-26900,8081}"
GAME_INGRESS_CIDR="${GAME_INGRESS_CIDR:-0.0.0.0/0}"

if [[ "$SHOW_RECOMMENDED" -eq 1 ]]; then
  echo "Recommended instance types for ${GAME_NAME}:"
  printf '%s\n' "$RECOMMENDED_INSTANCE_TYPES" | sed '/^[[:space:]]*$/d' | sed 's/^/ - /'
fi
echo "Selected instance type: ${INSTANCE_TYPE}"

read -r -a SECURITY_GROUP_ID_ARRAY <<< "$SECURITY_GROUP_IDS"

ensure_security_group_ports() {
  local sg_id="$1"
  local protocol="$2"
  local port="$3"
  local output

  if [[ -z "$sg_id" || -z "$protocol" || -z "$port" ]]; then
    return 1
  fi

  if ! output="$("${aws_cmd[@]}" ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$sg_id" \
    --protocol "$protocol" \
    --port "$port" \
    --cidr "$GAME_INGRESS_CIDR" \
    2>&1)"; then
    if [[ "$output" == *"InvalidPermission.Duplicate"* || "$output" == *"already exists"* ]]; then
      return 0
    fi
    echo "Could not configure inbound ${protocol^^} ${port} on ${sg_id}: ${output}" >&2
    return 1
  fi
}

normalize_port_list() {
  local list="$1"
  local -n out_ref=$2
  local token token_clean range_start range_end p
  local -a tokens
  IFS=',' read -ra tokens <<< "$list"
  out_ref=()

  for token in "${tokens[@]}"; do
    token_clean="$(printf '%s' "$token" | tr -d '[:space:]')"
    if [[ -z "$token_clean" ]]; then
      continue
    fi

    if [[ "$token_clean" == *-* ]]; then
      range_start="${token_clean%-*}"
      range_end="${token_clean#*-}"
      if [[ ! "$range_start" =~ ^[0-9]+$ ]] || [[ ! "$range_end" =~ ^[0-9]+$ ]]; then
        continue
      fi
      for ((p=range_start; p<=range_end; p++)); do
        out_ref+=("$p")
      done
    elif [[ "$token_clean" =~ ^[0-9]+$ ]]; then
      out_ref+=("$token_clean")
    fi
  done
}

ensure_profile_security_group_rules() {
  local sg_id
  local -a udp_ports
  local -a tcp_ports

  if [[ "${ENSURE_PROFILE_SECURITY_GROUP_RULES}" != "1" ]]; then
    return 0
  fi

  if [[ -z "${SECURITY_GROUP_IDS}" ]]; then
    echo "SECURITY_GROUP_IDS is empty. Aborting launch." >&2
    return 1
  fi

  normalize_port_list "$GAME_UDP_PORTS" udp_ports
  normalize_port_list "$GAME_TCP_PORTS" tcp_ports

  for sg_id in "${SECURITY_GROUP_ID_ARRAY[@]}"; do
    if [[ -z "$sg_id" ]]; then
      continue
    fi

    if ! "${aws_cmd[@]}" ec2 describe-security-groups --region "$AWS_REGION" --group-ids "$sg_id" --query "SecurityGroups[0].GroupId" --output text >/dev/null 2>&1; then
      echo "Security group $sg_id not found in ${AWS_REGION}. Aborting launch." >&2
      return 1
    fi

    for port in "${udp_ports[@]}"; do
      ensure_security_group_ports "$sg_id" "udp" "$port" || return 1
    done

    for port in "${tcp_ports[@]}"; do
      ensure_security_group_ports "$sg_id" "tcp" "$port" || return 1
    done
  done
}

aws_cmd=(aws)
if [[ -n "${AWS_PROFILE:-}" ]]; then
  aws_cmd+=(--profile "$AWS_PROFILE")
fi

if ! which base64 >/dev/null 2>&1; then
  echo "base64 is required." >&2
  exit 1
fi

ensure_profile_security_group_rules

if [[ -n "${AMI_ID:-}" ]]; then
  if [[ "$AMI_ID" == /aws/service/* ]]; then
    AMI="$(
      "${aws_cmd[@]}" ssm get-parameter \
        --region "$AWS_REGION" \
        --name "$AMI_ID" \
        --query "Parameter.Value" \
        --output text
    )"
  else
    AMI="${AMI_ID}"
  fi
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

TMP_BOOTSTRAP="$(mktemp)"
TMP_USER_DATA="$(mktemp)"
trap 'rm -f "$TMP_BOOTSTRAP" "$TMP_USER_DATA"' EXIT

GAME_INSTALL_B64="$(printf '%s' "$GAME_INSTALL_CMD" | base64 -w0)"
GAME_START_B64="$(printf '%s' "$GAME_START_CMD" | base64 -w0)"

cat > "$TMP_BOOTSTRAP" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export AWS_DEFAULT_REGION="${WORLD_BUCKET_REGION}"

WORLD_BUCKET="${WORLD_BUCKET:-}"
GAME_STATE_PREFIX="${GAME_STATE_PREFIX:-${S3_PREFIX%/}/${GAME_NAME}}"
WORLD_PREFIX="${WORLD_PREFIX:-${GAME_STATE_PREFIX}}"
STATE_DIR_PATH="${STATE_DIR_PATH:-/srv/${GAME_NAME}-state}"
STATE_LINK="${STATE_LINK:-}"
STEAM_BETA_BRANCH="${STEAM_BETA_BRANCH}"
STEAM_BETA_PASSWORD="${STEAM_BETA_PASSWORD}"
GAME_HOME="${GAME_HOME:-/opt/${GAME_NAME}}"
GAMECONFIG_S3_KEY="${GAMECONFIG_S3_KEY:-${WORLD_PREFIX}/config/serverconfig.xml}"
GAMECONFIG_LOCAL_PATH="${GAMECONFIG_LOCAL_PATH:-${GAME_HOME}/serverconfig.xml}"
BACKUP_INTERVAL_MINUTES="${BACKUP_INTERVAL_MINUTES}"
BACKUP_BOOT_OFFSET_MINUTES="${BACKUP_BOOT_OFFSET_MINUTES}"
STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"
GAME_INSTALL_CMD_B64="${GAME_INSTALL_B64}"
GAME_START_CMD_B64="${GAME_START_B64}"
GAME_SERVICE="${GAME_SERVICE:-${GAME_NAME}}"
GAME_NAME="${GAME_NAME}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
STATE_TOOLS_DIR="/opt/\${GAME_SERVICE}-tools"

decode() {
  printf '%s' "\$1" | base64 -d
}

mkdir -p "/var/log/\${GAME_NAME}" "\${STATE_TOOLS_DIR}"
mkdir -p /tmp

if command -v yum >/dev/null 2>&1; then
  yum -y update
  yum -y install ${YUM_BASE_PACKAGES:-ca-certificates tar gzip glibc libstdc++}
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

if [[ "\$SERVICE_USER" == "auto" ]]; then
  if id -u ec2-user >/dev/null 2>&1; then
    SERVICE_USER="ec2-user"
  elif id -u ubuntu >/dev/null 2>&1; then
    SERVICE_USER="ubuntu"
  else
    SERVICE_USER="root"
  fi
fi

if ! id -u "\$SERVICE_USER" >/dev/null 2>&1; then
  SERVICE_USER="root"
fi

if [[ -z "\$STATE_LINK" ]]; then
  SERVICE_USER_HOME="\$(getent passwd "\$SERVICE_USER" | cut -d: -f6 || true)"
  if [[ -z "\$SERVICE_USER_HOME" ]]; then
    SERVICE_USER_HOME="/home/\$SERVICE_USER"
  fi
  STATE_LINK="\${SERVICE_USER_HOME}/.local/share/7DaysToDie"
else
  STATE_LINK="\${STATE_LINK%/}"
fi

mkdir -p "\${STATE_DIR_PATH}"
mkdir -p "\${STATE_LINK%/*}"
if id -u "\$SERVICE_USER" >/dev/null 2>&1; then
  chown -R "\$SERVICE_USER:\$SERVICE_USER" "\${STATE_DIR_PATH}" "\${STATE_LINK%/*}" || true
  chmod -R u+rwX "\${STATE_DIR_PATH}" || true
fi
ln -sfn "\${STATE_DIR_PATH}" "\${STATE_LINK}"

restore_state() {
  aws s3 sync "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" "\${STATE_DIR_PATH}/" || true
  if [[ -d "\${STATE_DIR_PATH}" ]] && [[ "\${SERVICE_USER}" != "root" ]] && id -u "\${SERVICE_USER}" >/dev/null 2>&1; then
    chown -R "\${SERVICE_USER}:\${SERVICE_USER}" "\${STATE_DIR_PATH}" || true
    chmod -R u+rwX "\${STATE_DIR_PATH}" || true
  fi
}

upload_state() {
  aws s3 sync "\${STATE_DIR_PATH}/" "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" --delete
}

ensure_server_setting() {
  local config_path="\$1"
  local setting_name="\$2"
  local setting_value="\$3"

  if [[ -z "\${setting_name}" || -z "\${setting_value}" ]]; then
    return 0
  fi

  if [[ -f "\${config_path}" ]] && grep -q "name=\"\${setting_name}\"" "\${config_path}"; then
    return 0
  fi

  sed -i "/<\\/ServerSettings>/i\\  <property name=\"\${setting_name}\" value=\"\${setting_value}\" />" "\${config_path}"
}

ensure_server_config_defaults() {
  local config_path="\$1"
  local game_world="\${GAME_WORLD:-Navezgane}"
  local game_name="\${GAME_NAME:-7d2d}"

  ensure_server_setting "\${config_path}" "ServerName" "7d2d Spot"
  ensure_server_setting "\${config_path}" "ServerPassword" ""
  ensure_server_setting "\${config_path}" "ServerMaxPlayerCount" "8"
  ensure_server_setting "\${config_path}" "ServerPort" "26900"
  ensure_server_setting "\${config_path}" "GameWorld" "\${game_world}"
  ensure_server_setting "\${config_path}" "GameName" "\${game_name}"
}

apply_server_config() {
  mkdir -p "\$(dirname "\${GAMECONFIG_LOCAL_PATH}")"

  if [[ -n "\${GAMECONFIG_S3_KEY}" ]]; then
    if aws s3 cp "s3://\${WORLD_BUCKET}/\${GAMECONFIG_S3_KEY}" "\${GAMECONFIG_LOCAL_PATH}"; then
      echo "Restored server config from s3://\${WORLD_BUCKET}/\${GAMECONFIG_S3_KEY}"
      ensure_server_config_defaults "\${GAMECONFIG_LOCAL_PATH}"
      return
    fi
  fi

  if [[ ! -f "\${GAMECONFIG_LOCAL_PATH}" ]]; then
    cat <<XML > "\${GAMECONFIG_LOCAL_PATH}"
<ServerSettings>
  <property name="BloodMoonFrequency" value="7" />
  <property name="BloodMoonRange" value="2" />
  <property name="DropOnDeath" value="2" />
  <property name="PlayerKillingMode" value="2" />
  <property name="AirDropMarker" value="true" />
</ServerSettings>
XML
    echo "Created default serverconfig.xml with requested 7D2D settings at \${GAMECONFIG_LOCAL_PATH}."
  fi

  ensure_server_config_defaults "\${GAMECONFIG_LOCAL_PATH}"
}

install_game() {
  mkdir -p /opt/steamcmd "\${GAME_HOME%/*}"
  if [[ ! -x /opt/steamcmd/steamcmd.sh ]]; then
    curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz -o /tmp/steamcmd_linux.tar.gz
    tar -xzf /tmp/steamcmd_linux.tar.gz -C /opt/steamcmd
    chmod +x /opt/steamcmd/steamcmd.sh
  fi

  ensure_steamcmd_runtime() {
    if /opt/steamcmd/linux32/steamcmd +quit >/dev/null 2>&1; then
      return 0
    fi

    echo "SteamCMD runtime check failed; attempting to install 32-bit compatibility dependencies."
    if command -v dnf >/dev/null 2>&1; then
      dnf -y install glibc.i686 libgcc.i686 libstdc++.i686 || true
      dnf -y install glibc-devel.i686 libstdc++-devel.i686 || true
    elif command -v yum >/dev/null 2>&1; then
      yum -y install glibc.i686 libgcc.i686 libstdc++.i686 || true
    elif command -v apt-get >/dev/null 2>&1; then
      dpkg --add-architecture i386 || true
      apt-get update || true
      apt-get install -y libc6-i386 libstdc++6:i386 libgcc-s1:i386 || true
      apt-get install -y libc6:i386 libstdc++6:i386 libgcc1:i386 || true
      apt-get install -y libc6:i386 libstdc++6:i386 lib32gcc-s1 || true
      apt-get install -y lib32stdc++6 || true
      apt-get install -y lib32gcc1 || true
    fi

    if /opt/steamcmd/linux32/steamcmd +quit >/dev/null 2>&1; then
      return 0
    fi
    return 1
  }

  ensure_steamcmd_runtime || true

  install_cmd="\$(decode "\$GAME_INSTALL_CMD_B64")"
  local install_branches
  local tried_branches
  local branch
  local install_ok=0

  install_branches=()
  tried_branches=()

  if [[ -n "\${STEAM_BETA_BRANCH}" ]]; then
    install_branches+=("\${STEAM_BETA_BRANCH}")
  fi

  case "\${STEAM_BETA_BRANCH}" in
    latest_experimental|latest-experimental|latestexperimental|experimental|beta)
      install_branches+=("experimental")
      ;;
  esac

  install_branches+=("")

  for branch in "\${install_branches[@]}"; do
    if [[ " \${tried_branches[*]} " == *" \${branch} "* ]]; then
      continue
    fi
    tried_branches+=("\${branch}")

    if [[ -n "\${branch}" ]]; then
      echo "Attempting app_update using beta branch: \${branch}"
    else
      echo "Attempting app_update using public branch"
    fi

    if STEAM_BETA_BRANCH="\${branch}" bash -lc "\${install_cmd}"; then
      echo "Steam install succeeded."
      install_ok=1
      break
    fi
  done

  if [[ "\$install_ok" -ne 1 ]]; then
    echo "All app_update attempts failed."
    return 1
  fi
}

cat > "\${STATE_TOOLS_DIR}/restore-state.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

WORLD_BUCKET="${WORLD_BUCKET:-}"
WORLD_PREFIX="${WORLD_PREFIX:-${GAME_STATE_PREFIX:-servers/${GAME_SERVICE}}}"
GAMECONFIG_S3_KEY="${GAMECONFIG_S3_KEY:-}"
TOOLS_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
SERVICE_NAME="\$(basename "\${TOOLS_DIR}")"
GAME_SERVICE="\${GAME_SERVICE:-\${SERVICE_NAME}}"
GAME_SERVICE="\${GAME_SERVICE%-tools}"
GAME_SERVICE="\${GAME_SERVICE,,}"
GAME_HOME="\${GAME_HOME:-/opt/\${GAME_SERVICE}}"
GAMECONFIG_LOCAL_PATH="\${GAMECONFIG_LOCAL_PATH:-}"
if [[ -z "\${GAMECONFIG_LOCAL_PATH}" ]]; then
  GAMECONFIG_LOCAL_PATH="\${GAME_HOME}/serverconfig.xml"
fi
STATE_DIR_PATH="\${STATE_DIR_PATH:-}"
if [[ -z "\${STATE_DIR_PATH}" ]]; then
  STATE_DIR_PATH="/srv/\${GAME_SERVICE}-state"
fi
SERVICE_USER="\${SERVICE_USER:-\${USER:-\$(whoami)}}"
SERVICE_HOME="\$(getent passwd "\${SERVICE_USER}" | cut -d: -f6 || true)"
WORLD_LINK_PATH="\${WORLD_LINK_PATH:-}"
if [[ -z "\${WORLD_LINK_PATH}" ]]; then
  if [[ -z "\${SERVICE_HOME}" ]]; then
    SERVICE_HOME="\${HOME:-/home/\${SERVICE_USER}}"
  fi
  WORLD_LINK_PATH="\${SERVICE_HOME%/}/.local/share/7DaysToDie"
fi
WORLD_LINK_PATH="\${WORLD_LINK_PATH%/}"

mkdir -p "\${WORLD_LINK_PATH%/*}" || true
ln -sfn "\${STATE_DIR_PATH}" "\${WORLD_LINK_PATH}"

if [[ -n "${WORLD_BUCKET}" && -n "${WORLD_PREFIX}" ]]; then
  aws s3 sync "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" "\${STATE_DIR_PATH}/" || true
else
  echo "Skipping restore-state sync: WORLD_BUCKET or WORLD_PREFIX not set."
fi
if [[ -d "\${WORLD_LINK_PATH%/*}" ]]; then
  chown_user="${SERVICE_USER:-ubuntu}"
  if id -u "\${chown_user}" >/dev/null 2>&1; then
    chown -R "\${chown_user}:\${chown_user}" "\${STATE_DIR_PATH}" || true
  else
    chown -R "ubuntu:ubuntu" "\${STATE_DIR_PATH}" || true
  fi
  chmod -R u+rwX "\${STATE_DIR_PATH}" || true
fi
if [[ -n "\${GAMECONFIG_S3_KEY}" ]]; then
  mkdir -p "\$(dirname "\${GAMECONFIG_LOCAL_PATH}")"
  aws s3 cp "s3://\${WORLD_BUCKET}/\${GAMECONFIG_S3_KEY}" "\${GAMECONFIG_LOCAL_PATH}" || true
fi
EOS

cat > "\${STATE_TOOLS_DIR}/upload-state.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail

WORLD_BUCKET="${WORLD_BUCKET:-}"
WORLD_PREFIX="${WORLD_PREFIX:-${GAME_STATE_PREFIX:-servers/${GAME_SERVICE}}}"
GAMECONFIG_S3_KEY="${GAMECONFIG_S3_KEY:-}"
TOOLS_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
SERVICE_NAME="\$(basename "\$TOOLS_DIR")"
GAME_SERVICE="\${GAME_SERVICE:-\${SERVICE_NAME}}"
GAME_SERVICE="\${GAME_SERVICE%-tools}"
GAME_SERVICE="\${GAME_SERVICE,,}"
GAME_HOME="\${GAME_HOME:-/opt/\${GAME_SERVICE}}"
GAMECONFIG_LOCAL_PATH="\${GAMECONFIG_LOCAL_PATH:-}"
if [[ -z "\${GAMECONFIG_LOCAL_PATH}" ]]; then
  GAMECONFIG_LOCAL_PATH="\${GAME_HOME}/serverconfig.xml"
fi
STATE_DIR_PATH="\${STATE_DIR_PATH:-}"
if [[ -z "\${STATE_DIR_PATH}" ]]; then
  STATE_DIR_PATH="/srv/\${GAME_SERVICE}-state"
fi
SERVICE_USER="\${SERVICE_USER:-\${USER:-\$(whoami)}}"
SERVICE_HOME="\$(getent passwd "\${SERVICE_USER}" | cut -d: -f6 || true)"
WORLD_LINK_PATH="\${WORLD_LINK_PATH:-}"
if [[ -z "\${WORLD_LINK_PATH}" ]]; then
  if [[ -z "\${SERVICE_HOME}" ]]; then
    SERVICE_HOME="\${HOME:-/home/\${SERVICE_USER}}"
  fi
  WORLD_LINK_PATH="\${SERVICE_HOME%/}/.local/share/7DaysToDie"
fi
WORLD_LINK_PATH="\${WORLD_LINK_PATH%/}"

mkdir -p "\${WORLD_LINK_PATH%/*}" || true
ln -sfn "\${STATE_DIR_PATH}" "\${WORLD_LINK_PATH}"

if [[ -n "\${WORLD_BUCKET}" && -n "\${WORLD_PREFIX}" ]]; then
  aws s3 sync "\${STATE_DIR_PATH}/" "s3://\${WORLD_BUCKET}/\${WORLD_PREFIX}/state/" --delete || true
else
  echo "Skipping upload-state sync: WORLD_BUCKET or WORLD_PREFIX not set."
fi
if [[ -n "\${GAMECONFIG_S3_KEY}" && -f "\${GAMECONFIG_LOCAL_PATH}" ]]; then
  aws s3 cp "\${GAMECONFIG_LOCAL_PATH}" "s3://\${WORLD_BUCKET}/\${GAMECONFIG_S3_KEY}" || true
fi
EOS

cat > "\${STATE_TOOLS_DIR}/stop-server.command" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
TOOLS_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
SERVICE_NAME="\$(basename "\${TOOLS_DIR}")"
GAME_SERVICE="\${GAME_SERVICE:-\${SERVICE_NAME}}"
GAME_SERVICE="\${GAME_SERVICE%-tools}"
GAME_SERVICE="\${GAME_SERVICE,,}"

STOP_TIMEOUT_SECONDS="${STOP_TIMEOUT_SECONDS:-30}"

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

WORLD_BUCKET="${WORLD_BUCKET:-}"

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
TOOLS_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
SERVICE_NAME="\$(basename "\$TOOLS_DIR")"
GAME_SERVICE="\${GAME_SERVICE:-\${SERVICE_NAME}}"
GAME_SERVICE="\${GAME_SERVICE%-tools}"
GAME_SERVICE="\${GAME_SERVICE,,}"
GAME_HOME="\${GAME_HOME:-/opt/\${GAME_SERVICE}}"
GAMECONFIG_S3_KEY="\${GAMECONFIG_S3_KEY:-}"
GAMECONFIG_LOCAL_PATH="\${GAMECONFIG_LOCAL_PATH:-}"
if [[ -z "\${GAMECONFIG_LOCAL_PATH}" ]]; then
  GAMECONFIG_LOCAL_PATH="\${GAME_HOME}/serverconfig.xml"
fi
STATE_DIR_PATH="\${STATE_DIR_PATH:-}"
if [[ -z "\${STATE_DIR_PATH}" ]]; then
  STATE_DIR_PATH="/srv/\${GAME_SERVICE}-state"
fi
if [[ -n "\${HOME}" ]]; then
  mkdir -p "\${HOME}/.local/share/7DaysToDie/Saves" || true
  if [[ -d "\${STATE_DIR_PATH}" ]] && [[ "\$runtime_user" != "root" ]]; then
    chown -R "\$runtime_user:\$runtime_user" "\${STATE_DIR_PATH}" "${HOME}/.local/share/7DaysToDie" || {
      echo "WARNING: Could not chown all state files as \${runtime_user}."
    }
    chmod -R u+rwX "\${STATE_DIR_PATH}" "${HOME}/.local/share/7DaysToDie" || true
  fi

  ln -sfn "\${STATE_DIR_PATH}" "\${HOME}/.local/share/7DaysToDie" || true
  chown -R "\$runtime_user:\$runtime_user" "\${HOME}/.local/share/7DaysToDie" || true
  chmod -R u+rwX "\${HOME}/.local/share/7DaysToDie" || true
fi

mkdir -p "\${GAME_HOME}"
mkdir -p "\$(dirname "\${GAMECONFIG_LOCAL_PATH}")"
if [[ -n "\${GAMECONFIG_S3_KEY}" ]]; then
  aws s3 cp "s3://\${WORLD_BUCKET}/\${GAMECONFIG_S3_KEY}" "\${GAMECONFIG_LOCAL_PATH}" || true
fi
if [[ ! -f "\${GAMECONFIG_LOCAL_PATH}" ]]; then
  cat <<XML > "\${GAMECONFIG_LOCAL_PATH}"
<ServerSettings>
  <property name="BloodMoonFrequency" value="7" />
  <property name="BloodMoonRange" value="2" />
  <property name="DropOnDeath" value="2" />
  <property name="PlayerKillingMode" value="2" />
  <property name="AirDropMarker" value="true" />
</ServerSettings>
XML
fi
ensure_server_setting() {
  local config_path="\$1"
  local setting_name="\$2"
  local setting_value="\$3"

  if [[ -z "\${setting_name}" || -z "\${setting_value}" ]]; then
    return 0
  fi

  if [[ -f "\${config_path}" ]] && grep -q "name=\"\${setting_name}\"" "\${config_path}"; then
    return 0
  fi

  sed -i "/<\\/ServerSettings>/i\\  <property name=\"\${setting_name}\" value=\"\${setting_value}\" />" "\${config_path}"
}

ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "ServerName" "7d2d Spot"
ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "ServerPassword" ""
ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "ServerMaxPlayerCount" "8"
ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "ServerPort" "26900"
ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "GameWorld" "Navezgane"
ensure_server_setting "\${GAMECONFIG_LOCAL_PATH}" "GameName" "7d2d"
ensure_steamclient

GAME_START_CMD_B64="${GAME_START_B64}"
eval "\$(decode "\$GAME_START_CMD_B64")"
START_SERVER_CMD

cat > "\${STATE_TOOLS_DIR}/spot-watchdog.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
TOOLS_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
SERVICE_NAME="\$(basename "\$TOOLS_DIR")"
GAME_SERVICE="\${GAME_SERVICE:-\${SERVICE_NAME}}"
GAME_SERVICE="\${GAME_SERVICE%-tools}"
GAME_SERVICE="\${GAME_SERVICE,,}"
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

systemctl stop "\${GAME_SERVICE}-server.service" "\${GAME_SERVICE}-watchdog.service" "\${GAME_SERVICE}-shutdown-save.service" "\${GAME_SERVICE}-backup.service" "\${GAME_SERVICE}-backup.timer" 2>/dev/null || true
systemctl disable "\${GAME_SERVICE}-server.service" "\${GAME_SERVICE}-watchdog.service" "\${GAME_SERVICE}-shutdown-save.service" "\${GAME_SERVICE}-backup.service" "\${GAME_SERVICE}-backup.timer" 2>/dev/null || true
rm -f "/etc/systemd/system/\${GAME_SERVICE}-server.service" \
  "/etc/systemd/system/\${GAME_SERVICE}-watchdog.service" \
  "/etc/systemd/system/\${GAME_SERVICE}-shutdown-save.service" \
  "/etc/systemd/system/\${GAME_SERVICE}-backup.service" \
  "/etc/systemd/system/\${GAME_SERVICE}-backup.timer"
rm -rf "/etc/systemd/system/\${GAME_SERVICE}-server.service.d" \
  "/etc/systemd/system/\${GAME_SERVICE}-watchdog.service.d" \
  "/etc/systemd/system/\${GAME_SERVICE}-shutdown-save.service.d" \
  "/etc/systemd/system/\${GAME_SERVICE}-backup.service.d" \
  "/etc/systemd/system/\${GAME_SERVICE}-backup.timer.d"

cat > "/etc/systemd/system/\${GAME_SERVICE}-server.service" <<SERVER_SERVICE
[Unit]
Description=\${GAME_NAME} dedicated server
After=network.target

[Service]
Type=simple
User=\${SERVICE_USER}
WorkingDirectory=\${GAME_HOME}
Environment=STATE_DIR_PATH=\${STATE_DIR_PATH}
Environment=WORLD_BUCKET=\${WORLD_BUCKET}
Environment=WORLD_PREFIX=\${WORLD_PREFIX}
Environment=GAME_STATE_PREFIX=\${GAME_STATE_PREFIX}
Environment=GAME_HOME=\${GAME_HOME}
Environment=GAMECONFIG_S3_KEY=\${GAMECONFIG_S3_KEY}
Environment=GAMECONFIG_LOCAL_PATH=\${GAMECONFIG_LOCAL_PATH}
Environment=GAME_SERVICE=\${GAME_SERVICE}
Environment=SERVICE_USER=\${SERVICE_USER}
Environment=STATE_LINK=\${STATE_LINK}
Environment=BACKUP_INTERVAL_MINUTES=\${BACKUP_INTERVAL_MINUTES}
Environment=BACKUP_BOOT_OFFSET_MINUTES=\${BACKUP_BOOT_OFFSET_MINUTES}
Environment=STOP_TIMEOUT_SECONDS=\${STOP_TIMEOUT_SECONDS}
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
apply_server_config

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

BOOTSTRAP_B64="$(base64 -w0 < <(gzip -c "$TMP_BOOTSTRAP"))"
cat > "$TMP_USER_DATA" <<USER_DATA
#!/usr/bin/env bash
set -euo pipefail
printf '%s' "${BOOTSTRAP_B64}" | base64 -d | gzip -dc | bash
USER_DATA

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
