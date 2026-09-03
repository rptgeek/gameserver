export const INSTANCE_ACTION_LABELS = Object.freeze({
  start: 'Start instance', stop: 'Stop instance', restart: 'Restart instance', terminate: 'Permanently terminate',
});

export const GAME_SERVER_ACTION_LABELS = Object.freeze({
  start: 'Start game server', stop: 'Stop game server', restart: 'Restart game server',
});

export function terminateInstanceConfirmation(label: string) {
  return `Permanently terminate AWS instance “${label}”?\n\nThis is different from stopping the game server or stopping the instance. A final backup will be requested, then the EC2 instance will be deleted.`;
}

export function deleteWorldConfirmation(name: string) {
  return `Permanently delete saved world “${name}”?\n\nThis removes both the GameConsole record and its S3 save data. This cannot be undone from GameConsole.`;
}

export function deleteRestorePointConfirmation(name: string) {
  return `Permanently delete restore point “${name}”?\n\nThe saved snapshot will be removed and cannot be restored from GameConsole.`;
}

interface LaunchLabelState { configSaving: boolean; instanceCreating: boolean; supportsConfig: boolean }
export function launchButtonLabel({ configSaving, instanceCreating, supportsConfig }: LaunchLabelState) {
  if (configSaving) return 'Saving configuration…';
  if (instanceCreating) return 'Starting AWS instance…';
  return supportsConfig ? 'Save configuration & start instance' : 'Start AWS instance';
}

interface LaunchBlockers {
  missingGame?: boolean;
  missingWorld?: boolean;
  configLoading?: boolean;
  configSaving?: boolean;
  instanceCreating?: boolean;
  validationError?: string;
}
export function launchDisabledReason({ missingGame, missingWorld, configLoading, configSaving, instanceCreating, validationError }: LaunchBlockers) {
  if (missingGame) return 'Select a game before starting an instance.';
  if (missingWorld) return 'Select a saved world. If this is your first world, create a world preset above first.';
  if (configLoading) return 'Loading the required game-server configuration.';
  if (configSaving) return 'Saving the required game-server configuration.';
  if (instanceCreating) return 'The AWS instance is already being started.';
  if (validationError) return `Fix the advanced game-server configuration: ${validationError}`;
  return '';
}

export function nextTabIndex(currentIndex: number, key: string, tabCount: number) {
  if (tabCount <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return tabCount - 1;
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount;
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount;
  return currentIndex;
}
