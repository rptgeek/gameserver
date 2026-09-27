const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createFoundryRouter } = require('../dist/foundry.js');
const configuration = { deploymentId: 'test-foundry', launchTemplateId: 'lt-123abc', url: 'https://example123.cloudfront.net/', commandDocument: 'foundry-save' };

async function harness(t, { state = 'not-running', leaseFails = false, commandFails = false, configured = true, runFails = false, lifecycle } = {}) {
  const calls = [];
  const ec2 = { send: async command => {
    calls.push(command);
    if (command.constructor.name === 'DescribeInstancesCommand') return { Reservations: state === 'not-running' ? [] : [{ Instances: [{ InstanceId: 'i-123abc', State: { Name: state }, InstanceLifecycle: lifecycle, LaunchTime: new Date('2026-09-27T18:00:00Z') }] }] };
    if (command.constructor.name === 'RunInstancesCommand' && runFails) {
      const e = new Error('There is no Spot capacity available'); e.name = 'InsufficientInstanceCapacity'; e.$metadata = { httpStatusCode: 400 }; throw e;
    }
    return {};
  } };
  const ssm = { send: async command => {
    calls.push(command);
    if (command.constructor.name === 'GetParameterCommand') {
      if (!configured) { const e = new Error('missing'); e.name = 'ParameterNotFound'; throw e; }
      return { Parameter: { Value: JSON.stringify(configuration) } };
    }
    if (commandFails) throw new Error('SSM unavailable');
    if (command.constructor.name === 'SendCommandCommand') return { Command: { CommandId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
    return { DocumentName: 'foundry-save', Status: 'Success', ResponseCode: 0 };
  } };
  const ddb = { send: async command => { calls.push(command); if (leaseFails) { const e = new Error('locked'); e.name = 'ConditionalCheckFailedException'; throw e; } return {}; } };
  const app = express(); app.use(express.json()); app.use('/v1/foundry', createFoundryRouter(ec2, ssm, ddb, 'operations'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/v1/foundry`;
  const action = (value, extra = {}) => fetch(`${base}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: value, ...extra }) });
  return { calls, action, base };
}
test('start launches one temporary instance from the approved template', async t => {
  const h = await harness(t); assert.equal((await h.action('start')).status, 202);
  const launches = h.calls.filter(c => c.constructor.name === 'RunInstancesCommand');
  assert.equal(launches.length, 1); assert.equal(launches[0].input.MaxCount, 1);
  assert.equal(launches[0].input.LaunchTemplate.LaunchTemplateId, 'lt-123abc');
  assert(h.calls.some(c => c.constructor.name === 'PutCommand'));
});
test('a concurrent launch cannot create a second server', async t => {
  const h = await harness(t, { leaseFails: true }); assert.equal((await h.action('start')).status, 409);
  assert(!h.calls.some(c => c.constructor.name === 'RunInstancesCommand'));
});
test('stop only sends the fixed save command, never EC2 termination', async t => {
  const h = await harness(t, { state: 'running' }); assert.equal((await h.action('stop')).status, 202);
  const command = h.calls.find(c => c.constructor.name === 'SendCommandCommand');
  assert.deepEqual(command.input.Parameters, { action: ['stop'] });
  assert.equal(command.input.DocumentName, 'foundry-save');
  assert(!h.calls.some(c => /Terminate|StopInstances/.test(c.constructor.name)));
});
test('an SSM failure cannot fall back to direct termination', async t => {
  const h = await harness(t, { state: 'running', commandFails: true }); assert.equal((await h.action('stop')).status, 500);
  assert(!h.calls.some(c => /Terminate|StopInstances/.test(c.constructor.name)));
});
test('terminal commands remain queryable after the instance is gone', async t => {
  const h = await harness(t);
  const result = await fetch(`${h.base}/commands/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee?instanceId=i-123abc`);
  assert.equal(result.status, 200); assert.equal((await result.json()).status, 'Success');
});
test('unsupported actions cannot become shell commands', async t => {
  const h = await harness(t); assert.equal((await h.action('terminate; rm -rf /')).status, 400); assert.equal(h.calls.length, 0);
});
test('missing deployment is a normal status and prevents launch', async t => {
  const h = await harness(t, { configured: false }); assert.deepEqual(await (await fetch(h.base)).json(), { configured: false });
  assert.equal((await h.action('start')).status, 409);
});
test('on-demand is the default capacity and requests no spot market', async t => {
  const h = await harness(t); assert.equal((await h.action('start')).status, 202);
  const launch = h.calls.find(c => c.constructor.name === 'RunInstancesCommand');
  assert.equal(launch.input.InstanceMarketOptions, undefined);
});
test('spot capacity launches a one-time spot instance from the same template', async t => {
  const h = await harness(t); const result = await h.action('start', { capacity: 'spot' });
  assert.equal(result.status, 202); assert.equal((await result.json()).capacityType, 'spot');
  const launch = h.calls.find(c => c.constructor.name === 'RunInstancesCommand');
  assert.equal(launch.input.LaunchTemplate.LaunchTemplateId, 'lt-123abc');
  assert.deepEqual(launch.input.InstanceMarketOptions, { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } });
  assert.equal(launch.input.DisableApiTermination, false);
});
test('unknown capacity values are rejected before any AWS call', async t => {
  const h = await harness(t); assert.equal((await h.action('start', { capacity: 'dedicated' })).status, 400); assert.equal(h.calls.length, 0);
});
test('a rejected launch releases the lease so the user can retry immediately', async t => {
  const h = await harness(t, { runFails: true }); assert.equal((await h.action('start', { capacity: 'spot' })).status, 500);
  assert(h.calls.some(c => c.constructor.name === 'DeleteCommand'));
});
test('status reports capacity type and launch time', async t => {
  const h = await harness(t, { state: 'running', lifecycle: 'spot' });
  const body = await (await fetch(h.base)).json();
  assert.equal(body.capacityType, 'spot'); assert.equal(body.launchedAt, '2026-09-27T18:00:00.000Z');
});
