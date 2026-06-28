export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? "3000"),
  awsRegion: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",

  auth: {
    cognitoRegion: process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    userPoolId: process.env.COGNITO_USER_POOL_ID?.trim(),
    clientId: (
      process.env.COGNITO_CLIENT_ID ??
      process.env.COGNITO_USER_POOL_CLIENT_ID
    )?.trim(),
    issuerTemplate: process.env.COGNITO_ISSUER,
    authDisabled: process.env.AUTH_DISABLED === "true",
    defaultRole: process.env.DEFAULT_AUTH_ROLE ?? "admin",
  },

  tables: {
    games: process.env.DYNAMO_TABLE_GAMES ?? process.env.GAMES_TABLE_NAME ?? "games",
    instances: process.env.DYNAMO_TABLE_INSTANCES ?? process.env.INSTANCES_TABLE_NAME ?? "instances",
    operations: process.env.DYNAMO_TABLE_OPERATIONS ?? process.env.OPERATIONS_TABLE_NAME ?? "operations",
    configHistory: process.env.DYNAMO_TABLE_CONFIG_HISTORY ?? process.env.CONFIG_HISTORY_TABLE_NAME ?? "config_history",
    instanceConfig: process.env.DYNAMO_TABLE_INSTANCE_CONFIG ?? process.env.INSTANCE_CONFIG_TABLE_NAME ?? "instance_config",
  },

  ec2: {
    defaultInstanceType: process.env.EC2_DEFAULT_INSTANCE_TYPE ?? "t3.micro",
    defaultAmiId: process.env.EC2_DEFAULT_AMI_ID,
    defaultSubnetId: process.env.EC2_DEFAULT_SUBNET_ID,
    defaultSecurityGroupIds: (process.env.EC2_DEFAULT_SECURITY_GROUP_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  },

  ssm: {
    bootstrapDocumentName: process.env.SSM_BOOTSTRAP_DOCUMENT ?? "7d2d-bootstrap",
    updateDocumentName: process.env.SSM_UPDATE_DOCUMENT ?? "7d2d-update",
    backupDocumentName: process.env.SSM_BACKUP_DOCUMENT ?? "7d2d-backup",
  },

  logs: {
    serverPrefix: process.env.CW_LOG_GROUP_SERVER_PREFIX ?? "/7d2d/server",
    bootstrapPrefix: process.env.CW_LOG_GROUP_BOOTSTRAP_PREFIX ?? "/7d2d/bootstrap",
  },
};
