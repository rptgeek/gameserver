"""Run the actual save script with isolated fake AWS/systemd; no cloud writes."""
import os
import pathlib
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
BASH = os.environ.get('BASH_EXE', r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else '/bin/bash')

def bash_path(path):
    value = pathlib.Path(path).as_posix()
    return '/' + value[0].lower() + value[2:] if len(value) > 1 and value[1] == ':' else value

class FoundrySaveTests(unittest.TestCase):
    def run_save(self, fault='', action='stop'):
        with tempfile.TemporaryDirectory(prefix='foundry-save-test-') as temp:
            root = pathlib.Path(temp)
            for part in ['data/userdata/Config', 'data/userdata/Data/worlds', 's3/snapshots', 'lock', 'tmp']:
                (root / part).mkdir(parents=True, exist_ok=True)
            (root / 'data/userdata/Config/options.json').write_text('{"port":30000}')
            (root / 'data/userdata/Data/worlds/test.json').write_text('{"character":"Carl","hp":12}')
            (root / 'host.env').write_text('export BACKUP_BUCKET=test\nexport DISTRIBUTION_ID=test\n')
            source = (REPO / 'infra/assets/foundry-operation.sh').read_text()
            base = bash_path(root)
            for old, new in [('/srv/foundry', base + '/data'), ('/etc/foundry-host.env', base + '/host.env'),
                             ('/run/lock', base + '/lock'), ('/var/tmp', base + '/tmp'),
                             ('$(cat /proc/sys/kernel/random/uuid)', 'test-uuid')]:
                source = source.replace(old, new)
            (root / 'save.sh').write_bytes(source.encode())
            wrapper = r'''
set -euo pipefail
export ROOT="__ROOT__" FAULT="__FAULT__"
systemctl() {
  printf '%s\n' "$*" >> "$ROOT/events"
  case "$1" in
    is-active) return 0;;
    show) if [[ "$FAULT" == unclean ]]; then echo timeout; else echo success; fi;;
  esac
}
shutdown() { echo TERMINATE >> "$ROOT/events"; }
flock() { return 0; }
aws() {
  if [[ "$1" == cloudfront ]]; then
    if [[ "$FAULT" == disconnect ]]; then return 33; fi
    if [[ "$2" == get-distribution-config ]]; then echo '{"ETag":"test","DistributionConfig":{}}'; fi
    if [[ "$2" == wait ]]; then echo DISCONNECTED >> "$ROOT/events"; fi
    return 0
  fi
  [[ "$1 $2" == 's3 cp' ]] || return 30
  local src="$3" dst="$4"
  if [[ "$FAULT" == upload && "$dst" == s3://test/snapshots/* ]]; then return 31; fi
  if [[ "$FAULT" == corrupt && "$src" == s3://test/snapshots/* ]]; then echo corrupted; return 0; fi
  if [[ "$FAULT" == pointer && "$dst" == s3://test/last-backup.json ]]; then return 32; fi
  src="${src/s3:\/\/test\//$ROOT/s3/}"
  dst="${dst/s3:\/\/test\//$ROOT/s3/}"
  if [[ "$dst" == '-' ]]; then cat "$src"; else cp "$src" "$dst"; fi
}
jq() { if [[ "$1" == '-r' ]]; then echo test; else echo '{}'; fi; }
export -f systemctl shutdown flock aws jq
bash "$ROOT/save.sh" "__ACTION__"
'''.replace('__ROOT__', base).replace('__FAULT__', fault).replace('__ACTION__', action)
            (root / 'wrapper.sh').write_bytes(wrapper.encode())
            result = subprocess.run([BASH, bash_path(root / 'wrapper.sh')], capture_output=True, text=True)
            events = (root / 'events').read_text() if (root / 'events').exists() else ''
            if fault:
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('TERMINATE', events)
                self.assertIn('start foundry', events)
                self.assertEqual((root / 's3/last-backup.json').exists(), fault == 'disconnect')
            else:
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue((root / 's3/last-backup.json').exists())
                if action == 'stop':
                    self.assertIn('TERMINATE', events)
                    self.assertLess(events.index('DISCONNECTED'), events.index('TERMINATE'))
                else:
                    self.assertNotIn('TERMINATE', events)
                    self.assertIn('start foundry', events)

    def test_verified_save_permits_termination(self): self.run_save()
    def test_upload_failure_preserves_runtime(self): self.run_save('upload')
    def test_checksum_mismatch_preserves_runtime(self): self.run_save('corrupt')
    def test_pointer_failure_preserves_runtime(self): self.run_save('pointer')
    def test_unclean_shutdown_preserves_runtime(self): self.run_save('unclean')
    def test_https_disconnect_failure_preserves_runtime(self): self.run_save('disconnect')
    def test_backup_restarts_without_terminating(self): self.run_save(action='backup')

if __name__ == '__main__': unittest.main()
