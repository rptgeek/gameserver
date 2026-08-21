import React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getCurrentUserProfile,
  initializeAuth,
  signIn,
  signOut,
} from './auth';
import {
  copyWorld,
  createInstance,
  createProfile,
  createWorld,
  deleteWorld,
  getConfig,
  getInstance,
  getLogs,
  getOperation,
  getPlayerStatus,
  getWorldRuntimeInfo,
  getWorldServerConfig,
  listProfiles,
  listWorlds,
  listGames,
  listInstances,
  restartGameServer,
  restartInstance,
  sendGameServerCommand,
  startGameServer,
  startInstance,
  stopGameServer,
  stopInstance,
  streamLogs,
  saveWorldRuntimeInfo,
  saveWorldServerConfig,
  terminateInstance,
  UnauthorizedError,
  updateConfig,
} from './api';
import type {
  AuthUser,
  Game,
  GameProfile,
  LogType,
  OperationResult,
  PlayerStatus,
  ServerInstance,
  ToastType,
  WorldPreset,
  WorldRuntimeInfo,
} from './types';

type DetailTab = 'overview' | 'bootstrap-logs' | 'server-logs' | 'console' | 'config';
type WindroseJsonFocus = 'server' | 'world';
type LaunchPhaseKey =
  | 'ec2'
  | 'bootstrap'
  | 'files'
  | 'install'
  | 'config'
  | 'game'
  | 'network'
  | 'world'
  | 'waiting-account'
  | 'first-player'
  | 'ready';

interface LaunchPhaseDefinition {
  key: LaunchPhaseKey;
  label: string;
  estimateSeconds: number;
}

interface LaunchProgress {
  phases: LaunchPhaseDefinition[];
  phase: LaunchPhaseDefinition;
  phaseIndex: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  remainingLabel?: string;
  percent: number;
  ready: boolean;
  statusText: string;
  endpoint?: string;
}

interface LaunchPhaseMarker {
  key: LaunchPhaseKey;
  atMs?: number;
}

const LAUNCH_LOG_HISTORY_LIMIT = 800;

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface InstanceForm {
  gameId: string;
  region: string;
  config: string;
  selectedProfileId: string;
  selectedWorldId: string;
  worldName: string;
  steamBetaBranch: string;
}

interface WorldRuntimeState {
  instance?: ServerInstance;
  status: string;
  publicIp?: string;
  lastBackupAt?: string;
}

const FINISHED_OPERATION_STATUSES = new Set([
  'SUCCEEDED',
  'SUCCESS',
  'FAILED',
  'CANCELLED',
  'CANCELED',
  'COMPLETE',
  'COMPLETED',
  'TERMINATED',
  'DELETED',
]);

function instanceId(instance: ServerInstance): string {
  return instance.instanceId || instance.id;
}

function prettyDate(iso?: string): string {
  if (!iso) {
    return '—';
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString();
}

function normalizeStatus(raw?: string): string {
  if (!raw) {
    return 'unknown';
  }
  return raw.toString().toLowerCase();
}

function statusClassName(raw?: string): string {
  const s = normalizeStatus(raw);
  return `status-pill ${s}`;
}

function displayUnknown(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '—';
}

function instanceType(instance: ServerInstance): string {
  return displayUnknown(instance.instanceType);
}

function worldGameId(world: WorldPreset): string {
  return world.gameId || String(world.gameRefId || '');
}

function worldKey(world: WorldPreset): string {
  return `${worldGameId(world)}:${world.worldId}`;
}

function supportsServerConfig(gameId: string): boolean {
  return gameId.toLowerCase() === '7d2d';
}

function supportsRuntimeJsonConfig(gameId: string): boolean {
  return gameId.toLowerCase() === 'windrose';
}

function windroseMonitorUrl(publicIp?: string): string | undefined {
  return publicIp ? `http://${publicIp}:8080` : undefined;
}

const LAUNCH_PHASES: LaunchPhaseDefinition[] = [
  { key: 'ec2', label: 'Launching EC2 server', estimateSeconds: 75 },
  { key: 'bootstrap', label: 'Bootstrapping host', estimateSeconds: 95 },
  { key: 'files', label: 'Loading save files', estimateSeconds: 45 },
  { key: 'install', label: 'Installing game files', estimateSeconds: 240 },
  { key: 'config', label: 'Updating server config', estimateSeconds: 25 },
  { key: 'game', label: 'Launching game server', estimateSeconds: 120 },
  { key: 'ready', label: 'Game ready', estimateSeconds: 0 },
];

const BAKED_LAUNCH_PHASES: LaunchPhaseDefinition[] = [
  { key: 'ec2', label: 'Launching EC2 server', estimateSeconds: 60 },
  { key: 'bootstrap', label: 'Bootstrapping host', estimateSeconds: 45 },
  { key: 'files', label: 'Loading save files', estimateSeconds: 50 },
  { key: 'install', label: 'Game files ready', estimateSeconds: 10 },
  { key: 'config', label: 'Updating server config', estimateSeconds: 15 },
  { key: 'game', label: 'Launching game server', estimateSeconds: 55 },
  { key: 'ready', label: 'Game ready', estimateSeconds: 0 },
];

const WINDROSE_BAKED_LAUNCH_PHASES: LaunchPhaseDefinition[] = [
  { key: 'ec2', label: 'Launching EC2 server', estimateSeconds: 45 },
  { key: 'bootstrap', label: 'Bootstrapping host', estimateSeconds: 25 },
  { key: 'files', label: 'Loading save files', estimateSeconds: 45 },
  { key: 'install', label: 'Game files ready', estimateSeconds: 10 },
  { key: 'config', label: 'Updating server config', estimateSeconds: 10 },
  { key: 'game', label: 'Starting Windrose', estimateSeconds: 80 },
  { key: 'network', label: 'Opening game port', estimateSeconds: 20 },
  { key: 'world', label: 'Loading world', estimateSeconds: 25 },
  { key: 'waiting-account', label: 'Waiting for first player', estimateSeconds: 0 },
  { key: 'first-player', label: 'Preparing player session', estimateSeconds: 120 },
  { key: 'ready', label: 'Game ready', estimateSeconds: 0 },
];

function totalLaunchSeconds(phases: LaunchPhaseDefinition[]): number {
  return phases.reduce(
  (total, phase) => total + phase.estimateSeconds,
  0,
  );
}

const TOTAL_LAUNCH_SECONDS = totalLaunchSeconds(LAUNCH_PHASES);

function isWindroseInstance(instance: ServerInstance): boolean {
  return instanceGameId(instance).toLowerCase() === 'windrose';
}

function launchPhasesFor(instance: ServerInstance): LaunchPhaseDefinition[] {
  if (isWindroseInstance(instance) && String(instance.amiSource || '').toLowerCase() === 'baked') {
    return WINDROSE_BAKED_LAUNCH_PHASES;
  }
  return String(instance.amiSource || '').toLowerCase() === 'baked' ? BAKED_LAUNCH_PHASES : LAUNCH_PHASES;
}

function mergeLaunchLogLines(existing: string[] | undefined, incoming: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const line of [...(existing || []), ...incoming]) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    merged.push(line);
  }
  return merged.slice(-LAUNCH_LOG_HISTORY_LIMIT);
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

function launchPort(instance: ServerInstance): number {
  return instanceGameId(instance).toLowerCase() === 'windrose' ? 7777 : 26900;
}

function launchStartedAt(instance: ServerInstance): number | undefined {
  const source = instance.startedAt || instance.createdAt;
  if (!source) {
    return undefined;
  }
  const parsed = Date.parse(source);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function phaseIndexForElapsed(phases: LaunchPhaseDefinition[], elapsedSeconds: number): number {
  let cursor = 0;
  for (let index = 0; index < phases.length - 1; index += 1) {
    cursor += phases[index].estimateSeconds;
    if (elapsedSeconds < cursor) {
      return index;
    }
  }
  return phases.length - 2;
}

function phaseMarkerFromLogs(lines: string[]): LaunchPhaseMarker | undefined {
  let current: LaunchPhaseMarker | undefined;
  for (const line of lines) {
    const lower = line.toLowerCase();
    const match = line.match(/LAUNCH_PHASE\s+phase=([a-z-]+).*?\bat=([^\s]+)/i);
    const marker = (match?.[1] || line.match(/LAUNCH_PHASE\s+phase=([a-z-]+)/i)?.[1])?.toLowerCase();
    if (
      marker === 'ec2' ||
      marker === 'bootstrap' ||
      marker === 'files' ||
      marker === 'install' ||
      marker === 'config' ||
      marker === 'game' ||
      marker === 'network' ||
      marker === 'world' ||
      marker === 'waiting-account' ||
      marker === 'first-player' ||
      marker === 'ready'
    ) {
      const parsedAt = match?.[2] ? Date.parse(match[2]) : Number.NaN;
      const normalizedMarker =
        marker === 'ready' && lower.includes('waiting for game readiness')
          ? 'network'
          : marker;
      current = { key: normalizedMarker, atMs: Number.isNaN(parsedAt) ? undefined : parsedAt };
      continue;
    }
    if (lower.includes('startgame done')) current = { key: 'ready' };
    else if (lower.includes('ueloggedin') || lower.includes('readytoplay') || lower.includes('rulerequestserver')) current = { key: 'ready' };
    else if (
      lower.includes('notifyacceptingconnection') ||
      lower.includes('login request') ||
      lower.includes('readyforterraingeneration') ||
      lower.includes('terraingeneration') ||
      lower.includes('waitingforbuildingisready') ||
      lower.includes('waitingforclientisready')
    ) current = { key: 'first-player' };
    else if (lower.includes('waitingforfirstaccount')) current = { key: 'waiting-account' };
    else if (
      lower.includes('loadmap load map complete /game/maps/gym/genlandia/genlandiamulty') ||
      lower.includes('bringing world /game/maps/gym/genlandia/genlandiamulty')
    ) current = { key: 'world' };
    else if (lower.includes('grpc server started') || lower.includes('ipnetdriver listening on port 7777')) current = { key: 'network' };
    else if (lower.includes('bootstrap complete')) current = { key: 'network' };
    else if (lower.includes('success! app') && lower.includes('fully installed')) current = { key: 'install' };
    else if (lower.includes(' update state ') || lower.includes('steamcmd') || lower.includes('download complete')) current = { key: 'install' };
    else if (lower.includes('pulling from windroseserver') || lower.includes('downloaded newer image')) current = { key: 'install' };
    else if (lower.includes('aws s3 sync') || lower.includes('world path:')) current = { key: 'files' };
    else if (lower.includes('serverdescription.json')) current = { key: 'config' };
  }
  return current;
}

function remainingSecondsForPhase(
  phases: LaunchPhaseDefinition[],
  phaseIndex: number,
  elapsedInPhaseSeconds: number,
): number {
  return phases
    .slice(phaseIndex, phases.length - 1)
    .reduce((total, phase, index) => {
      if (index === 0) {
        return total + Math.max(0, phase.estimateSeconds - elapsedInPhaseSeconds);
      }
      return total + phase.estimateSeconds;
    }, 0);
}

function launchStatusFromLogs(lines: string[], endpoint?: string): string | undefined {
  for (const line of [...lines].reverse()) {
    const packageLine = line.match(/^(Get|Ign|Err):(\d+)\s+.*?(?:\s([A-Za-z0-9_.:+~/-]+)\s+\[[^\]]+\])?$/);
    if (packageLine?.[2]) {
      const index = Number(packageLine[2]);
      const verb = packageLine[1] === 'Ign'
        ? 'Retrying package download'
        : packageLine[1] === 'Err'
          ? 'Package download error'
          : 'Downloading system packages';
      return `${verb} (${index}/96)`;
    }

    const lower = line.toLowerCase();
    const setup = line.match(/Setting up\s+([^:\s)]+)(?::[^\s)]+)?\s+\(([^)]+)\)/i);
    if (setup?.[1]) {
      return `Installing package ${setup[1]}`;
    }
    if (lower.includes('apt-get install -y awscli')) return 'Installing AWS CLI dependencies';
    if (lower.includes('apt-get install') && lower.includes('docker')) return 'Installing Docker dependencies';
    if (lower.includes('pulling from windroseserver')) return 'Downloading Windrose server image';
    if (lower.includes('downloaded newer image')) return 'Windrose server image downloaded';
    if (lower.includes('aws s3 sync')) return 'Syncing world files from S3';
    if (lower.includes('serverdescription.json')) return 'Applying Windrose server configuration';
    if (lower.includes('started windrose player monitor')) return 'Starting player monitor';
    if (lower.includes('started windrose-server') || lower.includes('started windrose server')) return 'Starting Windrose server';
    if (lower.includes('shutdown') || lower.includes('shut down')) {
      if (lower.includes('bl disconnected') || lower.includes('netdriver') || lower.includes('reactor')) {
        return 'Player session disconnected during startup';
      }
      return 'Server shutdown detected';
    }
    if (lower.includes('startgame done')) return endpoint ? `Game ready at ${endpoint}` : 'Game ready';
    if (lower.includes('server is still initializing')) return 'Server initializing; loading world';
    if (lower.includes('ueloggedin') || lower.includes('readytoplay') || lower.includes('rulerequestserver')) return endpoint ? `Game ready at ${endpoint}` : 'Game ready';
    if (lower.includes('waitingforbuildingisready') || lower.includes('waitingforclientisready')) return 'Finalizing first player session';
    if (lower.includes('readyforterraingeneration') || lower.includes('terraingeneration')) return 'Preparing world for first player';
    if (lower.includes('notifyacceptingconnection') || lower.includes('login request')) return 'Player connection detected';
    if (lower.includes('waitingforfirstaccount')) return endpoint ? `Listening at ${endpoint}; waiting for first player` : 'Waiting for first player';
    if (
      lower.includes('loadmap load map complete /game/maps/gym/genlandia/genlandiamulty') ||
      lower.includes('bringing world /game/maps/gym/genlandia/genlandiamulty')
    ) return 'Loading Windrose world';
    if (lower.includes('grpc server started') || lower.includes('ipnetdriver listening on port 7777')) return 'Opening Windrose network listener';
  }

  return endpoint ? `Waiting for game readiness at ${endpoint}` : undefined;
}

function gameReadyFromLogs(lines: string[], windrose: boolean): boolean {
  return lines.some((line) => {
    const lower = line.toLowerCase();
    if (windrose) {
      return lower.includes('ueloggedin') || lower.includes('readytoplay') || lower.includes('rulerequestserver');
    }
    return lower.includes('startgame done');
  });
}

function buildLaunchProgress(
  instance: ServerInstance,
  logLines: string[],
  nowMs: number,
): LaunchProgress | undefined {
  const status = normalizeStatus(instance.status);
  const isTerminal = ['stopped', 'terminated', 'error'].includes(status);
  const startedAt = launchStartedAt(instance);
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((nowMs - startedAt) / 1000)) : 0;
  const endpoint = instance.publicIp ? `${instance.publicIp}:${launchPort(instance)}` : undefined;
  const hasLaunchLogs = logLines.length > 0;
  const phases = launchPhasesFor(instance);
  const totalSeconds = totalLaunchSeconds(phases);
  const marker = phaseMarkerFromLogs(logLines);
  const markerPhase = marker?.key;
  const windrose = isWindroseInstance(instance);
  const ready =
    !isTerminal &&
    Boolean(instance.publicIp) &&
    (windrose
      ? markerPhase === 'ready' || gameReadyFromLogs(logLines, true)
      : gameReadyFromLogs(logLines, false));

  if (ready) {
    return {
      phases,
      phase: phases[phases.length - 1],
      phaseIndex: phases.length - 1,
      elapsedSeconds,
      remainingSeconds: 0,
      percent: 100,
      ready: true,
      statusText: endpoint ? `Ready at ${endpoint}` : 'Ready',
      endpoint,
    };
  }

  const shouldShow =
    !isTerminal &&
    Boolean(startedAt) &&
    (status === 'launching' || status === 'starting' || status === 'running' || elapsedSeconds < totalSeconds + 300);
  if (!shouldShow) {
    return undefined;
  }

  const markerIndex = markerPhase
    ? phases.findIndex((phase) => phase.key === markerPhase)
    : -1;
  const phaseIndex = markerIndex >= 0 ? markerIndex : phaseIndexForElapsed(phases, elapsedSeconds);
  const phase = phases[Math.min(phaseIndex, phases.length - 2)];
  const markerAgeSeconds = marker?.atMs ? Math.max(0, Math.floor((nowMs - marker.atMs) / 1000)) : 0;
  const estimatedRemainingFromPhase =
    markerIndex >= 0
      ? remainingSecondsForPhase(phases, phaseIndex, markerAgeSeconds)
      : Math.max(0, totalSeconds - elapsedSeconds);
  const completedEstimate = Math.max(0, totalSeconds - estimatedRemainingFromPhase);
  const remainingSeconds = Math.max(0, estimatedRemainingFromPhase);
  const percent = Math.min(98, Math.max(5, (completedEstimate / totalSeconds) * 100));
  const logStatus = launchStatusFromLogs(logLines, endpoint);
  const waitingForFirstPlayer = phase.key === 'waiting-account';
  const statusText = hasLaunchLogs
    ? logStatus || (endpoint ? `Waiting for game readiness at ${endpoint}` : 'Waiting for public IP')
    : 'Waiting for bootstrap logs';

  return {
    phases,
    phase,
    phaseIndex,
    elapsedSeconds,
    remainingSeconds,
    remainingLabel: waitingForFirstPlayer ? 'Waiting for player' : undefined,
    percent,
    ready: false,
    statusText,
    endpoint,
  };
}

function LaunchProgressView({
  progress,
  compact = false,
}: {
  progress: LaunchProgress;
  compact?: boolean;
}) {
  return (
    <div className={`launch-progress ${compact ? 'compact' : ''} ${progress.ready ? 'ready' : ''}`}>
      <div className="launch-progress-top">
        <strong>{progress.phase.label}</strong>
        <span>{progress.ready ? 'Ready' : progress.remainingLabel || `${formatDuration(progress.remainingSeconds)} left`}</span>
      </div>
      <div className="launch-progress-track" aria-label="Launch progress">
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      {!compact && (
        <>
          <div className="launch-phase-list">
            {progress.phases.map((phase, index) => (
              <span
                key={phase.key}
                className={index < progress.phaseIndex ? 'done' : index === progress.phaseIndex ? 'active' : ''}
              >
                {phase.label}
              </span>
            ))}
          </div>
          <div className="launch-progress-note">{progress.statusText}</div>
        </>
      )}
    </div>
  );
}

function CopyableIp({
  ip,
  onCopy,
}: {
  ip?: string;
  onCopy: (ip: string) => void;
}) {
  if (!ip) {
    return <>—</>;
  }

  return (
    <button
      type="button"
      className="copyable-ip"
      onClick={() => onCopy(ip)}
      aria-label={`Copy IP address ${ip}`}
      title="Copy IP address"
    >
      {ip}
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 8h11v11H8z" />
        <path d="M16 8V5H5v11h3" />
      </svg>
    </button>
  );
}

function s3KeyFromDisplayPath(displayPath: string, bucket?: string): string | undefined {
  const trimmed = displayPath.trim();
  if (!trimmed) {
    return undefined;
  }
  if (bucket && trimmed.startsWith(`${bucket}/`)) {
    return trimmed.slice(bucket.length + 1);
  }
  return trimmed;
}

function worldS3Prefix(world: WorldPreset): string {
  const rawPrefix = typeof world.worldPrefix === 'string' ? world.worldPrefix : '';
  if (rawPrefix) {
    return rawPrefix;
  }
  const gameId = worldGameId(world);
  return gameId && world.worldId ? `servers/${gameId}/${world.worldId}` : '—';
}

function worldBucket(world: WorldPreset, profiles: GameProfile[]): string {
  const explicit = typeof world.worldBucket === 'string' ? world.worldBucket : '';
  if (explicit) {
    return explicit;
  }
  const profileBucket = profiles.find((profile) => typeof profile.worldBucket === 'string')?.worldBucket;
  return typeof profileBucket === 'string' ? profileBucket : 'gameserver-state-example';
}

function playerSummary(status?: PlayerStatus): string {
  if (!status) {
    return '—';
  }
  return `${status.playerCount}`;
}

function instanceGameId(instance: ServerInstance): string {
  return String(instance.gameId || instance.game || '');
}

function runtimeServerLabel(instance: ServerInstance): string {
  return instanceGameId(instance) === 'windrose' ? 'Windrose' : '7D2D';
}

function isWorldConfigPlaceholder(instance: ServerInstance): boolean {
  return instanceId(instance).startsWith('world-config:');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameInstanceSnapshot(left: ServerInstance, right: ServerInstance): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [instances, setInstances] = useState<ServerInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [showTerminatedInstances, setShowTerminatedInstances] = useState(false);
  const [showSavedWorlds, setShowSavedWorlds] = useState(true);
  const [selectedInstance, setSelectedInstance] = useState<ServerInstance | null>(null);

  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [operations, setOperations] = useState<Record<string, OperationResult>>({});
  const [playerStatuses, setPlayerStatuses] = useState<Record<string, PlayerStatus>>({});
  const [launchLogLines, setLaunchLogLines] = useState<Record<string, string[]>>({});
  const [launchProgressTick, setLaunchProgressTick] = useState(Date.now());

  const [configText, setConfigText] = useState('{}');
  const [configMode, setConfigMode] = useState<'apply' | 'applyAndRestart'>('apply');
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState('');

  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsLive, setLogsLive] = useState(false);
  const [logsNextToken, setLogsNextToken] = useState<string | undefined>(undefined);
  const [logsClearMarker, setLogsClearMarker] = useState<string | null>(null);
  const [serverCommand, setServerCommand] = useState('');
  const [serverCommandBusy, setServerCommandBusy] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);

  const [showAddInstance, setShowAddInstance] = useState(false);
  const [addForm, setAddForm] = useState<InstanceForm>({
    gameId: '',
    region: 'us-east-1',
    config: '{\n  \"maxPlayers\": 64,\n  \"tickRate\": 30\n}',
    selectedProfileId: '',
    selectedWorldId: '',
    worldName: '',
    steamBetaBranch: 'latest_experimental',
  });
  const [profiles, setProfiles] = useState<GameProfile[]>([]);
  const [worlds, setWorlds] = useState<WorldPreset[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [worldName, setWorldPresetName] = useState('');
  const [worldDescription, setWorldDescription] = useState('');
  const [worldSeedText, setWorldSeedText] = useState('{\n  "seed": ""\n}');
  const [busyWorldIds, setBusyWorldIds] = useState<Record<string, 'copying' | 'deleting' | 'launching'>>({});
  const [instanceCreating, setInstanceCreating] = useState(false);
  const creatingInstanceRef = useRef(false);
  const launchingWorldKeysRef = useRef<Set<string>>(new Set());
  const [worldRuntimeInfo, setWorldRuntimeInfo] = useState<Record<string, WorldRuntimeInfo>>({});
  const [serverConfigXml, setServerConfigXml] = useState('');
  const [serverConfigKey, setServerConfigKey] = useState('');
  const [serverConfigLoading, setServerConfigLoading] = useState(false);
  const [serverConfigSaving, setServerConfigSaving] = useState(false);
  const [runtimeServerJson, setRuntimeServerJson] = useState('{}');
  const [runtimeWorldJson, setRuntimeWorldJson] = useState('{}');
  const [runtimeServerKey, setRuntimeServerKey] = useState('');
  const [runtimeWorldKey, setRuntimeWorldKey] = useState('');
  const [windroseJsonFocus, setWindroseJsonFocus] = useState<WindroseJsonFocus | null>(null);
  const selectedLogInstanceId = selectedInstance ? instanceId(selectedInstance) : '';

  const pollRef = useRef<Record<string, number>>({});
  const logStreamRef = useRef<AbortController | null>(null);
  const runtimeServerEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const runtimeWorldEditorRef = useRef<HTMLTextAreaElement | null>(null);

  const notify = (type: ToastType, message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((current) => [...current, { id, type, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 7000);
  };

  const isOperationRunning = (instance: ServerInstance): boolean => {
    const key = instanceId(instance);
    const op = operations[key];
    if (!op) {
      return false;
    }
    return !FINISHED_OPERATION_STATUSES.has(normalizeStatus(op.status).toUpperCase());
  };

  const clearOperationPoll = (id: string) => {
    const timer = pollRef.current[id];
    if (timer) {
      clearInterval(timer);
      delete pollRef.current[id];
    }
  };

  const stopLogStream = () => {
    if (logStreamRef.current) {
      logStreamRef.current.abort();
      logStreamRef.current = null;
    }
  };

  const loadPresetsForGame = async (gameId: string) => {
    try {
      const [loadedProfiles, loadedWorlds] = await Promise.all([
        listProfiles(gameId),
        listWorlds(gameId),
      ]);
      setProfiles(loadedProfiles);
      setWorlds(loadedWorlds);
      const runtimeEntries = await Promise.all(
        loadedWorlds
          .filter((world) => worldGameId(world).toLowerCase() === 'windrose')
          .map(async (world) => {
            try {
              const info = await getWorldRuntimeInfo(worldGameId(world), world.worldId);
              return [worldKey(world), info] as const;
            } catch {
              return [worldKey(world), null] as const;
            }
          }),
      );
      setWorldRuntimeInfo((current) => {
        const next = { ...current };
        for (const [key, info] of runtimeEntries) {
          if (info) {
            next[key] = info;
          } else {
            delete next[key];
          }
        }
        return next;
      });
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to load presets');
      setProfiles([]);
      setWorlds([]);
    }
  };

  const refreshInstances = async (gameFilter = selectedGameId) => {
    setInstancesLoading(true);
    try {
      const data = await listInstances(gameFilter || undefined);
      setInstances(data);
      if (selectedInstance) {
        const id = instanceId(selectedInstance);
        const next = data.find((candidate) => instanceId(candidate) === id);
        if (next) {
          setSelectedInstance((current) => (current && sameInstanceSnapshot(current, next) ? current : next));
        }
      }
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Failed to load instances');
    } finally {
      setInstancesLoading(false);
    }
  };

  const refreshPlayerStatuses = async (sourceInstances = instances) => {
    const activeInstances = sourceInstances.filter((instance) => {
      const status = normalizeStatus(instance.status);
      return status === 'running' || status === 'launching' || status === 'restoring' || status === 'starting';
    });
    if (activeInstances.length === 0) {
      return;
    }
    const results = await Promise.allSettled(
      activeInstances.map((instance) => getPlayerStatus(instanceId(instance))),
    );
    setPlayerStatuses((current) => {
      const next = { ...current };
      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          next[result.value.instanceId] = result.value;
        }
      });
      return next;
    });
  };

  const launchProgressFor = (instance: ServerInstance): LaunchProgress | undefined =>
    buildLaunchProgress(
      instance,
      launchLogLines[instanceId(instance)] ?? [],
      launchProgressTick,
    );

  const pollOperation = (id: string, operationId: string) => {
    clearOperationPoll(id);
    setOperations((prev) => ({ ...prev, [id]: { operationId, status: 'QUEUED' } }));

    const timer = window.setInterval(async () => {
      try {
        const op = await getOperation(operationId);
        setOperations((prev) => ({ ...prev, [id]: op }));

        if (FINISHED_OPERATION_STATUSES.has(op.status?.toUpperCase() || '')) {
          clearOperationPoll(id);
          notify('success', `${id} operation finished: ${op.status}`);
          await refreshInstances();
          const latest = await getInstance(id);
          if (latest && selectedInstance && instanceId(selectedInstance) === id) {
            setSelectedInstance((current) => (current && sameInstanceSnapshot(current, latest) ? current : latest));
          }
        }
      } catch (error) {
        clearOperationPoll(id);
        setOperations((prev) => ({ ...prev, [id]: { operationId, status: 'FAILED', message: 'Unable to poll operation' } }));
        notify('error', error instanceof Error ? error.message : 'Operation polling failed');
      }
    }, 2500);

    pollRef.current[id] = timer;
  };

  const loadDashboardContext = async () => {
    try {
      const loadedGames = await listGames();
      setGames(loadedGames);
      if (!selectedGameId && loadedGames.length > 0) {
        setSelectedGameId(loadedGames[0].id);
      }
      await refreshInstances(selectedGameId || undefined);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to load dashboard context');
    }
  };

  useEffect(() => {
    let active = true;
    const bootstrap = async () => {
      try {
        await initializeAuth();
        const profile = await getCurrentUserProfile();
        if (!active) {
          return;
        }
        setUser(profile);
        if (profile) {
          await loadDashboardContext();
        }
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Failed to initialize auth');
      } finally {
        if (active) {
          setBootstrapping(false);
        }
      }
    };
    bootstrap();

    return () => {
      active = false;
      Object.keys(pollRef.current).forEach((id) => {
        clearOperationPoll(id);
      });
      stopLogStream();
    };
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }
    if (!selectedGameId) {
      if (games.length === 1) {
        setSelectedGameId(games[0].id);
      } else if (games.length > 1) {
        setSelectedGameId('all');
      }
      return;
    }
    void refreshInstances(selectedGameId === 'all' ? undefined : selectedGameId);
    if (selectedGameId !== 'all') {
      void loadPresetsForGame(selectedGameId);
    }
  }, [selectedGameId, user]);

  useEffect(() => {
    if (!selectedInstance) {
      return;
    }
    if (isWorldConfigPlaceholder(selectedInstance)) {
      return;
    }
    const latest = instances.find((instance) => instanceId(instance) === instanceId(selectedInstance));
    if (!latest) {
      setSelectedInstance(null);
    } else {
      setSelectedInstance(latest);
    }
  }, [instances]);

  useEffect(() => {
    if (!user) {
      return;
    }
    void refreshPlayerStatuses();
    const timer = window.setInterval(() => {
      void refreshInstances(selectedGameId === 'all' ? undefined : selectedGameId);
      void refreshPlayerStatuses();
    }, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [user, selectedGameId, instances.length]);

  useEffect(() => {
    const timer = window.setInterval(() => setLaunchProgressTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!user) {
      return;
    }

    let cancelled = false;
    const pollLaunchProgress = async () => {
      const now = Date.now();
      const tracked = instances
        .filter((instance) => {
          const startedAt = launchStartedAt(instance);
          const status = normalizeStatus(instance.status);
          if (!startedAt || ['stopped', 'terminated', 'error'].includes(status)) {
            return false;
          }
          const ageSeconds = (now - startedAt) / 1000;
          return (
            status === 'launching' ||
            status === 'starting' ||
            (status === 'running' && ageSeconds < TOTAL_LAUNCH_SECONDS + 600)
          );
        })
        .slice(0, 6);

      if (tracked.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        tracked.map(async (instance) => {
          const id = instanceId(instance);
          const [latest, bootstrap, server, playerStatus] = await Promise.all([
            getInstance(id),
            getLogs(id, 'bootstrap', undefined, 250),
            getLogs(id, 'server', undefined, 250),
            getPlayerStatus(id),
          ]);
          return [id, latest, [...bootstrap.lines, ...server.lines], playerStatus] as const;
        }),
      );

      if (cancelled) {
        return;
      }

      setLaunchLogLines((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status === 'fulfilled') {
            next[result.value[0]] = mergeLaunchLogLines(current[result.value[0]], result.value[2]);
          }
        }
        return next;
      });
      setPlayerStatuses((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status === 'fulfilled') {
            next[result.value[0]] = result.value[3];
          }
        }
        return next;
      });
      setInstances((current) =>
        current.map((instance) => {
          const result = results.find(
            (candidate) =>
              candidate.status === 'fulfilled' &&
              candidate.value[0] === instanceId(instance) &&
              candidate.value[1],
          );
          return result?.status === 'fulfilled' && result.value[1] ? result.value[1] : instance;
        }),
      );
      setSelectedInstance((current) => {
        if (!current) {
          return current;
        }
        const result = results.find(
          (candidate) =>
            candidate.status === 'fulfilled' &&
            candidate.value[0] === instanceId(current) &&
            candidate.value[1],
        );
        if (result?.status === 'fulfilled' && result.value[1]) {
          return sameInstanceSnapshot(current, result.value[1]) ? current : result.value[1];
        }
        return current;
      });
    };

    void pollLaunchProgress();
    const timer = window.setInterval(() => {
      void pollLaunchProgress();
    }, 20000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user, instances]);

  useEffect(() => {
    if (!selectedInstance || detailTab !== 'config') {
      return;
    }
    const load = async () => {
      setConfigError('');
      try {
        const gameId = instanceGameId(selectedInstance);
        if (gameId && selectedInstance.selectedWorldId && supportsServerConfig(gameId)) {
          setServerConfigLoading(true);
          const worldConfig = await getWorldServerConfig(gameId, selectedInstance.selectedWorldId);
          setServerConfigXml(worldConfig.configXml || '');
          setServerConfigKey(`${worldConfig.bucket}/${worldConfig.key}`);
          return;
        }
        if (gameId && selectedInstance.selectedWorldId && supportsRuntimeJsonConfig(gameId)) {
          setServerConfigLoading(true);
          const runtimeInfo = await getWorldRuntimeInfo(gameId, selectedInstance.selectedWorldId);
          setRuntimeServerJson(JSON.stringify(runtimeInfo.serverDescription ?? {}, null, 2));
          setRuntimeWorldJson(JSON.stringify(runtimeInfo.worldDescription ?? {}, null, 2));
          setRuntimeServerKey(runtimeInfo.serverDescriptionKey ? `${runtimeInfo.bucket}/${runtimeInfo.serverDescriptionKey}` : '');
          setRuntimeWorldKey(runtimeInfo.worldDescriptionKey ? `${runtimeInfo.bucket}/${runtimeInfo.worldDescriptionKey}` : '');
          setWorldRuntimeInfo((current) => ({
            ...current,
            [`${gameId}:${selectedInstance.selectedWorldId}`]: runtimeInfo,
          }));
          return;
        }
        const configResponse = await getConfig(instanceId(selectedInstance));
        const payload = configResponse.config === undefined ? configResponse : configResponse.config;
        setConfigText(JSON.stringify(payload ?? {}, null, 2));
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to load config';
        notify('error', msg);
      } finally {
        setServerConfigLoading(false);
      }
    };
    load();
  }, [selectedInstance, detailTab]);

  useEffect(() => {
    if (detailTab !== 'config' || serverConfigLoading || !windroseJsonFocus) {
      return;
    }
    const target =
      windroseJsonFocus === 'server'
        ? runtimeServerEditorRef.current
        : runtimeWorldEditorRef.current;
    target?.focus();
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setWindroseJsonFocus(null);
  }, [detailTab, serverConfigLoading, windroseJsonFocus]);

  useEffect(() => {
    if (!selectedInstance || (detailTab !== 'bootstrap-logs' && detailTab !== 'server-logs')) {
      return;
    }
    setLogs([]);
    setLogsClearMarker(null);
    setLogsNextToken(undefined);
    const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
    const load = async () => {
      setLogsLoading(true);
      try {
        const response = await getLogs(selectedLogInstanceId, kind, undefined);
        setLogs(response.lines);
        setLogsNextToken(response.nextToken);
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          setLogsAutoRefresh(false);
          notify('error', 'Session expired. Sign in again to continue loading logs.');
        } else {
          notify('error', error instanceof Error ? error.message : 'Failed to load logs');
        }
      } finally {
        setLogsLoading(false);
      }
    };
    load();
  }, [selectedLogInstanceId, detailTab]);

  useEffect(() => {
    if (!selectedInstance || (detailTab !== 'bootstrap-logs' && detailTab !== 'server-logs') || !logsAutoRefresh || logsLive) {
      return;
    }
    const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
    const timer = window.setInterval(async () => {
      try {
        const response = await getLogs(selectedLogInstanceId, kind, undefined);
        setLogs((previous) => (sameStringArray(previous, response.lines) ? previous : response.lines));
        setLogsNextToken((previous) => (previous === response.nextToken ? previous : response.nextToken));
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          setLogsAutoRefresh(false);
          notify('error', 'Session expired. Sign in again to continue loading logs.');
        } else {
          notify('error', error instanceof Error ? error.message : 'Log auto-refresh failed');
        }
      }
    }, 15000);

    return () => clearInterval(timer);
  }, [selectedLogInstanceId, detailTab, logsAutoRefresh, logsLive]);

  useEffect(() => {
    if (!selectedInstance || (detailTab !== 'bootstrap-logs' && detailTab !== 'server-logs') || !logsLive) {
      stopLogStream();
      return;
    }
    const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
    const controller = new AbortController();
    logStreamRef.current = controller;
    const run = async () => {
      try {
        await streamLogs(selectedLogInstanceId, kind, (line) => {
          setLogs((previous) => [...previous, line].slice(-1200));
        }, controller.signal);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          notify('error', error instanceof Error ? error.message : 'Live stream failed');
          setLogsLive(false);
        }
      }
    };
    run();

    return () => {
      controller.abort();
      logStreamRef.current = null;
    };
  }, [selectedLogInstanceId, detailTab, logsLive]);

  const handleAction = async (instance: ServerInstance, kind: 'start' | 'stop' | 'restart' | 'terminate') => {
    if (isOperationRunning(instance)) {
      return;
    }
    if (kind === 'terminate') {
      const label = instance.serverName || instance.name || instance.instanceId || 'this instance';
      const confirmed = window.confirm(
        `Terminate ${label}?\n\nThis will run the final backup flow and then terminate the EC2 instance.`,
      );
      if (!confirmed) {
        return;
      }
    }
    try {
      const id = instanceId(instance);
      let op: OperationResult;
      if (kind === 'start') {
        op = await startInstance(id);
      } else if (kind === 'stop') {
        op = await stopInstance(id);
      } else if (kind === 'restart') {
        op = await restartInstance(id);
      } else {
        op = await terminateInstance(id);
      }
      notify('info', `${kind.toUpperCase()} started: ${op.operationId}`);
      pollOperation(id, op.operationId);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : `Unable to ${kind} instance`);
    }
  };

  const handleServerAction = async (instance: ServerInstance, kind: 'start' | 'stop' | 'restart') => {
    if (isOperationRunning(instance)) {
      return;
    }
    try {
      const id = instanceId(instance);
      const op =
        kind === 'start'
          ? await startGameServer(id)
          : kind === 'stop'
            ? await stopGameServer(id)
            : await restartGameServer(id);
      notify('info', `${runtimeServerLabel(instance)} server ${kind} submitted: ${op.operationId}`);
      pollOperation(id, op.operationId);
      if (kind !== 'stop') {
        setDetailTab('server-logs');
      }
    } catch (error) {
      notify('error', error instanceof Error ? error.message : `Unable to ${kind} ${runtimeServerLabel(instance)} server`);
    }
  };

  const handleSendServerCommand = async () => {
    if (!selectedInstance) {
      return;
    }
    const command = serverCommand.trim();
    if (!command) {
      notify('error', 'Enter a 7D2D console command first.');
      return;
    }
    try {
      setServerCommandBusy(true);
      const op = await sendGameServerCommand(instanceId(selectedInstance), command);
      notify('info', `Command submitted: ${op.operationId}`);
      pollOperation(instanceId(selectedInstance), op.operationId);
      setServerCommand('');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to send server command');
    } finally {
      setServerCommandBusy(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!selectedInstance) {
      return;
    }
    if (isOperationRunning(selectedInstance)) {
      notify('error', 'Finish running operation before editing config.');
      return;
    }
    try {
      const gameId = instanceGameId(selectedInstance);
      if (gameId && selectedInstance.selectedWorldId && supportsServerConfig(gameId)) {
        setServerConfigSaving(true);
        setConfigError('');
        const saved = await saveWorldServerConfig(gameId, selectedInstance.selectedWorldId, serverConfigXml);
        setServerConfigKey(`${saved.bucket}/${saved.key}`);
        notify('success', 'serverconfig.xml saved. Restart 7D2D to apply it.');
        return;
      }
      if (gameId && selectedInstance.selectedWorldId && supportsRuntimeJsonConfig(gameId)) {
        const serverDescription = JSON.parse(runtimeServerJson);
        const worldDescription = JSON.parse(runtimeWorldJson);
        if (!isObject(serverDescription) || !isObject(worldDescription)) {
          throw new SyntaxError('Windrose config files must be JSON objects');
        }
        setServerConfigSaving(true);
        setConfigError('');
        const runtimeInfo = worldRuntimeInfo[`${gameId}:${selectedInstance.selectedWorldId}`];
        const saved = await saveWorldRuntimeInfo(gameId, selectedInstance.selectedWorldId, {
          serverDescription,
          worldDescription,
          serverDescriptionKey: s3KeyFromDisplayPath(runtimeServerKey, runtimeInfo?.bucket),
          worldDescriptionKey: s3KeyFromDisplayPath(runtimeWorldKey, runtimeInfo?.bucket),
        });
        setRuntimeServerKey(saved.serverDescriptionKey ? `${saved.bucket}/${saved.serverDescriptionKey}` : runtimeServerKey);
        setRuntimeWorldKey(saved.worldDescriptionKey ? `${saved.bucket}/${saved.worldDescriptionKey}` : runtimeWorldKey);
        const refreshed = await getWorldRuntimeInfo(gameId, selectedInstance.selectedWorldId);
        setWorldRuntimeInfo((current) => ({
          ...current,
          [`${gameId}:${selectedInstance.selectedWorldId}`]: refreshed,
        }));
        notify('success', 'Windrose JSON saved. Restart Windrose to apply it.');
        return;
      }
      const parsed = JSON.parse(configText);
      setConfigSaving(true);
      setConfigError('');
      const op = await updateConfig(instanceId(selectedInstance), parsed, configMode);
      notify('success', `Config update submitted: ${op.operationId}`);
      pollOperation(instanceId(selectedInstance), op.operationId);
    } catch (error) {
      if (error instanceof SyntaxError) {
        setConfigError('Invalid JSON format');
        notify('error', 'Invalid JSON format');
      } else {
        notify('error', error instanceof Error ? error.message : 'Failed to save config');
      }
    } finally {
      setConfigSaving(false);
      setServerConfigSaving(false);
    }
  };

  const handleLoadMoreLogs = async () => {
    if (!selectedInstance || !logsNextToken) {
      return;
    }
    setLogsLoading(true);
    try {
      const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
      const response = await getLogs(instanceId(selectedInstance), kind, logsNextToken);
      setLogs((previous) => [...previous, ...response.lines]);
      setLogsNextToken(response.nextToken);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Failed to load additional logs');
    } finally {
      setLogsLoading(false);
    }
  };

  const handleClearLogsView = () => {
    setLogsClearMarker(logs.length > 0 ? logs[logs.length - 1] : null);
  };

  const visibleLogs = logsClearMarker
    ? logs.slice(logs.lastIndexOf(logsClearMarker) >= 0 ? logs.lastIndexOf(logsClearMarker) + 1 : 0)
    : logs;
  const visibleLogText = useMemo(() => visibleLogs.join('\n'), [visibleLogs]);

  const handleOpenAddModal = () => {
    setAddForm({
      gameId:
        selectedGameId && selectedGameId !== 'all'
          ? selectedGameId
          : games.length > 0
            ? games[0].id
            : '',
      region: 'us-east-1',
      config: '{\n  \"maxPlayers\": 64,\n  \"tickRate\": 30\n}',
      selectedProfileId: '',
      selectedWorldId: '',
      worldName: '',
      steamBetaBranch: 'latest_experimental',
    });
    setProfileName('');
    setProfileDescription('');
    setWorldPresetName('');
    setWorldDescription('');
    setWorldSeedText('{\n  "seed": ""\n}');
    setServerConfigXml('');
    setServerConfigKey('');
    setShowAddInstance(true);
  };

  const loadWorldServerConfig = async (gameId: string, worldId: string) => {
    if (!gameId || !worldId || !supportsServerConfig(gameId)) {
      setServerConfigXml('');
      setServerConfigKey('');
      return;
    }
    setServerConfigLoading(true);
    try {
      const config = await getWorldServerConfig(gameId, worldId);
      setServerConfigXml(config.configXml || '');
      setServerConfigKey(`${config.bucket}/${config.key}`);
    } catch (error) {
      setServerConfigXml('');
      setServerConfigKey('');
      notify('error', error instanceof Error ? error.message : 'Unable to load serverconfig.xml');
    } finally {
      setServerConfigLoading(false);
    }
  };

  const handleConfigureWorldLaunch = async (world: WorldPreset) => {
    const gameId = worldGameId(world);
    if (!gameId) {
      notify('error', 'World is missing a game id');
      return;
    }
    setAddForm({
      gameId,
      region: 'us-east-1',
      config: '{\n  \"maxPlayers\": 64,\n  \"tickRate\": 30\n}',
      selectedProfileId: '',
      selectedWorldId: world.worldId,
      worldName: world.name,
      steamBetaBranch: 'latest_experimental',
    });
    setProfileName('');
    setProfileDescription('');
    setWorldPresetName('');
    setWorldDescription('');
    setWorldSeedText('{\n  "seed": ""\n}');
    setServerConfigXml('');
    setServerConfigKey('');
    setShowAddInstance(true);
    await loadPresetsForGame(gameId);
    await loadWorldServerConfig(gameId, world.worldId);
  };

  useEffect(() => {
    if (!showAddInstance || !addForm.gameId) {
      return;
    }
    loadPresetsForGame(addForm.gameId);
  }, [showAddInstance, addForm.gameId]);

  const handleCreateInstance = async () => {
    if (!addForm.gameId) {
      notify('error', 'Select a game');
      return;
    }
    if (creatingInstanceRef.current) {
      return;
    }
    creatingInstanceRef.current = true;
    setInstanceCreating(true);
    try {
      if (addForm.selectedWorldId && supportsServerConfig(addForm.gameId)) {
        setServerConfigSaving(true);
        await saveWorldServerConfig(addForm.gameId, addForm.selectedWorldId, serverConfigXml);
      }
      const configParsed = JSON.parse(addForm.config);
      const created = await createInstance({
        gameId: addForm.gameId,
        region: addForm.region,
        config: configParsed,
        selectedProfileId: addForm.selectedProfileId || undefined,
        selectedWorldId: addForm.selectedWorldId || undefined,
        worldName: addForm.worldName || undefined,
        steamBetaBranch: addForm.steamBetaBranch,
      }, `create-instance:${Date.now()}:${Math.random().toString(36).slice(2)}`);
      setInstances((current) => [created, ...current]);
      setShowAddInstance(false);
      notify('success', `Instance ${instanceId(created)} created`);
      await refreshInstances(selectedGameId === 'all' ? undefined : selectedGameId);
    } catch (error) {
      if (error instanceof SyntaxError) {
        notify('error', 'Invalid JSON in config');
      } else {
        notify('error', error instanceof Error ? error.message : 'Unable to create instance');
      }
    } finally {
      setServerConfigSaving(false);
      setInstanceCreating(false);
      creatingInstanceRef.current = false;
    }
  };

  const handleLaunchWorld = async (world: WorldPreset) => {
    const gameId = worldGameId(world);
    if (!gameId || !world.worldId) {
      notify('error', 'World is missing a game id or world id');
      return;
    }
    const launchKey = `${gameId}:${world.worldId}`;
    if (launchingWorldKeysRef.current.has(launchKey)) {
      return;
    }
    launchingWorldKeysRef.current.add(launchKey);
    setBusyWorldIds((current) => ({ ...current, [launchKey]: 'launching' }));
    try {
      const availableProfiles =
        profiles.some((profile) => profile.gameId === gameId)
          ? profiles.filter((profile) => profile.gameId === gameId)
          : await listProfiles(gameId);
      if (!profiles.some((profile) => profile.gameId === gameId)) {
        setProfiles(availableProfiles);
      }
      const defaultProfile = availableProfiles[0];
      const created = await createInstance({
        gameId,
        region: 'us-east-1',
        config: {},
        selectedProfileId: defaultProfile?.profileId,
        selectedWorldId: world.worldId,
        worldName: world.name,
        steamBetaBranch: 'latest_experimental',
      }, `launch-world:${launchKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`);
      setInstances((current) => [created, ...current]);
      setSelectedInstance(created);
      setDetailTab('bootstrap-logs');
      notify('success', `Launching ${world.name}`);
      await refreshInstances(selectedGameId === 'all' ? undefined : selectedGameId);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to launch world');
    } finally {
      launchingWorldKeysRef.current.delete(launchKey);
      setBusyWorldIds((current) => {
        const next = { ...current };
        delete next[launchKey];
        return next;
      });
    }
  };

  const handleSaveProfile = async () => {
    if (!addForm.gameId) {
      notify('error', 'Select a game first');
      return;
    }
    if (!profileName.trim()) {
      notify('error', 'Profile name is required');
      return;
    }
    try {
      const parsedConfig = JSON.parse(addForm.config);
      const profile = await createProfile(addForm.gameId, {
        name: profileName.trim(),
        description: profileDescription.trim() || undefined,
        config: parsedConfig,
      });
      setProfiles((current) => [profile, ...current]);
      setAddForm((current) => ({ ...current, selectedProfileId: profile.profileId }));
      setProfileName('');
      setProfileDescription('');
      notify('success', `Profile ${profile.name} saved`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        notify('error', 'Invalid JSON in config');
        return;
      }
      notify('error', error instanceof Error ? error.message : 'Unable to save profile');
    }
  };

  const handleSaveWorld = async () => {
    if (!addForm.gameId) {
      notify('error', 'Select a game first');
      return;
    }
    if (!worldName.trim()) {
      notify('error', 'World name is required');
      return;
    }
    try {
      const worldSeed = JSON.parse(worldSeedText);
      const world = await createWorld(addForm.gameId, {
        name: worldName.trim(),
        description: worldDescription.trim() || undefined,
        worldSeed: isObject(worldSeed) ? worldSeed : { seed: worldSeed },
      });
      setWorlds((current) => [world, ...current]);
      setAddForm((current) => ({ ...current, selectedWorldId: world.worldId }));
      setWorldPresetName('');
      setWorldDescription('');
      setWorldSeedText('{\n  "seed": ""\n}');
      notify('success', `World preset ${world.name} saved`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        notify('error', 'Invalid JSON in world seed');
        return;
      }
      notify('error', error instanceof Error ? error.message : 'Unable to save world');
    }
  };

  const setWorldBusy = (world: WorldPreset, value?: 'copying' | 'deleting' | 'launching') => {
    const key = worldKey(world);
    setBusyWorldIds((current) => {
      const next = { ...current };
      if (value) {
        next[key] = value;
      } else {
        delete next[key];
      }
      return next;
    });
  };

  const worldBusyState = (world: WorldPreset): 'copying' | 'deleting' | 'launching' | undefined => {
    return busyWorldIds[worldKey(world)];
  };

  const handleCopyWorld = async (world: WorldPreset) => {
    const gameId = worldGameId(world);
    if (!gameId || !world.worldId) {
      notify('error', 'World is missing a game id or world id');
      return;
    }
    const name = window.prompt('Name for the copied world', `Copy of ${world.name}`);
    if (name === null) {
      return;
    }
    if (!name.trim()) {
      notify('error', 'World name is required');
      return;
    }

    setWorldBusy(world, 'copying');
    try {
      const copied = await copyWorld(gameId, world.worldId, { name: name.trim() });
      setWorlds((current) => [copied, ...current]);
      notify('success', `Copied ${world.name}`);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to copy world');
    } finally {
      setWorldBusy(world);
    }
  };

  const handleDeleteWorld = async (world: WorldPreset, active: boolean) => {
    const gameId = worldGameId(world);
    if (!gameId || !world.worldId) {
      notify('error', 'World is missing a game id or world id');
      return;
    }
    if (active) {
      notify('error', 'Stop the running server before deleting this world');
      return;
    }
    const confirmed = window.confirm(
      `Delete ${world.name}? This removes the saved world record and S3 save data for this world.`,
    );
    if (!confirmed) {
      return;
    }

    setWorldBusy(world, 'deleting');
    try {
      await deleteWorld(gameId, world.worldId);
      setWorlds((current) => current.filter((item) => item.worldId !== world.worldId || worldGameId(item) !== gameId));
      setAddForm((current) =>
        current.gameId === gameId && current.selectedWorldId === world.worldId
          ? { ...current, selectedWorldId: '', worldName: '' }
          : current,
      );
      notify('success', `Deleted ${world.name}`);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to delete world');
    } finally {
      setWorldBusy(world);
    }
  };

  const handleCopyInviteCode = async (inviteCode: string) => {
    try {
      await navigator.clipboard.writeText(inviteCode);
      notify('success', 'Invite code copied');
    } catch {
      notify('error', 'Unable to copy invite code');
    }
  };

  const handleCopyIpAddress = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      notify('success', `IP address ${ip} copied`);
    } catch {
      notify('error', 'Unable to copy IP address');
    }
  };

  const handleEditWindroseRuntimeJson = (
    world: WorldPreset,
    section: WindroseJsonFocus,
    runtime?: WorldRuntimeState,
  ) => {
    const gameId = worldGameId(world);
    if (!gameId || !world.worldId) {
      notify('error', 'World is missing a game id or world id');
      return;
    }
    const editorInstance =
      runtime?.instance ?? ({
        id: `world-config:${gameId}:${world.worldId}`,
        gameId,
        selectedWorldId: world.worldId,
        worldName: world.name,
        status: 'offline',
      } as ServerInstance);
    setSelectedInstance(editorInstance);
    setDetailTab('config');
    setWindroseJsonFocus(section);
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setUser(null);
      setInstances([]);
      setSelectedInstance(null);
      setLogs([]);
      setOperations({});
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Sign out failed');
    }
  };

  const visibleInstances = instances.filter((instance) => {
    const status = normalizeStatus(instance.status);
    if (!showTerminatedInstances && (status === 'terminated' || status === 'shutting-down')) {
      return false;
    }
    if (selectedGameId === '' || selectedGameId === 'all') {
      return true;
    }
    const game = instance.game || '';
    const gameId = instance.gameId || '';
    return game === selectedGameId || gameId === selectedGameId;
  });

  const gameName = (instance: ServerInstance): string => {
    const found = games.find((game) => game.id === (instance.game || instance.gameId));
    return found?.name || instance.game || instance.gameId || '—';
  };

  const worldRuntimeState = (world: WorldPreset): WorldRuntimeState => {
    const timeValue = (instance: ServerInstance): number => {
      const raw =
        typeof instance.updatedAt === 'string'
          ? instance.updatedAt
          : instance.startedAt || (typeof instance.createdAt === 'string' ? instance.createdAt : undefined);
      return raw ? new Date(raw).getTime() : 0;
    };
    const candidates = instances
      .filter((instance) => instance.selectedWorldId === world.worldId)
      .sort((a, b) => timeValue(b) - timeValue(a));
    const active = candidates.find((instance) => {
      const status = normalizeStatus(instance.status);
      return status !== 'terminated' && status !== 'shutting-down' && status !== 'stopped';
    });
    const latest = active || candidates[0];
    return {
      instance: latest,
      status: active ? normalizeStatus(active.status) : 'offline',
      publicIp: active?.publicIp,
      lastBackupAt:
        typeof latest?.lastBackupAt === 'string'
          ? latest.lastBackupAt
          : undefined,
    };
  };

  const visibleWorlds = selectedGameId && selectedGameId !== 'all'
    ? worlds.filter((world) => worldGameId(world) === selectedGameId)
    : [];

  if (bootstrapping) {
    return (
      <div className="landing">
        <div className="loading-card">Initializing session…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="landing">
        <section className="auth-card">
          <h1>Game Fleet Console</h1>
          <p>Connect with AWS Cognito to manage instances, logs, and runtime configuration.</p>
          <button
            className="btn btn-primary"
            type="button"
            onClick={async () => {
              try {
                await signIn();
              } catch (error) {
                notify('error', error instanceof Error ? error.message : 'Sign in failed');
              }
            }}
          >
            Sign in with Cognito
          </button>
          <small>Click sign in to authenticate through AWS Cognito.</small>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>Game Fleet Console</h1>
          <p>{user.displayName || user.username}</p>
        </div>
        <div className="user-info">
          <span>{user.email}</span>
          <button type="button" className="btn btn-danger" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className={`dashboard-grid ${showSavedWorlds ? '' : 'saved-worlds-collapsed'}`}>
        <aside className={`panel saved-worlds-panel ${showSavedWorlds ? '' : 'panel-collapsed'}`}>
          {showSavedWorlds ? (
            <>
              <div className="panel-head">
                <h2>Saved worlds</h2>
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn-small"
                    aria-expanded={showSavedWorlds}
                    onClick={() => setShowSavedWorlds(false)}
                  >
                    Collapse saved worlds
                  </button>
                  <label htmlFor="game-filter" className="sr-only">
                    Game filter
                  </label>
                  <select
                    id="game-filter"
                    value={selectedGameId}
                    onChange={(event) => setSelectedGameId(event.target.value)}
                    className="select"
                  >
                    <option value="all">All games</option>
                    {games.map((game) => (
                      <option key={game.id} value={game.id}>
                        {game.name}
                      </option>
                    ))}
                  </select>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={showTerminatedInstances}
                      onChange={(event) => setShowTerminatedInstances(event.target.checked)}
                    />
                    Show terminated
                  </label>
                  <button type="button" className="btn btn-success" onClick={handleOpenAddModal}>
                    Add instance
                  </button>
                </div>
              </div>

              {selectedGameId === 'all' || !selectedGameId ? (
                <div className="empty">Choose a game to see saved worlds from its S3 save paths.</div>
              ) : visibleWorlds.length === 0 ? (
                <div className="empty">No saved worlds found for this game. Create a world preset to launch from S3.</div>
              ) : (
                <div className="world-grid">
                  {visibleWorlds.map((world) => {
                    const runtime = worldRuntimeState(world);
                    const active = runtime.status !== 'offline';
                    const status = runtime.instance ? playerStatuses[instanceId(runtime.instance)] : undefined;
                    const launchProgress = runtime.instance ? launchProgressFor(runtime.instance) : undefined;
                    const busy = worldBusyState(world);
                    const runtimeInfo = worldRuntimeInfo[worldKey(world)];
                    const inviteCode = runtimeInfo?.inviteCode;
                    const monitorUrl =
                      worldGameId(world).toLowerCase() === 'windrose'
                        ? windroseMonitorUrl(runtime.publicIp)
                        : undefined;
                    return (
                      <article className="world-card" key={world.worldId}>
                        <div className="world-card-head">
                          <div>
                            <h3>{world.name}</h3>
                            <p>{world.description || 'Saved world'}</p>
                          </div>
                          <span className={statusClassName(runtime.status)}>{runtime.status}</span>
                        </div>
                        {launchProgress && <LaunchProgressView progress={launchProgress} />}
                        <div className="world-meta">
                          <span>Bucket</span>
                          <strong>{worldBucket(world, profiles)}</strong>
                          <span>S3 path</span>
                          <strong>{worldS3Prefix(world)}/state</strong>
                          <span>Last backup</span>
                          <strong>{prettyDate(runtime.lastBackupAt)}</strong>
                          <span>Public IP</span>
                          <CopyableIp ip={runtime.publicIp} onCopy={handleCopyIpAddress} />
                          <span>Players</span>
                          <strong>{playerSummary(status)}</strong>
                          <span>Version</span>
                          <strong>{status?.serverVersion || '—'}</strong>
                          <span>Player check</span>
                          <strong>{prettyDate(status?.lastUpdatedAt)}</strong>
                          {worldGameId(world).toLowerCase() === 'windrose' && (
                            <>
                              <span>Invite code</span>
                              <strong>{inviteCode || 'Available after first backup'}</strong>
                              <span>Server name</span>
                              <strong>{runtimeInfo?.serverName || '—'}</strong>
                              <span>Max players</span>
                              <strong>{runtimeInfo?.maxPlayerCount ?? '—'}</strong>
                              <span>World island</span>
                              <strong>{runtimeInfo?.worldIslandId || '—'}</strong>
                              <span>Difficulty</span>
                              <strong>{runtimeInfo?.combatDifficulty || '—'}</strong>
                              <span>Server JSON</span>
                              <strong className="json-key-action">
                                <span>{runtimeInfo?.serverDescriptionKey || 'Not backed up yet'}</span>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => handleEditWindroseRuntimeJson(world, 'server', runtime)}
                                >
                                  Edit
                                </button>
                              </strong>
                              <span>World JSON</span>
                              <strong className="json-key-action">
                                <span>{runtimeInfo?.worldDescriptionKey || 'Not backed up yet'}</span>
                                <button
                                  type="button"
                                  className="link-button"
                                  onClick={() => handleEditWindroseRuntimeJson(world, 'world', runtime)}
                                >
                                  Edit
                                </button>
                              </strong>
                            </>
                          )}
                        </div>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-success"
                            disabled={active || busy === 'launching'}
                            onClick={() => handleConfigureWorldLaunch(world)}
                          >
                            {busy === 'launching' ? 'Launching...' : 'Configure & launch'}
                          </button>
                          {runtime.instance && (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                setSelectedInstance(runtime.instance || null);
                                setDetailTab(active ? 'server-logs' : 'overview');
                              }}
                            >
                              {active ? 'View running server' : 'View last launch'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={Boolean(busy)}
                            onClick={() => handleCopyWorld(world)}
                          >
                            {busy === 'copying' ? 'Copying...' : 'Copy'}
                          </button>
                          {inviteCode && (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => handleCopyInviteCode(inviteCode)}
                            >
                              Copy invite
                            </button>
                          )}
                          {monitorUrl && (
                            <a
                              className="btn btn-small"
                              href={monitorUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Monitor
                            </a>
                          )}
                          <button
                            type="button"
                            className="btn btn-small btn-danger"
                            disabled={active || Boolean(busy)}
                            onClick={() => handleDeleteWorld(world, active)}
                          >
                            {busy === 'deleting' ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <button
              type="button"
              className="collapsed-panel-toggle"
              aria-expanded={showSavedWorlds}
              onClick={() => setShowSavedWorlds(true)}
            >
              Show saved worlds
              <span>
                {selectedGameId === 'all' || !selectedGameId
                  ? 'hidden'
                  : `${visibleWorlds.length} world${visibleWorlds.length === 1 ? '' : 's'}`}
              </span>
            </button>
          )}

        </aside>

        <div className="main-workspace">
          <section className="panel">
          <div className="table-wrap">
            {instancesLoading ? (
              <div className="empty">Loading instances…</div>
            ) : visibleInstances.length === 0 ? (
              <div className="empty">No instances found.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Game</th>
                    <th>Instance ID</th>
                    <th>Instance type</th>
                    <th>World</th>
                    <th>Status</th>
                    <th>Region</th>
                    <th>Public IP</th>
                    <th>Started At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleInstances.map((instance) => {
                    const id = instanceId(instance);
                    const disabled = isOperationRunning(instance);
                    const launchProgress = launchProgressFor(instance);
                    return (
                      <tr key={id}>
                        <td>{gameName(instance)}</td>
                        <td>{id}</td>
                        <td>{instanceType(instance)}</td>
                        <td>{instance.worldName || instance.selectedWorldId || '—'}</td>
                        <td>
                          <span className={statusClassName(instance.status)}>{normalizeStatus(instance.status)}</span>
                          {launchProgress && <LaunchProgressView progress={launchProgress} compact />}
                        </td>
                        <td>{instance.region || '—'}</td>
                        <td><CopyableIp ip={instance.publicIp} onCopy={handleCopyIpAddress} /></td>
                        <td>{prettyDate(instance.startedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                setSelectedInstance(instance);
                                setDetailTab('overview');
                              }}
                            >
                              Overview
                            </button>
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                setSelectedInstance(instance);
                                setDetailTab('bootstrap-logs');
                              }}
                            >
                              Logs
                            </button>
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                setSelectedInstance(instance);
                                setDetailTab('config');
                              }}
                            >
                              Config
                            </button>
                            <button className="btn btn-small" disabled={disabled} onClick={() => handleAction(instance, 'start')}>
                              Launch
                            </button>
                            <button
                              className="btn btn-small"
                              disabled={disabled}
                              onClick={() => handleAction(instance, 'stop')}
                            >
                              Shutdown
                            </button>
                            <button
                              className="btn btn-small"
                              disabled={disabled}
                              onClick={() => handleAction(instance, 'restart')}
                            >
                              Restart
                            </button>
                            <button
                              className="btn btn-small btn-danger"
                              disabled={disabled}
                              onClick={() => handleAction(instance, 'terminate')}
                            >
                              Terminate
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Instance detail</h2>
            {selectedInstance && (
              <div className="toolbar">
                <span>{selectedInstance.game || selectedInstance.gameId}</span>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setSelectedInstance(null)}
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {!selectedInstance ? (
            <div className="empty">
              Select an instance in the table. Actions are available there and status updates appear here.
            </div>
          ) : (
            <>
              <div className="tabs" role="tablist">
                <button
                  type="button"
                  className={`tab-btn ${detailTab === 'overview' ? 'active' : ''}`}
                  onClick={() => setDetailTab('overview')}
                >
                  Overview
                </button>
                <button
                  type="button"
                  className={`tab-btn ${detailTab === 'bootstrap-logs' ? 'active' : ''}`}
                  onClick={() => setDetailTab('bootstrap-logs')}
                >
                  Bootstrap Logs
                </button>
                <button
                  type="button"
                  className={`tab-btn ${detailTab === 'server-logs' ? 'active' : ''}`}
                  onClick={() => setDetailTab('server-logs')}
                >
                  Server Logs
                </button>
                <button
                  type="button"
                  className={`tab-btn ${detailTab === 'console' ? 'active' : ''}`}
                  onClick={() => setDetailTab('console')}
                >
                  Console
                </button>
                <button
                  type="button"
                  className={`tab-btn ${detailTab === 'config' ? 'active' : ''}`}
                  onClick={() => setDetailTab('config')}
                >
                  Config
                </button>
              </div>
              <div className="tab-content">
                {detailTab === 'overview' && (
                  <article className="overview">
                    <div className="kv">
                      <span>Instance</span>
                      <strong>{instanceId(selectedInstance)}</strong>
                    </div>
                    <div className="kv">
                      <span>Region</span>
                      <strong>{selectedInstance.region || '—'}</strong>
                    </div>
                    <div className="kv">
                      <span>Public IP</span>
                      <CopyableIp ip={selectedInstance.publicIp} onCopy={handleCopyIpAddress} />
                    </div>
                    <div className="kv">
                      <span>Started</span>
                      <strong>{prettyDate(selectedInstance.startedAt)}</strong>
                    </div>
                    <div className="kv">
                      <span>Status</span>
                      <span className={statusClassName(selectedInstance.status)}>{normalizeStatus(selectedInstance.status)}</span>
                    </div>
                    <div className="kv">
                      <span>Players</span>
                      <strong>{playerSummary(playerStatuses[instanceId(selectedInstance)])}</strong>
                    </div>
                    <div className="kv">
                      <span>Version</span>
                      <strong>{playerStatuses[instanceId(selectedInstance)]?.serverVersion || '—'}</strong>
                    </div>
                    <div className="kv">
                      <span>Player check</span>
                      <strong>{prettyDate(playerStatuses[instanceId(selectedInstance)]?.lastUpdatedAt)}</strong>
                    </div>
                    <div className="kv">
                      <span>Instance type</span>
                      <strong>{instanceType(selectedInstance)}</strong>
                    </div>
                    <div className="kv">
                      <span>Selected world</span>
                      <strong>{selectedInstance.worldName || selectedInstance.selectedWorldId || '—'}</strong>
                    </div>
                    {launchProgressFor(selectedInstance) && (
                      <div className="overview-wide">
                        <LaunchProgressView progress={launchProgressFor(selectedInstance)!} />
                      </div>
                    )}
                    <div className="row-actions actions">
                      {supportsRuntimeJsonConfig(instanceGameId(selectedInstance)) && windroseMonitorUrl(selectedInstance.publicIp) && (
                        <a
                          className="btn btn-small"
                          href={windroseMonitorUrl(selectedInstance.publicIp)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Monitor
                        </a>
                      )}
                      <button
                        className="btn btn-small btn-success"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleServerAction(selectedInstance, 'start')}
                      >
                        Start {runtimeServerLabel(selectedInstance)}
                      </button>
                      <button
                        className="btn btn-small"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleServerAction(selectedInstance, 'stop')}
                      >
                        Stop {runtimeServerLabel(selectedInstance)}
                      </button>
                      <button
                        className="btn btn-small"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleServerAction(selectedInstance, 'restart')}
                      >
                        Restart {runtimeServerLabel(selectedInstance)}
                      </button>
                    </div>
                    <div className="row-actions actions">
                      <button
                        className="btn btn-small"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleAction(selectedInstance, 'start')}
                      >
                        Launch
                      </button>
                      <button
                        className="btn btn-small"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleAction(selectedInstance, 'stop')}
                      >
                        Shutdown
                      </button>
                      <button
                        className="btn btn-small"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleAction(selectedInstance, 'restart')}
                      >
                        Restart
                      </button>
                      <button
                        className="btn btn-small btn-danger"
                        disabled={isOperationRunning(selectedInstance)}
                        onClick={() => handleAction(selectedInstance, 'terminate')}
                      >
                        Terminate
                      </button>
                    </div>
                  </article>
                )}

                {(detailTab === 'bootstrap-logs' || detailTab === 'server-logs') && (
                  <div className="log-panel">
                    <div className="log-toolbar">
                      <label>
                        <input
                          type="checkbox"
                          checked={logsAutoRefresh}
                          onChange={(event) => setLogsAutoRefresh(event.target.checked)}
                        />
                        Auto-refresh
                      </label>
                      <label>
                        <input type="checkbox" checked={logsLive} onChange={(event) => setLogsLive(event.target.checked)} />
                        Live stream
                      </label>
                      {logsNextToken && (
                        <button type="button" className="btn btn-small" onClick={handleLoadMoreLogs} disabled={logsLoading}>
                          Load older
                        </button>
                      )}
                      <button type="button" className="btn btn-small" onClick={handleClearLogsView} disabled={logs.length === 0}>
                        Clear view
                      </button>
                      {logsLoading && logs.length > 0 && <span className="log-filter-note">Refreshing…</span>}
                      {logsClearMarker && <span className="log-filter-note">Showing new lines only</span>}
                    </div>
                    <pre className="log-output">{visibleLogText || (logsLoading ? 'Loading logs…' : 'No log lines.')}</pre>
                  </div>
                )}

                {detailTab === 'console' && (
                  <div className="console-panel">
                    <p className="field-hint">
                      Sends a command to the running 7D2D telnet console on the instance. Examples: status, listplayers, saveworld, say Server restart in 5 minutes.
                    </p>
                    <div className="console-command-row">
                      <input
                        type="text"
                        value={serverCommand}
                        onChange={(event) => setServerCommand(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleSendServerCommand();
                          }
                        }}
                        placeholder="7D2D console command"
                      />
                      <button
                        type="button"
                        className="btn btn-success"
                        disabled={serverCommandBusy || !serverCommand.trim()}
                        onClick={handleSendServerCommand}
                      >
                        Send
                      </button>
                    </div>
                    <div className="row-actions actions">
                      <button className="btn btn-small" onClick={() => setServerCommand('status')}>status</button>
                      <button className="btn btn-small" onClick={() => setServerCommand('listplayers')}>listplayers</button>
                      <button className="btn btn-small" onClick={() => setServerCommand('saveworld')}>saveworld</button>
                    </div>
                    <p className="field-hint">
                      Command output is recorded in the operation result. Server-side effects also appear in Server Logs.
                    </p>
                    {operations[instanceId(selectedInstance)]?.payload?.output && (
                      <pre className="log-output">
                        {operations[instanceId(selectedInstance)]?.payload?.output}
                      </pre>
                    )}
                    {operations[instanceId(selectedInstance)]?.error && (
                      <div className="error">{operations[instanceId(selectedInstance)]?.error}</div>
                    )}
                  </div>
                )}

                {detailTab === 'config' && (
                  <div className="config-panel">
                    {instanceGameId(selectedInstance) && selectedInstance.selectedWorldId && supportsServerConfig(instanceGameId(selectedInstance)) ? (
                      <>
                        <p className="field-hint">
                          Editing S3 serverconfig.xml for world {selectedInstance.worldName || selectedInstance.selectedWorldId}.
                          Restart 7D2D after saving to apply changes.
                        </p>
                        {serverConfigKey && <small className="field-hint">S3: {serverConfigKey}</small>}
                        <textarea
                          value={serverConfigLoading ? 'Loading serverconfig.xml…' : serverConfigXml}
                          onChange={(event) => setServerConfigXml(event.target.value)}
                          className="xml-editor"
                          disabled={serverConfigLoading}
                          spellCheck={false}
                        />
                      </>
                    ) : instanceGameId(selectedInstance) && selectedInstance.selectedWorldId && supportsRuntimeJsonConfig(instanceGameId(selectedInstance)) ? (
                      <>
                        <p className="field-hint">
                          Editing Windrose JSON files for world {selectedInstance.worldName || selectedInstance.selectedWorldId}.
                          Restart Windrose after saving to apply changes.
                        </p>
                        <label>
                          ServerDescription.json
                          {runtimeServerKey && <small className="field-hint">S3: {runtimeServerKey}</small>}
                          <textarea
                            ref={runtimeServerEditorRef}
                            value={serverConfigLoading ? 'Loading ServerDescription.json…' : runtimeServerJson}
                            onChange={(event) => setRuntimeServerJson(event.target.value)}
                            className="json-editor"
                            disabled={serverConfigLoading}
                            spellCheck={false}
                          />
                        </label>
                        <label>
                          WorldDescription.json
                          {runtimeWorldKey && <small className="field-hint">S3: {runtimeWorldKey}</small>}
                          <textarea
                            ref={runtimeWorldEditorRef}
                            value={serverConfigLoading ? 'Loading WorldDescription.json…' : runtimeWorldJson}
                            onChange={(event) => setRuntimeWorldJson(event.target.value)}
                            className="json-editor"
                            disabled={serverConfigLoading}
                            spellCheck={false}
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <textarea
                          value={configText}
                          onChange={(event) => setConfigText(event.target.value)}
                          className="json-editor"
                          spellCheck={false}
                        />
                        <label>
                          Save mode:
                          <select value={configMode} onChange={(event) => setConfigMode(event.target.value as 'apply' | 'applyAndRestart')}>
                            <option value="apply">apply</option>
                            <option value="applyAndRestart">applyAndRestart</option>
                          </select>
                        </label>
                      </>
                    )}
                    <div className="row-actions">
                      {configError && <div className="error">{configError}</div>}
                      <button
                        className="btn btn-success"
                        disabled={configSaving || serverConfigSaving || serverConfigLoading}
                        onClick={handleSaveConfig}
                      >
                        {instanceGameId(selectedInstance) && selectedInstance.selectedWorldId && supportsServerConfig(instanceGameId(selectedInstance))
                          ? 'Save serverconfig.xml'
                          : instanceGameId(selectedInstance) && selectedInstance.selectedWorldId && supportsRuntimeJsonConfig(instanceGameId(selectedInstance))
                            ? 'Save Windrose JSON'
                            : 'Save config'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
        </div>
      </main>

      {showAddInstance && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Configure launch</h3>
            <label>
              Game
              <select
                value={addForm.gameId}
                onChange={(event) =>
                  setAddForm((previous) => ({
                    ...previous,
                    gameId: event.target.value,
                    selectedProfileId: '',
                    selectedWorldId: '',
                    worldName: '',
                    steamBetaBranch: previous.steamBetaBranch || 'latest_experimental',
                  }))
                }
              >
                <option value="">Select</option>
                {games.map((game) => (
                  <option key={game.id} value={game.id}>
                    {game.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Game branch
              <select
                value={addForm.steamBetaBranch}
                onChange={(event) =>
                  setAddForm((previous) => ({
                    ...previous,
                    steamBetaBranch: event.target.value,
                  }))
                }
              >
                <option value="latest_experimental">Experimental/latest</option>
                <option value="public">Public/stable</option>
              </select>
            </label>
            <label>
              Region
              <input
                value={addForm.region}
                onChange={(event) => setAddForm((previous) => ({ ...previous, region: event.target.value }))}
              />
            </label>
            <label>
              Profile
              <select
                value={addForm.selectedProfileId}
                onChange={(event) =>
                  setAddForm((previous) => ({
                    ...previous,
                    selectedProfileId: event.target.value,
                  }))
                }
              >
                <option value="">Boot with default config</option>
                {profiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              World
              <select
                value={addForm.selectedWorldId}
                onChange={(event) => {
                  const selectedWorldId = event.target.value;
                  const selectedWorld = worlds.find((world) => world.worldId === selectedWorldId);
                  setAddForm((previous) => ({
                    ...previous,
                    selectedWorldId,
                    worldName: selectedWorld?.name ?? previous.worldName,
                  }));
                  void loadWorldServerConfig(addForm.gameId, selectedWorldId);
                }}
              >
                <option value="">No world preset</option>
                {worlds.map((world) => (
                  <option key={world.worldId} value={world.worldId}>
                    {world.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              World name
              <input
                value={addForm.worldName}
                onChange={(event) =>
                  setAddForm((previous) => ({ ...previous, worldName: event.target.value }))
                }
                placeholder="Optional world identifier"
              />
            </label>
            <div className="modal-actions">
              <label>
                Save profile name
                <input
                  value={profileName}
                  onChange={(event) => setProfileName(event.target.value)}
                  placeholder="Profile name"
                />
              </label>
              <label>
                Save profile description
                <input
                  value={profileDescription}
                  onChange={(event) => setProfileDescription(event.target.value)}
                  placeholder="Description"
                />
              </label>
              <button type="button" className="btn btn-small" onClick={handleSaveProfile}>
                Save current config as profile
              </button>
            </div>
            <label>
              World seed JSON
              <textarea
                rows={6}
                value={worldSeedText}
                onChange={(event) => setWorldSeedText(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <label>
                World name
                <input
                  value={worldName}
                  onChange={(event) => setWorldPresetName(event.target.value)}
                  placeholder="World name"
                />
              </label>
              <label>
                World description
                <input
                  value={worldDescription}
                  onChange={(event) => setWorldDescription(event.target.value)}
                  placeholder="Description"
                />
              </label>
              <button type="button" className="btn btn-small" onClick={handleSaveWorld}>
                Save as world
              </button>
            </div>
            {supportsServerConfig(addForm.gameId) && (
              <label>
                serverconfig.xml
                {serverConfigKey && <small className="field-hint">S3: {serverConfigKey}</small>}
                <textarea
                  rows={18}
                  value={serverConfigLoading ? 'Loading serverconfig.xml…' : serverConfigXml}
                  onChange={(event) => setServerConfigXml(event.target.value)}
                  disabled={serverConfigLoading}
                  spellCheck={false}
                  className="xml-editor"
                />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-small" onClick={() => setShowAddInstance(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-success"
                onClick={handleCreateInstance}
                disabled={serverConfigLoading || serverConfigSaving || instanceCreating}
              >
                {serverConfigSaving
                  ? 'Saving config...'
                  : instanceCreating
                    ? 'Launching...'
                    : supportsServerConfig(addForm.gameId) ? 'Save config & launch' : 'Launch'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}
