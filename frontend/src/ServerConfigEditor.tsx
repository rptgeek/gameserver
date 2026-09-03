import React, { useId, useMemo, useState } from 'react';
import { nextTabIndex } from './uiSemantics';

type ConfigFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';
type ConfigTabId = 'identity' | 'network' | 'world' | 'sandbox' | 'gameplay' | 'population' | 'claims' | 'system' | 'other' | 'raw';

interface ConfigOption {
  value: string;
  label: string;
}

interface ConfigFieldDefinition {
  name: string;
  label: string;
  tab: Exclude<ConfigTabId, 'other' | 'raw'>;
  section: string;
  type?: ConfigFieldType;
  help?: string;
  options?: ConfigOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  caution?: boolean;
}

interface ParsedProperty {
  name: string;
  value: string;
}

interface SandboxFieldDefinition extends ConfigFieldDefinition {
  tab: 'sandbox';
  enumId: number;
  defaultValue: string;
  options: ConfigOption[];
}

interface ServerConfigEditorProps {
  xml: string;
  onChange: (nextXml: string) => void;
  disabled?: boolean;
  contextLabel?: string;
}

const booleanOptions: ConfigOption[] = [
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
];

const visibilityOptions: ConfigOption[] = [
  { value: '2', label: 'Public' },
  { value: '1', label: 'Friends only' },
  { value: '0', label: 'Unlisted' },
];

const movementOptions: ConfigOption[] = [
  { value: '0', label: 'Walk' },
  { value: '1', label: 'Jog' },
  { value: '2', label: 'Run' },
  { value: '3', label: 'Sprint' },
  { value: '4', label: 'Nightmare' },
];

const FIELD_DEFINITIONS: ConfigFieldDefinition[] = [
  { name: 'ServerName', label: 'Server name', tab: 'identity', section: 'Server listing', help: 'Shown in the public server browser.' },
  { name: 'ServerDescription', label: 'Description', tab: 'identity', section: 'Server listing', type: 'textarea' },
  { name: 'ServerWebsiteURL', label: 'Website URL', tab: 'identity', section: 'Server listing', help: 'Optional clickable link in the server browser.' },
  { name: 'ServerLoginConfirmationText', label: 'Join confirmation message', tab: 'identity', section: 'Server listing', type: 'textarea' },
  { name: 'Region', label: 'Region', tab: 'identity', section: 'Discovery', type: 'select', options: ['NorthAmericaEast', 'NorthAmericaWest', 'CentralAmerica', 'SouthAmerica', 'Europe', 'Russia', 'Asia', 'MiddleEast', 'Africa', 'Oceania'].map((value) => ({ value, label: value.replace(/([a-z])([A-Z])/g, '$1 $2') })) },
  { name: 'Language', label: 'Primary language', tab: 'identity', section: 'Discovery' },
  { name: 'ServerPassword', label: 'Join password', tab: 'identity', section: 'Access', type: 'password', help: 'Leave blank for an open server.' },
  { name: 'ServerMaxPlayerCount', label: 'Maximum players', tab: 'identity', section: 'Player slots', type: 'number', min: 1, max: 64 },
  { name: 'ServerReservedSlots', label: 'Reserved slots', tab: 'identity', section: 'Player slots', type: 'number', min: 0, max: 64 },
  { name: 'ServerReservedSlotsPermission', label: 'Reserved permission level', tab: 'identity', section: 'Player slots', type: 'number', min: 0, max: 1000 },
  { name: 'ServerAdminSlots', label: 'Extra admin slots', tab: 'identity', section: 'Player slots', type: 'number', min: 0, max: 64 },
  { name: 'ServerAdminSlotsPermission', label: 'Admin slot permission', tab: 'identity', section: 'Player slots', type: 'number', min: 0, max: 1000 },

  { name: 'ServerPort', label: 'Game port', tab: 'network', section: 'Connectivity', type: 'number', min: 1, max: 65535, caution: true },
  { name: 'ServerVisibility', label: 'Visibility', tab: 'network', section: 'Connectivity', type: 'select', options: visibilityOptions },
  { name: 'ServerDisabledNetworkProtocols', label: 'Disabled protocols', tab: 'network', section: 'Connectivity', help: 'Comma-separated: LiteNetLib, SteamNetworking.' },
  { name: 'ServerMaxWorldTransferSpeedKiBs', label: 'World transfer limit', tab: 'network', section: 'Connectivity', type: 'number', min: 1, max: 1300, unit: 'KiB/s' },
  { name: 'ServerAllowCrossplay', label: 'Crossplay', tab: 'network', section: 'Connectivity', type: 'boolean' },
  { name: 'WebDashboardEnabled', label: 'Native web dashboard', tab: 'network', section: 'Administration', type: 'boolean', caution: true, help: 'Served by 7D2D on the instance public IP. Create web users through the game console and grant only the permissions they need.' },
  { name: 'WebDashboardPort', label: 'Dashboard port', tab: 'network', section: 'Administration', type: 'number', min: 1, max: 65535, caution: true, help: 'Port 8080 is opened by the managed 7D2D launch profile.' },
  { name: 'WebDashboardUrl', label: 'External dashboard URL', tab: 'network', section: 'Administration', help: 'Leave blank for direct public-IP access. Set the full HTTPS URL only when a reverse proxy is configured.' },
  { name: 'EnableMapRendering', label: 'Dashboard map rendering', tab: 'network', section: 'Administration', type: 'boolean', caution: true, help: 'Uses additional CPU and disk while players explore.' },
  { name: 'TelnetEnabled', label: 'Telnet console', tab: 'network', section: 'Telnet', type: 'boolean' },
  { name: 'TelnetPort', label: 'Telnet port', tab: 'network', section: 'Telnet', type: 'number', min: 1, max: 65535, caution: true },
  { name: 'TelnetPassword', label: 'Telnet password', tab: 'network', section: 'Telnet', type: 'password', help: 'Blank restricts Telnet to local loopback.' },
  { name: 'TelnetFailedLoginLimit', label: 'Failed login limit', tab: 'network', section: 'Telnet', type: 'number', min: 1 },
  { name: 'TelnetFailedLoginsBlocktime', label: 'Login block time', tab: 'network', section: 'Telnet', type: 'number', min: 1, unit: 'seconds' },

  { name: 'GameWorld', label: 'World', tab: 'world', section: 'World identity', help: 'Existing generated-world folder, a pregen name, Navezgane, or RWG.', caution: true },
  { name: 'GameName', label: 'Save game name', tab: 'world', section: 'World identity', help: 'Controls the save folder. Changing it starts a different save.', caution: true },
  { name: 'GameMode', label: 'Game mode', tab: 'world', section: 'World identity', type: 'select', options: [{ value: 'GameModeSurvival', label: 'Survival' }] },
  { name: 'WorldGenSeed', label: 'Generation seed', tab: 'world', section: 'Random generation', caution: true },
  { name: 'WorldGenSize', label: 'Generated world size', tab: 'world', section: 'Random generation', type: 'select', options: ['6144', '8192', '10240'].map((value) => ({ value, label: `${value} × ${value}` })), caution: true },
  { name: 'SandboxCode', label: 'Sandbox options code', tab: 'world', section: 'Sandbox', help: 'Paste the code copied from the in-game sandbox options screen.', caution: true },

  { name: 'DayCount', label: 'Starting day', tab: 'gameplay', section: 'Time', type: 'number', min: 1 },
  { name: 'PartySharedKillRange', label: 'Shared kill range', tab: 'gameplay', section: 'Multiplayer rules', type: 'number', min: 0, unit: 'meters' },
  { name: 'PlayerKillingMode', label: 'Player killing', tab: 'gameplay', section: 'Multiplayer rules', type: 'select', options: [{ value: '0', label: 'No killing' }, { value: '1', label: 'Allies only' }, { value: '2', label: 'Strangers only' }, { value: '3', label: 'Everyone' }] },
  { name: 'AllowSpawnNearFriend', label: 'Spawn near friends', tab: 'gameplay', section: 'Multiplayer rules', type: 'select', options: [{ value: '0', label: 'Disabled' }, { value: '1', label: 'Always' }, { value: '2', label: 'Forest biome only' }] },
  { name: 'CameraRestrictionMode', label: 'Camera mode', tab: 'gameplay', section: 'Player rules', type: 'select', options: [{ value: '0', label: 'First or third person' }, { value: '1', label: 'First person only' }, { value: '2', label: 'Third person only' }] },
  { name: 'BuildCreate', label: 'Cheat mode', tab: 'gameplay', section: 'Player rules', type: 'boolean' },

  { name: 'MaxSpawnedZombies', label: 'Maximum zombies', tab: 'population', section: 'Population', type: 'number', min: 0, caution: true, help: 'High impact on server CPU during blood moons and sleepers.' },
  { name: 'MaxSpawnedAnimals', label: 'Maximum animals', tab: 'population', section: 'Population', type: 'number', min: 0, caution: true },
  { name: 'PlayerSafeZoneLevel', label: 'New-player safe level', tab: 'population', section: 'New-player protection', type: 'number', min: 0 },
  { name: 'PlayerSafeZoneHours', label: 'Safe-zone duration', tab: 'population', section: 'New-player protection', type: 'number', min: 0, unit: 'world hours' },

  { name: 'BedrollDeadZoneSize', label: 'Bedroll dead-zone radius', tab: 'claims', section: 'Bedroll protection', type: 'number', min: 0, unit: 'blocks' },
  { name: 'BedrollExpiryTime', label: 'Bedroll expiry', tab: 'claims', section: 'Bedroll protection', type: 'number', min: 0, unit: 'real days' },
  { name: 'LandClaimCount', label: 'Claims per player', tab: 'claims', section: 'Land claims', type: 'number', min: 0 },
  { name: 'LandClaimSize', label: 'Claim size', tab: 'claims', section: 'Land claims', type: 'number', min: 1, unit: 'blocks' },
  { name: 'LandClaimDeadZone', label: 'Minimum claim spacing', tab: 'claims', section: 'Land claims', type: 'number', min: 0, unit: 'blocks' },
  { name: 'LandClaimExpiryTime', label: 'Claim expiry', tab: 'claims', section: 'Land claims', type: 'number', min: 0, unit: 'real days' },
  { name: 'LandClaimDecayMode', label: 'Offline decay', tab: 'claims', section: 'Land claims', type: 'select', options: [{ value: '0', label: 'Slow / linear' }, { value: '1', label: 'Fast / exponential' }, { value: '2', label: 'No decay before expiry' }] },
  { name: 'LandClaimOnlineDurabilityModifier', label: 'Online durability', tab: 'claims', section: 'Durability', type: 'number', min: 0, unit: '×' },
  { name: 'LandClaimOfflineDurabilityModifier', label: 'Offline durability', tab: 'claims', section: 'Durability', type: 'number', min: 0, unit: '×' },
  { name: 'LandClaimOfflineDelay', label: 'Offline protection delay', tab: 'claims', section: 'Durability', type: 'number', min: 0, unit: 'minutes' },
  { name: 'DynamicMeshEnabled', label: 'Dynamic mesh', tab: 'claims', section: 'Dynamic mesh', type: 'boolean', caution: true },
  { name: 'DynamicMeshLandClaimOnly', label: 'Claims only', tab: 'claims', section: 'Dynamic mesh', type: 'boolean' },
  { name: 'DynamicMeshLandClaimBuffer', label: 'Claim buffer', tab: 'claims', section: 'Dynamic mesh', type: 'number', min: 0, unit: 'chunks' },
  { name: 'DynamicMeshMaxItemCache', label: 'Concurrent cache items', tab: 'claims', section: 'Dynamic mesh', type: 'number', min: 0, caution: true },

  { name: 'EACEnabled', label: 'Easy Anti-Cheat', tab: 'system', section: 'Security', type: 'boolean' },
  { name: 'IgnoreEOSSanctions', label: 'Ignore EOS sanctions', tab: 'system', section: 'Security', type: 'boolean', caution: true },
  { name: 'PersistentPlayerProfiles', label: 'Lock player profiles', tab: 'system', section: 'Player data', type: 'boolean' },
  { name: 'MaxUncoveredMapChunksPerPlayer', label: 'Map chunks per player', tab: 'system', section: 'Player data', type: 'number', min: 0, caution: true },
  { name: 'MaxChunkAge', label: 'Chunk reset age', tab: 'system', section: 'Storage limits', type: 'number', min: -1, unit: 'game days' },
  { name: 'SaveDataLimit', label: 'Save data limit', tab: 'system', section: 'Storage limits', type: 'number', min: -1, unit: 'MB', caution: true },
  { name: 'ServerMaxAllowedViewDistance', label: 'Maximum view distance', tab: 'system', section: 'Performance', type: 'number', min: 6, max: 12, caution: true },
  { name: 'MaxQueuedMeshLayers', label: 'Queued mesh layers', tab: 'system', section: 'Performance', type: 'number', min: 1, caution: true },
  { name: 'HideCommandExecutionLog', label: 'Command log visibility', tab: 'system', section: 'Logging', type: 'select', options: [{ value: '0', label: 'Show everything' }, { value: '1', label: 'Hide remote console commands' }, { value: '2', label: 'Also hide remote game clients' }, { value: '3', label: 'Hide everything' }] },
  { name: 'TerminalWindowEnabled', label: 'Windows terminal window', tab: 'system', section: 'Logging', type: 'boolean' },
  { name: 'AdminFileName', label: 'Admin file name', tab: 'system', section: 'Files' },
  { name: 'TwitchServerPermission', label: 'Twitch permission level', tab: 'system', section: 'Integrations', type: 'number', min: 0, max: 1000 },
  { name: 'TwitchBloodMoonAllowed', label: 'Twitch during blood moons', tab: 'system', section: 'Integrations', type: 'boolean', caution: true },
];

function sandboxOptions(
  values: Array<string | number | boolean>,
  label: (value: string) => string = (value) => value,
): ConfigOption[] {
  return values.map((value) => {
    const normalized = String(value);
    return { value: normalized, label: label(normalized) };
  });
}

const multiplierValues = [0, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 1, 1.25, 1.5, 2, 3, 4, 5];
const damageValues = [0, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85, 1, 1.25, 1.5, 2, 2.5, 3];
const percentLabel = (value: string) => Number(value) === 0 ? 'None' : `${Math.round(Number(value) * 100)}%`;
const dayLabel = (value: string) => Number(value) === 0 ? 'Disabled' : `${value} day${value === '1' ? '' : 's'}`;

const SANDBOX_FIELDS: SandboxFieldDefinition[] = [
  { name: 'XPMultiplier', label: 'XP multiplier', tab: 'sandbox', section: 'Progression', type: 'select', enumId: 18, defaultValue: '1', options: sandboxOptions([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 5], percentLabel) },
  { name: 'QuestProgressionDailyLimit', label: 'Tier-progressing quests per day', tab: 'sandbox', section: 'Progression', type: 'select', enumId: 123, defaultValue: '4', options: sandboxOptions([-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], (value) => value === '-1' ? 'Unlimited' : value), help: 'Additional quests still award normal rewards but do not advance the trader tier that day.' },
  { name: 'QuestsPerTier', label: 'Quests required per tier', tab: 'sandbox', section: 'Progression', type: 'select', enumId: 122, defaultValue: '10', options: sandboxOptions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) },
  { name: 'StarterSkillPoints', label: 'Starting skill points', tab: 'sandbox', section: 'Progression', type: 'select', enumId: 121, defaultValue: '4', options: sandboxOptions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) },
  { name: 'QuestsEnabled', label: 'Trader quests', tab: 'sandbox', section: 'Progression', type: 'boolean', enumId: 118, defaultValue: 'true', options: sandboxOptions([false, true]) },
  { name: 'BiomeProgression', label: 'Biome progression', tab: 'sandbox', section: 'Progression', type: 'boolean', enumId: 55, defaultValue: 'true', options: sandboxOptions([false, true]) },

  { name: 'BloodMoonFrequency', label: 'Blood moon frequency', tab: 'sandbox', section: 'Blood moon', type: 'select', enumId: 48, defaultValue: '7', options: sandboxOptions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14, 20, 30], dayLabel) },
  { name: 'BloodMoonRange', label: 'Frequency variance', tab: 'sandbox', section: 'Blood moon', type: 'select', enumId: 49, defaultValue: '0', options: sandboxOptions([0, 1, 2, 3, 4, 7, 10, 14, 20], (value) => `${value} day${value === '1' ? '' : 's'}`) },
  { name: 'BloodMoonWarning', label: 'Warning begins', tab: 'sandbox', section: 'Blood moon', type: 'select', enumId: 50, defaultValue: '1', options: sandboxOptions([0, 1, 2], (value) => ({ '0': 'Disabled', '1': 'Morning', '2': 'Evening' })[value] ?? value) },
  { name: 'BloodMoonEnemyCount', label: 'Simultaneous enemies per player', tab: 'sandbox', section: 'Blood moon', type: 'select', enumId: 51, defaultValue: '8', options: sandboxOptions([4, 6, 8, 10, 12, 16, 24, 32, 64], (value) => `${value} enemies`), caution: true, help: 'MaxSpawnedZombies can cap the combined multiplayer total.' },
  { name: 'BlockDamageAIBM', label: 'Blood moon block damage', tab: 'sandbox', section: 'Blood moon', type: 'select', enumId: 33, defaultValue: '1', options: sandboxOptions(damageValues, percentLabel), caution: true },

  { name: 'AirDropFrequency', label: 'Air drop frequency', tab: 'sandbox', section: 'Events & weather', type: 'select', enumId: 52, defaultValue: '3', options: sandboxOptions([0, 1, 2, 3, 4, 5, 6], dayLabel) },
  { name: 'AirDropMarker', label: 'Air drop map marker', tab: 'sandbox', section: 'Events & weather', type: 'boolean', enumId: 53, defaultValue: 'true', options: sandboxOptions([false, true]) },
  { name: 'AirDropRandomTime', label: 'Air drop delivery window', tab: 'sandbox', section: 'Events & weather', type: 'select', enumId: 54, defaultValue: '0', options: sandboxOptions([0, 1, 2, 3, 4, 5, 6], (value) => ({ '0': 'No variance', '1': 'Morning', '2': 'Midday', '3': 'Evening', '4': 'Night', '5': 'All day', '6': 'Any time' })[value] ?? value) },
  { name: 'StormFreq', label: 'Storm frequency', tab: 'sandbox', section: 'Events & weather', type: 'select', enumId: 57, defaultValue: '1', options: sandboxOptions([0, 0.5, 1, 1.5, 2, 3, 4, 5], percentLabel) },
  { name: 'StormWarning', label: 'Storm warnings', tab: 'sandbox', section: 'Events & weather', type: 'boolean', enumId: 58, defaultValue: 'true', options: sandboxOptions([false, true]) },

  { name: 'DayNightLength', label: '24-hour cycle length', tab: 'sandbox', section: 'World time', type: 'select', enumId: 66, defaultValue: '60', options: sandboxOptions([10, 20, 30, 40, 50, 60, 90, 120], (value) => `${value} minutes`) },
  { name: 'DayLightLength', label: 'Daylight hours', tab: 'sandbox', section: 'World time', type: 'select', enumId: 67, defaultValue: '18', options: sandboxOptions([0, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24], (value) => `${value} hours`) },
  { name: 'TemperatureSurvival', label: 'Temperature survival', tab: 'sandbox', section: 'World time', type: 'boolean', enumId: 56, defaultValue: 'true', options: sandboxOptions([false, true]) },

  { name: 'EnemySpawnMode', label: 'Enemy spawning', tab: 'sandbox', section: 'Enemies', type: 'boolean', enumId: 30, defaultValue: 'true', options: sandboxOptions([false, true]) },
  { name: 'ZombieMove', label: 'Zombie day speed', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 34, defaultValue: '0', options: movementOptions },
  { name: 'ZombieMoveNight', label: 'Zombie night speed', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 35, defaultValue: '3', options: movementOptions },
  { name: 'ZombieFeralMove', label: 'Feral zombie speed', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 36, defaultValue: '3', options: movementOptions },
  { name: 'ZombieBMMove', label: 'Blood moon zombie speed', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 37, defaultValue: '3', options: movementOptions },
  { name: 'BlockDamageAI', label: 'Enemy block damage', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 32, defaultValue: '1', options: sandboxOptions(damageValues, percentLabel) },
  { name: 'ZombieRageChance', label: 'Zombie rage chance', tab: 'sandbox', section: 'Enemies', type: 'select', enumId: 41, defaultValue: '0.15', options: sandboxOptions([0, 0.15, 0.3, 0.35, 0.4, 0.5, 0.6, 0.75, 0.9, 1], percentLabel) },

  { name: 'GlobalLootCount', label: 'Global loot abundance', tab: 'sandbox', section: 'Loot & resources', type: 'select', enumId: 78, defaultValue: '1', options: sandboxOptions(multiplierValues, percentLabel) },
  { name: 'LootRespawnDays', label: 'Loot respawn', tab: 'sandbox', section: 'Loot & resources', type: 'select', enumId: 75, defaultValue: '7', options: sandboxOptions([-1, 5, 7, 10, 15, 20, 30, 40, 50], (value) => value === '-1' ? 'Disabled' : `${value} days`) },
  { name: 'MiningOutput', label: 'Mining output', tab: 'sandbox', section: 'Loot & resources', type: 'select', enumId: 101, defaultValue: '1', options: sandboxOptions(multiplierValues, percentLabel) },
  { name: 'HarvestingOutput', label: 'Harvesting output', tab: 'sandbox', section: 'Loot & resources', type: 'select', enumId: 102, defaultValue: '1', options: sandboxOptions(multiplierValues, percentLabel) },
  { name: 'CraftingTime', label: 'Crafting time', tab: 'sandbox', section: 'Loot & resources', type: 'select', enumId: 97, defaultValue: '1', options: sandboxOptions([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3], percentLabel) },

  { name: 'BlockDamage', label: 'Player block damage', tab: 'sandbox', section: 'Player consequences', type: 'select', enumId: 2, defaultValue: '1', options: sandboxOptions(damageValues, percentLabel) },
  { name: 'DeathPenalty', label: 'Death penalty', tab: 'sandbox', section: 'Player consequences', type: 'select', enumId: 26, defaultValue: '1', options: [{ value: '0', label: 'Nothing' }, { value: '1', label: 'XP debt' }, { value: '2', label: 'Injured' }, { value: '3', label: 'Permanent death' }] },
  { name: 'DropOnDeath', label: 'Drop on death', tab: 'sandbox', section: 'Player consequences', type: 'select', enumId: 27, defaultValue: '1', options: [{ value: '0', label: 'Nothing' }, { value: '1', label: 'Everything' }, { value: '2', label: 'Toolbelt only' }, { value: '3', label: 'Backpack only' }, { value: '4', label: 'Delete everything' }] },
];

const fieldByName = new Map(FIELD_DEFINITIONS.map((field) => [field.name, field]));

const TAB_DEFINITIONS: Array<{ id: ConfigTabId; label: string; shortLabel: string }> = [
  { id: 'identity', label: 'Identity & access', shortLabel: 'Identity' },
  { id: 'network', label: 'Network & admin', shortLabel: 'Network' },
  { id: 'world', label: 'World & save', shortLabel: 'World' },
  { id: 'sandbox', label: 'Sandbox 3.0', shortLabel: 'Sandbox' },
  { id: 'gameplay', label: 'Gameplay rules', shortLabel: 'Gameplay' },
  { id: 'population', label: 'Enemies & spawning', shortLabel: 'Population' },
  { id: 'claims', label: 'Claims & building', shortLabel: 'Claims' },
  { id: 'system', label: 'System & performance', shortLabel: 'System' },
  { id: 'other', label: 'Other properties', shortLabel: 'Other' },
  { id: 'raw', label: 'Advanced XML', shortLabel: 'XML' },
];

function parseProperties(xml: string): { properties: ParsedProperty[]; error?: string } {
  if (!xml.trim()) return { properties: [], error: 'serverconfig.xml is empty' };
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const parserError = document.querySelector('parsererror');
  if (parserError) {
    return { properties: [], error: parserError.textContent?.trim() || 'Invalid XML' };
  }
  if (document.documentElement.nodeName !== 'ServerSettings') {
    return { properties: [], error: 'The root element must be <ServerSettings>.' };
  }
  const properties = Array.from(document.querySelectorAll('property'))
    .map((node) => ({ name: node.getAttribute('name') || '', value: node.getAttribute('value') || '' }))
    .filter((property) => property.name.length > 0);
  if (properties.length === 0) {
    return { properties: [], error: 'No active <property> settings were found.' };
  }
  return {
    properties,
  };
}

export function serverConfigXmlValidationError(xml: string): string | undefined {
  const parsed = parseProperties(xml);
  if (parsed.error) return parsed.error;
  const sandboxCode = parsed.properties.find((property) => property.name === 'SandboxCode')?.value;
  return sandboxCode === undefined ? undefined : parseSandboxCode(sandboxCode).error;
}

function escapeAttribute(value: string, quote: string): string {
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&apos;');
}

function updatePropertyValue(xml: string, propertyName: string, nextValue: string): string {
  const commentRanges = Array.from(xml.matchAll(/<!--[\s\S]*?-->/g)).map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const tagPattern = /<property\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(xml))) {
    const matchIndex = match.index;
    if (commentRanges.some((range) => matchIndex >= range.start && matchIndex < range.end)) continue;
    const tag = match[0];
    const nameMatch = tag.match(/\bname\s*=\s*(["'])(.*?)\1/i);
    if (nameMatch?.[2] !== propertyName) continue;
    const valueMatch = tag.match(/\bvalue\s*=\s*(["'])(.*?)\1/i);
    if (!valueMatch || valueMatch.index === undefined) return xml;
    const quote = valueMatch[1];
    const valueStart = valueMatch.index + valueMatch[0].indexOf(quote) + 1;
    const valueEnd = valueStart + valueMatch[2].length;
    const updatedTag = `${tag.slice(0, valueStart)}${escapeAttribute(nextValue, quote)}${tag.slice(valueEnd)}`;
    return `${xml.slice(0, matchIndex)}${updatedTag}${xml.slice(matchIndex + tag.length)}`;
  }
  return xml;
}

interface ParsedSandboxCode {
  header: string;
  values: Map<number, number>;
  error?: string;
}

function parseSandboxCode(rawCode: string): ParsedSandboxCode {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { header: 'A', values: new Map() };
  if (!/^[A-Z]+$/.test(code) || (code.length - 1) % 3 !== 0) {
    return { header: code[0] || 'A', values: new Map(), error: 'SandboxCode must contain a one-letter header followed by three-letter option blocks.' };
  }
  const values = new Map<number, number>();
  for (let offset = 1; offset < code.length; offset += 3) {
    const enumId = (code.charCodeAt(offset) - 65) * 26 + (code.charCodeAt(offset + 1) - 65);
    const valueIndex = code.charCodeAt(offset + 2) - 65;
    values.set(enumId, valueIndex);
  }
  return { header: code[0], values };
}

function sandboxValue(parsed: ParsedSandboxCode, definition: SandboxFieldDefinition): string {
  const valueIndex = parsed.values.get(definition.enumId);
  return valueIndex === undefined
    ? definition.defaultValue
    : definition.options[valueIndex]?.value ?? definition.defaultValue;
}

function updateSandboxCode(
  rawCode: string,
  definition: SandboxFieldDefinition,
  nextValue: string,
): string {
  const parsed = parseSandboxCode(rawCode);
  if (parsed.error) return rawCode;
  const nextIndex = definition.options.findIndex((option) => option.value === nextValue);
  if (nextIndex < 0) return rawCode;
  if (nextValue === definition.defaultValue) parsed.values.delete(definition.enumId);
  else parsed.values.set(definition.enumId, nextIndex);
  const blocks = Array.from(parsed.values.entries())
    .sort(([left], [right]) => left - right)
    .map(([enumId, valueIndex]) => {
      const high = String.fromCharCode(65 + Math.floor(enumId / 26));
      const low = String.fromCharCode(65 + (enumId % 26));
      const value = String.fromCharCode(65 + valueIndex);
      return `${high}${low}${value}`;
    });
  return `${parsed.header}${blocks.join('')}`;
}

function inferredField(property: ParsedProperty): ConfigFieldDefinition {
  const spaced = property.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const type: ConfigFieldType = property.value === 'true' || property.value === 'false'
    ? 'boolean'
    : /^-?\d+(\.\d+)?$/.test(property.value)
      ? 'number'
      : 'text';
  return { name: property.name, label: spaced, tab: 'system', section: 'Unmapped', type };
}

function ConfigField({
  definition,
  value,
  disabled,
  revealSecrets,
  idPrefix,
  onChange,
}: {
  definition: ConfigFieldDefinition;
  value: string;
  disabled: boolean;
  revealSecrets: boolean;
  idPrefix: string;
  onChange: (value: string) => void;
}) {
  const id = `${idPrefix}-${definition.name}`;
  const type = definition.type ?? 'text';
  const options = definition.options ?? (type === 'boolean' ? booleanOptions : undefined);
  const hasCustomOption = options && !options.some((option) => option.value === value);

  return (
    <label className={`server-config-field ${definition.caution ? 'caution' : ''}`} htmlFor={id}>
      <span className="server-config-field-head">
        <span>{definition.label}</span>
        {definition.unit ? <small>{definition.unit}</small> : null}
      </span>
      {type === 'boolean' ? (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={value === 'true'}
          className={`config-switch ${value === 'true' ? 'enabled' : ''}`}
          disabled={disabled}
          onClick={() => onChange(value === 'true' ? 'false' : 'true')}
        >
          <span className="config-switch-track"><span /></span>
          <strong>{value === 'true' ? 'Enabled' : 'Disabled'}</strong>
        </button>
      ) : type === 'select' ? (
        <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          {hasCustomOption ? <option value={value}>{value} (custom)</option> : null}
          {options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : type === 'textarea' ? (
        <textarea id={id} rows={3} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input
          id={id}
          type={type === 'password' && !revealSecrets ? 'password' : type === 'number' ? 'number' : 'text'}
          value={value}
          min={definition.min}
          max={definition.max}
          step={definition.step}
          disabled={disabled}
          autoComplete={type === 'password' ? 'new-password' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <span className="server-config-property-name">{definition.name}</span>
      {definition.help ? <small className="server-config-help">{definition.help}</small> : null}
    </label>
  );
}

export default function ServerConfigEditor({ xml, onChange, disabled = false, contextLabel }: ServerConfigEditorProps) {
  const idPrefix = `server-config-${useId().replace(/:/g, '')}`;
  const [requestedTab, setRequestedTab] = useState<ConfigTabId>('identity');
  const [search, setSearch] = useState('');
  const [revealSecrets, setRevealSecrets] = useState(false);
  const parsed = useMemo(() => parseProperties(xml), [xml]);
  const propertyByName = useMemo(
    () => new Map(parsed.properties.map((property) => [property.name, property])),
    [parsed.properties],
  );
  const sandboxCode = propertyByName.get('SandboxCode')?.value;
  const parsedSandbox = useMemo(() => parseSandboxCode(sandboxCode ?? ''), [sandboxCode]);
  const hasSandboxCode = sandboxCode !== undefined;
  const unknownProperties = useMemo(
    () => parsed.properties.filter((property) => !fieldByName.has(property.name)),
    [parsed.properties],
  );
  const availableTabs = useMemo(() => TAB_DEFINITIONS.filter((tab) => {
    if (tab.id === 'raw') return true;
    if (tab.id === 'other') return unknownProperties.length > 0;
    if (tab.id === 'sandbox') return hasSandboxCode;
    return FIELD_DEFINITIONS.some((field) => field.tab === tab.id && propertyByName.has(field.name));
  }), [hasSandboxCode, propertyByName, unknownProperties.length]);
  const activeTab = availableTabs.some((tab) => tab.id === requestedTab) ? requestedTab : (availableTabs[0]?.id ?? 'raw');
  const normalizedSearch = search.trim().toLowerCase();

  const displayedFields = useMemo(() => {
    const presentDefinitions = FIELD_DEFINITIONS.filter((field) => propertyByName.has(field.name));
    const inferred = unknownProperties.map(inferredField);
    const candidates = normalizedSearch
      ? [...presentDefinitions, ...(hasSandboxCode ? SANDBOX_FIELDS : []), ...inferred]
      : activeTab === 'other'
        ? inferred
        : activeTab === 'sandbox'
          ? SANDBOX_FIELDS
          : presentDefinitions.filter((field) => field.tab === activeTab);
    if (!normalizedSearch) return candidates;
    return candidates.filter((field) =>
      `${field.label} ${field.name} ${field.help ?? ''}`.toLowerCase().includes(normalizedSearch),
    );
  }, [activeTab, hasSandboxCode, normalizedSearch, propertyByName, unknownProperties]);

  const sections = useMemo(() => {
    const grouped = new Map<string, ConfigFieldDefinition[]>();
    for (const field of displayedFields) {
      const current = grouped.get(field.section) ?? [];
      current.push(field);
      grouped.set(field.section, current);
    }
    return Array.from(grouped.entries());
  }, [displayedFields]);

  return (
    <div className="server-config-editor">
      <header className="server-config-header">
        <div>
          <span className="eyebrow">7D2D control surface</span>
          <h3>Server configuration</h3>
          <p>{contextLabel || 'Edit the selected world configuration.'}</p>
        </div>
        <div className="server-config-stats" aria-label="Configuration summary">
          <strong>{parsed.properties.length}</strong>
          <span>properties</span>
          {unknownProperties.length > 0 ? <small>{unknownProperties.length} preserved in Other</small> : null}
        </div>
      </header>

      <div className="server-config-tools">
        <label className="server-config-search">
          <span className="sr-only">Search server settings</span>
          <input
            type="search"
            value={search}
            placeholder="Search settings or XML property names…"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={revealSecrets} onChange={(event) => setRevealSecrets(event.target.checked)} />
          Show passwords
        </label>
      </div>

      <nav className="server-config-tabs" role="tablist" aria-label="Server configuration sections">
        {availableTabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${idPrefix}-tab-${tab.id}`}
            type="button"
            role="tab"
            className={!normalizedSearch && activeTab === tab.id ? 'active' : ''}
            aria-selected={activeTab === tab.id}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => { setRequestedTab(tab.id); setSearch(''); }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
              const currentIndex = tabs.indexOf(event.currentTarget);
              const nextIndex = nextTabIndex(currentIndex, event.key, tabs.length);
              tabs[nextIndex]?.focus();
              tabs[nextIndex]?.click();
            }}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {tab.shortLabel}
          </button>
        ))}
      </nav>

      {parsed.error ? <div className="server-config-parse-error"><strong>XML needs attention</strong><span>{parsed.error}</span></div> : null}
      {hasSandboxCode && parsedSandbox.error ? <div className="server-config-parse-error"><strong>Sandbox code needs attention</strong><span>{parsedSandbox.error}</span></div> : null}

      <div
        id={`${idPrefix}-panel`}
        role="tabpanel"
        aria-labelledby={`${idPrefix}-tab-${activeTab}`}
      >
      {activeTab === 'raw' && !normalizedSearch ? (
        <section className="server-config-raw">
          <div>
            <h4>Advanced XML</h4>
            <p>Direct edits remain synchronized with the form. Unknown elements and comments are preserved.</p>
          </div>
          <textarea
            value={xml}
            onChange={(event) => onChange(event.target.value)}
            className="xml-editor"
            disabled={disabled}
            spellCheck={false}
          />
        </section>
      ) : sections.length === 0 ? (
        <div className="server-config-empty">No settings match this view.</div>
      ) : (
        <div className="server-config-sections">
          {normalizedSearch ? <div className="server-config-search-result">Showing matches across every tab</div> : null}
          {!normalizedSearch && activeTab === 'sandbox' ? (
            <div className="sandbox-code-banner">
              <div>
                <span className="eyebrow">Current 3.0 format</span>
                <strong>Changes are encoded directly into SandboxCode</strong>
                <p>Default choices are omitted automatically, while settings outside this curated view remain untouched.</p>
              </div>
              <code>{sandboxCode || 'A'}</code>
            </div>
          ) : null}
          {sections.map(([section, fields]) => (
            <section className="server-config-section" key={section}>
              <div className="server-config-section-title">
                <h4>{section}</h4>
                <span>{fields.length}</span>
              </div>
              <div className="server-config-field-grid">
                {fields.map((definition) => (
                  <ConfigField
                    key={definition.name}
                    definition={definition}
                    value={'enumId' in definition
                      ? sandboxValue(parsedSandbox, definition as SandboxFieldDefinition)
                      : propertyByName.get(definition.name)?.value ?? ''}
                    disabled={disabled || ('enumId' in definition && Boolean(parsedSandbox.error))}
                    revealSecrets={revealSecrets}
                    idPrefix={idPrefix}
                    onChange={(value) => {
                      if ('enumId' in definition) {
                        const nextCode = updateSandboxCode(sandboxCode ?? 'A', definition as SandboxFieldDefinition, value);
                        onChange(updatePropertyValue(xml, 'SandboxCode', nextCode));
                      } else {
                        onChange(updatePropertyValue(xml, definition.name, value));
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
