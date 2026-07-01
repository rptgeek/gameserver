import { getAuthToken } from './auth';
import type {
  Game,
  GameProfile,
  InstanceConfigResponse,
  LogsResponse,
  LogType,
  OperationResult,
  PlayerStatus,
  ServerInstance,
  WorldRuntimeInfo,
  WorldServerConfig,
  WorldPreset,
} from './types';

type Env = Record<string, string | undefined>;
const env = (import.meta as { env: Env }).env;
const API_BASE_URL = (env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

type Query = Record<string, string | undefined>;
type GetOperationApiResponse = OperationResult | { operation: OperationResult };

function toUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (typeof value === 'string' && value.length > 0) {
        params.append(key, value);
      }
    });
  }
  const url = `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const q = params.toString();
  return q ? `${url}?${q}` : url;
}

function normalizeList<T>(payload: unknown, fallbackKeys: string[] = []): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  for (const key of fallbackKeys) {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }
  return [];
}

async function request<T>(path: string, init: RequestInit = {}, query?: Query): Promise<T> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');

  let body = init.body;
  if (typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  } else if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.body);
  } else if (init.body === undefined) {
    body = undefined;
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(toUrl(path, query), {
    ...init,
    headers,
    body,
  });

  const text = await response.text();
  const parseJson = () => {
    if (!text) {
      return null as unknown as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null as unknown as T;
    }
  };

  if (!response.ok) {
    let msg = text || response.statusText;
    try {
      const parsed = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === 'object') {
        const error = (parsed as { error?: unknown; message?: unknown; details?: unknown }).error;
        const message = (parsed as { error?: unknown; message?: unknown; details?: unknown }).message;
        const details = (parsed as { error?: unknown; message?: unknown; details?: unknown }).details;
        msg = [error, message, details].filter((value) => typeof value === 'string' && value).join(': ') || msg;
      }
    } catch {
      // keep raw text/status
    }
    throw new Error(msg || 'Request failed');
  }

  if (response.status === 204) {
    return null as unknown as T;
  }

  return parseJson();
}

function operationIdFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return `operation-${Date.now()}`;
  }
  const candidate =
    (payload as { operationId?: unknown; id?: unknown; operation_id?: unknown }).operationId ??
    (payload as { operationId?: unknown; id?: unknown; operation_id?: unknown }).id ??
    (payload as { operationId?: unknown; id?: unknown; operation_id?: unknown }).operation_id;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  return `operation-${Date.now()}`;
}

function logsFromPayload(payload: unknown): LogsResponse {
  if (!payload || typeof payload !== 'object') {
    return { lines: [] };
  }
  const mapPayload = payload as {
    lines?: unknown;
    log?: unknown;
    logs?: unknown;
    events?: unknown;
    nextToken?: unknown;
    next_token?: unknown;
  };

  let linesRaw: unknown = mapPayload.lines || mapPayload.log || mapPayload.logs;
  if (!Array.isArray(linesRaw) && Array.isArray(mapPayload.events)) {
    linesRaw = mapPayload.events.map((event: unknown) => {
      if (typeof event === 'string') {
        return event;
      }
      if (!event || typeof event !== 'object') {
        return String(event);
      }
      const item = event as { message?: unknown; timestamp?: unknown };
      const ts = item.timestamp ? `${item.timestamp} ` : '';
      return `${ts}${String(item.message ?? '')}`.trim();
    });
  }

  const lines = Array.isArray(linesRaw)
    ? (linesRaw as unknown[]).map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (!item || typeof item !== 'object') {
          return String(item);
        }
        const obj = item as { message?: unknown; timestamp?: unknown; level?: unknown };
        if (typeof obj.message === 'string') {
          const ts = obj.timestamp ? `${obj.timestamp} ` : '';
          const level = obj.level ? `[${obj.level}] ` : '';
          return `${ts}${level}${obj.message}`;
        }
        return JSON.stringify(obj);
      })
    : [];

  const nextToken = typeof mapPayload.nextToken === 'string' ? mapPayload.nextToken : typeof mapPayload.next_token === 'string' ? mapPayload.next_token : undefined;
  return { lines, nextToken };
}

function normalizeGame(item: { id?: unknown; gameId?: unknown; name?: unknown; title?: unknown }): Game {
  const id =
    typeof item.id === 'string'
      ? item.id
      : typeof item.gameId === 'string'
        ? item.gameId
        : `game-${Date.now()}`;
  return {
    id,
    name:
      typeof item.name === 'string'
        ? item.name
        : typeof item.title === 'string'
          ? item.title
          : id,
    gameId: typeof item.gameId === 'string' ? item.gameId : id,
    ...(item as Record<string, unknown>),
  } as Game;
}

export async function listGames(): Promise<Game[]> {
  const payload = await request<Game[] | { games?: Game[]; items?: Game[] } | unknown>('/v1/games');
  if (Array.isArray(payload)) {
    return (payload as { id?: unknown; gameId?: unknown }[]).map((game) =>
      normalizeGame(game),
    );
  }
  const games = normalizeList<Game>(payload, ['games', 'items', 'data']);
  return (games as { id?: unknown; gameId?: unknown }[]).map((game) => normalizeGame(game));
}

export async function listProfiles(gameId: string): Promise<GameProfile[]> {
  const payload = await request<{ profiles?: GameProfile[] } | GameProfile[]>(
    `/v1/games/${encodeURIComponent(gameId)}/profiles`,
  );
  if (Array.isArray(payload)) {
    return payload;
  }
  return normalizeList<GameProfile>(payload, ['profiles', 'items']);
}

export async function createProfile(gameId: string, payload: {
  name: string;
  description?: string;
  config: Record<string, unknown>;
  worldId?: string;
}): Promise<GameProfile> {
  const result = await request<{ profile?: GameProfile } | GameProfile>(
    `/v1/games/${encodeURIComponent(gameId)}/profiles`,
    {
      method: 'POST',
      body: payload,
    },
  );
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid profile response');
  }
  return Array.isArray(result)
    ? result[0]
    : ('profile' in result ? (result.profile as GameProfile) : (result as GameProfile));
}

export async function listWorlds(gameId: string): Promise<WorldPreset[]> {
  const payload = await request<{ worlds?: WorldPreset[] } | WorldPreset[]>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds`,
  );
  if (Array.isArray(payload)) {
    return payload;
  }
  return normalizeList<WorldPreset>(payload, ['worlds', 'items']);
}

export async function createWorld(gameId: string, payload: {
  name: string;
  description?: string;
  worldSeed: Record<string, unknown>;
}): Promise<WorldPreset> {
  const result = await request<{ world?: WorldPreset } | WorldPreset>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds`,
    {
      method: 'POST',
      body: payload,
    },
  );
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid world response');
  }
  return Array.isArray(result)
    ? result[0]
    : ('world' in result ? (result.world as WorldPreset) : (result as WorldPreset));
}

export async function copyWorld(gameId: string, worldId: string, payload: {
  name?: string;
  description?: string;
} = {}): Promise<WorldPreset> {
  const result = await request<{ world?: WorldPreset } | WorldPreset>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/copy`,
    {
      method: 'POST',
      body: payload,
    },
  );
  if (!result || typeof result !== 'object') {
    throw new Error('Invalid world copy response');
  }
  return Array.isArray(result)
    ? result[0]
    : ('world' in result ? (result.world as WorldPreset) : (result as WorldPreset));
}

export async function deleteWorld(gameId: string, worldId: string): Promise<void> {
  await request(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getWorldRuntimeInfo(gameId: string, worldId: string): Promise<WorldRuntimeInfo> {
  return request<WorldRuntimeInfo>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/runtime-info`,
  );
}

export async function saveWorldRuntimeInfo(gameId: string, worldId: string, payload: {
  serverDescription?: Record<string, unknown>;
  worldDescription?: Record<string, unknown>;
  serverDescriptionKey?: string;
  worldDescriptionKey?: string;
}): Promise<WorldRuntimeInfo & { writtenKeys?: string[] }> {
  return request<WorldRuntimeInfo & { writtenKeys?: string[] }>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/runtime-info`,
    {
      method: 'PUT',
      body: payload,
    },
  );
}

export async function getWorldServerConfig(gameId: string, worldId: string): Promise<WorldServerConfig> {
  return request<WorldServerConfig>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/server-config`,
  );
}

export async function saveWorldServerConfig(gameId: string, worldId: string, configXml: string): Promise<WorldServerConfig> {
  return request<WorldServerConfig>(
    `/v1/games/${encodeURIComponent(gameId)}/worlds/${encodeURIComponent(worldId)}/server-config`,
    {
      method: 'PUT',
      body: { configXml },
    },
  );
}

export async function listInstances(gameId?: string): Promise<ServerInstance[]> {
  const payload = await request<ServerInstance[] | { instances?: ServerInstance[]; items?: ServerInstance[] } | unknown>(
    '/v1/instances',
    { method: 'GET' },
    gameId ? { gameId } : undefined,
  );

  if (Array.isArray(payload)) {
    return payload;
  }
  return normalizeList<ServerInstance>(payload, ['instances', 'items', 'data']);
}

export async function getInstance(instanceId: string): Promise<ServerInstance | null> {
  const payload = await request<ServerInstance | { instance?: ServerInstance }>(`/v1/instances/${encodeURIComponent(instanceId)}`);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if ((payload as Record<string, unknown>).id || (payload as Record<string, unknown>).instanceId) {
    return payload as ServerInstance;
  }
  return (payload as { instance?: ServerInstance }).instance || null;
}

export async function getPlayerStatus(instanceId: string): Promise<PlayerStatus> {
  return request<PlayerStatus>(`/v1/instances/${encodeURIComponent(instanceId)}/player-status`);
}

export async function createInstance(payload: {
  gameId: string;
  region: string;
  config: unknown;
  selectedProfileId?: string;
  selectedWorldId?: string;
  worldName?: string;
  steamBetaBranch?: string;
}): Promise<ServerInstance> {
  const result = await request<
    | ServerInstance
    | { instance?: ServerInstance; instanceIds?: string[]; instances?: string[]; operationId?: string }
    | OperationResult
  >('/v1/instances', {
    method: 'POST',
    body: payload,
  });

  if (!result || typeof result !== 'object') {
    return {
      id: `instance-${Date.now()}`,
    };
  }

  if ('instanceIds' in result && Array.isArray((result as { instanceIds?: string[] }).instanceIds)) {
    const ids = (result as { instanceIds?: string[] }).instanceIds ?? [];
    if (ids.length > 0) {
      return {
        id: ids[0],
        gameId: payload.gameId,
      };
    }
  }

  if ('instances' in result && Array.isArray((result as { instances?: string[] }).instances)) {
    const ids = (result as { instances?: string[] }).instances ?? [];
    if (ids.length > 0) {
      return {
        id: ids[0],
        gameId: payload.gameId,
      };
    }
  }

  if ('instance' in result && (result as { instance?: unknown }).instance && typeof result.instance === 'object') {
    return (result as { instance: ServerInstance }).instance;
  }

  if ((result as ServerInstance).id || (result as ServerInstance).instanceId) {
    return result as ServerInstance;
  }
  return { id: `instance-${Date.now()}` };
}

async function triggerInstanceAction(
  instanceId: string,
  action: 'start' | 'stop' | 'restart' | 'terminate' | 'reboot',
): Promise<OperationResult> {
  const res = await request<OperationResult | unknown>(`/v1/instances/${encodeURIComponent(instanceId)}/action`, {
    method: 'POST',
    body: { action },
  });
  const operationId = operationIdFromPayload(res);
  return typeof res === 'object' && res !== null && 'operationId' in res
    ? (res as OperationResult)
    : { operationId, status: 'STARTING' };
}

async function triggerServerAction(
  instanceId: string,
  action: 'server-start' | 'server-stop' | 'server-restart',
): Promise<OperationResult> {
  const res = await request<OperationResult | unknown>(`/v1/instances/${encodeURIComponent(instanceId)}/server-action`, {
    method: 'POST',
    body: { action },
  });
  const operationId = operationIdFromPayload(res);
  return typeof res === 'object' && res !== null && 'operationId' in res
    ? (res as OperationResult)
    : { operationId, status: 'STARTING' };
}

export async function startGameServer(instanceId: string): Promise<OperationResult> {
  return triggerServerAction(instanceId, 'server-start');
}

export async function stopGameServer(instanceId: string): Promise<OperationResult> {
  return triggerServerAction(instanceId, 'server-stop');
}

export async function restartGameServer(instanceId: string): Promise<OperationResult> {
  return triggerServerAction(instanceId, 'server-restart');
}

export async function sendGameServerCommand(instanceId: string, command: string): Promise<OperationResult> {
  const res = await request<OperationResult | unknown>(`/v1/instances/${encodeURIComponent(instanceId)}/server-command`, {
    method: 'POST',
    body: { command },
  });
  const operationId = operationIdFromPayload(res);
  return typeof res === 'object' && res !== null && 'operationId' in res
    ? (res as OperationResult)
    : { operationId, status: 'STARTING' };
}

export async function startInstance(instanceId: string): Promise<OperationResult> {
  return triggerInstanceAction(instanceId, 'start');
}

export async function stopInstance(instanceId: string): Promise<OperationResult> {
  return triggerInstanceAction(instanceId, 'stop');
}

export async function restartInstance(instanceId: string): Promise<OperationResult> {
  return triggerInstanceAction(instanceId, 'restart');
}

export async function terminateInstance(instanceId: string): Promise<OperationResult> {
  return triggerInstanceAction(instanceId, 'terminate');
}

export async function getOperation(operationId: string): Promise<OperationResult> {
  const res = await request<GetOperationApiResponse>(`/v1/operations/${encodeURIComponent(operationId)}`);
  const operation =
    (res && typeof res === 'object' && 'operation' in res && (res as { operation: unknown }).operation)
      ? ((res as { operation: OperationResult }).operation)
      : (res as OperationResult | null);

  if (!operation || !operation.operationId) {
    return { operationId, status: 'UNKNOWN', message: 'No operation payload returned.' };
  }
  return operation;
}

export async function getConfig(instanceId: string): Promise<InstanceConfigResponse> {
  const payload = await request<InstanceConfigResponse | { config?: unknown }>(`/v1/instances/${encodeURIComponent(instanceId)}/config`);
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  return payload;
}

export async function updateConfig(
  instanceId: string,
  config: unknown,
  applyMode: 'apply' | 'applyAndRestart',
): Promise<OperationResult> {
  const res = await request<OperationResult | unknown>(`/v1/instances/${encodeURIComponent(instanceId)}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ config, applyMode }),
  });
  const operationId = operationIdFromPayload(res);
  return typeof res === 'object' && res !== null && 'operationId' in res
    ? (res as OperationResult)
    : { operationId, status: 'UPDATED' };
}

export async function getLogs(
  instanceId: string,
  type: LogType,
  nextToken?: string,
  limit = 200,
): Promise<LogsResponse> {
  const query: Query = {};
  if (nextToken) {
    query.nextToken = nextToken;
  }
  if (limit) {
    query.limit = String(limit);
  }
  const payload = await request<unknown>(
    `/v1/instances/${encodeURIComponent(instanceId)}/logs/${type}`,
    {
      method: 'GET',
      headers: {
        'content-type': 'text/plain',
      },
    },
    query,
  );
  return logsFromPayload(payload);
}

export async function streamLogs(
  instanceId: string,
  type: LogType,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  while (!signal?.aborted) {
    const payload = await getLogs(instanceId, type, undefined);
    for (const line of payload.lines) {
      if (signal?.aborted) {
        return;
      }
      onLine(line);
    }

    await new Promise((resolve) => window.setTimeout(resolve, 3000));
  }
}
