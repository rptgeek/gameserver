export type ToastType = 'success' | 'error' | 'info';

export type ServerStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'restarting' | 'terminated' | 'error' | 'unknown';

export interface Game {
  id: string;
  name: string;
  gameId?: string;
  title?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface GameProfile {
  id?: string;
  gameId: string;
  profileId: string;
  name: string;
  config: Record<string, unknown>;
  description?: string;
  worldId?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface WorldPreset {
  id?: string;
  gameId: string;
  worldId: string;
  name: string;
  description?: string;
  worldSeed: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface WorldServerConfig {
  bucket: string;
  key: string;
  sourceKey?: string;
  worldPrefix?: string;
  exists?: boolean;
  configXml: string;
}

export interface PlayerStatus {
  instanceId: string;
  playerCount: number;
  players: string[];
  lastUpdatedAt?: string;
  serverVersion?: string;
}

export interface ServerInstance {
  id: string;
  instanceId?: string;
  game?: string;
  gameId?: string;
  selectedProfileId?: string;
  selectedWorldId?: string;
  worldName?: string;
  tags?: Record<string, string>;
  gameInstanceResourceId?: string;
  resourceId?: string;
  status?: ServerStatus | string;
  region?: string;
  publicIp?: string;
  startedAt?: string;
  [key: string]: unknown;
}

export interface OperationResult {
  operationId: string;
  status?: string;
  message?: string;
  commandId?: string;
  error?: string;
  payload?: {
    output?: string;
    commandStatus?: string;
    responseCode?: number;
    [key: string]: unknown;
  };
}

export interface LogsResponse {
  lines: string[];
  nextToken?: string;
}

export interface InstanceConfigResponse {
  config?: unknown;
  [key: string]: unknown;
}

export interface AuthUser {
  username: string;
  userId: string;
  email?: string;
  displayName?: string;
}

export type LogType = 'bootstrap' | 'server';
