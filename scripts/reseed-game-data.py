#!/usr/bin/env python3
"""Seed DynamoDB game records from legacy game profile .env files."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import boto3
from botocore.exceptions import ClientError


def parse_env(path: Path) -> Dict[str, str]:
  values: Dict[str, str] = {}
  in_block = False
  key = ""
  quote = ""
  buffer: List[str] = []

  for raw_line in path.read_text().splitlines():
    line = raw_line.rstrip("\n")
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
      continue

    if in_block:
      buffer.append(line)
      if line.rstrip().endswith(quote):
        values[key] = "\n".join(buffer)[:-1]
        in_block = False
        buffer = []
      continue

    if "=" not in stripped:
      continue

    name, value = stripped.split("=", 1)
    name = name.strip()
    if not name:
      continue
    if name.lower() == "export":
      continue
    value = value.strip()
    if not value:
      values[name] = ""
      continue
    if value[0] in {"'", '"'}:
      quote = value[0]
      if value.endswith(quote) and len(value) > 1:
        values[name] = value[1:-1]
      else:
        in_block = True
        key = name
        buffer = [value[1:]]
      continue
    values[name] = value

  if in_block and key:
    values[key] = "\n".join(buffer)

  return values


def split_csv(value: str) -> List[str]:
  return [item.strip() for item in value.split(",") if item.strip()]


def as_attr_value(value: Any) -> Dict[str, Any]:
  if value is None:
    return {"NULL": True}
  if isinstance(value, bool):
    return {"BOOL": value}
  if isinstance(value, int):
    return {"N": str(value)}
  if isinstance(value, float):
    return {"N": str(int(value)) if value.is_integer() else str(value)}
  if isinstance(value, list):
    return {"L": [as_attr_value(item) for item in value]}
  if isinstance(value, dict):
    return {"M": {k: as_attr_value(v) for k, v in value.items()}}
  return {"S": str(value)}


def make_item(fields: Dict[str, Any]) -> Dict[str, Any]:
  return {key: as_attr_value(value) for key, value in fields.items()}


def parse_int(raw: str, fallback: int = 0) -> int:
  try:
    parsed = int(str(raw).strip())
    if parsed > 0:
      return parsed
  except ValueError:
    pass
  return fallback


def safe_str(value: str | None, fallback: str = "") -> str:
  if not value:
    return fallback
  return value.strip()


def get_table_partition_key(ddb: Any, table_name: str) -> str:
  response = ddb.describe_table(TableName=table_name)
  keys = response["Table"]["KeySchema"]
  for key in keys:
    if key.get("KeyType") == "HASH":
      return key["AttributeName"]
  raise RuntimeError(f"Unable to determine partition key for {table_name}")


def main() -> None:
  root = Path(__file__).resolve().parent
  profiles_dir = root / "game-profiles"
  if not profiles_dir.exists():
    raise SystemExit(f"Missing profile directory: {profiles_dir}")

  stage = os.getenv("STAGE", "dev")
  project = os.getenv("PROJECT_NAME", "gameserver")
  region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1"
  table_name = f"{project}-{stage}-games"

  now = datetime.now(tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
  ddb = boto3.client("dynamodb", region_name=region)
  key_attribute = get_table_partition_key(ddb, table_name)
  table_key = lambda value: ({key_attribute: value})

  created_game = 0
  skipped_game = 0
  created_profile = 0
  skipped_profile = 0
  created_world = 0
  skipped_world = 0

  discovered_games = set[str]()

  env_files = sorted(profiles_dir.glob("*.env"))
  if not env_files:
    raise SystemExit(f"No profiles found in {profiles_dir}")

  for file in env_files:
    env = parse_env(file)
    profile_id = file.stem
    game_id = safe_str(env.get("GAME_NAME"), fallback=file.stem).strip()
    discovered_games.add(game_id)
    game_pk = game_id

    game_display = game_id.upper() if game_id.lower() == "7d2d" else game_id
    game_item = make_item(
      {
        "gameId": game_id,
        "kind": "game",
        "name": game_display,
        "title": game_display if game_id else game_id,
        "createdAt": now,
        "updatedAt": now,
      }
    )
    game_item.update(table_key(game_pk))
    if key_attribute != "pk" and "pk" not in game_item:
      game_item["pk"] = game_id
    try:
      ddb.put_item(
        TableName=table_name,
        Item=game_item,
        ConditionExpression=f"attribute_not_exists({key_attribute})",
      )
      created_game += 1
      print(f"created game: {game_id}")
    except ClientError as error:
      code = error.response["Error"]["Code"]
      if code in {"ConditionalCheckFailedException", "ConditionalCheckFailed"}:
        skipped_game += 1
      else:
        raise

    profile_name = game_id if file.stem == game_id else profile_id
    profile_record_key = f"game-profile#{game_id}#{profile_id}"
    subnet_ids = split_csv(safe_str(env.get("SUBNET_ID")))
    security_group_ids = split_csv(safe_str(env.get("SECURITY_GROUP_IDS")))
    udp_ports = split_csv(safe_str(env.get("GAME_UDP_PORTS")))
    tcp_ports = split_csv(safe_str(env.get("GAME_TCP_PORTS")))
    backup_interval = parse_int(env.get("BACKUP_INTERVAL_MINUTES", "5"), fallback=5)
    stop_timeout = parse_int(env.get("STOP_TIMEOUT_SECONDS", "30"), fallback=30)
    volume_size = parse_int(env.get("VOLUME_SIZE_GIB", ""), fallback=0)
    manages_game_config = game_id == "7d2d" or safe_str(env.get("MANAGE_GAME_CONFIG")) == "1"

    profile_item = make_item(
      {
        "pk": profile_record_key,
        "gameId": game_id,
        "gameRefId": game_id,
        "kind": "game-profile",
        "profileId": profile_id,
        "name": profile_name,
        "description": f"Imported from {file.name}",
        "config": {},
        "instanceType": safe_str(env.get("INSTANCE_TYPE")),
        "defaultInstanceType": safe_str(env.get("DEFAULT_INSTANCE_TYPE"), fallback=""),
        "amiId": safe_str(env.get("AMI_ID"), fallback=""),
        "subnetIds": subnet_ids,
        "securityGroupIds": security_group_ids,
        "keyName": safe_str(env.get("KEY_NAME"), fallback=""),
        "iamInstanceProfile": safe_str(env.get("IAM_INSTANCE_PROFILE"), fallback=""),
        "worldBucket": safe_str(env.get("WORLD_BUCKET"), fallback=""),
        "s3Prefix": safe_str(env.get("S3_PREFIX"), fallback=""),
        "worldBucketRegion": safe_str(env.get("WORLD_BUCKET_REGION"), fallback=env.get("AWS_REGION", region)),
        "gameInstallCmd": safe_str(env.get("GAME_INSTALL_CMD"), fallback=""),
        "gameStartCmd": safe_str(env.get("GAME_START_CMD"), fallback=""),
        "udpPorts": udp_ports,
        "tcpPorts": tcp_ports,
        "ingressCidr": safe_str(env.get("GAME_INGRESS_CIDR"), fallback=""),
        "backupIntervalMinutes": backup_interval,
        "stopTimeoutSeconds": stop_timeout,
        "gameName": game_id,
        "gameHome": safe_str(env.get("GAME_HOME"), fallback=f"/opt/{game_id}"),
        "stateLink": safe_str(env.get("STATE_LINK"), fallback=""),
        "steamBetaBranch": safe_str(env.get("STEAM_BETA_BRANCH"), fallback=""),
        "steamBetaPassword": safe_str(env.get("STEAM_BETA_PASSWORD"), fallback=""),
        "gameStateDirPath": safe_str(env.get("STATE_DIR_PATH"), fallback=f"/srv/{game_id}-state"),
        "gameConfigS3Key": safe_str(
          env.get("GAMECONFIG_S3_KEY"),
          fallback=f"{safe_str(env.get('S3_PREFIX'), fallback='servers')}/{game_id}/config/serverconfig.xml" if manages_game_config else "",
        ),
        "gameConfigLocalPath": safe_str(
          env.get("GAMECONFIG_LOCAL_PATH"),
          fallback=f"/opt/{game_id}/serverconfig.xml" if manages_game_config else "",
        ),
        "ensureSecurityGroupRules": safe_str(env.get("ENSURE_PROFILE_SECURITY_GROUP_RULES"), fallback="") == "1",
        "createdAt": now,
        "updatedAt": now,
      }
    )
    profile_item.update(table_key(profile_record_key))
    if key_attribute != "pk" and "pk" not in profile_item:
      profile_item["pk"] = profile_record_key
    # Avoid writing empty keys that would become false positives in UI rendering.
    if profile_item["instanceType"]["S"] == "":
      del profile_item["instanceType"]
    if profile_item["amiId"]["S"] == "":
      del profile_item["amiId"]
    if profile_item["subnetIds"]["L"]:
      profile_item["subnetIds"] = {"L": profile_item["subnetIds"]["L"]}
    else:
      del profile_item["subnetIds"]
    if profile_item["securityGroupIds"]["L"]:
      profile_item["securityGroupIds"] = {"L": profile_item["securityGroupIds"]["L"]}
    else:
      del profile_item["securityGroupIds"]
    if profile_item["udpPorts"]["L"]:
      profile_item["udpPorts"] = {"L": profile_item["udpPorts"]["L"]}
    else:
      del profile_item["udpPorts"]
    if profile_item["tcpPorts"]["L"]:
      profile_item["tcpPorts"] = {"L": profile_item["tcpPorts"]["L"]}
    else:
      del profile_item["tcpPorts"]
    if not volume_size:
      profile_item.pop("volumeSizeGiB", None)
    if profile_item["gameConfigS3Key"]["S"] == "":
      del profile_item["gameConfigS3Key"]
    if profile_item["gameConfigLocalPath"]["S"] == "":
      del profile_item["gameConfigLocalPath"]

    try:
      ddb.put_item(
        TableName=table_name,
        Item=profile_item,
        ConditionExpression=f"attribute_not_exists({key_attribute})",
      )
      created_profile += 1
      print(f"created profile: {game_id}/{profile_id}")
    except ClientError as error:
      code = error.response["Error"]["Code"]
      if code in {"ConditionalCheckFailedException", "ConditionalCheckFailed"}:
        skipped_profile += 1
      else:
        raise

  # Create a default world preset per game to prevent empty world selectors in UI.
  for game_id in sorted(discovered_games):
    world_id = "default"
    world_record_key = f"game-world#{game_id}#{world_id}"
    world_item = make_item(
      {
        "pk": world_record_key,
        "gameId": game_id,
        "gameRefId": game_id,
        "kind": "game-world",
        "worldId": world_id,
        "name": f"{game_id} - default",
        "description": f"Auto-created default world for {game_id}",
        "worldSeed": {},
        "createdAt": now,
        "updatedAt": now,
      }
    )
    world_item.update(table_key(world_record_key))
    if key_attribute != "pk" and "pk" not in world_item:
      world_item["pk"] = world_record_key
    try:
      ddb.put_item(
        TableName=table_name,
        Item=world_item,
        ConditionExpression=f"attribute_not_exists({key_attribute})",
      )
      created_world += 1
      print(f"created world: {game_id}/{world_id}")
    except ClientError as error:
      code = error.response["Error"]["Code"]
      if code in {"ConditionalCheckFailedException", "ConditionalCheckFailed"}:
        skipped_world += 1
      else:
        raise

  print("\nSummary:")
  print(f"  games: created={created_game} skipped={skipped_game}")
  print(f"  profiles: created={created_profile} skipped={skipped_profile}")
  print(f"  worlds: created={created_world} skipped={skipped_world}")


if __name__ == "__main__":
  main()
