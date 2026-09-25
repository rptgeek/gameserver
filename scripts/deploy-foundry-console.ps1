$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$deploymentDir = Join-Path $repoRoot '.codex-temp/console-deploy'
New-Item -ItemType Directory -Force (Join-Path $deploymentDir 'backend') | Out-Null
function Check-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed" } }
$stackJson = & aws cloudformation describe-stacks --stack-name gameserver-dev --region us-east-1 --output json --no-cli-pager
Check-Exit 'Inspect console stack'
$outputs = @{}
($stackJson | ConvertFrom-Json).Stacks[0].Outputs | ForEach-Object { $outputs[$_.OutputKey] = $_.OutputValue }
$functionName = 'gameserver-dev-backend'
# Keep an exact rollback package before updating the existing Lambda.
$codeUrl = & aws lambda get-function --function-name $functionName --region us-east-1 --query Code.Location --output text --no-cli-pager
Check-Exit 'Read previous Lambda package'
Invoke-WebRequest -Uri $codeUrl -OutFile (Join-Path $deploymentDir 'previous-backend.zip')
& aws s3 sync "s3://$($outputs.FrontendBucketName)" (Join-Path $deploymentDir 'previous-frontend') --only-show-errors
Check-Exit 'Back up frontend'
Push-Location $repoRoot
try {
  & npm run build --prefix backend
  Check-Exit 'Backend typecheck'
  & node infra/node_modules/esbuild/bin/esbuild backend/src/lambda.ts --bundle --platform=node --target=node20 --format=cjs "--outfile=$deploymentDir/backend/index.js"
  Check-Exit 'Backend bundle'
  Copy-Item -LiteralPath infra/assets/bootstrap.sh.tmpl -Destination (Join-Path $deploymentDir 'backend/bootstrap.sh.tmpl')
  Compress-Archive -Path (Join-Path $deploymentDir 'backend/*') -DestinationPath (Join-Path $deploymentDir 'backend.zip') -Force
  $env:VITE_API_BASE_URL = $outputs.ApiBaseUrl
  $env:VITE_COGNITO_USER_POOL_ID = $outputs.UserPoolId
  $env:VITE_COGNITO_USER_POOL_CLIENT_ID = $outputs.UserPoolClientId
  $env:VITE_COGNITO_REGION = 'us-east-1'
  $env:VITE_COGNITO_DOMAIN = $outputs.CognitoDomain
  $env:VITE_COGNITO_REDIRECT_SIGN_IN = "$($outputs.CloudFrontUrl)/"
  $env:VITE_COGNITO_REDIRECT_SIGN_OUT = "$($outputs.CloudFrontUrl)/"
  & npm run typecheck --prefix frontend
  Check-Exit 'Frontend typecheck'
  & npm run build --prefix frontend
  Check-Exit 'Frontend build'
  & aws lambda update-function-code --function-name $functionName --region us-east-1 --zip-file "fileb://$deploymentDir/backend.zip" --query '{Status:LastUpdateStatus,CodeSha256:CodeSha256}' --output json --no-cli-pager
  Check-Exit 'Deploy backend'
  & aws lambda wait function-updated-v2 --function-name $functionName --region us-east-1
  Check-Exit 'Wait for backend'
  $health = Invoke-RestMethod -Uri "$($outputs.ApiBaseUrl)/health"
  if ($health.status -ne 'ok') { throw 'Deployed backend health check failed; restore previous-backend.zip' }
  # Publish hashed assets before the entry page. Keep old assets for open browsers.
  & aws s3 sync frontend/dist "s3://$($outputs.FrontendBucketName)" --exclude index.html --cache-control 'public,max-age=31536000,immutable' --only-show-errors
  Check-Exit 'Publish frontend assets'
  & aws s3 cp frontend/dist/index.html "s3://$($outputs.FrontendBucketName)/index.html" --cache-control 'no-cache' --content-type text/html --only-show-errors
  Check-Exit 'Publish frontend entry'
  $resourcesJson = & aws cloudformation list-stack-resources --stack-name gameserver-dev --region us-east-1 --output json --no-cli-pager
  Check-Exit 'Find frontend distribution'
  $distribution = ($resourcesJson | ConvertFrom-Json).StackResourceSummaries | Where-Object ResourceType -eq 'AWS::CloudFront::Distribution'
  & aws cloudfront create-invalidation --distribution-id $distribution.PhysicalResourceId --paths '/' '/index.html' --query 'Invalidation.{Id:Id,Status:Status}' --output json --no-cli-pager
  Check-Exit 'Invalidate frontend entry'
} finally { Pop-Location }
