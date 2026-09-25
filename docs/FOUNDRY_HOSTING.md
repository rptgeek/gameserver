# Foundry sessions backed by S3

The existing Game Fleet Console gains a Foundry panel. Each session launches one
on-demand t3.medium in us-east-1, installs licensed Foundry 14.368 with Node 24.13.1,
restores the last verified save, and serves it through a stable CloudFront HTTPS URL.
The initial DCC system is packaged from the separate dcc-foundry-vtt repository.

Save and stop closes Foundry, archives **all userdata** (Config, Data, Logs), checks
the archive, uploads an immutable snapshot, downloads it to verify SHA-256, and
atomically updates and reads back last-backup.json. It disconnects the CloudFront
origin and waits for that change to propagate before scheduling an OS shutdown,
so the HTTPS address cannot point at a subsequently reassigned IP. The launch
template sets that shutdown to **terminate**. The 32-GiB
encrypted root disk and temporary public IP disappear with the instance.

There is no idle EC2 instance, EBS volume, Elastic IP, NAT gateway, or load balancer.
S3 retains the saves and installation assets. A Standard encrypted SSM parameter
holds the CloudFront origin token. Do not put the installer,
license, credentials, or campaign data in Git.

## Failure behavior

- Upload, checksum, latest-pointer, or clean-shutdown failure prevents termination.
  The service is restarted when it was previously running. The instance remains
  billable until recovery; no force-terminate fallback exists in the Foundry UI.
- Failed downloads/checksums abort startup. Existing snapshots without a latest
  pointer require explicit recovery; they never become an empty campaign.
- Start calls use a DynamoDB lease and an EC2 client token to prevent duplicate
  runtimes. A failed launch may require a three-minute wait before retrying.
- A failure of the EC2 host itself can lose changes since the last verified backup.
  Use Back up now at a natural break for long sessions; it briefly disconnects players.
- API termination protection and an IAM denial protect Foundry from the legacy
  console termination path. An explicit manual override can still destroy unsaved data.
- Snapshots are retained indefinitely by default. Never prune the snapshot named
  by last-backup.json. Old noncurrent object versions expire after 90 days.

## Deployment

Use `scripts/deploy-foundry.ps1` from PowerShell with the installer path and the DCC
system directory. It validates the package version, creates the encrypted
origin token if missing, and deploys the separate
`gameserver-foundry-dev` CDK stack. The stack creates a launch template; it does not
start a session. `scripts/deploy-foundry-console.ps1` backs up the existing Lambda
package and frontend, builds both, updates the existing console, checks API health,
and publishes hashed frontend assets before the new entry page. It preserves old
assets for browsers with an older page open. Rollback copies are under
`.codex-temp/console-deploy/`; repeat deployments replace those local copies.

The stack defaults to Gary's existing us-east-1 default VPC/subnet. It can be
parameterized for another subnet within that region. The API reads the non-secret
configuration at `/gameserver/dev/foundry/config`.

CloudFront's origin is rebound to the new EC2 hostname at each launch. This avoids
a paid idle static IP, but adds a few minutes to startup. Do not edit the Foundry
distribution during bootstrap. A stack update that changes the distribution may
require rebinding its origin for an already-running session. Viewer traffic uses
HTTPS; the origin hop uses HTTP limited to the CloudFront managed prefix list and
an unguessable origin header. Foundry's port and SSH are not open publicly.

The site uses Foundry's own administrator and world-user authentication, without
an additional browser Basic Authentication prompt. On first use, enter the purchased
license, accept Foundry's terms, set an administrator password, and create a world
using `dcc-crawler`. Players use their Foundry world credentials; do not share the
administrator password. Save and stop preserves all Foundry credentials and configuration.
The former `/gameserver/dev/foundry/access` parameter is unused.

## Recovery and verification

1. Stop any active session safely before choosing a different save.
2. Download the selected `snapshots/*.tar.gz` into a temporary recovery directory;
   inspect it and validate its SHA-256 and archive contents.
3. Preserve the current last-backup.json (S3 versioning also retains prior versions).
   Replace it with JSON containing the selected `key`, `sha256`, and `verifiedAt`.
4. Start Foundry. Verify the expected configuration, users, characters, and scenes.
   Do not overwrite good saves until recovery is verified.

Acceptance for infrastructure: save a test marker, terminate the instance, confirm
its EBS volume is gone, start a different instance, and confirm the restored marker
and configuration hashes. Acceptance for the campaign additionally requires a
licensed world and a character/journal save-and-restore test after first activation.

## Costs

At the verified us-east-1 rate, t3.medium Linux costs $0.0416 per running hour.
Temporary public IPv4 is $0.005/hour; 32 GiB gp3 is approximately $0.0035/hour.
Three four-hour sessions are approximately $0.60 for those runtime resources,
plus startup/testing time, S3 storage/requests and CloudFront usage. S3 costs grow
with the total retained snapshot size. This is an estimate, not a spending cap;
use Save and stop after each session. CPU credits use standard mode to avoid
unlimited-mode CPU credit charges. No game runtime is created merely by deploying.

## Local checks

```
cd backend && npm ci && npm run build && node --test tests/foundry.test.cjs
cd ../frontend && npm ci && npm run typecheck && npm test && npm run build
cd .. && python scripts/test-foundry-save.py
```

For local administrator testing, `node scripts/foundry-control.cjs status` uses the
same handlers with local AWS credentials. For `start`, set `FOUNDRY_OPERATIONS_TABLE`
to the table name in the existing backend Lambda's `OPERATIONS_TABLE_NAME` variable.
The CLI supports `start`, `stop`, `backup`, and `command <commandId> <instanceId>`.

The save tests execute the real shell script against isolated fake AWS/systemd
commands, covering successful saves and failures at shutdown, upload, checksum and
pointer publication, and HTTPS disconnection. They never contact AWS or shut down
the test machine.
