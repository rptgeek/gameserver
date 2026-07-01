import { Instance, InstanceState } from "@aws-sdk/client-ec2";

export interface GameItem {
  pk: string;
  gameId: string;
  kind: "game";
  name?: string;
  title?: string;
  configSchema?: ConfigField[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select";
  description?: string;
  default?: unknown;
  options?: string[];
}

export interface GameProfileItem {
  pk: string;
  gameId: string;
  gameRefId?: string;
  kind: "game-profile";
  profileId: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  instanceType?: string;
  defaultInstanceType?: string;
  amiId?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  keyName?: string;
  iamInstanceProfile?: string;
  worldBucket?: string;
  s3Prefix?: string;
  worldBucketRegion?: string;
  gameInstallCmd?: string;
  gameStartCmd?: string;
  udpPorts?: string[];
  tcpPorts?: string[];
  ingressCidr?: string;
  backupIntervalMinutes?: number;
  gameName?: string;
  gameHome?: string;
  steamBetaBranch?: string;
  steamBetaPassword?: string;
  gameStateDirPath?: string;
  gameConfigS3Key?: string;
  gameConfigLocalPath?: string;
  stateLink?: string;
  volumeSizeGiB?: number;
  stopTimeoutSeconds?: number;
  spotPriceBumpPercent?: number;
  ensureSecurityGroupRules?: boolean;
  profileEnv?: Record<string, string>;
  worldId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface WorldPresetItem {
  pk: string;
  gameId: string;
  gameRefId?: string;
  kind: "game-world";
  worldId: string;
  name: string;
  description?: string;
  worldSeed?: Record<string, unknown>;
  lockedAt?: string;
  currentInstanceId?: string;
  currentInstanceGameId?: string;
  worldPrefix?: string;
  saveVersion?: string;
  saveVersionUpdatedAt?: string;
  lastBackupAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface InstanceItem {
  pk: string;
  instanceId: string;
  gameId: string;
  ec2State?: InstanceState;
  status?: string;
  availabilityZone?: string;
  spotPriceAtLaunch?: string;
  lastBackupAt?: string;
  serverName?: string;
  worldBucket?: string;
  worldS3Prefix?: string;
  worldPrefix?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  amiId?: string;
  instanceType?: string;
  subnetId?: string;
  securityGroupIds?: string[];
  tags?: Record<string, string>;
  bootstrapProfile?: string;
  selectedProfileId?: string;
  selectedWorldId?: string;
  worldName?: string;
  profileType?: "bootstrap" | "update";
  backupState?: "idle" | "requested" | "running" | "failed";
}

export interface OperationItem {
  pk: string;
  operationId: string;
  action: "create" | "start" | "stop" | "restart" | "terminate" | "reboot" | "bootstrap" | "update" | "config-update" | "log-stream" | "server-start" | "server-stop" | "server-restart" | "server-command";
  instanceIds: string[];
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  userRole?: string;
  commandId?: string;
  commandDocument?: string;
  error?: string;
  payload?: Record<string, unknown>;
}

export interface IdempotencyLookupItem {
  pk: string;
  kind: "idempotency";
  operationId: string;
  createdAt: string;
}

export interface ConfigItem {
  pk: string;
  instanceId: string;
  values: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
}

export interface ConfigHistoryItem {
  pk: string;
  instanceId: string;
  operationId: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
  createdAt: string;
  updatedBy: string;
}

export interface UserContext {
  sub: string;
  role: string;
  username: string;
}

export interface InstanceCreateRequest {
  gameId: string;
  // Number of instances to create with a single game spec.
  count?: number;
  // Optional fields for per-game bootstrap selection.
  selectedProfileId?: string;
  selectedWorldId?: string;
  worldName?: string;
  steamBetaBranch?: string;
  serverName?: string;
  subnetIds?: string[];
  amiId?: string;
  instanceType?: string;
  spotPriceBumpPercent?: number;
  subnetId?: string;
  keyName?: string;
  securityGroupIds?: string[];
  tags?: Record<string, string>;
  bootstrap?: boolean;
  bootstrapAction?: "bootstrap" | "update";
  bootstrapDocumentName?: string;
  config?: Record<string, unknown>;
}

export interface LogSourceQuery {
  source?: "bootstrap" | "server";
  nextToken?: string;
  limit?: number;
}

export interface SaveProfileRequest {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  profileEnv?: Record<string, string>;
  worldBucket?: string;
  s3Prefix?: string;
  worldBucketRegion?: string;
  amiId?: string;
  defaultInstanceType?: string;
  instanceType?: string;
  subnetIds?: string[];
  securityGroupIds?: string[];
  keyName?: string;
  iamInstanceProfile?: string;
  gameInstallCmd?: string;
  gameStartCmd?: string;
  udpPorts?: string[];
  tcpPorts?: string[];
  ingressCidr?: string;
  backupIntervalMinutes?: number;
  stopTimeoutSeconds?: number;
  worldId?: string;
}

export interface SaveWorldRequest {
  name: string;
  description?: string;
  worldSeed?: Record<string, unknown>;
}

export interface CopyWorldRequest {
  name?: string;
  description?: string;
}

export type SupportedAction = "start" | "stop" | "restart" | "terminate" | "reboot";
