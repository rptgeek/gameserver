import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSpotPriceHistoryCommand,
  DescribeSubnetsCommand,
  RebootInstancesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  GetCommandInvocationCommand,
  GetParameterCommand,
  SendCommandCommand,
} from "@aws-sdk/client-ssm";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CreateLogStreamCommand,
  GetLogEventsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-cloudwatch-logs";
import { createRemoteJWKSet, jwtVerify, JWTPayload } from "jose";

import { config } from "./config";
import { ddbClient, ec2Client, logsClient, s3Client, ssmClient } from "./aws";
import { BaseRepository } from "./models/repositories";
import {
  ConfigHistoryItem,
  ConfigItem,
  IdempotencyLookupItem,
  InstanceCreateRequest,
  InstanceItem,
  GameItem,
  GameProfileItem,
  WorldPresetItem,
  OperationItem,
  CopyWorldRequest,
  SaveProfileRequest,
  SaveWorldRequest,
  UserContext,
  SupportedAction,
} from "./models/types";

const gamesRepository = new BaseRepository<GameItem>(config.tables.games, ddbClient);
const gameProfilesRepository = new BaseRepository<GameProfileItem>(
  config.tables.games,
  ddbClient,
);
const worldPresetsRepository = new BaseRepository<WorldPresetItem>(
  config.tables.games,
  ddbClient,
);
const instanceRepository = new BaseRepository<InstanceItem>(
  config.tables.instances,
  ddbClient,
);
const operationRepository = new BaseRepository<OperationItem>(
  config.tables.operations,
  ddbClient,
);
const configRepository = new BaseRepository<ConfigItem>(
  config.tables.instanceConfig,
  ddbClient,
);
const configHistoryRepository = new BaseRepository<ConfigHistoryItem>(
  config.tables.configHistory,
  ddbClient,
);
const idempotencyRepository = new BaseRepository<IdempotencyLookupItem>(
  config.tables.operations,
  ddbClient,
);

type AuthenticatedRequest = Request & { user: UserContext };

const jwksUrl =
  config.auth.userPoolId && config.auth.clientId
    ? new URL(
        `https://cognito-idp.${config.auth.cognitoRegion}.amazonaws.com/${config.auth.userPoolId}/.well-known/jwks.json`,
      )
    : null;
const jwks = jwksUrl ? createRemoteJWKSet(jwksUrl) : null;

function authRole(payload: JWTPayload): string {
  const claim = payload["custom:role"] as unknown;
  if (typeof claim === "string" && claim.trim()) return claim.toLowerCase().trim();
  if (Array.isArray(claim) && claim.length > 0)
    return String(claim[0]).toLowerCase();
  return "user";
}

async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authReq = req as AuthenticatedRequest;
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  if (
    config.auth.authDisabled ||
    !config.auth.userPoolId ||
    !config.auth.clientId ||
    !jwks
  ) {
    authReq.user = {
      sub: "system",
      username: "system",
      role: config.auth.defaultRole,
    };
    next();
    return;
  }

  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header missing" });
    return;
  }

  const token = authorization.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer:
        config.auth.issuerTemplate ??
        `https://cognito-idp.${config.auth.cognitoRegion}.amazonaws.com/${config.auth.userPoolId}`,
      audience: config.auth.clientId,
    });

    const issuerPayload = (payload as Record<string, unknown> | undefined) ?? {};
    authReq.user = {
      sub: String(payload.sub ?? "unknown"),
      username: String(
        issuerPayload.email ??
          issuerPayload["cognito:username"] ??
          payload.sub ??
          "unknown",
      ),
      role: authRole(payload),
    };
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token", details: (error as Error).message });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function asIntList(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number(item))
      .filter((value) => Number.isInteger(value) && value > 0);
  }
  if (typeof value === "string") {
    return parsePortList(value);
  }
  return [];
}

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return typeof value === "string" ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : String(item)))
    .filter((item) => item.length > 0);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function normalizeCsvList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parsePortList(raw: string | undefined): number[] {
  if (!raw) return [];
  const items = normalizeCsvList(raw);
  const ports: number[] = [];

  for (const token of items) {
    const range = token.split('-').map((entry) => entry.trim()).filter(Boolean);
    if (range.length === 1) {
      const value = Number(range[0]);
      if (Number.isInteger(value) && value > 0) {
        ports.push(value);
      }
      continue;
    }

    if (range.length !== 2) {
      continue;
    }

    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
      continue;
    }

    for (let port = start; port <= end; port += 1) {
      ports.push(port);
    }
  }

  return [...new Set(ports)];
}

function parseIntConfig(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.round(parsed);
}

function sanitizeToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(lowered)) return true;
    if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  }
  return fallback;
}

async function resolveAmiId(profileAmiId: string | undefined): Promise<string> {
  const amiId = profileAmiId ?? config.ec2.defaultAmiId;
  if (!amiId) {
    throw new Error("No AMI id configured and no AMI id in request");
  }
  if (!amiId.startsWith("/aws/service/")) {
    return amiId;
  }

  const response = await ssmClient.send(
    new GetParameterCommand({
      Name: amiId,
      WithDecryption: false,
    }),
  );
  const value = response.Parameter?.Value;
  if (!value) {
    throw new Error(`Could not resolve AMI parameter ${amiId}`);
  }
  return value;
}

async function resolveAmiRootDeviceName(imageId: string): Promise<string> {
  try {
    const result = await ec2Client.send(
      new DescribeImagesCommand({ ImageIds: [imageId] }),
    );
    const rootDeviceName = result.Images?.[0]?.RootDeviceName;
    if (rootDeviceName && rootDeviceName !== "None") {
      return rootDeviceName;
    }
  } catch {
    // Fall back to the common Nitro device name if the lookup fails.
  }
  return "/dev/xvda";
}

function parseSubnets(profileSubnetIds: string[] = [], specSubnetIds: string[] = [], fallback?: string): string[] {
  if (specSubnetIds.length > 0) return specSubnetIds;
  if (profileSubnetIds.length > 0) return profileSubnetIds;
  if (fallback) return [fallback];
  return [];
}

function hasLaunchSettings(profile: GameProfileItem): boolean {
  return (
    normalizeTextList(profile.subnetIds).length > 0 &&
    normalizeTextList(profile.securityGroupIds).length > 0 &&
    Boolean(profile.keyName?.trim()) &&
    Boolean(profile.iamInstanceProfile?.trim())
  );
}

function withLaunchSettings(
  selectedProfile: GameProfileItem,
  profiles: GameProfileItem[],
): GameProfileItem {
  if (hasLaunchSettings(selectedProfile)) {
    return selectedProfile;
  }

  const launchProfiles = [...profiles].filter(hasLaunchSettings);
  const sameRegionProfiles = launchProfiles.filter(
    (profile) => !profile.worldBucketRegion || profile.worldBucketRegion === config.awsRegion,
  );
  const launchProfile = (sameRegionProfiles.length > 0 ? sameRegionProfiles : launchProfiles)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];

  if (!launchProfile) {
    return selectedProfile;
  }

  return {
    ...launchProfile,
    ...selectedProfile,
    config: {
      ...(isObject(launchProfile.config) ? launchProfile.config : {}),
      ...(isObject(selectedProfile.config) ? selectedProfile.config : {}),
    },
    instanceType: selectedProfile.instanceType || launchProfile.instanceType,
    defaultInstanceType: selectedProfile.defaultInstanceType || launchProfile.defaultInstanceType,
    amiId: selectedProfile.amiId || launchProfile.amiId,
    subnetIds:
      normalizeTextList(selectedProfile.subnetIds).length > 0
        ? selectedProfile.subnetIds
        : launchProfile.subnetIds,
    securityGroupIds:
      normalizeTextList(selectedProfile.securityGroupIds).length > 0
        ? selectedProfile.securityGroupIds
        : launchProfile.securityGroupIds,
    keyName: selectedProfile.keyName || launchProfile.keyName,
    iamInstanceProfile: selectedProfile.iamInstanceProfile || launchProfile.iamInstanceProfile,
    worldBucket: selectedProfile.worldBucket || launchProfile.worldBucket,
    s3Prefix: selectedProfile.s3Prefix || launchProfile.s3Prefix,
    worldBucketRegion: selectedProfile.worldBucketRegion || launchProfile.worldBucketRegion,
    gameInstallCmd: selectedProfile.gameInstallCmd || launchProfile.gameInstallCmd,
    gameStartCmd: selectedProfile.gameStartCmd || launchProfile.gameStartCmd,
    udpPorts:
      normalizeTextList(selectedProfile.udpPorts).length > 0
        ? selectedProfile.udpPorts
        : launchProfile.udpPorts,
    tcpPorts:
      normalizeTextList(selectedProfile.tcpPorts).length > 0
        ? selectedProfile.tcpPorts
        : launchProfile.tcpPorts,
    ingressCidr: selectedProfile.ingressCidr || launchProfile.ingressCidr,
    gameName: selectedProfile.gameName || launchProfile.gameName,
    gameHome: selectedProfile.gameHome || launchProfile.gameHome,
    gameStateDirPath: selectedProfile.gameStateDirPath || launchProfile.gameStateDirPath,
    gameConfigS3Key: selectedProfile.gameConfigS3Key || launchProfile.gameConfigS3Key,
    gameConfigLocalPath: selectedProfile.gameConfigLocalPath || launchProfile.gameConfigLocalPath,
    stateLink: selectedProfile.stateLink || launchProfile.stateLink,
    steamBetaBranch: selectedProfile.steamBetaBranch || launchProfile.steamBetaBranch,
    steamBetaPassword: selectedProfile.steamBetaPassword || launchProfile.steamBetaPassword,
    backupIntervalMinutes: selectedProfile.backupIntervalMinutes || launchProfile.backupIntervalMinutes,
    stopTimeoutSeconds: selectedProfile.stopTimeoutSeconds || launchProfile.stopTimeoutSeconds,
    spotPriceBumpPercent: selectedProfile.spotPriceBumpPercent || launchProfile.spotPriceBumpPercent,
    ensureSecurityGroupRules:
      selectedProfile.ensureSecurityGroupRules ?? launchProfile.ensureSecurityGroupRules,
  };
}

async function resolveSubnetZoneMap(subnetIds: string[]): Promise<Record<string, string>> {
  if (subnetIds.length === 0) {
    return {};
  }

  const response = await ec2Client.send(
    new DescribeSubnetsCommand({
      SubnetIds: subnetIds,
    }),
  );
  const map: Record<string, string> = {};
  for (const subnet of response.Subnets ?? []) {
    if (subnet.SubnetId && subnet.AvailabilityZone) {
      map[subnet.SubnetId] = subnet.AvailabilityZone;
    }
  }
  return map;
}

async function resolveSpotLaunchChoice(
  subnetIds: string[],
  instanceType: string,
  bumpPercent: number,
): Promise<{ subnetId: string; availabilityZone: string; maxPrice?: string }> {
  const subnetZoneMap = await resolveSubnetZoneMap(subnetIds);
  const candidates = subnetIds
    .map((subnetId) => ({ subnetId, availabilityZone: subnetZoneMap[subnetId] }))
    .filter((candidate): candidate is { subnetId: string; availabilityZone: string } => Boolean(candidate.availabilityZone));

  if (candidates.length === 0) {
    throw new Error("No usable subnet/az pair was found for launch");
  }

  let best: {
    subnetId: string;
    availabilityZone: string;
    basePrice: number;
    maxPrice?: string;
  } | undefined;

  for (const candidate of candidates) {
    const response = await ec2Client.send(
      new DescribeSpotPriceHistoryCommand({
        InstanceTypes: [instanceType],
        ProductDescriptions: ["Linux/UNIX"],
        AvailabilityZone: candidate.availabilityZone,
        MaxResults: 1,
      }),
    );
    const first = response.SpotPriceHistory?.[0];
    const rawPrice = Number(first?.SpotPrice);
    if (!Number.isFinite(rawPrice)) {
      continue;
    }
    const maxPrice = (rawPrice * (1 + bumpPercent / 100)).toFixed(6);

    if (!best || rawPrice < best.basePrice) {
      best = {
        subnetId: candidate.subnetId,
        availabilityZone: candidate.availabilityZone,
        basePrice: rawPrice,
        maxPrice,
      };
    }
  }

  if (!best) {
    const firstCandidate = candidates[0];
    return {
      subnetId: firstCandidate.subnetId,
      availabilityZone: firstCandidate.availabilityZone,
    };
  }

  return {
    subnetId: best.subnetId,
    availabilityZone: best.availabilityZone,
    maxPrice: best.maxPrice,
  };
}

function renderBootstrapTemplate(profile: GameProfileItem, worldPrefix: string, gameId: string): string {
  let template = bootstrapTemplate();
  const manageServerConfig = supportsManagedServerConfig(profile, gameId);
  const replacements: Record<string, string> = {
    WORLD_BUCKET: shellSingleQuote(profile.worldBucket || ""),
    WORLD_BUCKET_REGION: shellSingleQuote(profile.worldBucketRegion || config.awsRegion),
    WORLD_PREFIX: shellSingleQuote(worldPrefix),
    GAME_STATE_PREFIX: shellSingleQuote(worldPrefix),
    GAME_NAME: shellSingleQuote(profile.gameName || gameId),
    GAME_HOME: shellSingleQuote(profile.gameHome || `/opt/${profile.gameName ?? gameId}`),
    STATE_DIR_PATH: shellSingleQuote(profile.gameStateDirPath || `/srv/${(profile.gameName || gameId)}-state`),
    STATE_LINK: shellSingleQuote(profile.stateLink || ""),
    SERVICE_USER: shellSingleQuote(profile.profileEnv?.SERVICE_USER || "auto"),
    GAMECONFIG_S3_KEY: shellSingleQuote(manageServerConfig ? profile.gameConfigS3Key || `${worldPrefix}/config/serverconfig.xml` : ""),
    GAMECONFIG_LOCAL_PATH: shellSingleQuote(manageServerConfig ? profile.gameConfigLocalPath || `/opt/${profile.gameName || gameId}/serverconfig.xml` : ""),
    BACKUP_INTERVAL_MINUTES: String(asPositiveInt(profile.backupIntervalMinutes, 5)),
    BACKUP_BOOT_OFFSET_MINUTES: String(asPositiveInt(profile.backupIntervalMinutes, 5)),
    STOP_TIMEOUT_SECONDS: String(asPositiveInt(profile.stopTimeoutSeconds, 30)),
    GAME_INSTALL_CMD_B64: shellSingleQuote(Buffer.from(profile.gameInstallCmd || "").toString("base64")),
    GAME_START_CMD_B64: shellSingleQuote(Buffer.from(profile.gameStartCmd || "").toString("base64")),
    STEAM_BETA_BRANCH: shellSingleQuote(profile.steamBetaBranch || ""),
    STEAM_BETA_PASSWORD: shellSingleQuote(profile.steamBetaPassword || ""),
    GAME_SERVICE: shellSingleQuote(sanitizeToken(profile.gameName || gameId)),
    GAME_INSTALL_CMD: shellSingleQuote(profile.gameInstallCmd || ""),
    GAME_START_CMD: shellSingleQuote(profile.gameStartCmd || ""),
    GAME_UDP_PORTS: String(asIntList(profile.udpPorts).join(',')),
    GAME_TCP_PORTS: String(asIntList(profile.tcpPorts).join(',')),
    GAME_INGRESS_CIDR: shellSingleQuote(profile.ingressCidr || "0.0.0.0/0"),
    SERVER_NAME: shellSingleQuote(`${profile.gameName || gameId}-spot-${randomUUID().slice(0, 6)}`),
    ENFORCE_BOOTSTRAP_LOG_PREFIX: shellSingleQuote(config.logs.bootstrapPrefix),
    ENFORCE_SERVER_LOG_PREFIX: shellSingleQuote(config.logs.serverPrefix),
    WORLD_ID: shellSingleQuote(worldPrefix),
  };

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}

function encodeUserData(script: string): string {
  const compressed = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const wrapper = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `printf '%s' '${compressed}' | base64 -d | gzip -dc | bash`,
    "",
  ].join("\n");
  return Buffer.from(wrapper, "utf8").toString("base64");
}

function bootstrapTemplate(): string {
  if (process.env.BOOTSTRAP_TEMPLATE) {
    return process.env.BOOTSTRAP_TEMPLATE;
  }

  const bundled = path.join(__dirname, "bootstrap.sh.tmpl");
  try {
    return readFileSync(bundled, "utf8");
  } catch {
    // Fall through to local development paths below.
  }

  const candidate = path.join(process.cwd(), "infra", "assets", "bootstrap.sh.tmpl");
  try {
    return readFileSync(candidate, "utf8");
  } catch {
    const fallback = path.join(__dirname, "../../infra/assets/bootstrap.sh.tmpl");
    return readFileSync(fallback, "utf8");
  }
}

function instanceCanBeStarted(ec2State: string | undefined): boolean {
  if (!ec2State) return false;
  return ["stopped"].includes(ec2State);
}

function isTerminalInstanceState(value: string | undefined): boolean {
  if (!value) return false;
  return ["terminated", "stopped", "stopping", "shutting-down"].includes(value);
}

function logStreamNameFor(instanceId: string, source: "bootstrap" | "server"): string {
  return `${instanceId}-${source}`;
}

function windrosePlayerName(message: string): string | undefined {
  const quoted =
    message.match(/(?:player|user|client)\s+['"]([^'"]+)['"]\s+(?:has\s+)?(?:connected|disconnected|logged\s+(?:in|out))/i) ||
    message.match(/['"]([^'"]+)['"]\s+(?:has\s+)?(?:connected|disconnected|logged\s+(?:in|out))/i);
  if (quoted?.[1]) return quoted[1].trim();

  const labeled = message.match(
    /(?:player|user|client)[\s:=]+([A-Za-z0-9_. -]{1,64})\s+(?:has\s+)?(?:connected|disconnected|logged\s+(?:in|out))/i,
  );
  return labeled?.[1]?.trim();
}

function parseLatestPlayerStatus(events: Array<{ timestamp?: number; message?: string }>) {
  let playerCount: number | undefined;
  let lastUpdatedAt: string | undefined;
  let serverVersion: string | undefined;
  const players = new Set<string>();
  const windrosePlayers = new Set<string>();

  for (const event of events) {
    const message = event.message ?? "";
    const joined = message.match(/GMSG: Player '([^']+)' joined the game/);
    if (joined?.[1]) {
      players.add(joined[1]);
    }

    if (/\b(?:connected|login|logged in)\b/i.test(message)) {
      const playerName = windrosePlayerName(message);
      if (playerName) {
        windrosePlayers.add(playerName);
        lastUpdatedAt = event.timestamp ? new Date(event.timestamp).toISOString() : lastUpdatedAt;
      }
    } else if (/\b(?:disconnected|logout|logged out)\b/i.test(message)) {
      const playerName = windrosePlayerName(message);
      if (playerName) {
        windrosePlayers.delete(playerName);
        lastUpdatedAt = event.timestamp ? new Date(event.timestamp).toISOString() : lastUpdatedAt;
      }
    }
  }

  for (const event of [...events].reverse()) {
    const message = event.message ?? "";
    const versionMatch = message.match(/\bVersion:\s*(V\s+[^\r\n,]+)/);
    if (versionMatch?.[1] && !serverVersion) {
      serverVersion = versionMatch[1].trim();
    }
    const match = message.match(/\bPly:\s*(\d+)\b/);
    if (match?.[1]) {
      playerCount = Number(match[1]);
      lastUpdatedAt = event.timestamp ? new Date(event.timestamp).toISOString() : undefined;
      if (serverVersion) break;
    }
  }

  return {
    playerCount: playerCount ?? windrosePlayers.size,
    players: Array.from(players.size > 0 ? players : windrosePlayers),
    lastUpdatedAt,
    serverVersion,
  };
}

function worldPrefixToken(world: string): string {
  return `${sanitizeToken(world)}${world ? "" : randomUUID().slice(0, 12)}`;
}

function canonicalWorldPrefix(basePrefix: string, gameId: string, worldId: string): string {
  return `${basePrefix.replace(/\/+$/, "")}/${gameId}/${sanitizeToken(worldId)}`;
}

function siblingWorldPrefix(sourcePrefix: string, gameId: string, worldId: string): string {
  const normalizedSource = sourcePrefix.replace(/\/+$/, "");
  const marker = `/${gameId}/`;
  const markerIndex = normalizedSource.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return canonicalWorldPrefix(normalizedSource.slice(0, markerIndex), gameId, worldId);
  }
  return canonicalWorldPrefix("servers", gameId, worldId);
}

function worldConfigKey(worldPrefix: string): string {
  return `${worldPrefix.replace(/\/+$/, "")}/config/serverconfig.xml`;
}

function windroseConfigRoot(worldPrefix: string): string {
  return `${worldPrefix.replace(/\/+$/, "")}/config/windrose`;
}

function windroseStableServerDescriptionKey(worldPrefix: string): string {
  return `${windroseConfigRoot(worldPrefix)}/ServerDescription.json`;
}

function windroseStableWorldDescriptionKey(worldPrefix: string): string {
  return `${windroseConfigRoot(worldPrefix)}/WorldDescription.json`;
}

function supportsManagedServerConfig(profile: GameProfileItem, gameId: string): boolean {
  const gameName = (profile.gameName || gameId).toLowerCase();
  return gameName === "7d2d" || profile.profileEnv?.MANAGE_GAME_CONFIG === "1";
}

function worldPrefixRoot(worldPrefix: string): string {
  return `${worldPrefix.replace(/\/+$/, "")}/`;
}

function profilePk(gameId: string, profileId: string): string {
  return `game-profile#${gameId}#${profileId}`;
}

function worldPk(gameId: string, worldId: string): string {
  return `game-world#${gameId}#${worldId}`;
}

function gameIdFromRecordKey(pk: string | undefined): string | undefined {
  if (!pk || typeof pk !== "string") return undefined;
  const [prefix, gameId] = pk.split("#");
  return prefix === "game-profile" || prefix === "game-world" ? gameId : undefined;
}

function recordGameId(record: {
  pk?: string;
  gameId?: string;
  gameRefId?: string;
}): string | undefined {
  if (typeof record.gameRefId === "string" && record.gameRefId.trim()) {
    return record.gameRefId.trim();
  }
  if (typeof record.gameId === "string" && record.gameId.trim()) {
    return record.gameId.trim();
  }
  return gameIdFromRecordKey(record.pk);
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function instanceStateText(instance: InstanceItem): string {
  if (typeof instance.status === "string" && instance.status.trim()) {
    return instance.status.toLowerCase();
  }
  const ec2State = instance.ec2State as unknown;
  if (typeof ec2State === "string") {
    return ec2State.toLowerCase();
  }
  if (
    ec2State &&
    typeof ec2State === "object" &&
    typeof (ec2State as { Name?: unknown }).Name === "string"
  ) {
    return (ec2State as { Name: string }).Name.toLowerCase();
  }
  return "";
}

function isGameProfileForGame(profile: GameProfileItem, gameId: string): boolean {
  return recordGameId(profile) === gameId;
}

function isGameWorldForGame(world: WorldPresetItem, gameId: string): boolean {
  return recordGameId(world) === gameId;
}

function isLikelyGameRecord(game: GameItem): boolean {
  if (game.kind === "game") {
    return Boolean(recordGameId(game));
  }

  if (game.kind) {
    return false;
  }

  if (typeof game.pk === "string" && game.pk.includes("#")) {
    return false;
  }

  return Boolean(recordGameId(game));
}

function hasProfileShape(profile: GameProfileItem): boolean {
  return profile.kind === "game-profile" || profile.pk.startsWith("game-profile#");
}

function hasWorldShape(world: WorldPresetItem): boolean {
  return world.kind === "game-world" || world.pk.startsWith("game-world#");
}

function parseProfileListEntry(profile: GameProfileItem): GameProfileItem {
  return profile;
}

function parseWorldListEntry(world: WorldPresetItem): WorldPresetItem {
  return world;
}

async function getS3ObjectText(bucket: string, key: string): Promise<string | undefined> {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return response.Body?.transformToString ? await response.Body.transformToString() : undefined;
  } catch (error) {
    if (error instanceof NoSuchKey || (error as Error).name === "NoSuchKey") {
      return undefined;
    }
    throw error;
  }
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function windroseServerSettings(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const nested = record?.ServerDescription_Persistent;
  return isObject(nested) ? nested : record;
}

function windroseWorldSettings(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const nested = record?.WorldDescription;
  return isObject(nested) ? nested : record;
}

function windroseWorldFloat(
  record: Record<string, unknown> | undefined,
  suffix: string,
): number | undefined {
  const worldSettings = windroseWorldSettings(record)?.WorldSettings;
  const floatParameters = isObject(worldSettings)
    ? worldSettings.FloatParameters
    : undefined;
  if (!isObject(floatParameters)) return undefined;
  const match = Object.entries(floatParameters).find(([key]) => key.includes(`WDS.Parameter.${suffix}`));
  return typeof match?.[1] === "number" && Number.isFinite(match[1]) ? match[1] : undefined;
}

function windroseCombatDifficulty(record: Record<string, unknown> | undefined): string | undefined {
  const worldSettings = windroseWorldSettings(record)?.WorldSettings;
  const tagParameters = isObject(worldSettings)
    ? worldSettings.TagParameters
    : undefined;
  if (!isObject(tagParameters)) return textField(windroseWorldSettings(record), "CombatDifficulty");
  const match = Object.entries(tagParameters).find(([key]) => key.includes("WDS.Parameter.CombatDifficulty"));
  const value = match?.[1];
  if (isObject(value)) {
    return textField(value, "TagName")?.split(".").pop();
  }
  return undefined;
}

function isSafeWorldJsonKey(key: unknown, worldPrefix: string, basename: string): key is string {
  if (typeof key !== "string" || !key.trim()) return false;
  const normalizedKey = key.replace(/^\/+/, "");
  const normalizedPrefix = worldPrefixRoot(worldPrefix);
  return (
    normalizedKey === `${worldPrefix.replace(/\/+$/, "")}/${basename}` ||
    (normalizedKey.startsWith(normalizedPrefix) && normalizedKey.endsWith(`/${basename}`))
  );
}

function copySourceFor(bucket: string, key: string): string {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

async function listS3Keys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of response.Contents ?? []) {
      if (object.Key) {
        keys.push(object.Key);
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}

async function copyS3Prefix(bucket: string, sourcePrefix: string, targetPrefix: string): Promise<number> {
  const sourceRoot = worldPrefixRoot(sourcePrefix);
  const targetRoot = worldPrefixRoot(targetPrefix);
  const keys = await listS3Keys(bucket, sourceRoot);

  for (const key of keys) {
    const targetKey = `${targetRoot}${key.slice(sourceRoot.length)}`;
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: targetKey,
        CopySource: copySourceFor(bucket, key),
      }),
    );
  }

  return keys.length;
}

async function deleteS3Prefix(bucket: string, prefix: string): Promise<number> {
  const keys = await listS3Keys(bucket, worldPrefixRoot(prefix));
  for (let index = 0; index < keys.length; index += 1000) {
    const chunk = keys.slice(index, index + 1000);
    await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      }),
    );
  }
  return keys.length;
}

async function resolveWorldConfigLocation(
  gameId: string,
  world: WorldPresetItem,
): Promise<{ bucket: string; key: string; fallbackKeys: string[]; worldPrefix: string }> {
  const profiles = (await gameProfilesRepository.scanByPrefix("pk", `game-profile#${gameId}#`))
    .filter((profile) => hasProfileShape(profile) && isGameProfileForGame(profile, gameId));
  const launchProfile = profiles.find(hasLaunchSettings) || profiles[0];
  const basePrefix = launchProfile?.s3Prefix || "servers";
  const worldPrefix = world.worldPrefix || canonicalWorldPrefix(basePrefix, gameId, world.worldId);
  const bucket = launchProfile?.worldBucket || "gameserver-state-example";
  const key = worldConfigKey(worldPrefix);
  const fallbackKeys = [
    launchProfile?.gameConfigS3Key,
    `${basePrefix.replace(/\/+$/, "")}/${gameId}/config/serverconfig.xml`,
  ].filter((candidate): candidate is string => Boolean(candidate));
  return { bucket, key, fallbackKeys, worldPrefix };
}

function withAsync<T = void>(
  fn: (req: Request, res: Response) => Promise<T>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function asInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, 1), 1000);
}

function cleanIdempotencyKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 256) : undefined;
}

function operationPk(operationId: string): string {
  return `operation#${operationId}`;
}

function idempotencyPk(key: string): string {
  return `idempotency#${key}`;
}

function normalizeLogSource(source: unknown): "bootstrap" | "server" {
  return source === "bootstrap" ? "bootstrap" : "server";
}

function logLocation(instanceId: string, source: "bootstrap" | "server") {
  const stream = logStreamNameFor(instanceId, source);
  return {
    logGroupName:
      source === "bootstrap"
        ? config.logs.bootstrapPrefix
        : config.logs.serverPrefix,
    logStreamName: stream,
  };
}

function isSupportedAction(value: unknown): value is SupportedAction {
  return (
    value === "start" ||
    value === "stop" ||
    value === "restart" ||
    value === "terminate" ||
    value === "reboot"
  );
}

type GameServerAction = "server-start" | "server-stop" | "server-restart";

function isGameServerAction(value: unknown): value is GameServerAction {
  return value === "server-start" || value === "server-stop" || value === "server-restart";
}

function gameServerActionCommands(action: GameServerAction): string[] {
  const service = "7d2d-server";
  if (action === "server-start") {
    return [
      `sudo systemctl start ${service}`,
      "sleep 3",
      `sudo systemctl is-active ${service} || true`,
    ];
  }
  if (action === "server-stop") {
    return [
      `sudo systemctl stop ${service}`,
      "sleep 3",
      `sudo systemctl is-active ${service} || true`,
    ];
  }
  return [
    `sudo systemctl restart ${service}`,
    "sleep 5",
    `sudo systemctl is-active ${service} || true`,
  ];
}

function gameServerConsoleCommands(commandText: string): string[] {
  const encoded = Buffer.from(commandText, "utf8").toString("base64");
  const python = [
    "python3 -c",
    shellSingleQuote(
      "import base64, pathlib, re, socket, sys, time\n" +
        "cmd = base64.b64decode(sys.argv[1]).decode()\n" +
        "cfg = pathlib.Path('/opt/7d2d/serverconfig.xml')\n" +
        "text = cfg.read_text() if cfg.exists() else ''\n" +
        "def prop(name, default=''):\n" +
        "    m = re.search(r'<property\\s+name=\"' + re.escape(name) + r'\"\\s+value=\"([^\"]*)\"', text)\n" +
        "    return m.group(1) if m else default\n" +
        "if prop('TelnetEnabled', 'false').lower() != 'true':\n" +
        "    raise SystemExit('TelnetEnabled is not true in /opt/7d2d/serverconfig.xml')\n" +
        "port = int(prop('TelnetPort', '8081') or '8081')\n" +
        "password = prop('TelnetPassword', '')\n" +
        "sock = socket.create_connection(('127.0.0.1', port), timeout=8)\n" +
        "sock.settimeout(1)\n" +
        "def recv_window(seconds=1.0):\n" +
        "    end = time.time() + seconds\n" +
        "    chunks = []\n" +
        "    while time.time() < end:\n" +
        "        try:\n" +
        "            chunks.append(sock.recv(4096))\n" +
        "        except socket.timeout:\n" +
        "            break\n" +
        "    return b''.join(chunks).decode(errors='replace')\n" +
        "out = recv_window()\n" +
        "if password:\n" +
        "    sock.sendall((password + '\\n').encode())\n" +
        "    out += recv_window()\n" +
        "sock.sendall((cmd + '\\n').encode())\n" +
        "out += recv_window(2.0)\n" +
        "sock.sendall(b'exit\\n')\n" +
        "out += recv_window(0.5)\n" +
        "sock.close()\n" +
        "print(out[-12000:])",
    ),
    encoded,
  ].join(" ");
  return [python];
}

async function executeGameServerAction(
  req: AuthenticatedRequest,
  instanceId: string,
  action: GameServerAction,
): Promise<OperationItem> {
  const { operation, replay } = await createOperation(req, action, [instanceId], { action }, cleanIdempotencyKey(req.headers["idempotency-key"]));
  if (replay) return operation;

  try {
    const command = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Comment: `game-server:${action}`,
        Parameters: { commands: gameServerActionCommands(action) },
      }),
    );
    return saveOperation(operation, {
      commandId: command.Command?.CommandId,
      commandDocument: "AWS-RunShellScript",
      status: "running",
    });
  } catch (error) {
    return saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
  }
}

async function executeGameServerCommand(
  req: AuthenticatedRequest,
  instanceId: string,
  commandText: string,
): Promise<OperationItem> {
  const { operation, replay } = await createOperation(
    req,
    "server-command",
    [instanceId],
    { command: commandText },
    cleanIdempotencyKey(req.headers["idempotency-key"]),
  );
  if (replay) return operation;

  try {
    const command = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Comment: "game-server:command",
        Parameters: { commands: gameServerConsoleCommands(commandText) },
      }),
    );
    return saveOperation(operation, {
      commandId: command.Command?.CommandId,
      commandDocument: "AWS-RunShellScript",
      status: "running",
    });
  } catch (error) {
    return saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
  }
}

async function lookupOperationByIdempotency(
  key: string | undefined,
): Promise<OperationItem | undefined> {
  if (!key) return undefined;
  const mapping = await idempotencyRepository.get(idempotencyPk(key));
  if (!mapping?.operationId) return undefined;
  return operationRepository.get(operationPk(mapping.operationId));
}

function expectedEc2State(action: OperationItem["action"]): string | undefined {
  if (action === "start" || action === "reboot" || action === "restart")
    return "running";
  if (action === "stop") return "terminated";
  if (action === "terminate") return "terminated";
  return undefined;
}

type Ec2InstanceSnapshot = {
  ec2State?: string;
  publicIp?: string;
  privateIp?: string;
  startedAt?: string;
};

async function describeEc2InstanceSnapshot(instanceId: string): Promise<Ec2InstanceSnapshot | undefined> {
  try {
    const result = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const instance = result.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;
    return {
      ec2State: instance.State?.Name,
      publicIp: instance.PublicIpAddress,
      privateIp: instance.PrivateIpAddress,
      startedAt: instance.LaunchTime?.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function refreshEc2State(instanceId: string): Promise<string | undefined> {
  return (await describeEc2InstanceSnapshot(instanceId))?.ec2State;
}

function shouldRefreshInstanceFromEc2(instance: InstanceItem): boolean {
  const status = (instance.status || "").toLowerCase();
  const ec2State = (instance.ec2State || "").toLowerCase();
  return !["terminated"].includes(status) && !["terminated"].includes(ec2State);
}

function normalizeInstanceLifecycle(instance: InstanceItem): InstanceItem {
  const ec2State = (instance.ec2State || "").toLowerCase();
  if (ec2State === "terminated" || ec2State === "shutting-down") {
    return {
      ...instance,
      status: "terminated",
      publicIp: undefined,
    };
  }
  if (ec2State === "stopped") {
    return {
      ...instance,
      status: "terminated",
      publicIp: undefined,
    };
  }
  return instance;
}

async function hydrateInstanceFromEc2(instance: InstanceItem): Promise<InstanceItem> {
  if (!instance.instanceId || !shouldRefreshInstanceFromEc2(instance)) {
    const normalized = normalizeInstanceLifecycle(instance);
    if (
      normalized.status !== instance.status ||
      normalized.publicIp !== instance.publicIp
    ) {
      await instanceRepository.put({
        ...normalized,
        updatedAt: new Date().toISOString(),
      });
    }
    return normalized;
  }
  const snapshot = await describeEc2InstanceSnapshot(instance.instanceId);
  if (!snapshot) return normalizeInstanceLifecycle(instance);

  const next: InstanceItem = {
    ...instance,
    ec2State: snapshot.ec2State ?? instance.ec2State,
    publicIp: snapshot.publicIp,
    privateIp: snapshot.privateIp,
    startedAt: snapshot.startedAt ?? instance.startedAt,
    status:
      instance.status === "launching" && snapshot.ec2State === "running"
        ? "running"
        : instance.status,
    updatedAt: new Date().toISOString(),
  };
  const normalizedNext = normalizeInstanceLifecycle(next);

  if (
    normalizedNext.ec2State !== instance.ec2State ||
    normalizedNext.publicIp !== instance.publicIp ||
    normalizedNext.privateIp !== instance.privateIp ||
    normalizedNext.startedAt !== instance.startedAt ||
    normalizedNext.status !== instance.status
  ) {
    await instanceRepository.put(normalizedNext);
  }

  return normalizedNext;
}

async function createOperation(
  req: AuthenticatedRequest,
  action: OperationItem["action"],
  instanceIds: string[],
  payload?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ operation: OperationItem; replay: boolean }> {
  const normalized = cleanIdempotencyKey(idempotencyKey);
  const existing = await lookupOperationByIdempotency(normalized);
  if (existing) {
    return { operation: existing, replay: true };
  }

  const now = new Date().toISOString();
  const operationId = randomUUID();
  const operation: OperationItem = {
    pk: operationPk(operationId),
    operationId,
    action,
    instanceIds,
    status: "running",
    createdAt: now,
    updatedAt: now,
    createdBy: req.user.sub,
    userRole: req.user.role,
    payload,
  };
  await operationRepository.put(operation);

  if (normalized) {
    const recorded = await idempotencyRepository.putIfNotExists({
      pk: idempotencyPk(normalized),
      kind: "idempotency",
      operationId,
      createdAt: now,
    });
    if (!recorded) {
      const again = await lookupOperationByIdempotency(normalized);
      if (again) {
        return { operation: again, replay: true };
      }
    }
  }

  return { operation, replay: false };
}

async function saveOperation(
  operation: OperationItem,
  patch: Partial<OperationItem>,
): Promise<OperationItem> {
  const updated = { ...operation, ...patch, updatedAt: new Date().toISOString() };
  await operationRepository.put(updated);
  return updated;
}

function operationStatusFromSsm(status: string | undefined): OperationItem["status"] {
  if (status === "Success") return "succeeded";
  if (
    status === "Failed" ||
    status === "Cancelled" ||
    status === "Cancelling" ||
    status === "TimedOut"
  ) {
    return "failed";
  }
  return "running";
}

async function hydrateOperationCommandStatus(
  operation: OperationItem,
): Promise<OperationItem> {
  if (!operation.commandId || operation.status !== "running" || operation.instanceIds.length === 0) {
    return operation;
  }
  try {
    const invocation = await ssmClient.send(
      new GetCommandInvocationCommand({
        CommandId: operation.commandId,
        InstanceId: operation.instanceIds[0],
      }),
    );
    const status = operationStatusFromSsm(invocation.Status);
    if (status === operation.status) {
      return operation;
    }
    return saveOperation(operation, {
      status,
      error:
        status === "failed"
          ? invocation.StandardErrorContent || invocation.StandardOutputContent || invocation.StatusDetails
          : operation.error,
      payload: {
        ...(operation.payload ?? {}),
        commandStatus: invocation.Status,
        responseCode: invocation.ResponseCode,
        output: invocation.StandardOutputContent,
      },
    });
  } catch {
    return operation;
  }
}

async function launchSsmCommand(
  req: AuthenticatedRequest,
  instanceIds: string[],
  action: "bootstrap" | "update",
  documentName: string,
  idempotencyKey?: string,
): Promise<OperationItem> {
  const { operation, replay } = await createOperation(
    req,
    action,
    instanceIds,
    { action, documentName },
    idempotencyKey,
  );
  if (replay) return operation;

  try {
    const command = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: instanceIds,
        DocumentName: documentName,
        Comment: `7d2d-console:${action}`,
        Parameters: { action: [action] },
      }),
    );
    return saveOperation(operation, {
      commandId: command.Command?.CommandId,
      commandDocument: documentName,
      status: "running",
    });
  } catch (error) {
    return saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
  }
}

async function createInstancesForSpec(
  req: AuthenticatedRequest,
  spec: InstanceCreateRequest,
): Promise<string[]> {
  const requestConfig = isObject(spec.config) ? spec.config : {};
  const count = Math.min(Math.max(Math.floor(Number(spec.count ?? 1)), 1), 20);
  const gameId = String(spec.gameId);
  if (!spec.gameId) {
    throw new Error("Missing gameId");
  }

  const allProfiles = await gameProfilesRepository.scanByPrefix(
    "pk",
    `game-profile#${gameId}#`,
  );
  let selectedProfile: GameProfileItem | undefined;
  const resolvedProfileId = spec.selectedProfileId?.trim();
  if (spec.selectedProfileId) {
    selectedProfile = await gameProfilesRepository.get(
      profilePk(gameId, resolvedProfileId),
    );
    if (!selectedProfile) {
      const fallback = allProfiles.find(
        (candidate) => candidate.profileId === resolvedProfileId,
      );
      selectedProfile = fallback;
    }
    if (!selectedProfile || !isGameProfileForGame(selectedProfile, gameId)) {
      throw new Error(`Unknown profile id: ${resolvedProfileId}`);
    }
  } else if (allProfiles.length > 0) {
    const sortedProfiles = [...allProfiles].sort(
      (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    selectedProfile =
      sortedProfiles.find(
        (profile) =>
          hasLaunchSettings(profile) &&
          (!profile.worldBucketRegion || profile.worldBucketRegion === config.awsRegion),
      ) ??
      sortedProfiles.find(hasLaunchSettings) ??
      sortedProfiles[0];
  }

  if (!selectedProfile) {
    throw new Error(`No launch profile found for gameId ${gameId}`);
  }

  selectedProfile = withLaunchSettings(selectedProfile, allProfiles);

  let selectedWorld: WorldPresetItem | undefined;
  if (spec.selectedWorldId) {
    selectedWorld = await worldPresetsRepository.get(
      worldPk(gameId, spec.selectedWorldId),
    );
    if (!selectedWorld) {
      const fallback = (await worldPresetsRepository.scanByPrefix("pk", `game-world#${gameId}#`))
        .find((candidate) => candidate.worldId === spec.selectedWorldId);
      selectedWorld = fallback;
    }
    if (!selectedWorld || !isGameWorldForGame(selectedWorld, gameId)) {
      throw new Error(`Unknown world id: ${spec.selectedWorldId}`);
    }
  }

  const profileConfig =
    selectedProfile && isObject(selectedProfile.config) ? selectedProfile.config : {};
  const worldSeed =
    selectedWorld && isObject(selectedWorld.worldSeed) ? selectedWorld.worldSeed : undefined;

  const profile = {
    ...selectedProfile,
    config: profileConfig,
  };

  if (selectedWorld?.currentInstanceId) {
    const lockedInstance = await instanceRepository.get(selectedWorld.currentInstanceId);
    const busyState = lockedInstance?.ec2State;
    if (lockedInstance && busyState && !isTerminalInstanceState(busyState)) {
      throw new Error(
        `World ${selectedWorld.worldId} is already running an active server`,
      );
    }
    if (!lockedInstance || isTerminalInstanceState(busyState)) {
      await worldPresetsRepository.put({
        ...selectedWorld,
        currentInstanceId: undefined,
        currentInstanceGameId: undefined,
        lockedAt: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const subnetIds = parseSubnets(
    selectedProfile?.subnetIds,
    spec.subnetIds ?? (spec.subnetId ? [spec.subnetId] : []),
    config.ec2.defaultSubnetId,
  );
  if (subnetIds.length === 0) {
    throw new Error("No subnet configured for launch");
  }

  const instanceType =
    spec.instanceType ??
    profile.instanceType ??
    profile.defaultInstanceType ??
    config.ec2.defaultInstanceType;
  const imageId = await resolveAmiId(spec.amiId ?? profile.amiId);
  const rootDeviceName = await resolveAmiRootDeviceName(imageId);

  const securityGroupIds =
    normalizeTextList(spec.securityGroupIds ?? profile.securityGroupIds ?? config.ec2.defaultSecurityGroupIds)
      .filter((id) => id.length > 0)
      .sort();
  if (securityGroupIds.length === 0) {
    throw new Error("No security group configured for launch");
  }

  const keyName = spec.keyName ?? profile.keyName;
  const instanceProfileName = profile.iamInstanceProfile;
  if (!keyName) {
    throw new Error("KEY_NAME is required to launch an instance");
  }
  if (!instanceProfileName) {
    throw new Error("IAM instance profile is required to launch an instance");
  }
  const spotBumpPercent = parseIntConfig(
    profile.spotPriceBumpPercent ?? spec.spotPriceBumpPercent,
    25,
  );
  const spot = await resolveSpotLaunchChoice(subnetIds, instanceType, spotBumpPercent);

  const basePrefix = profile.s3Prefix ?? "servers";
  const basePrefixSafe = basePrefix.replace(/\/+$/, "");
  const worldSuffix =
    selectedWorld?.worldId ||
    spec.selectedWorldId ||
    spec.worldName ||
    worldPrefixToken(spec.worldName ?? "");
  const worldPrefix = canonicalWorldPrefix(basePrefixSafe, gameId, worldSuffix);
  const worldLabel = selectedWorld?.name || spec.worldName || worldSuffix;

  const bootstrapProfile = {
    worldBucket: profile.worldBucket || "gameserver-state-example",
    worldBucketRegion: profile.worldBucketRegion || config.awsRegion,
    worldPrefix,
    s3Prefix: basePrefixSafe,
    gameName: profile.gameName || gameId,
    gameHome: profile.gameHome || `/opt/${profile.gameName ?? gameId}`,
    gameInstallCmd: profile.gameInstallCmd || "",
    gameStartCmd: profile.gameStartCmd || "",
    gameStateDirPath: profile.gameStateDirPath || `/srv/${profile.gameName || gameId}-state`,
    gameConfigS3Key: worldConfigKey(worldPrefix),
    gameConfigLocalPath: profile.gameConfigLocalPath || `/opt/${profile.gameName || gameId}/serverconfig.xml`,
    stateLink: profile.stateLink,
    steamBetaBranch: spec.steamBetaBranch || profile.steamBetaBranch || "",
    steamBetaPassword: profile.steamBetaPassword || "",
    backupIntervalMinutes: asPositiveInt(profile.backupIntervalMinutes, 5),
    stopTimeoutSeconds: asPositiveInt(profile.stopTimeoutSeconds, 30),
    udpPorts: profile.udpPorts,
    tcpPorts: profile.tcpPorts,
    ingressCidr: profile.ingressCidr || "0.0.0.0/0",
    profileEnv: profile.profileEnv,
  };

  const serverName = spec.serverName || spec.worldName || selectedWorld?.name || gameId;
  const bootstrapScript = renderBootstrapTemplate(
    bootstrapProfile as GameProfileItem,
    worldPrefix,
    gameId,
  );
  const userData = encodeUserData(bootstrapScript);

  const blockDevices = [
    {
      DeviceName: rootDeviceName,
      Ebs: {
        VolumeSize: asPositiveInt(profile.volumeSizeGiB, 80),
        VolumeType: "gp3",
        Encrypted: true,
        DeleteOnTermination: true,
      },
    },
  ];

  const mergedConfig = {
    ...(profile.config || {}),
    ...requestConfig,
    ...(worldSeed ? { worldSeed } : {}),
  };

  const now = new Date().toISOString();
  const basePayload = {
    gameId: spec.gameId,
    region: config.awsRegion,
    worldBucket: profile.worldBucket || "",
    worldS3Prefix: worldPrefix,
    worldPrefix,
    worldName: spec.worldName,
    worldLabel,
    availabilityZone: spot.availabilityZone,
    subnetId: spot.subnetId,
    securityGroupIds,
    spotPriceAtLaunch: spot.maxPrice,
    serverName,
  };

  const result = await ec2Client.send(
    new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceType,
      MinCount: count,
      MaxCount: count,
      KeyName: keyName,
      IamInstanceProfile: { Name: instanceProfileName },
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: spot.subnetId,
          AssociatePublicIpAddress: true,
          Groups: securityGroupIds,
        },
      ],
      InstanceMarketOptions: {
        MarketType: "spot",
        SpotOptions: {
          SpotInstanceType: "one-time",
          InstanceInterruptionBehavior: "terminate",
          ...(spot.maxPrice ? { MaxPrice: spot.maxPrice } : {}),
        },
      },
      BlockDeviceMappings: blockDevices,
      InstanceInitiatedShutdownBehavior: "terminate",
      UserData: userData,
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "GameId", Value: spec.gameId },
            { Key: "ManagedBy", Value: "7d2d-console" },
            { Key: "Name", Value: serverName },
            ...(Object.entries(spec.tags || {}).map(([key, value]) => ({ Key: key, Value: value }))),
            { Key: "GameProfileId", Value: selectedProfile.profileId },
            ...(spec.selectedWorldId
              ? [{ Key: "GameWorldId", Value: spec.selectedWorldId }]
              : []),
            ...(spec.worldName ? [{ Key: "WorldName", Value: spec.worldName }] : []),
            { Key: "WorldPrefix", Value: worldPrefix },
          ],
        },
      ],
    }),
  );

  const createdIds = (result.Instances ?? [])
    .map((instance) => instance.InstanceId)
    .filter((instanceId): instanceId is string => Boolean(instanceId));
  if (createdIds.length === 0) {
    throw new Error("No instance ids returned from RunInstances");
  }
  
  for (const instanceId of createdIds) {
    await instanceRepository.put({
      pk: instanceId,
      instanceId,
      gameId,
      status: "launching",
      ec2State: "pending",
      createdBy: req.user.sub,
      createdAt: now,
      updatedAt: now,
      ...basePayload,
      amiId: imageId,
      instanceType,
      subnetId: spot.subnetId,
      securityGroupIds,
      tags: { ...(spec.tags ?? {}), gameId: spec.gameId },
      bootstrapProfile: "requested:bootstrap",
      profileType: "bootstrap",
      selectedProfileId: selectedProfile.profileId,
      selectedWorldId: spec.selectedWorldId,
      worldName: spec.worldName,
      serverName,
      lastBackupAt: undefined,
      backupState: "idle",
    });

    if (Object.keys(mergedConfig).length > 0) {
      await configRepository.put({
        pk: instanceId,
        instanceId,
        values: mergedConfig,
        updatedAt: now,
        updatedBy: req.user.sub,
      });
    }
  }

  if (selectedWorld) {
    await worldPresetsRepository.put({
      ...selectedWorld,
      currentInstanceId: createdIds[0],
      currentInstanceGameId: gameId,
      worldPrefix,
      updatedAt: now,
      lockedAt: now,
    });
  }

  return createdIds;
}

async function latestOperationForInstance(
  instanceId: string,
): Promise<OperationItem | undefined> {
  const operations = await operationRepository.scan({
    expression: "contains(instanceIds, :instanceId)",
    values: { ":instanceId": instanceId },
  });
  operations.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return operations[0];
}

async function readLogEvents(
  instanceId: string,
  source: "bootstrap" | "server",
  nextToken?: string,
  limit = 100,
) {
  const { logGroupName, logStreamName } = logLocation(instanceId, source);
  const fallbackStreams = [
    logStreamName,
    `${instanceId}-${source}`,
    instanceId,
  ].filter(Boolean) as string[];
  let response;
  let selectedStream = logStreamName;
  for (const streamName of fallbackStreams) {
    try {
      response = await logsClient.send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName: streamName,
          startFromHead: false,
          limit,
          nextToken,
        }),
      );
      selectedStream = streamName;
      break;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        continue;
      }
      throw error;
    }
  }

  if (!response) {
    return {
      source,
      logGroupName,
      logStreamName,
      nextToken: null,
      events: [],
    };
  }

  return {
    source,
    logGroupName,
    logStreamName: response ? selectedStream : logStreamName,
    nextToken: response.nextForwardToken ?? null,
    events: (response.events ?? []).map((event) => ({
      timestamp: event.timestamp,
      message: event.message,
      ingestionTime: event.ingestionTime,
    })),
  };
}

function isTerminalOrStoppedState(value: string | undefined): boolean {
  if (!value) return false;
  return ["terminated", "stopped", "shutting-down"].includes(value);
}

async function waitForCommandCompletion(
  instanceId: string,
  commandId: string,
): Promise<"Success" | "Failed" | "TimedOut" | "Cancelled" | "Unknown"> {
  const terminalStates = new Set([
    "Success",
    "Failed",
    "Cancelled",
    "TimedOut",
    "Undeliverable",
    "Terminated",
  ]);
  const timeout = Date.now() + 120_000;

  while (Date.now() < timeout) {
    try {
      const invocation = await ssmClient.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }),
      );
      const status = invocation.Status ?? "Unknown";
      if (terminalStates.has(status)) {
        const code = invocation.ResponseCode;
        if (status === "Success" && code === 0) {
          return "Success";
        }
        if (code === 0 && status === "Success") {
          return "Success";
        }
        if (status === "Cancelled") return "Cancelled";
        if (status === "TimedOut") return "TimedOut";
        return "Failed";
      }
    } catch {
      // wait for command invocation record to be available
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return "TimedOut";
}

async function sendFinalBackupCommand(instanceId: string): Promise<boolean> {
  const commandName = config.ssm.backupDocumentName ?? "7d2d-backup";
  let commandId: string | undefined;

  try {
    const backupResult = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: commandName,
        Comment: "7d2d-console:final-backup",
      }),
    );
    commandId = backupResult.Command?.CommandId;
  } catch {
    // Fallback to direct shell command for legacy deployments
    const fallback = await ssmClient.send(
      new SendCommandCommand({
        InstanceIds: [instanceId],
        DocumentName: "AWS-RunShellScript",
        Comment: "7d2d-console:final-backup-fallback",
        Parameters: {
          commands: [
            'if ls /opt/*-tools/upload-state.sh >/dev/null 2>&1; then',
            '  for script in /opt/*-tools/upload-state.sh; do',
            '    bash "${script}" || true',
            '  done',
            'else',
            '  echo "No upload-state scripts found"',
            'fi',
          ],
        },
      }),
    );
    commandId = fallback.Command?.CommandId;
  }

  if (!commandId) {
    throw new Error("Failed to dispatch backup command");
  }

  const finalStatus = await waitForCommandCompletion(instanceId, commandId);
  return finalStatus === "Success";
}

async function updateInstanceRecord(
  instanceId: string,
  patch: Partial<InstanceItem>,
): Promise<void> {
  const current = await instanceRepository.get(instanceId);
  if (!current) return;
  await instanceRepository.put({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
}

async function clearWorldLockForInstance(instance: InstanceItem): Promise<void> {
  if (!instance.selectedWorldId || !instance.gameId) {
    return;
  }
  const world = await worldPresetsRepository.get(
    worldPk(instance.gameId, instance.selectedWorldId),
  );
  if (!world || world.currentInstanceId !== instance.instanceId) {
    return;
  }
  await worldPresetsRepository.put({
    ...world,
    currentInstanceId: undefined,
    currentInstanceGameId: undefined,
    lockedAt: undefined,
    updatedAt: new Date().toISOString(),
  });
}

async function executeInstanceAction(
  req: AuthenticatedRequest,
  instanceId: string,
  action: SupportedAction,
  requireAdmin = false,
): Promise<OperationItem> {
  if (requireAdmin && req.user.role !== "admin") {
    const error = new Error("admin role required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }

  const idem = cleanIdempotencyKey(req.headers["idempotency-key"]);
  const existing = await lookupOperationByIdempotency(idem);
  if (existing && existing.instanceIds.includes(instanceId) && existing.action === action) {
    return existing;
  }

  const { operation: createdOp, replay } = await createOperation(
    req,
    action,
    [instanceId],
    { action },
    idem,
  );
  let operation = createdOp;

  if (replay) {
    return operation;
  }

  try {
    const targetInstance = await instanceRepository.get(instanceId);
    const observedState = targetInstance?.ec2State ?? (await refreshEc2State(instanceId));

    if (action === "start") {
      if (!instanceCanBeStarted(observedState)) {
        throw new Error(
          `Cannot start instance ${instanceId} from EC2 state: ${observedState ?? "unknown"}`,
        );
      }
      await ec2Client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    } else if (action === "restart" || action === "reboot") {
      await ec2Client.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    } else if (action === "stop" || action === "terminate") {
      await updateInstanceRecord(instanceId, {
        status: "backing-up",
        backupState: "requested",
      });
      const backupSucceeded = await sendFinalBackupCommand(instanceId);
      if (!backupSucceeded) {
        throw new Error("Final backup command failed");
      }

      await updateInstanceRecord(instanceId, {
        status: "terminating",
        backupState: "idle",
        lastBackupAt: new Date().toISOString(),
      });

      const ec2State = targetInstance?.ec2State ?? (await refreshEc2State(instanceId));
      if (!isTerminalOrStoppedState(ec2State)) {
        await ec2Client.send(
          new TerminateInstancesCommand({ InstanceIds: [instanceId] }),
        );
      }
      await clearWorldLockForInstance(targetInstance ?? { instanceId, gameId: "" } as InstanceItem);
    }
    operation = await saveOperation(operation, { status: "succeeded" });
  } catch (error) {
    operation = await saveOperation(operation, {
      status: "failed",
      error: (error as Error).message,
    });
    if (action === "stop" || action === "terminate") {
      await updateInstanceRecord(instanceId, {
        status: "backing-up",
        backupState: "failed",
      });
    }
  }

  const instance = await instanceRepository.get(instanceId);
  if (instance) {
    const isStopOrTerminateAction = action === "stop" || action === "terminate";
    const failedStop = isStopOrTerminateAction && operation.status !== "succeeded";
    await instanceRepository.put({
      ...instance,
      status: operation.status === "succeeded"
        ? isStopOrTerminateAction
          ? "terminated"
          : action === "start"
            ? "running"
            : action
        : failedStop
          ? instance.status
          : operation.status === "running"
            ? action
            : instance.status,
      updatedAt: new Date().toISOString(),
      ec2State:
        isStopOrTerminateAction
          ? operation.status === "succeeded"
            ? "stopped"
            : instance.ec2State
          : instance.ec2State,
      backupState:
        isStopOrTerminateAction
          ? failedStop
            ? "failed"
            : "idle"
          : operation.status === "failed" && isStopOrTerminateAction
            ? "failed"
            : instance.backupState,
    });
  }

  return operation;
}

export function createRouter(): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString(), env: config.nodeEnv });
  });

  router.options(/.*/, (_req, res) => {
    res.status(204).json({ ok: true });
  });

  router.use(requireAuth);

  router.get(
    "/v1/games",
    withAsync(async (_req, res) => {
      const rawGames = await gamesRepository.scan();
      const gameProfiles = await gameProfilesRepository.scan();
      const worldPresets = await worldPresetsRepository.scan();

      const gamesById = new Map<string, GameItem>();

      rawGames
        .filter((game) => isLikelyGameRecord(game))
        .map((game) => {
          const resolved = recordGameId(game) ?? game.pk;
          const normalized = {
            ...game,
            gameId: game.gameId || resolved || game.pk,
            kind: game.kind || "game",
          };
          if (normalized.gameId) {
            gamesById.set(normalized.gameId, normalized as GameItem);
          }
          return normalized;
        });

      for (const profile of gameProfiles) {
        const gameId = recordGameId(profile);
        if (!gameId || gamesById.has(gameId)) {
          continue;
        }
        gamesById.set(gameId, {
          pk: gameId,
          gameId,
          kind: "game",
          name: gameId === "7d2d" ? "7D2D" : gameId,
        });
      }

      for (const world of worldPresets) {
        const gameId = recordGameId(world);
        if (!gameId || gamesById.has(gameId)) {
          continue;
        }
        gamesById.set(gameId, {
          pk: gameId,
          gameId,
          kind: "game",
          name: gameId === "7d2d" ? "7D2D" : gameId,
        });
      }

      const games = Array.from(gamesById.values()) as GameItem[];
      games.sort((a, b) => {
        const aName = a.name ?? a.gameId ?? "";
        const bName = b.name ?? b.gameId ?? "";
        return aName.localeCompare(bName);
      });
      res.json({ games });
    }),
  );

  router.get(
    "/v1/games/:gameId/profiles",
    withAsync(async (req, res) => {
      const { gameId } = req.params;
      const allProfiles = await gameProfilesRepository.scan();
      const profiles = allProfiles
        .filter(
          (profile) =>
            hasProfileShape(profile) && isGameProfileForGame(profile, gameId),
        )
        .map((profile) => parseProfileListEntry(profile));
      profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ profiles });
    }),
  );

  router.post(
    "/v1/games/:gameId/profiles",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const { gameId } = req.params;
      const body = req.body as SaveProfileRequest;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!isObject(body?.config)) {
        res.status(400).json({ error: "config must be an object" });
        return;
      }

      const now = new Date().toISOString();
      const profileId = randomUUID();
      const profile: GameProfileItem = {
        pk: profilePk(gameId, profileId),
        gameId,
        gameRefId: gameId,
        kind: "game-profile",
        profileId,
        name,
        description: body.description,
        config: body.config,
        instanceType:
          typeof body.instanceType === "string"
            ? body.instanceType.trim()
            : undefined,
        defaultInstanceType:
          typeof body.defaultInstanceType === "string"
            ? body.defaultInstanceType.trim()
            : undefined,
        amiId: typeof body.amiId === "string" ? body.amiId.trim() : undefined,
        subnetIds:
          typeof body.subnetIds === "string"
            ? normalizeCsvList(body.subnetIds)
            : body.subnetIds,
        securityGroupIds:
          typeof body.securityGroupIds === "string"
            ? normalizeCsvList(body.securityGroupIds)
            : body.securityGroupIds,
        keyName: typeof body.keyName === "string" ? body.keyName.trim() : undefined,
        iamInstanceProfile:
          typeof body.iamInstanceProfile === "string"
            ? body.iamInstanceProfile.trim()
            : undefined,
        worldBucket:
          typeof body.worldBucket === "string"
            ? body.worldBucket.trim()
            : undefined,
        s3Prefix:
          typeof body.s3Prefix === "string" ? body.s3Prefix.trim() : undefined,
        worldBucketRegion:
          typeof body.worldBucketRegion === "string"
            ? body.worldBucketRegion.trim()
            : undefined,
        gameInstallCmd:
          typeof body.gameInstallCmd === "string"
            ? body.gameInstallCmd.trim()
            : undefined,
        gameStartCmd:
          typeof body.gameStartCmd === "string"
            ? body.gameStartCmd.trim()
            : undefined,
        udpPorts:
          typeof body.udpPorts === "string"
            ? normalizeCsvList(body.udpPorts)
            : normalizeTextList(body.udpPorts),
        tcpPorts:
          typeof body.tcpPorts === "string"
            ? normalizeCsvList(body.tcpPorts)
            : normalizeTextList(body.tcpPorts),
        ingressCidr:
          typeof body.ingressCidr === "string"
            ? body.ingressCidr.trim()
            : undefined,
        backupIntervalMinutes: parseIntConfig(body.backupIntervalMinutes, 5),
        stopTimeoutSeconds: parseIntConfig(body.stopTimeoutSeconds, 30),
        profileEnv: isObject(body.profileEnv) ? body.profileEnv : undefined,
        worldId: body.worldId,
        createdAt: now,
        updatedAt: now,
        createdBy: authReq.user.sub,
      };
      await gameProfilesRepository.put(profile);
      res.status(201).json({ profile });
    }),
  );

  router.get(
    "/v1/games/:gameId/worlds",
    withAsync(async (req, res) => {
      const { gameId } = req.params;
      const allWorlds = await worldPresetsRepository.scan();
      const worlds = allWorlds
        .filter((world) => hasWorldShape(world) && isGameWorldForGame(world, gameId))
        .map((world) => parseWorldListEntry(world));
      worlds.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      res.json({ worlds });
    }),
  );

  router.post(
    "/v1/games/:gameId/worlds",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const { gameId } = req.params;
      const body = req.body as SaveWorldRequest;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ error: "name is required" });
        return;
      }
      if (!isObject(body?.worldSeed)) {
        res.status(400).json({ error: "worldSeed must be an object" });
        return;
      }

      const now = new Date().toISOString();
      const worldId = randomUUID();
      const world: WorldPresetItem = {
        pk: worldPk(gameId, worldId),
        gameId,
        gameRefId: gameId,
        kind: "game-world",
        worldId,
        name,
        description: body.description,
        worldSeed: body.worldSeed,
        createdAt: now,
        updatedAt: now,
        createdBy: authReq.user.sub,
      };
      await worldPresetsRepository.put(world);
      res.status(201).json({ world });
    }),
  );

  router.post(
    "/v1/games/:gameId/worlds/:worldId/copy",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const gameId = routeParam(req.params.gameId);
      const worldId = routeParam(req.params.worldId);
      const body = req.body as CopyWorldRequest;
      const sourceWorld = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!sourceWorld || !isGameWorldForGame(sourceWorld, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const now = new Date().toISOString();
      const nextWorldId = randomUUID();
      const sourceLocation = await resolveWorldConfigLocation(gameId, sourceWorld);
      const targetPrefix = siblingWorldPrefix(sourceLocation.worldPrefix, gameId, nextWorldId);
      const copiedObjectCount = await copyS3Prefix(
        sourceLocation.bucket,
        sourceLocation.worldPrefix,
        targetPrefix,
      );

      const world: WorldPresetItem = {
        ...sourceWorld,
        pk: worldPk(gameId, nextWorldId),
        gameId,
        gameRefId: gameId,
        kind: "game-world",
        worldId: nextWorldId,
        name:
          typeof body?.name === "string" && body.name.trim()
            ? body.name.trim()
            : `Copy of ${sourceWorld.name}`,
        description:
          typeof body?.description === "string"
            ? body.description.trim() || undefined
            : sourceWorld.description,
        worldPrefix: targetPrefix,
        currentInstanceId: undefined,
        currentInstanceGameId: undefined,
        lockedAt: undefined,
        createdAt: now,
        updatedAt: now,
        createdBy: authReq.user.sub,
      };
      await worldPresetsRepository.put(world);
      res.status(201).json({ world, copiedObjectCount });
    }),
  );

  router.delete(
    "/v1/games/:gameId/worlds/:worldId",
    withAsync(async (req, res) => {
      const gameId = routeParam(req.params.gameId);
      const worldId = routeParam(req.params.worldId);
      const world = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!world || !isGameWorldForGame(world, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const matchingInstances = (await instanceRepository.scanByField("selectedWorldId", worldId))
        .filter((instance) => instance.gameId === gameId);
      let activeInstance = matchingInstances.find((instance) => {
        return !isTerminalInstanceState(instanceStateText(instance));
      });
      if (!activeInstance && world.currentInstanceId) {
        const lockedInstance = await instanceRepository.get(world.currentInstanceId);
        if (lockedInstance) {
          if (!isTerminalInstanceState(instanceStateText(lockedInstance))) {
            activeInstance = lockedInstance;
          }
        }
      }
      if (activeInstance) {
        res.status(409).json({ error: "world has an active or locked server" });
        return;
      }

      const location = await resolveWorldConfigLocation(gameId, world);
      const deletedObjectCount = await deleteS3Prefix(location.bucket, location.worldPrefix);
      await worldPresetsRepository.delete(worldPk(gameId, worldId));
      res.json({ deleted: true, deletedObjectCount });
    }),
  );

  router.get(
    "/v1/games/:gameId/worlds/:worldId/runtime-info",
    withAsync(async (req, res) => {
      const gameId = routeParam(req.params.gameId);
      const worldId = routeParam(req.params.worldId);
      const world = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!world || !isGameWorldForGame(world, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const location = await resolveWorldConfigLocation(gameId, world);
      const stateRoot = `${location.worldPrefix.replace(/\/+$/, "")}/state`;
      const configRoot = `${location.worldPrefix.replace(/\/+$/, "")}/config/windrose`;
      const serverDescriptionKeys = [
        `${configRoot}/ServerDescription.json`,
        `${stateRoot}/ServerDescription.json`,
        `${stateRoot}/R5/ServerDescription.json`,
      ];
      const worldDescriptionKeys = [
        `${configRoot}/WorldDescription.json`,
        `${stateRoot}/WorldDescription.json`,
        `${stateRoot}/R5/WorldDescription.json`,
      ];

      let serverDescription: Record<string, unknown> | undefined;
      let serverDescriptionKey: string | undefined;
      for (const key of serverDescriptionKeys) {
        serverDescription = parseJsonObject(await getS3ObjectText(location.bucket, key));
        if (serverDescription) {
          serverDescriptionKey = key;
          break;
        }
      }

      let worldDescription: Record<string, unknown> | undefined;
      let worldDescriptionKey: string | undefined;
      const serverSettings = windroseServerSettings(serverDescription);
      const worldIslandId = textField(serverSettings, "WorldIslandId");
      const candidateWorldDescriptionKeys = [
        ...worldDescriptionKeys,
        ...(worldIslandId
          ? [
              `${stateRoot}/Saved/SaveProfiles/Default/Worlds/${worldIslandId}/WorldDescription.json`,
              `${stateRoot}/R5/Saved/SaveProfiles/Default/Worlds/${worldIslandId}/WorldDescription.json`,
            ]
          : []),
      ];
      for (const key of candidateWorldDescriptionKeys) {
        worldDescription = parseJsonObject(await getS3ObjectText(location.bucket, key));
        if (worldDescription) {
          worldDescriptionKey = key;
          break;
        }
      }
      if (!worldDescription) {
        const stateKeys = await listS3Keys(location.bucket, `${stateRoot}/`);
        for (const key of stateKeys.filter((candidate) => candidate.endsWith("/WorldDescription.json"))) {
          worldDescription = parseJsonObject(await getS3ObjectText(location.bucket, key));
          if (worldDescription) {
            worldDescriptionKey = key;
            break;
          }
        }
      }

      res.json({
        bucket: location.bucket,
        worldPrefix: location.worldPrefix,
        inviteCode:
          textField(serverSettings, "InviteCode") ||
          textField(serverSettings, "inviteCode"),
        serverName:
          textField(serverSettings, "ServerName") ||
          textField(serverSettings, "Name") ||
          textField(serverSettings, "name"),
        isPasswordProtected: booleanField(serverSettings, "IsPasswordProtected"),
        maxPlayerCount: numberField(serverSettings, "MaxPlayerCount"),
        worldIslandId,
        combatDifficulty: windroseCombatDifficulty(worldDescription),
        mobHealthMultiplier:
          numberField(windroseWorldSettings(worldDescription), "MobHealthMultiplier") ||
          windroseWorldFloat(worldDescription, "MobHealthMultiplier"),
        mobDamageMultiplier:
          numberField(windroseWorldSettings(worldDescription), "MobDamageMultiplier") ||
          windroseWorldFloat(worldDescription, "MobDamageMultiplier"),
        serverDescriptionKey,
        worldDescriptionKey,
        serverDescription,
        worldDescription,
      });
    }),
  );

  router.put(
    "/v1/games/:gameId/worlds/:worldId/runtime-info",
    withAsync(async (req, res) => {
      const gameId = routeParam(req.params.gameId);
      const worldId = routeParam(req.params.worldId);
      if (gameId.toLowerCase() !== "windrose") {
        res.status(400).json({ error: "runtime-info editing is only supported for Windrose" });
        return;
      }

      const body = req.body as {
        serverDescription?: unknown;
        worldDescription?: unknown;
        serverDescriptionKey?: unknown;
        worldDescriptionKey?: unknown;
      };
      if (body.serverDescription !== undefined && !isObject(body.serverDescription)) {
        res.status(400).json({ error: "serverDescription must be a JSON object" });
        return;
      }
      if (body.worldDescription !== undefined && !isObject(body.worldDescription)) {
        res.status(400).json({ error: "worldDescription must be a JSON object" });
        return;
      }
      if (body.serverDescription === undefined && body.worldDescription === undefined) {
        res.status(400).json({ error: "serverDescription or worldDescription is required" });
        return;
      }

      const world = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!world || !isGameWorldForGame(world, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const location = await resolveWorldConfigLocation(gameId, world);
      const writtenKeys = new Set<string>();
      const writeJson = async (key: string, value: Record<string, unknown>) => {
        if (writtenKeys.has(key)) return;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: location.bucket,
            Key: key,
            Body: `${JSON.stringify(value, null, 2)}\n`,
            ContentType: "application/json",
          }),
        );
        writtenKeys.add(key);
      };

      if (isObject(body.serverDescription)) {
        await writeJson(
          windroseStableServerDescriptionKey(location.worldPrefix),
          body.serverDescription,
        );
        if (
          isSafeWorldJsonKey(
            body.serverDescriptionKey,
            location.worldPrefix,
            "ServerDescription.json",
          )
        ) {
          await writeJson(body.serverDescriptionKey, body.serverDescription);
        } else {
          await writeJson(
            `${location.worldPrefix.replace(/\/+$/, "")}/state/ServerDescription.json`,
            body.serverDescription,
          );
        }
      }

      if (isObject(body.worldDescription)) {
        await writeJson(
          windroseStableWorldDescriptionKey(location.worldPrefix),
          body.worldDescription,
        );
        if (
          isSafeWorldJsonKey(
            body.worldDescriptionKey,
            location.worldPrefix,
            "WorldDescription.json",
          )
        ) {
          await writeJson(body.worldDescriptionKey, body.worldDescription);
        } else {
          const islandId =
            textField(
              windroseServerSettings(isObject(body.serverDescription) ? body.serverDescription : undefined),
              "WorldIslandId",
            ) ||
            textField(windroseWorldSettings(body.worldDescription), "IslandId");
          if (islandId) {
            await writeJson(
              `${location.worldPrefix.replace(/\/+$/, "")}/state/Saved/SaveProfiles/Default/RocksDB_v2/current/Worlds/${islandId}/WorldDescription.json`,
              body.worldDescription,
            );
          }
        }
      }

      const updatedWorld = {
        ...world,
        worldPrefix: location.worldPrefix,
        updatedAt: new Date().toISOString(),
      };
      await worldPresetsRepository.put(updatedWorld);

      res.json({
        bucket: location.bucket,
        worldPrefix: location.worldPrefix,
        writtenKeys: Array.from(writtenKeys),
        serverDescriptionKey: windroseStableServerDescriptionKey(location.worldPrefix),
        worldDescriptionKey: windroseStableWorldDescriptionKey(location.worldPrefix),
      });
    }),
  );

  router.get(
    "/v1/games/:gameId/worlds/:worldId/server-config",
    withAsync(async (req, res) => {
      const { gameId, worldId } = req.params;
      const world = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!world || !isGameWorldForGame(world, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const location = await resolveWorldConfigLocation(gameId, world);
      let configXml = await getS3ObjectText(location.bucket, location.key);
      let sourceKey = location.key;
      let exists = true;
      if (configXml === undefined) {
        exists = false;
        for (const fallbackKey of location.fallbackKeys) {
          configXml = await getS3ObjectText(location.bucket, fallbackKey);
          if (configXml !== undefined) {
            sourceKey = fallbackKey;
            break;
          }
        }
      }

      res.json({
        bucket: location.bucket,
        key: location.key,
        sourceKey,
        worldPrefix: location.worldPrefix,
        exists,
        configXml: configXml ?? "",
      });
    }),
  );

  router.put(
    "/v1/games/:gameId/worlds/:worldId/server-config",
    withAsync(async (req, res) => {
      const { gameId, worldId } = req.params;
      const body = req.body as { configXml?: unknown };
      const configXml = typeof body?.configXml === "string" ? body.configXml : "";
      if (!configXml.trim()) {
        res.status(400).json({ error: "configXml is required" });
        return;
      }

      const world = await worldPresetsRepository.get(worldPk(gameId, worldId));
      if (!world || !isGameWorldForGame(world, gameId)) {
        res.status(404).json({ error: "world not found" });
        return;
      }

      const location = await resolveWorldConfigLocation(gameId, world);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: location.bucket,
          Key: location.key,
          Body: configXml,
          ContentType: "application/xml",
        }),
      );

      const updatedWorld = {
        ...world,
        worldPrefix: location.worldPrefix,
        updatedAt: new Date().toISOString(),
      };
      await worldPresetsRepository.put(updatedWorld);

      res.json({
        bucket: location.bucket,
        key: location.key,
        worldPrefix: location.worldPrefix,
        configXml,
      });
    }),
  );

  router.get(
    "/v1/instances",
    withAsync(async (req, res) => {
      const gameId = req.query.gameId ? String(req.query.gameId) : undefined;
      const instances = gameId
        ? await instanceRepository.scanByField("gameId", gameId)
        : await instanceRepository.scan();
      const hydrated = await Promise.all(instances.map((instance) => hydrateInstanceFromEc2(instance)));
      res.json({ instances: hydrated });
    }),
  );

  router.get(
    "/v1/instances/:instanceId",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const instance = await instanceRepository.get(instanceId);
      if (instance) {
        res.json({ instance: await hydrateInstanceFromEc2(instance) });
        return;
      }

      const fallbackState = await refreshEc2State(instanceId);
      if (!fallbackState) {
        res.status(404).json({ error: "instance not found" });
        return;
      }
      res.json({
        instance: {
          pk: instanceId,
          instanceId,
          gameId: "legacy",
          status: "legacy",
          ec2State: fallbackState,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
    }),
  );

  router.post(
    "/v1/instances",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const idempotencyKey = cleanIdempotencyKey(req.headers["idempotency-key"]);
      const requestBody = (req.body ?? {}) as Record<string, unknown>;
      const specs: InstanceCreateRequest[] = Array.isArray(requestBody.instances)
        ? (requestBody.instances as InstanceCreateRequest[])
        : [requestBody as InstanceCreateRequest];

      if (specs.length === 0) {
        res.status(400).json({ error: "No instance payload supplied" });
        return;
      }

      const replayLookup = await lookupOperationByIdempotency(idempotencyKey);
      if (replayLookup?.action === "create") {
        res.json(replayLookup);
        return;
      }

      const { operation: createdOperation, replay } = await createOperation(
        authReq,
        "create",
        [],
        { count: specs.length },
        idempotencyKey,
      );
      if (replay) {
        res.json(createdOperation);
        return;
      }

      const allIds: string[] = [];
      let operation = createdOperation;
      try {
        for (const rawSpec of specs) {
          const gameId =
            typeof rawSpec.gameId === "string"
              ? rawSpec.gameId.trim()
              : String(rawSpec.gameId ?? "").trim();
          if (!gameId) {
            throw new Error("Missing gameId");
          }
          const spec: InstanceCreateRequest = {
            gameId,
            count: rawSpec.count,
            amiId: rawSpec.amiId,
            instanceType: rawSpec.instanceType,
            keyName: rawSpec.keyName,
            subnetId: rawSpec.subnetId,
            securityGroupIds: rawSpec.securityGroupIds,
            tags: rawSpec.tags,
            bootstrap: rawSpec.bootstrap,
            bootstrapAction: rawSpec.bootstrapAction ?? (rawSpec.bootstrap ? "bootstrap" : undefined),
            bootstrapDocumentName: rawSpec.bootstrapDocumentName,
            config: isObject(rawSpec.config) ? rawSpec.config : undefined,
            selectedProfileId:
              typeof rawSpec.selectedProfileId === "string"
                ? rawSpec.selectedProfileId.trim()
                : undefined,
            selectedWorldId:
              typeof rawSpec.selectedWorldId === "string"
                ? rawSpec.selectedWorldId.trim()
                : undefined,
            worldName:
              typeof rawSpec.worldName === "string" ? rawSpec.worldName.trim() : undefined,
            steamBetaBranch:
              typeof rawSpec.steamBetaBranch === "string"
                ? rawSpec.steamBetaBranch.trim()
                : undefined,
          };
          const created = await createInstancesForSpec(authReq, spec);
          allIds.push(...created);
          operation = await saveOperation(operation, { instanceIds: [...operation.instanceIds, ...created] });
        }

        operation = await saveOperation(operation, {
          status: "succeeded",
          instanceIds: allIds,
        });
      } catch (error) {
        operation = await saveOperation(operation, {
          status: "failed",
          error: (error as Error).message,
        });
      }

      res.status(operation.status === "failed" ? 500 : 200).json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/start",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(authReq, req.params.instanceId, "start");
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/stop",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(authReq, req.params.instanceId, "stop");
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/restart",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "restart",
        true,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/reboot",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "reboot",
        false,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/terminate",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const operation = await executeInstanceAction(
        authReq,
        req.params.instanceId,
        "terminate",
        true,
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/action",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const instanceId = req.params.instanceId;
      const action = req.body?.action;
      if (!isSupportedAction(action)) {
        res.status(400).json({ error: "action must be start|stop|restart|terminate|reboot" });
        return;
      }

      const operation = await executeInstanceAction(
        authReq,
        instanceId,
        action,
        action === "restart" || action === "terminate",
      );
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/server-action",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const action = req.body?.action;
      if (!isGameServerAction(action)) {
        res.status(400).json({ error: "action must be server-start|server-stop|server-restart" });
        return;
      }
      const operation = await executeGameServerAction(authReq, req.params.instanceId, action);
      res.json(operation);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/server-command",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
      if (!command) {
        res.status(400).json({ error: "command is required" });
        return;
      }
      if (command.length > 500) {
        res.status(400).json({ error: "command must be 500 characters or fewer" });
        return;
      }
      const operation = await executeGameServerCommand(authReq, req.params.instanceId, command);
      res.json(operation);
    }),
  );

  router.get(
    "/v1/instances/:instanceId/player-status",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      try {
        const response = await logsClient.send(
          new GetLogEventsCommand({
            logGroupName: config.logs.serverPrefix,
            logStreamName: logStreamNameFor(instanceId, "server"),
            limit: 500,
            startFromHead: false,
          }),
        );
        const status = parseLatestPlayerStatus(
          (response.events ?? []).map((event) => ({
            timestamp: event.timestamp,
            message: event.message,
          })),
        );
        res.json({
          instanceId,
          ...status,
        });
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          res.json({
            instanceId,
            playerCount: 0,
            players: [],
            lastUpdatedAt: undefined,
            serverVersion: undefined,
          });
          return;
        }
        throw error;
      }
    }),
  );

  router.get(
    "/v1/instances/:instanceId/status",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const latest = await latestOperationForInstance(instanceId);
      const ec2State = await refreshEc2State(instanceId);

      if (latest?.commandId && (latest.action === "bootstrap" || latest.action === "update")) {
        try {
          const invocation = await ssmClient.send(
            new GetCommandInvocationCommand({
              CommandId: latest.commandId,
              InstanceId: instanceId,
            }),
          );
          res.json({
            instanceId,
            ec2State,
            latestOperation: latest,
            commandStatus: {
              status: invocation.Status,
              executionStartDate: invocation.ExecutionStartDate?.toISOString(),
              executionEndDate: invocation.ExecutionEndDate?.toISOString(),
              responseCode: invocation.ResponseCode,
            },
          });
          return;
        } catch {
          // fallback to ec2 state below
        }
      }

      if (latest) {
        const expected = expectedEc2State(latest.action);
        const derivedStatus =
          latest.status === "running" && expected && ec2State === expected
            ? "succeeded"
            : latest.status;
        res.json({ instanceId, ec2State, latestOperation: { ...latest, status: derivedStatus } });
        return;
      }

      res.json({ instanceId, ec2State, latestOperation: null });
    }),
  );

  router.get(
    "/v1/instances/:instanceId/logs",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.query.source);
      const limit = asInt(req.query.limit, 100);
      const nextToken =
        typeof req.query.nextToken === "string" ? req.query.nextToken : undefined;
      const payload = await readLogEvents(instanceId, source, nextToken, limit);
      res.json(payload);
    }),
  );

  router.get(
    "/v1/instances/:instanceId/logs/:source",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.params.source);
      const limit = asInt(req.query.limit, 100);
      const nextToken =
        typeof req.query.nextToken === "string" ? req.query.nextToken : undefined;
      const payload = await readLogEvents(instanceId, source, nextToken, limit);
      res.json(payload);
    }),
  );

  router.post(
    "/v1/instances/:instanceId/logs/stream",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const source = normalizeLogSource(req.body?.source);
      const { logGroupName } = logLocation(instanceId, source);
      const streamName = `${instanceId}-${source}-${Date.now()}`;
      await logsClient.send(
        new CreateLogStreamCommand({
          logGroupName,
          logStreamName: streamName,
        }),
      );
      res.json({ instanceId, source, logGroupName, streamName });
    }),
  );

  router.get(
    "/v1/instances/:instanceId/config",
    withAsync(async (req, res) => {
      const instanceId = req.params.instanceId;
      const item = await configRepository.get(instanceId);
      if (!item) {
        const instance = await instanceRepository.get(instanceId);
        if (!instance) {
          res.status(404).json({ error: "instance not found" });
          return;
        }
        res.json({ instanceId, config: {}, updatedAt: null, updatedBy: null });
        return;
      }
      res.json({
        instanceId,
        config: item.values,
        updatedAt: item.updatedAt,
        updatedBy: item.updatedBy,
      });
    }),
  );

  router.patch(
    "/v1/instances/:instanceId/config",
    withAsync(async (req, res) => {
      const authReq = req as AuthenticatedRequest;
      const instanceId = req.params.instanceId;
      const body = req.body as Record<string, unknown>;
      const bootstrapAction =
        body?.action === "bootstrap" || body?.action === "update"
          ? (body.action as "bootstrap" | "update")
          : undefined;

      const rawConfigPayload =
        body?.config && typeof body.config === "object" && !Array.isArray(body.config)
          ? (body.config as Record<string, unknown>)
          : body;
      const configPayload =
        rawConfigPayload && typeof rawConfigPayload === "object"
          ? Object.fromEntries(
              Object.entries(rawConfigPayload).filter(([key]) => key !== "action"),
            )
          : {};

      if (!bootstrapAction && Object.keys(configPayload).length === 0) {
        res.status(400).json({ error: "No config changes supplied" });
        return;
      }

      const existing = await configRepository.get(instanceId);
      const prevValues = existing?.values ?? {};
      const nextValues = bootstrapAction
        ? { ...prevValues, ...configPayload }
        : { ...prevValues, ...configPayload };

      const now = new Date().toISOString();
      await configRepository.put({
        pk: instanceId,
        instanceId,
        values: nextValues,
        updatedAt: now,
        updatedBy: authReq.user.sub,
      });
      await configHistoryRepository.put({
        pk: `config_history#${instanceId}#${Date.now()}`,
        instanceId,
        operationId: randomUUID(),
        previous: prevValues,
        next: nextValues,
        createdAt: now,
        updatedBy: authReq.user.sub,
      });

      if (bootstrapAction) {
        const commandDocument =
          bootstrapAction === "bootstrap"
            ? config.ssm.bootstrapDocumentName
            : config.ssm.updateDocumentName;
        const operation = await launchSsmCommand(
          authReq,
          [instanceId],
          bootstrapAction,
          commandDocument,
        );
        res.json({
          instanceId,
          config: nextValues,
          operation,
        });
        return;
      }

      res.json({ instanceId, config: nextValues });
    }),
  );

  router.get(
    "/v1/operations/:operationId",
    withAsync(async (req, res) => {
      const operation = await operationRepository.get(
        operationPk(req.params.operationId),
      );
      if (!operation) {
        res.status(404).json({ error: "operation not found" });
        return;
      }
      res.json({ operation: await hydrateOperationCommandStatus(operation) });
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status =
      (error as { statusCode?: number })?.statusCode ??
      (error as { status?: number })?.status ??
      500;
    const message = error instanceof Error ? error.message : "internal error";
    res.status(status).json({ error: message });
  });

  return router;
}
