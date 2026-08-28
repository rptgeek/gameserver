import { useId, useMemo, useState } from 'react';

type ConfigFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';
type ConfigTabId = 'identity' | 'network' | 'world' | 'gameplay' | 'population' | 'claims' | 'system' | 'other' | 'raw';

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

const difficultyOptions: ConfigOption[] = [
  { value: '0', label: 'Scavenger' },
  { value: '1', label: 'Adventurer' },
  { value: '2', label: 'Nomad' },
  { value: '3', label: 'Warrior' },
  { value: '4', label: 'Survivalist' },
  { value: '5', label: 'Insane' },
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
  { name: 'WebDashboardEnabled', label: 'Web dashboard', tab: 'network', section: 'Administration', type: 'boolean' },
  { name: 'WebDashboardPort', label: 'Dashboard port', tab: 'network', section: 'Administration', type: 'number', min: 1, max: 65535, caution: true },
  { name: 'WebDashboardUrl', label: 'External dashboard URL', tab: 'network', section: 'Administration' },
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

  { name: 'GameDifficulty', label: 'Difficulty', tab: 'gameplay', section: 'Difficulty', type: 'select', options: difficultyOptions },
  { name: 'DayNightLength', label: 'Day length', tab: 'gameplay', section: 'Time', type: 'number', min: 10, unit: 'minutes' },
  { name: 'DayLightLength', label: 'Daylight hours', tab: 'gameplay', section: 'Time', type: 'number', min: 0, max: 24 },
  { name: 'DayCount', label: 'Starting day', tab: 'gameplay', section: 'Time', type: 'number', min: 1 },
  { name: 'BloodMoonFrequency', label: 'Blood moon frequency', tab: 'gameplay', section: 'Blood moon', type: 'number', min: 0, unit: 'days' },
  { name: 'BloodMoonRange', label: 'Frequency variance', tab: 'gameplay', section: 'Blood moon', type: 'number', min: 0, unit: 'days' },
  { name: 'BloodMoonWarning', label: 'Warning hour', tab: 'gameplay', section: 'Blood moon', type: 'number', min: -1, max: 24 },
  { name: 'BloodMoonEnemyCount', label: 'Enemies per player', tab: 'gameplay', section: 'Blood moon', type: 'number', min: 1, caution: true },
  { name: 'XPMultiplier', label: 'XP multiplier', tab: 'gameplay', section: 'Progression & loot', type: 'number', min: 0, unit: '%' },
  { name: 'LootAbundance', label: 'Loot abundance', tab: 'gameplay', section: 'Progression & loot', type: 'number', min: 0, unit: '%' },
  { name: 'LootRespawnDays', label: 'Loot respawn', tab: 'gameplay', section: 'Progression & loot', type: 'number', min: -1, unit: 'days' },
  { name: 'AirDropFrequency', label: 'Air drop frequency', tab: 'gameplay', section: 'Progression & loot', type: 'number', min: 0, unit: 'hours' },
  { name: 'AirDropMarker', label: 'Air drop map marker', tab: 'gameplay', section: 'Progression & loot', type: 'boolean' },
  { name: 'PartySharedKillRange', label: 'Shared kill range', tab: 'gameplay', section: 'Multiplayer rules', type: 'number', min: 0, unit: 'meters' },
  { name: 'PlayerKillingMode', label: 'Player killing', tab: 'gameplay', section: 'Multiplayer rules', type: 'select', options: [{ value: '0', label: 'No killing' }, { value: '1', label: 'Allies only' }, { value: '2', label: 'Strangers only' }, { value: '3', label: 'Everyone' }] },
  { name: 'AllowSpawnNearFriend', label: 'Spawn near friends', tab: 'gameplay', section: 'Multiplayer rules', type: 'select', options: [{ value: '0', label: 'Disabled' }, { value: '1', label: 'Always' }, { value: '2', label: 'Forest biome only' }] },
  { name: 'CameraRestrictionMode', label: 'Camera mode', tab: 'gameplay', section: 'Player rules', type: 'select', options: [{ value: '0', label: 'First or third person' }, { value: '1', label: 'First person only' }, { value: '2', label: 'Third person only' }] },
  { name: 'BuildCreate', label: 'Cheat mode', tab: 'gameplay', section: 'Player rules', type: 'boolean' },
  { name: 'DeathPenalty', label: 'Death penalty', tab: 'gameplay', section: 'Player rules', type: 'select', options: [{ value: '0', label: 'Nothing' }, { value: '1', label: 'XP debt' }, { value: '2', label: 'Injured' }, { value: '3', label: 'Permanent death' }] },
  { name: 'DropOnDeath', label: 'Drop on death', tab: 'gameplay', section: 'Player rules', type: 'select', options: [{ value: '0', label: 'Nothing' }, { value: '1', label: 'Everything' }, { value: '2', label: 'Toolbelt only' }, { value: '3', label: 'Backpack only' }, { value: '4', label: 'Delete everything' }] },
  { name: 'DropOnQuit', label: 'Drop on quit', tab: 'gameplay', section: 'Player rules', type: 'select', options: [{ value: '0', label: 'Nothing' }, { value: '1', label: 'Everything' }, { value: '2', label: 'Toolbelt only' }, { value: '3', label: 'Backpack only' }] },

  { name: 'EnemySpawnMode', label: 'Enemy spawning', tab: 'population', section: 'Population', type: 'boolean' },
  { name: 'EnemyDifficulty', label: 'Feral enemies', tab: 'population', section: 'Population', type: 'select', options: [{ value: '0', label: 'Normal' }, { value: '1', label: 'Feral' }] },
  { name: 'MaxSpawnedZombies', label: 'Maximum zombies', tab: 'population', section: 'Population', type: 'number', min: 0, caution: true, help: 'High impact on server CPU during blood moons and sleepers.' },
  { name: 'MaxSpawnedAnimals', label: 'Maximum animals', tab: 'population', section: 'Population', type: 'number', min: 0, caution: true },
  { name: 'ZombieMove', label: 'Day movement', tab: 'population', section: 'Zombie movement', type: 'select', options: movementOptions },
  { name: 'ZombieMoveNight', label: 'Night movement', tab: 'population', section: 'Zombie movement', type: 'select', options: movementOptions },
  { name: 'ZombieFeralMove', label: 'Feral movement', tab: 'population', section: 'Zombie movement', type: 'select', options: movementOptions },
  { name: 'ZombieBMMove', label: 'Blood moon movement', tab: 'population', section: 'Zombie movement', type: 'select', options: movementOptions },
  { name: 'ZombieFeralSense', label: 'Feral sense', tab: 'population', section: 'Senses', type: 'select', options: [{ value: '0', label: 'Off' }, { value: '1', label: 'Day' }, { value: '2', label: 'Night' }, { value: '3', label: 'Always' }] },
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

const fieldByName = new Map(FIELD_DEFINITIONS.map((field) => [field.name, field]));

const TAB_DEFINITIONS: Array<{ id: ConfigTabId; label: string; shortLabel: string }> = [
  { id: 'identity', label: 'Identity & access', shortLabel: 'Identity' },
  { id: 'network', label: 'Network & admin', shortLabel: 'Network' },
  { id: 'world', label: 'World & save', shortLabel: 'World' },
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
  return parseProperties(xml).error;
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
  const unknownProperties = useMemo(
    () => parsed.properties.filter((property) => !fieldByName.has(property.name)),
    [parsed.properties],
  );
  const availableTabs = useMemo(() => TAB_DEFINITIONS.filter((tab) => {
    if (tab.id === 'raw') return true;
    if (tab.id === 'other') return unknownProperties.length > 0;
    return FIELD_DEFINITIONS.some((field) => field.tab === tab.id && propertyByName.has(field.name));
  }), [propertyByName, unknownProperties.length]);
  const activeTab = availableTabs.some((tab) => tab.id === requestedTab) ? requestedTab : (availableTabs[0]?.id ?? 'raw');
  const normalizedSearch = search.trim().toLowerCase();

  const displayedFields = useMemo(() => {
    const presentDefinitions = FIELD_DEFINITIONS.filter((field) => propertyByName.has(field.name));
    const inferred = unknownProperties.map(inferredField);
    const candidates = normalizedSearch
      ? [...presentDefinitions, ...inferred]
      : activeTab === 'other'
        ? inferred
        : presentDefinitions.filter((field) => field.tab === activeTab);
    if (!normalizedSearch) return candidates;
    return candidates.filter((field) =>
      `${field.label} ${field.name} ${field.help ?? ''}`.toLowerCase().includes(normalizedSearch),
    );
  }, [activeTab, normalizedSearch, propertyByName, unknownProperties]);

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
            type="button"
            role="tab"
            className={!normalizedSearch && activeTab === tab.id ? 'active' : ''}
            aria-selected={!normalizedSearch && activeTab === tab.id}
            onClick={() => { setRequestedTab(tab.id); setSearch(''); }}
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {tab.shortLabel}
          </button>
        ))}
      </nav>

      {parsed.error ? <div className="server-config-parse-error"><strong>XML needs attention</strong><span>{parsed.error}</span></div> : null}

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
                    value={propertyByName.get(definition.name)?.value ?? ''}
                    disabled={disabled}
                    revealSecrets={revealSecrets}
                    idPrefix={idPrefix}
                    onChange={(value) => onChange(updatePropertyValue(xml, definition.name, value))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
