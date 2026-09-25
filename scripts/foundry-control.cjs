// Local administrator CLI using the same handlers as the authenticated website.
// Requires local AWS credentials, backend build/dependencies, and operations table.
const path = require('node:path');
const { createRequire } = require('node:module');
const requireBackend = createRequire(path.join(__dirname, '../backend/package.json'));
const express = requireBackend('express');
const { EC2Client } = requireBackend('@aws-sdk/client-ec2');
const { SSMClient } = requireBackend('@aws-sdk/client-ssm');
const { DynamoDBClient } = requireBackend('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = requireBackend('@aws-sdk/lib-dynamodb');
const { createFoundryRouter } = require('../backend/dist/foundry.js');
const region = process.env.AWS_REGION || 'us-east-1';
if (process.argv[2] === 'start' && !process.env.FOUNDRY_OPERATIONS_TABLE) {
  throw new Error('Set FOUNDRY_OPERATIONS_TABLE to the existing console operations table before starting');
}
const app = express(); app.use(express.json());
app.use('/v1/foundry', createFoundryRouter(new EC2Client({ region }), new SSMClient({ region }),
  DynamoDBDocumentClient.from(new DynamoDBClient({ region })), process.env.FOUNDRY_OPERATIONS_TABLE || 'unused-for-status'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const action = process.argv[2] || 'status';
    const base = `http://127.0.0.1:${server.address().port}/v1/foundry`;
    let response;
    if (action === 'status') response = await fetch(base);
    else if (action === 'command') response = await fetch(`${base}/commands/${encodeURIComponent(process.argv[3] || '')}?instanceId=${encodeURIComponent(process.argv[4] || '')}`);
    else response = await fetch(`${base}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    console.log(await response.text());
    if (!response.ok) process.exitCode = 1;
  } finally { server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
