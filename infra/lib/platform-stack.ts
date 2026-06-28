import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayAuthorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigatewayIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'node:path';

export interface PlatformInfraStackProps extends cdk.StackProps {
  readonly stage: string;
  readonly projectName?: string;
  readonly frontendDomainName?: string;
  readonly apiDomainName?: string;
  readonly cognitoDomainPrefix?: string;
  readonly cognitoCallbackUrls?: string[];
  readonly cognitoLogoutUrls?: string[];
  readonly apiAllowedOrigins?: string[];
  readonly backendCpu?: number;
  readonly backendMemoryMiB?: number;
  readonly backendEnvironment?: { [name: string]: string };
}

const toSafePrefix = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);

export class PlatformInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PlatformInfraStackProps) {
    super(scope, id, props);

    const stage = props.stage;
    const project = props.projectName ?? '7d2d';
    const prefix = `${project}-${stage}`.toLowerCase();
    const frontendHost = props.frontendDomainName
      ? `https://${props.frontendDomainName}`
      : 'http://localhost:3000';
    const bootstrapDocumentName = `${prefix}-7d2d-bootstrap`;
    const updateDocumentName = `${prefix}-7d2d-update`;
    const backupDocumentName = `${prefix}-7d2d-backup`;

    const callbackUrls =
      props.cognitoCallbackUrls && props.cognitoCallbackUrls.length > 0
        ? props.cognitoCallbackUrls
        : [`${frontendHost}/auth/callback`, `${frontendHost}/`];
    const logoutUrls =
      props.cognitoLogoutUrls && props.cognitoLogoutUrls.length > 0
        ? props.cognitoLogoutUrls
        : [frontendHost, `${frontendHost}/logout`];
    const apiAllowedOrigins =
      props.apiAllowedOrigins && props.apiAllowedOrigins.length > 0
        ? props.apiAllowedOrigins
        : ['http://localhost:3000', frontendHost];

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${prefix}-users`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
      },
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        callbackUrls,
        logoutUrls,
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
      },
    });

    new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: toSafePrefix(`${props.cognitoDomainPrefix ?? `${prefix}-auth`}`),
      },
    });

    const gamesTable = new dynamodb.Table(this, 'GamesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const instancesTable = new dynamodb.Table(this, 'InstancesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const operationsTable = new dynamodb.Table(this, 'OperationsTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const configHistoryTable = new dynamodb.Table(this, 'ConfigHistoryTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const instanceConfigTable = new dynamodb.Table(this, 'InstanceConfigTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const backendLambdaRole = new iam.Role(this, 'BackendLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: `${prefix}-backend-lambda-role`,
      description: 'Runtime role for backend API Lambda',
    });

    backendLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:BatchGetItem',
          'dynamodb:BatchWriteItem',
          'dynamodb:DeleteItem',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:Scan',
          'dynamodb:UpdateItem',
        ],
        resources: [
          gamesTable.tableArn,
          instancesTable.tableArn,
          operationsTable.tableArn,
          configHistoryTable.tableArn,
          instanceConfigTable.tableArn,
        ],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Ec2Calls',
        effect: iam.Effect.ALLOW,
        actions: [
          'ec2:DescribeInstances',
          'ec2:DescribeInstanceStatus',
          'ec2:DescribeSpotPriceHistory',
          'ec2:DescribeImages',
          'ec2:DescribeSubnets',
          'ec2:RunInstances',
          'ec2:StopInstances',
          'ec2:TerminateInstances',
          'ec2:StartInstances',
          'ec2:RebootInstances',
          'ec2:CreateTags',
        ],
        resources: ['*'],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassIamRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: ['*'],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SsmCalls',
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:SendCommand',
          'ssm:GetCommandInvocation',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:DescribeParameters',
          'ssm:GetParameterHistory',
          'ssm:DescribeInstanceInformation',
        ],
        resources: ['*'],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogs',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:DescribeLogStreams',
          'logs:GetLogEvents',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:CreateLogGroup',
        ],
        resources: ['*'],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WorldConfigS3Access',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: ['arn:aws:s3:::*/*'],
      }),
    );

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WorldConfigS3ListAccess',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: ['arn:aws:s3:::*'],
      }),
    );

    const bootstrapDocument = new ssm.CfnDocument(this, '7d2dBootstrapDocument', {
      documentType: 'Command',
      name: bootstrapDocumentName,
      content: {
        schemaVersion: '2.2',
        description: 'No-op fallback bootstrap document.',
        parameters: {
          action: {
            type: 'String',
            description: 'Action selector',
            default: 'bootstrap',
          },
        },
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'RunNoop',
            inputs: {
              runCommand: ['echo "Bootstrap action requested: {{ action }}"'],
            },
          },
        ],
      },
    });

    const updateDocument = new ssm.CfnDocument(this, '7d2dUpdateDocument', {
      documentType: 'Command',
      name: updateDocumentName,
      content: {
        schemaVersion: '2.2',
        description: 'Generic no-op configuration update fallback document.',
        parameters: {
          action: {
            type: 'String',
            description: 'Action selector',
            default: 'update',
          },
        },
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'RunNoop',
            inputs: {
              runCommand: ['echo "Config update requested: {{ action }}"'],
            },
          },
        ],
      },
    });

    const backupDocument = new ssm.CfnDocument(this, '7d2dBackupDocument', {
      documentType: 'Command',
      name: backupDocumentName,
      content: {
        schemaVersion: '2.2',
        description: 'Backup action for 7d2d game worlds.',
        parameters: {
          action: {
            type: 'String',
            description: 'Action selector',
            default: 'backup',
          },
        },
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'RunBackup',
            inputs: {
              runCommand: [
                'if ls /opt/*-tools/upload-state.sh >/dev/null 2>&1; then',
                '  for script in /opt/*-tools/upload-state.sh; do',
                '    bash "${script}" || true',
                '  done',
                'else',
                '  echo "No upload-state scripts found"',
                'fi',
              ],
            },
          },
        ],
      },
    });

    new logs.LogRetention(this, 'GameBootstrapLogRetention', {
      logGroupName: '/7d2d/bootstrap',
      retention: logs.RetentionDays.THREE_DAYS,
    });

    new logs.LogRetention(this, 'GameServerLogRetention', {
      logGroupName: '/7d2d/server',
      retention: logs.RetentionDays.THREE_DAYS,
    });

    backendLambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }),
    );

    const backendEnv = {
      NODE_ENV: stage,
      APP_STAGE: stage,
      APP_NAME: project,
      FRONTEND_ORIGIN: frontendHost,
      COGNITO_USER_POOL_ID: userPool.userPoolId,
      COGNITO_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      COGNITO_REGION: cdk.Stack.of(this).region,
      COGNITO_ISSUER: `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${userPool.userPoolId}`,
      GAMES_TABLE_NAME: gamesTable.tableName,
      INSTANCES_TABLE_NAME: instancesTable.tableName,
      OPERATIONS_TABLE_NAME: operationsTable.tableName,
      CONFIG_HISTORY_TABLE_NAME: configHistoryTable.tableName,
      INSTANCE_CONFIG_TABLE_NAME: instanceConfigTable.tableName,
      SSM_BOOTSTRAP_DOCUMENT: bootstrapDocumentName,
      SSM_UPDATE_DOCUMENT: updateDocumentName,
      SSM_BACKUP_DOCUMENT: backupDocumentName,
      ...(props.backendEnvironment ?? {}),
    };

    const backendFunction = new lambdaNodejs.NodejsFunction(this, 'BackendFunction', {
      functionName: `${prefix}-backend`,
      memorySize: props.backendMemoryMiB ?? 768,
      timeout: cdk.Duration.seconds(30),
      environment: backendEnv,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '../../backend/src/lambda.ts'),
      projectRoot: path.join(__dirname, '../..'),
      bundling: {
        forceDockerBundling: false,
        commandHooks: {
          beforeBundling() {
            return [];
          },
          beforeInstall() {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string) {
            return [
              `cp ${path.join(inputDir, 'infra/assets/bootstrap.sh.tmpl')} ${path.join(outputDir, 'bootstrap.sh.tmpl')}`,
            ];
          },
        },
      },
      role: backendLambdaRole,
      logRetention: logs.RetentionDays.THREE_DAYS,
    });
    const backendIntegration = new apigatewayIntegrations.HttpLambdaIntegration(
      `${prefix}-backend-integration`,
      backendFunction,
      {
        payloadFormatVersion: apigateway.PayloadFormatVersion.VERSION_2_0,
      },
    );

    const s3Bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${toSafePrefix(prefix)}-frontend-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, 'FrontendOAI', {
      comment: `${prefix}-frontend-origin-access-identity`,
    });

    s3Bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`${s3Bucket.bucketArn}/*`],
        principals: [new iam.CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)],
      }),
    );

    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultRootObject: 'index.html',
      comment: `${prefix} frontend`,
      defaultBehavior: {
        origin: new cloudfrontOrigins.S3Origin(s3Bucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    const jwtIssuer = `https://cognito-idp.${cdk.Stack.of(this).region}.amazonaws.com/${userPool.userPoolId}`;
    const jwtAuthorizer = new apigatewayAuthorizers.HttpJwtAuthorizer(
      `${prefix}-cognito-authorizer`,
      jwtIssuer,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
      },
    );

    const httpApi = new apigateway.HttpApi(this, 'HttpApi', {
      apiName: `${prefix}-http-api`,
      description: 'Backend API gateway using Cognito JWT authorizer',
      corsPreflight: {
        allowCredentials: false,
        allowHeaders: ['Authorization', 'Content-Type'],
        allowMethods: [apigateway.CorsHttpMethod.ANY],
        allowOrigins: apiAllowedOrigins,
        maxAge: cdk.Duration.days(1),
      },
    });

    httpApi.addRoutes({
      path: '/health',
      methods: [apigateway.HttpMethod.GET],
      integration: backendIntegration,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigateway.HttpMethod.OPTIONS],
      integration: backendIntegration,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [apigateway.HttpMethod.OPTIONS],
      integration: backendIntegration,
    });

    httpApi.addRoutes({
      path: '/',
      methods: [apigateway.HttpMethod.ANY],
      integration: backendIntegration,
      authorizer: jwtAuthorizer,
    });

    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [apigateway.HttpMethod.ANY],
      integration: backendIntegration,
      authorizer: jwtAuthorizer,
    });

    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API base URL',
    });

    if (props.apiDomainName) {
      new cdk.CfnOutput(this, 'ApiDomainHint', {
        value: `Map a custom domain ${props.apiDomainName} with a CNAME to API Gateway domain: ${httpApi.apiEndpoint}`,
      });
    }

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Frontend CloudFront distribution URL',
    });

    if (props.frontendDomainName) {
      new cdk.CfnOutput(this, 'FrontendDomainHint', {
        value: `Point ${props.frontendDomainName} DNS/CNAME to CloudFront domain: ${distribution.distributionDomainName}`,
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${toSafePrefix(props.cognitoDomainPrefix ?? `${prefix}-auth`)}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: s3Bucket.bucketName,
    });
  }
}
