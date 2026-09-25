#!/usr/bin/env bash
set -euo pipefail
umask 077
dnf install -y nginx unzip xz jq util-linux

mkdir -p /srv/foundry
# A failed restore must never silently start a fresh campaign.
aws s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix last-backup.json --max-keys 1 > /tmp/foundry-save-list.json
if jq -e 'any(.Contents[]?; .Key == "last-backup.json")' /tmp/foundry-save-list.json >/dev/null; then
  aws s3 cp "s3://${BACKUP_BUCKET}/last-backup.json" /tmp/foundry-last-backup.json --only-show-errors
  save_key="$(jq -er '.key | select(test("^snapshots/[A-Za-z0-9_.-]+[.]tar[.]gz$"))' /tmp/foundry-last-backup.json)"
  save_hash="$(jq -er '.sha256 | select(test("^[a-f0-9]{64}$"))' /tmp/foundry-last-backup.json)"
  aws s3 cp "s3://${BACKUP_BUCKET}/${save_key}" /tmp/foundry-save.tar.gz --only-show-errors
  printf '%s  /tmp/foundry-save.tar.gz\n' "$save_hash" | sha256sum -c -
  tar -tzf /tmp/foundry-save.tar.gz >/dev/null
  tar -xzf /tmp/foundry-save.tar.gz --no-same-owner -C /srv/foundry
  [[ -f /srv/foundry/userdata/Config/options.json ]] || { echo 'Save missing Foundry configuration' >&2; exit 1; }
  rm /tmp/foundry-save.tar.gz
else
  aws s3api list-objects-v2 --bucket "$BACKUP_BUCKET" --prefix snapshots/ --max-keys 1 > /tmp/foundry-snapshot-list.json
  if jq -e '.KeyCount > 0' /tmp/foundry-snapshot-list.json >/dev/null; then
    echo 'Snapshots exist without latest-save pointer; explicit recovery required.' >&2; exit 1
  fi
fi
id foundry >/dev/null 2>&1 || useradd --system --home-dir /srv/foundry --shell /sbin/nologin foundry
mkdir -p /srv/foundry/userdata/{Config,Data/systems,Logs} /opt/foundry /opt/node

NODE_VERSION=24.13.1
node_archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" -o "/tmp/${node_archive}"
curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/node-shasums.txt
(cd /tmp && grep " ${node_archive}$" node-shasums.txt | sha256sum -c -)
tar -xJf "/tmp/${node_archive}" --strip-components=1 -C /opt/node
aws s3 cp "$INSTALLER_URI" /tmp/foundry.zip --only-show-errors
unzip -q /tmp/foundry.zip 'resources/app/*' -d /opt/foundry
chmod 755 /opt/foundry /opt/node
chmod -R a+rX /opt/foundry/resources /opt/node
/opt/node/bin/node -e 'const p=require("/opt/foundry/resources/app/package.json"); if(p.version!=="14.368.0") throw Error("Unexpected Foundry version")'
# Preserve the system already on a recovered data disk; updates are a separate operation.
if [[ ! -f /srv/foundry/userdata/Data/systems/dcc-crawler/system.json ]]; then
  aws s3 cp "$SYSTEM_URI" /tmp/dcc-system.zip --only-show-errors
  mkdir -p /srv/foundry/userdata/Data/systems/dcc-crawler
  unzip -q /tmp/dcc-system.zip -d /srv/foundry/userdata/Data/systems/dcc-crawler
fi
aws ssm get-parameter --name "$ORIGIN_PARAMETER" --with-decryption --query Parameter.Value --output text > /root/foundry-origin-token
origin_token="$(cat /root/foundry-origin-token)"
cat > /etc/nginx/nginx.conf <<EOF
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log;
pid /run/nginx.pid;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
  server {
    listen 80 default_server;
    if (\$http_x_foundry_origin != "$origin_token") { return 403; }
    client_max_body_size 100m;
    location / {
      proxy_pass http://127.0.0.1:30000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
      proxy_set_header Host "$PUBLIC_HOST";
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      proxy_buffering off;
    }
  }
}
EOF
# Set network defaults only for a fresh installation. Keep recovered configuration intact.
if [[ ! -f /srv/foundry/userdata/Config/options.json ]]; then
  jq -n --arg hostname "$PUBLIC_HOST" '{port:30000,hostname:$hostname,proxyPort:443,proxySSL:true,upnp:false}' > /srv/foundry/userdata/Config/options.json
fi
chown -R foundry:foundry /srv/foundry/userdata
chown root:foundry /srv/foundry
chmod 750 /srv/foundry /srv/foundry/userdata /srv/foundry/userdata/Config
cat > /etc/systemd/system/foundry.service <<'EOF'
[Unit]
Description=Foundry Virtual Tabletop 14.368
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=foundry
Group=foundry
WorkingDirectory=/opt/foundry/resources/app
ExecStartPre=/usr/bin/test -f /srv/foundry/userdata/Config/options.json
ExecStart=/opt/node/bin/node /opt/foundry/resources/app/main.js --dataPath=/srv/foundry/userdata
Restart=always
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGTERM
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/foundry/userdata
[Install]
WantedBy=multi-user.target
EOF
printf 'export AWS_DEFAULT_REGION=%q\nexport BACKUP_BUCKET=%q\nexport DISTRIBUTION_ID=%q\n' "$AWS_DEFAULT_REGION" "$BACKUP_BUCKET" "$DISTRIBUTION_ID" > /etc/foundry-host.env
aws s3 cp "$OPERATIONS_URI" /usr/local/sbin/foundry-operation --only-show-errors
chmod 700 /usr/local/sbin/foundry-operation
nginx -t
systemctl daemon-reload
systemctl enable --now foundry nginx
# Rebind the stable HTTPS address to this temporary server, without a paid idle IP.
imds_token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
public_dns="$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" http://169.254.169.254/latest/meta-data/public-hostname)"
[[ "$public_dns" == ec2-*.compute-1.amazonaws.com ]] || { echo 'Unexpected public DNS name' >&2; exit 1; }
aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" > /root/foundry-cf.json
etag="$(jq -r .ETag /root/foundry-cf.json)"
jq --arg domain "$public_dns" '.DistributionConfig | .Origins.Items[0].DomainName = $domain' /root/foundry-cf.json > /root/foundry-cf-update.json
aws cloudfront update-distribution --id "$DISTRIBUTION_ID" --if-match "$etag" --distribution-config file:///root/foundry-cf-update.json > /dev/null
aws cloudfront wait distribution-deployed --id "$DISTRIBUTION_ID"
curl --fail --retry 20 --retry-connrefused --retry-delay 3 http://127.0.0.1:30000/ -o /dev/null
imds_token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)"
instance_id="$(curl -fsS -H "X-aws-ec2-metadata-token: $imds_token" http://169.254.169.254/latest/meta-data/instance-id)"
aws ec2 create-tags --resources "$instance_id" --tags Key=FoundryReady,Value=yes
rm -f /root/foundry-origin-token /root/foundry-cf.json /root/foundry-cf-update.json /tmp/foundry.zip /tmp/dcc-system.zip "/tmp/${node_archive}" /tmp/node-shasums.txt
echo 'Foundry installation complete. Activate the license and set a Foundry administrator password in the browser.'
