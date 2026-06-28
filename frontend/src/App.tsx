import React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  getCurrentUserProfile,
  initializeAuth,
  signIn,
  signOut,
} from './auth';
import {
  createInstance,
  createProfile,
  createWorld,
  getConfig,
  getInstance,
  getLogs,
  getOperation,
  getPlayerStatus,
  getWorldServerConfig,
  listProfiles,
  listWorlds,
  listGames,
  listInstances,
  restartInstance,
  startInstance,
  stopInstance,
  streamLogs,
  saveWorldServerConfig,
  terminateInstance,
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
} from './types';

type DetailTab = 'overview' | 'bootstrap-logs' | 'server-logs' | 'config';

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
  return typeof profileBucket === 'string' ? profileBucket : '7d2d-state-prod';
}

function playerSummary(status?: PlayerStatus): string {
  if (!status) {
    return '—';
  }
  return `${status.playerCount}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGameId, setSelectedGameId] = useState('');
  const [instances, setInstances] = useState<ServerInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [showTerminatedInstances, setShowTerminatedInstances] = useState(false);
  const [selectedInstance, setSelectedInstance] = useState<ServerInstance | null>(null);

  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [operations, setOperations] = useState<Record<string, OperationResult>>({});
  const [playerStatuses, setPlayerStatuses] = useState<Record<string, PlayerStatus>>({});

  const [configText, setConfigText] = useState('{}');
  const [configMode, setConfigMode] = useState<'apply' | 'applyAndRestart'>('apply');
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState('');

  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const [logsLive, setLogsLive] = useState(false);
  const [logsNextToken, setLogsNextToken] = useState<string | undefined>(undefined);

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
  const [serverConfigXml, setServerConfigXml] = useState('');
  const [serverConfigKey, setServerConfigKey] = useState('');
  const [serverConfigLoading, setServerConfigLoading] = useState(false);
  const [serverConfigSaving, setServerConfigSaving] = useState(false);

  const pollRef = useRef<Record<string, number>>({});
  const logStreamRef = useRef<AbortController | null>(null);

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
          setSelectedInstance(next);
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
            setSelectedInstance(latest);
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
    if (!selectedInstance || detailTab !== 'config') {
      return;
    }
    const load = async () => {
      setConfigError('');
      try {
        const configResponse = await getConfig(instanceId(selectedInstance));
        const payload = configResponse.config === undefined ? configResponse : configResponse.config;
        setConfigText(JSON.stringify(payload ?? {}, null, 2));
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to load config';
        notify('error', msg);
      }
    };
    load();
  }, [selectedInstance, detailTab]);

  useEffect(() => {
    if (!selectedInstance || (detailTab !== 'bootstrap-logs' && detailTab !== 'server-logs')) {
      return;
    }
    setLogs([]);
    setLogsNextToken(undefined);
    const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
    const load = async () => {
      setLogsLoading(true);
      try {
        const response = await getLogs(instanceId(selectedInstance), kind, undefined);
        setLogs(response.lines);
        setLogsNextToken(response.nextToken);
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Failed to load logs');
      } finally {
        setLogsLoading(false);
      }
    };
    load();
  }, [selectedInstance, detailTab]);

  useEffect(() => {
    if (!selectedInstance || (detailTab !== 'bootstrap-logs' && detailTab !== 'server-logs') || !logsAutoRefresh || logsLive) {
      return;
    }
    const kind: LogType = detailTab === 'bootstrap-logs' ? 'bootstrap' : 'server';
    const timer = window.setInterval(async () => {
      try {
        const response = await getLogs(instanceId(selectedInstance), kind, undefined);
        setLogs(response.lines);
        setLogsNextToken(response.nextToken);
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Log auto-refresh failed');
      }
    }, 6000);

    return () => clearInterval(timer);
  }, [selectedInstance, detailTab, logsAutoRefresh, logsLive]);

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
        await streamLogs(instanceId(selectedInstance), kind, (line) => {
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
  }, [selectedInstance, detailTab, logsLive]);

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

  const handleSaveConfig = async () => {
    if (!selectedInstance) {
      return;
    }
    if (isOperationRunning(selectedInstance)) {
      notify('error', 'Finish running operation before editing config.');
      return;
    }
    try {
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
    if (!gameId || !worldId) {
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
    try {
      if (addForm.selectedWorldId) {
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
      });
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
    }
  };

  const handleLaunchWorld = async (world: WorldPreset) => {
    const gameId = worldGameId(world);
    if (!gameId || !world.worldId) {
      notify('error', 'World is missing a game id or world id');
      return;
    }
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
      });
      setInstances((current) => [created, ...current]);
      setSelectedInstance(created);
      setDetailTab('bootstrap-logs');
      notify('success', `Launching ${world.name}`);
      await refreshInstances(selectedGameId === 'all' ? undefined : selectedGameId);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : 'Unable to launch world');
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

      <main className="dashboard-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Saved worlds</h2>
            <div className="toolbar">
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
                return (
                  <article className="world-card" key={world.worldId}>
                    <div className="world-card-head">
                      <div>
                        <h3>{world.name}</h3>
                        <p>{world.description || 'Saved world'}</p>
                      </div>
                      <span className={statusClassName(runtime.status)}>{runtime.status}</span>
                    </div>
                    <div className="world-meta">
                      <span>Bucket</span>
                      <strong>{worldBucket(world, profiles)}</strong>
                      <span>S3 path</span>
                      <strong>{worldS3Prefix(world)}/state</strong>
                      <span>Last backup</span>
                      <strong>{prettyDate(runtime.lastBackupAt)}</strong>
                      <span>Public IP</span>
                      <strong>{runtime.publicIp || '—'}</strong>
                      <span>Players</span>
                      <strong>{playerSummary(status)}</strong>
                      <span>Player check</span>
                      <strong>{prettyDate(status?.lastUpdatedAt)}</strong>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn btn-success"
                        disabled={active}
                        onClick={() => handleConfigureWorldLaunch(world)}
                      >
                        Configure & launch
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
                    </div>
                  </article>
                );
              })}
            </div>
          )}

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
                    return (
                      <tr key={id}>
                        <td>{gameName(instance)}</td>
                        <td>{id}</td>
                        <td>{instanceType(instance)}</td>
                        <td>{instance.worldName || instance.selectedWorldId || '—'}</td>
                        <td>
                          <span className={statusClassName(instance.status)}>{normalizeStatus(instance.status)}</span>
                        </td>
                        <td>{instance.region || '—'}</td>
                        <td>{instance.publicIp || '—'}</td>
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
                      <strong>{selectedInstance.publicIp || '—'}</strong>
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
                    </div>
                    <pre className="log-output">{logsLoading ? 'Loading logs…' : logs.join('\n') || 'No log lines.'}</pre>
                  </div>
                )}

                {detailTab === 'config' && (
                  <div className="config-panel">
                    <textarea
                      value={configText}
                      onChange={(event) => setConfigText(event.target.value)}
                      className="json-editor"
                      spellCheck={false}
                    />
                    <div className="row-actions">
                      <label>
                        Save mode:
                        <select value={configMode} onChange={(event) => setConfigMode(event.target.value as 'apply' | 'applyAndRestart')}>
                          <option value="apply">apply</option>
                          <option value="applyAndRestart">applyAndRestart</option>
                        </select>
                      </label>
                      {configError && <div className="error">{configError}</div>}
                      <button
                        className="btn btn-success"
                        disabled={configSaving}
                        onClick={handleSaveConfig}
                      >
                        Save config
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
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
            <div className="modal-actions">
              <button type="button" className="btn btn-small" onClick={() => setShowAddInstance(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-success"
                onClick={handleCreateInstance}
                disabled={serverConfigLoading || serverConfigSaving}
              >
                {serverConfigSaving ? 'Saving config…' : 'Save config & launch'}
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
