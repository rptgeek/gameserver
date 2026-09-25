param(
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$SystemPath
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $InstallerPath))
try {
  $reader = [IO.StreamReader]::new($archive.GetEntry('resources/app/package.json').Open())
  try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($manifest.version -ne '14.368.0') { throw 'Expected Foundry 14.368.' }
} finally { $archive.Dispose() }
if (-not (Test-Path -LiteralPath (Join-Path $SystemPath 'system.json'))) { throw 'Missing DCC system.json' }
$privateDir = Join-Path $repoRoot '.codex-temp/foundry-deploy'
New-Item -ItemType Directory -Force $privateDir | Out-Null

function Get-OrCreateSecureParameter([string]$Name, [string]$InitialValue) {
  # Discover names without printing or retrieving values that are not needed.
  $namesJson = & aws ssm describe-parameters --region us-east-1 --parameter-filters "Key=Name,Option=Equals,Values=$Name" --query 'Parameters[].Name' --output json --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Parameter Store' }
  if (($namesJson | ConvertFrom-Json).Count -eq 0) {
    $payload = @{ Name=$Name; Value=$InitialValue; Type='SecureString'; Tier='Standard' } | ConvertTo-Json -Compress
    $payloadPath = Join-Path $privateDir 'parameter.json'
    [IO.File]::WriteAllText($payloadPath, $payload)
    try {
      & aws ssm put-parameter --region us-east-1 --cli-input-json "file://$payloadPath" --no-cli-pager | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Unable to create secure parameter' }
    } finally { Remove-Item -LiteralPath $payloadPath }
  }
  $result = & aws ssm get-parameter --region us-east-1 --name $Name --with-decryption --query Parameter.Value --output text --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read secure parameter' }
  return $result
}

$token = Get-OrCreateSecureParameter '/gameserver/dev/foundry/origin-token' ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant())
$env:FOUNDRY_INSTALLER_PATH = (Resolve-Path -LiteralPath $InstallerPath).Path
$env:FOUNDRY_SYSTEM_PATH = (Resolve-Path -LiteralPath $SystemPath).Path
Push-Location (Join-Path $repoRoot 'infra')
try {
  & npx cdk deploy --app 'npx ts-node --prefer-ts-exts bin/foundry.ts' --parameters "OriginToken=$token" --require-approval never --outputs-file (Join-Path $privateDir 'outputs.json')
  if ($LASTEXITCODE -ne 0) { throw 'Foundry stack deployment failed' }
} finally { Pop-Location; $token=$null }
