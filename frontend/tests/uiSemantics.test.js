import { describe, expect, it } from 'vitest';
import {
  GAME_SERVER_ACTION_LABELS,
  INSTANCE_ACTION_LABELS,
  deleteRestorePointConfirmation,
  deleteWorldConfirmation,
  launchButtonLabel,
  launchDisabledReason,
  nextTabIndex,
  terminateInstanceConfirmation,
} from '../src/uiSemantics';

describe('UI semantics', () => {
  it('keeps AWS and game-server labels distinct', () => {
    expect(INSTANCE_ACTION_LABELS).toEqual({ start: 'Start instance', stop: 'Stop instance', restart: 'Restart instance', terminate: 'Permanently terminate' });
    expect(GAME_SERVER_ACTION_LABELS).toEqual({ start: 'Start game server', stop: 'Stop game server', restart: 'Restart game server' });
  });

  it('describes destructive outcomes', () => {
    expect(terminateInstanceConfirmation('Friday')).toContain('EC2 instance will be deleted');
    expect(deleteWorldConfirmation('Navezgane')).toContain('S3 save data');
    expect(deleteRestorePointConfirmation('Before horde')).toContain('cannot be restored');
  });

  it('describes every launch state and blocker', () => {
    expect(launchButtonLabel({ configSaving: true, instanceCreating: true, supportsConfig: true })).toBe('Saving configuration…');
    expect(launchButtonLabel({ configSaving: false, instanceCreating: true, supportsConfig: true })).toBe('Starting AWS instance…');
    expect(launchButtonLabel({ configSaving: false, instanceCreating: false, supportsConfig: true })).toContain('Save configuration');
    expect(launchButtonLabel({ configSaving: false, instanceCreating: false, supportsConfig: false })).toBe('Start AWS instance');
    expect(launchDisabledReason({ missingGame: true })).toContain('Select a game');
    expect(launchDisabledReason({ missingWorld: true })).toContain('create a world preset');
    expect(launchDisabledReason({ configLoading: true })).toContain('Loading');
    expect(launchDisabledReason({ configSaving: true })).toContain('Saving');
    expect(launchDisabledReason({ instanceCreating: true })).toContain('already being started');
    expect(launchDisabledReason({ validationError: 'Invalid XML' })).toContain('Invalid XML');
    expect(launchDisabledReason({})).toBe('');
  });

  it('calculates all tab navigation paths', () => {
    expect(nextTabIndex(0, 'ArrowLeft', 5)).toBe(4);
    expect(nextTabIndex(4, 'ArrowRight', 5)).toBe(0);
    expect(nextTabIndex(2, 'Home', 5)).toBe(0);
    expect(nextTabIndex(2, 'End', 5)).toBe(4);
    expect(nextTabIndex(2, 'Enter', 5)).toBe(2);
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBe(-1);
  });
});
