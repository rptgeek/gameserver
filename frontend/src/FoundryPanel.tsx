import React, { useEffect, useState } from 'react';
import { foundryAction, foundryCommand, foundryStatus, type FoundryStatus } from './api';

type Pending = { action: 'start' | 'stop' | 'backup'; commandId?: string; instanceId?: string };
const STORAGE_KEY = 'gameserver.foundry.pending';
function savedPending(): Pending | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    return value && ['start', 'stop', 'backup'].includes(value.action) ? value : null;
  } catch { return null; }
}

export default function FoundryPanel() {
  const [server, setServer] = useState<FoundryStatus>();
  const [pending, setPending] = useState<Pending | null>(savedPending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (pending) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(STORAGE_KEY);
  }, [pending]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const status = await foundryStatus();
        if (cancelled) return;
        setServer(status);
        if (pending?.commandId) {
          const result = await foundryCommand(pending.commandId, pending.instanceId || '');
          if (cancelled) return;
          if (['Failed', 'Cancelled', 'TimedOut'].includes(result.status)) {
            setPending(null);
            setError('The backup or shutdown failed. Foundry was not deliberately powered off. Check its server logs before retrying.');
          } else if (result.status === 'Success') {
            if (pending.action === 'backup') {
              setPending(null); setMessage('Backup verified. Foundry has restarted.');
            } else if (status.state === 'not-running') {
              setPending(null); setMessage('Temporary server removed. Your campaign is saved in S3 for next time.');
            } else {
              setMessage('Backup verified. Waiting for the server to finish shutting down.');
            }
          }
        } else if (pending?.action === 'start' && status.state === 'running' && status.ready) {
          setPending(null); setMessage('Your save is restored and Foundry is ready to open.');
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to check Foundry status.');
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 10000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending]);

  async function act(action: Pending['action']) {
    if (action !== 'start' && !window.confirm(action === 'stop'
      ? 'End the current session, verify a backup, and stop Foundry? Players will be disconnected.'
      : 'Disconnect players briefly, back up the campaign, and restart Foundry?')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await foundryAction(action);
      if (result.state === 'not-running') {
        setPending(null); setServer(current => current && ({ ...current, state: 'not-running' }));
      } else setPending({ action, commandId: result.commandId, instanceId: result.instanceId });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Foundry action failed.'); }
    finally { setBusy(false); }
  }

  const disabled = busy || Boolean(pending);
  return <section className="panel foundry-panel" aria-labelledby="foundry-title">
    <div><h2 id="foundry-title">Foundry · Dungeon Crawler Carl</h2>
      <p>Resume your campaign with the same characters, scenes, and journals.</p></div>
    {!server ? <p>Checking Foundry…</p> : !server.configured
      ? <p>Foundry is not deployed yet.</p>
      : <>
        <p role="status">{pending ? (pending.action === 'start' ? 'Starting and restoring your save. This can take several minutes…' : 'Saving campaign and verifying backup…') : server.state === 'running' && !server.ready ? 'Preparing Foundry and HTTPS…' : `Server: ${server.state}`}</p>
        <div className="foundry-actions">
          <button className="btn" disabled={disabled || !['not-running', 'stopped'].includes(server.state || '')} onClick={() => void act('start')}>Start Foundry</button>
          <button className="btn" disabled={disabled || server.state !== 'running'} onClick={() => void act('stop')}>Save and stop</button>
          <button className="btn" disabled={disabled || server.state !== 'running'} onClick={() => void act('backup')}>Back up now</button>
          {server.state === 'running' && server.ready && !pending && server.url && <a className="btn" href={server.url} target="_blank" rel="noreferrer">Open Foundry</a>}
        </div>
        <p>Save and stop verifies your campaign in S3, then removes the temporary server and disk. Only saved files remain between sessions.</p>
      </>}
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
