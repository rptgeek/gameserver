#!/usr/bin/env bash
# Termination is permitted only after a complete, verified save in S3.
set -euo pipefail
umask 077
action="${1:-}"
[[ "$action" == backup || "$action" == stop ]] || { echo 'Unsupported action' >&2; exit 2; }
exec 9>/run/lock/foundry-operation.lock
flock -n 9 || { echo 'Another Foundry operation is in progress' >&2; exit 3; }
source /etc/foundry-host.env
[[ -f /srv/foundry/userdata/Config/options.json ]] || { echo 'Foundry data is missing' >&2; exit 4; }
was_running=0
systemctl is-active --quiet foundry && was_running=1
resume_on_exit() {
  local code=$?
  if [[ "$was_running" == 1 ]]; then systemctl start foundry || true; fi
  exit "$code"
}
trap resume_on_exit EXIT
systemctl stop foundry
# systemd must not have resorted to SIGKILL: that would invalidate a clean backup.
[[ "$(systemctl show foundry -p Result --value)" == success ]] || { echo 'Foundry did not shut down cleanly' >&2; exit 5; }
sync
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
key="snapshots/${stamp}-$(cat /proc/sys/kernel/random/uuid).tar.gz"
archive="$(mktemp /var/tmp/foundry-save.XXXXXX.tar.gz)"
tar -C /srv/foundry -czf "$archive" userdata
tar -tzf "$archive" >/dev/null
local_hash="$(sha256sum "$archive" | cut -d' ' -f1)"
aws s3 cp "$archive" "s3://${BACKUP_BUCKET}/${key}" --only-show-errors --checksum-algorithm SHA256
remote_hash="$(aws s3 cp "s3://${BACKUP_BUCKET}/${key}" - --only-show-errors | sha256sum | cut -d' ' -f1)"
[[ "$local_hash" == "$remote_hash" ]] || { echo 'Stored backup checksum mismatch' >&2; exit 6; }
printf '{"key":"%s","sha256":"%s","verifiedAt":"%s"}\n' "$key" "$local_hash" "$(date -u +%FT%TZ)" > /srv/foundry/last-backup.json
aws s3 cp /srv/foundry/last-backup.json "s3://${BACKUP_BUCKET}/last-backup.json" --only-show-errors
aws s3 cp "s3://${BACKUP_BUCKET}/last-backup.json" - --only-show-errors | cmp - /srv/foundry/last-backup.json
rm -f "$archive"
if [[ "$action" == stop ]]; then
  # Disconnect HTTPS before releasing the public IP; it must never point at an
  # address subsequently assigned to somebody else's server.
  cf_file="$(mktemp /var/tmp/foundry-origin.XXXXXX.json)"
  aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" > "$cf_file"
  etag="$(jq -r .ETag "$cf_file")"
  jq '.DistributionConfig | .Origins.Items[0].DomainName = "foundry-not-running.invalid"' "$cf_file" > "${cf_file}.update"
  aws cloudfront update-distribution --id "$DISTRIBUTION_ID" --if-match "$etag" --distribution-config "file://${cf_file}.update" > /dev/null
  aws cloudfront wait distribution-deployed --id "$DISTRIBUTION_ID"
  rm -f "$cf_file" "${cf_file}.update"
  # Let SSM report success first. The launch template sets OS shutdown to TERMINATE.
  shutdown -h +1 'Foundry save verified in S3; ending this temporary server'
  was_running=0
  echo 'Backup verified; shutdown scheduled in one minute.'
else
  echo 'Backup verified; restarting Foundry if it was running.'
fi
