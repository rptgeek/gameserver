import { Instance, InstanceState } from "@aws-sdk/client-ec2";

export interface GameItem {
  pk: string;
  gameId: string;
  kind: "game";
  name?: string;
  title?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  ownerUserId?: string;
  metadata?: Record<string, unknown>;
}

export interface GameProfileItem {
  pk: string;
  gameId: string;
  kind: "game-profile";
  profileId: string;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  worldId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface WorldPresetItem {
  pk: string;
  gameId: string;
  kind: "game-world";
  worldId: string;
  name: string;
  description?: string;
  worldSeed?: Record<string, unknown>;
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
}

export interface OperationItem {
  pk: string;
  operationId: string;
  action: "create" | "start" | "stop" | "restart" | "terminate" | "reboot" | "bootstrap" | "update" | "config-update" | "log-stream";
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
  amiId?: string;
  instanceType?: string;
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
  config: Record<string, unknown>;
  worldId?: string;
}

export interface SaveWorldRequest {
  name: string;
  description?: string;
  worldSeed?: Record<string, unknown>;
}

export type SupportedAction = "start" | "stop" | "restart" | "terminate" | "reboot";
