import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as assets from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface FoundryStackProps extends cdk.StackProps { installerPath?: string; systemPath?: string; }

/** Creates a launch template, not an always-running server or retained disk. */
export class FoundryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoundryStackProps) {
    super(scope, id, props);
    if (!props.installerPath || !existsSync(props.installerPath)) throw new Error('Set FOUNDRY_INSTALLER_PATH to licensed Linux 14.368 zip');
    if (!props.systemPath || !existsSync(path.join(props.systemPath, 'system.json'))) throw new Error('Set FOUNDRY_SYSTEM_PATH to dcc-foundry-vtt/system');
    const vpcId = new cdk.CfnParameter(this, 'VpcId', { type: 'AWS::EC2::VPC::Id', default: 'vpc-06479f10eb0e77729' });
    const subnetId = new cdk.CfnParameter(this, 'SubnetId', { type: 'AWS::EC2::Subnet::Id', default: 'subnet-0b4327cc2021d1267' });
    const cloudfrontPrefix = new cdk.CfnParameter(this, 'CloudFrontPrefixListId', { type: 'String', default: 'pl-3b927c52', allowedPattern: 'pl-[a-f0-9]+' });
    const ami = new cdk.CfnParameter(this, 'AmiId', { type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>', default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64' });
    const originToken = new cdk.CfnParameter(this, 'OriginToken', { type: 'String', noEcho: true, minLength: 48, allowedPattern: '[A-Za-z0-9]+' });
    const backupBucket = new s3.Bucket(this, 'Backups', {
      encryption: s3.BucketEncryption.S3_MANAGED, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, versioned: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Never expire the latest campaign merely because nobody played for a while.
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(90), abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) }],
    });
    const originParameter = '/gameserver/dev/foundry/origin-token';
    const role = new iam.Role(this, 'HostRole', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')] });
    backupBucket.grantReadWrite(role);
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })], conditions: { StringEquals: { 'ec2:ResourceTag/FoundryDeployment': id } } }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [originParameter].map(name => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.slice(1) })) }));
    const profile = new iam.CfnInstanceProfile(this, 'HostProfile', { roles: [role.roleName] });
    const installer = new assets.Asset(this, 'Installer', { path: props.installerPath });
    const system = new assets.Asset(this, 'DccSystem', { path: props.systemPath });
    const bootstrap = new assets.Asset(this, 'Bootstrap', { path: path.join(__dirname, '../assets/foundry-bootstrap.sh') });
    const operations = new assets.Asset(this, 'Operations', { path: path.join(__dirname, '../assets/foundry-operation.sh') });
    for (const asset of [installer, system, bootstrap, operations]) asset.grantRead(role);
    const securityGroup = new ec2.CfnSecurityGroup(this, 'SecurityGroup', {
      groupDescription: 'Foundry origin: CloudFront only, no public SSH or port 30000', vpcId: vpcId.valueAsString,
      securityGroupIngress: [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, sourcePrefixListId: cloudfrontPrefix.valueAsString }],
    });
    const distribution = new cloudfront.Distribution(this, 'FoundryHttps', {
      comment: 'Foundry temporary sessions; origin registered by each new host', priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: new origins.HttpOrigin('foundry-not-running.invalid', { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: { 'X-Foundry-Origin': originToken.valueAsString }, readTimeout: cdk.Duration.seconds(60) }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      errorResponses: [502, 503, 504].map(httpStatus => ({ httpStatus, ttl: cdk.Duration.seconds(0) })),
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution', 'cloudfront:GetDistribution'], resources: [distribution.distributionArn] }));
    const userData = ec2.UserData.forLinux();
    const env = {
      AWS_DEFAULT_REGION: this.region, BACKUP_BUCKET: backupBucket.bucketName,
      INSTALLER_URI: installer.s3ObjectUrl, SYSTEM_URI: system.s3ObjectUrl, OPERATIONS_URI: operations.s3ObjectUrl,
      ORIGIN_PARAMETER: originParameter,
      PUBLIC_HOST: distribution.distributionDomainName, DISTRIBUTION_ID: distribution.distributionId,
    };
    userData.addCommands('set -euo pipefail', 'umask 077',
      ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
      `aws s3 cp '${bootstrap.s3ObjectUrl}' /root/foundry-bootstrap.sh --only-show-errors`, 'bash /root/foundry-bootstrap.sh');
    const launchTemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', { launchTemplateData: {
      imageId: ami.valueAsString, instanceType: 't3.medium', iamInstanceProfile: { arn: profile.attrArn },
      networkInterfaces: [{ deviceIndex: 0, subnetId: subnetId.valueAsString, groups: [securityGroup.attrGroupId], associatePublicIpAddress: true, deleteOnTermination: true }],
      disableApiTermination: true, instanceInitiatedShutdownBehavior: 'terminate',
      creditSpecification: { cpuCredits: 'standard' },
      metadataOptions: { httpTokens: 'required', httpEndpoint: 'enabled' },
      blockDeviceMappings: [{ deviceName: '/dev/xvda', ebs: { volumeSize: 32, volumeType: 'gp3', encrypted: true, deleteOnTermination: true } }],
      userData: cdk.Fn.base64(userData.render()),
      tagSpecifications: [{ resourceType: 'instance', tags: [{ key: 'Name', value: 'foundry-dcc' }, { key: 'ManagedBy', value: 'foundry-console' }, { key: 'FoundryDeployment', value: id }] }],
    } });
    const document = new ssm.CfnDocument(this, 'OperationDocument', { documentType: 'Command', content: {
      schemaVersion: '2.2', description: 'Verify offline Foundry save before terminating temporary server',
      parameters: { action: { type: 'String', allowedValues: ['backup', 'stop'], interpolationType: 'ENV_VAR' } },
      mainSteps: [{ action: 'aws:runShellScript', name: 'FoundryOperation', inputs: { timeoutSeconds: '3600', runCommand: ['/usr/local/sbin/foundry-operation "$SSM_action"'] } }],
    } });
    new ssm.StringParameter(this, 'ConsoleConfiguration', {
      parameterName: '/gameserver/dev/foundry/config',
      stringValue: this.toJsonString({ deploymentId: id, launchTemplateId: launchTemplate.ref, url: `https://${distribution.distributionDomainName}/`, commandDocument: document.ref, backupBucket: backupBucket.bucketName }),
    });
    new iam.Policy(this, 'ConsoleTerminationGuard', {
      roles: [iam.Role.fromRoleName(this, 'ConsoleRole', 'gameserver-dev-backend-lambda-role')],
      statements: [new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['ec2:TerminateInstances', 'ec2:StopInstances', 'ec2:RebootInstances'],
        resources: [this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
        conditions: { StringEquals: { 'ec2:ResourceTag/ManagedBy': 'foundry-console' } } })],
    });
    new cdk.CfnOutput(this, 'LaunchTemplateId', { value: launchTemplate.ref });
    new cdk.CfnOutput(this, 'BackupBucket', { value: backupBucket.bucketName });
    new cdk.CfnOutput(this, 'FoundryUrl', { value: `https://${distribution.distributionDomainName}/` });
  }
}
