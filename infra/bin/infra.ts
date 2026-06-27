#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PlatformInfraStack, PlatformInfraStackProps } from '../lib/platform-stack';

const app = new cdk.App();

const parseCsv = (value: string | undefined): string[] | undefined => {
  if (!value) return undefined;
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : undefined;
};

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseJsonMap = (value: string | undefined): Record<string, string> | undefined => {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
};

const stage = process.env.STAGE ?? app.node.tryGetContext('stage') ?? 'dev';
const projectName = process.env.PROJECT_NAME ?? app.node.tryGetContext('projectName') ?? '7d2d';
const frontendDomainName = process.env.FRONTEND_DOMAIN_NAME ?? app.node.tryGetContext('frontendDomainName');
const apiDomainName = process.env.API_DOMAIN_NAME ?? app.node.tryGetContext('apiDomainName');
const cognitoDomainPrefix = process.env.COGNITO_DOMAIN_PREFIX ?? app.node.tryGetContext('cognitoDomainPrefix');
const backendImage = process.env.BACKEND_IMAGE ?? app.node.tryGetContext('backendImage');
const backendContainerPort = parseNumber(process.env.BACKEND_CONTAINER_PORT) ?? app.node.tryGetContext('backendContainerPort');
const backendCpu = parseNumber(process.env.BACKEND_CPU) ?? app.node.tryGetContext('backendCpu');
const backendMemoryMiB = parseNumber(process.env.BACKEND_MEMORY_MIB) ?? app.node.tryGetContext('backendMemoryMiB');
const backendDesiredCount = parseNumber(process.env.BACKEND_DESIRED_COUNT) ?? app.node.tryGetContext('backendDesiredCount');
const backendHealthCheckPath = process.env.BACKEND_HEALTH_CHECK_PATH ?? app.node.tryGetContext('backendHealthCheckPath');
const cognitoCallbackUrls = parseCsv(process.env.COGNITO_CALLBACK_URLS) ?? app.node.tryGetContext('cognitoCallbackUrls');
const cognitoLogoutUrls = parseCsv(process.env.COGNITO_LOGOUT_URLS) ?? app.node.tryGetContext('cognitoLogoutUrls');
const apiAllowedOrigins = parseCsv(process.env.API_ALLOWED_ORIGINS) ?? app.node.tryGetContext('apiAllowedOrigins');
const backendEnvironment = parseJsonMap(process.env.BACKEND_CONTAINER_ENV) ?? {};

const stackProps: PlatformInfraStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  stage,
  projectName,
  frontendDomainName,
  apiDomainName,
  cognitoDomainPrefix,
  backendImage,
  backendContainerPort,
  backendCpu,
  backendMemoryMiB,
  backendDesiredCount,
  backendHealthCheckPath,
  cognitoCallbackUrls,
  cognitoLogoutUrls,
  apiAllowedOrigins,
  backendEnvironment,
};

new PlatformInfraStack(app, `${projectName}-${stage}`, stackProps);
