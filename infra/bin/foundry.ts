#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FoundryStack } from '../lib/foundry-stack';

const app = new cdk.App();
new FoundryStack(app, 'gameserver-foundry-dev', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  installerPath: process.env.FOUNDRY_INSTALLER_PATH,
  systemPath: process.env.FOUNDRY_SYSTEM_PATH,
});
