# Security Model: Cognito, Permissions, and Audit

## Principles

- All control-plane endpoints require Cognito-authenticated identity.
- Least privilege by action and environment.
- No direct instance credentials in control-plane config.
- Every mutate operation is identity-bound and auditable.

## Identity and role model

### Cognito user pools and groups

Groups map to a logical role in control-plane:

- `GameOpsAdmin`
- `GameOpsOperator`
- `GameOpsReadOnly`
- `GameOpsAuditor`

JWT claim used:

- `cognito:groups`
- optional custom claim: `custom:game_roles`

### Action mapping

| Action | Description | Admin | Operator | ReadOnly | Auditor |
| --- | --- | --- | --- | --- | --- |
| `instances:list` | list active instances | yes | yes | yes | yes |
| `instances:get` | inspect instance status/logs | yes | yes | yes | yes |
| `instances:start` | start instance with profile | yes | yes | no | no |
| `instances:stop` | stop/terminate instance | yes | yes* | no | no |
| `instances:force-stop` | stop + force deletion of stale tracking/state | yes | no | no | no |
| `operations:get` | operation status | yes | yes | yes | yes |
| `profiles:list/get` | view profile definitions | yes | yes | yes | yes |
| `profiles:update` | create or edit profiles | yes | no | no | no |
| `logs:get` | runtime/cloud-init logs | yes | yes | yes | yes |
| `audit:get` | audit query | yes | no | no | yes |
| `migration:run` | run legacy migration jobs | yes | no | no | no |

`*` Operator stop actions can be constrained by policy:

- allow stop only on instances owned by same team.
- deny mass stop operations unless request flag `force` is true and second approval is present.

## Control-plane and AWS permission model

### Control-plane execution role

The control-plane compute identity should only have:

- `ec2:RunInstances`
- `ec2:DescribeInstances`
- `ec2:TerminateInstances`
- `ec2:CreateTags`
- `ssm:SendCommand`
- `ssm:GetCommandInvocation`
- `autoscaling:Describe*` (optional)
- `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` scoped to world bucket/state prefixes (if API touches logs/artifacts)
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`

### Instance runtime role (existing)

Instance profile attached to spot servers should be scoped to:

- `s3:ListBucket` on allowed prefixes
- `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` for `.../world-prefix/<game>/state/`
- KMS access if bucket encryption keys are customer-managed.

## Audit and traceability

### Required audit events

Record one immutable row for every operation state transition:

- operation id
- actor (sub/email)
- role and groups
- source IP + user agent
- request id/idempotency key
- resolved profile/game
- effective AWS calls
- terminal status and error code

### Audit sinks

- CloudTrail (control-plane AWS calls).
- Control-plane operation table (durable store).
- Optional SIEM stream for operation/log references and SSM command IDs.
- Optional secure archive in S3 for state migration snapshots.

### Retention

- Audit records: 365 days minimum.
- CloudTrail (at least read/write events covering EC2/SSM/S3): 90 days minimum.
- SSM command output: 30 days minimum.

## Environment and secret controls

- No secrets in game profile files.
- Keep AWS credentials out of process args and logs.
- Use AWS managed temporary creds (assumed roles only).
- Validate `WORLD_BUCKET` and profile source path allow-list in API to avoid SSRF/path traversal.
- Enforce TLS for all control-plane ingress.

## Security hardening checklist

- [ ] Enforce token audience/issuer and short access token TTL.
- [ ] Require per-endpoint authz checks before request fan-out.
- [ ] Add request schema validation to reject unexpected profile keys.
- [ ] Require idempotency key for all mutating endpoints.
- [ ] Sign and store operation events before and after AWS calls.
- [ ] Add explicit allowlist for `--profile` and `--size` in launch wrappers.
- [ ] Emit alert on `STOPPED` transition without successful S3 upload.
- [ ] Enforce explicit `allowDuplicate=false` default to prevent accidental overprovisioning.
