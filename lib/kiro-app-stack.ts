import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export interface KiroAppStackProps extends cdk.StackProps {}

/**
 * KiroAppStack provisions:
 *   - VPC (2 AZs, 1 NAT gateway)
 *   - ECR repository for kiro-app images
 *   - ECS Fargate cluster
 *   - ALB + target group (no service attached at deploy time)
 *   - Fargate service with desiredCount=0 and NO load balancer registration
 *   - CloudWatch log group (/ecs/kiro-app)
 *
 * Decoupling strategy:
 *   AWS ECS does not allow attaching a load balancer to a service with
 *   desiredCount=0 at creation time. So the service is created without ALB
 *   registration. GHA does the following after pushing the image:
 *     1. Registers new task def revision with real image
 *     2. Calls aws ecs update-service --desired-count 1 --load-balancers ...
 *   This is the cleanest decoupling — infra stack completes in ~3 minutes
 *   with zero dependency on any image being present in ECR.
 */
export class KiroAppStack extends cdk.Stack {
  public readonly vpc:              ec2.Vpc;
  public readonly cluster:          ecs.Cluster;
  public readonly appSecurityGroup: ec2.SecurityGroup;
  public readonly appRepository:    ecr.IRepository;

  constructor(scope: Construct, id: string, props?: KiroAppStackProps) {
    super(scope, id, props);

    // ── VPC ────────────────────────────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, 'KiroVpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // ── ECR repo ───────────────────────────────────────────────────────────
    // Using fromRepositoryName because the repo was created outside this stack
    // (initially imported). On full teardown, delete the repo manually:
    //   aws ecr delete-repository --repository-name kiro-app --force
    // On restore, cdk deploy recreates it via the Repository construct below.
    //
    // Switch between these two lines:
    //   - First deploy on fresh account: use `new ecr.Repository`
    //   - Subsequent deploys (repo exists): use `fromRepositoryName`
    this.appRepository = ecr.Repository.fromRepositoryName(
      this, 'KiroAppRepo', 'kiro-app',
    );

    // ── ECS Cluster ────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'KiroCluster', {
      vpc:         this.vpc,
      clusterName: 'kiro-cluster',
    });

    // ── Security group ─────────────────────────────────────────────────────
    this.appSecurityGroup = new ec2.SecurityGroup(this, 'KiroAppSG', {
      vpc:              this.vpc,
      description:      'SG for kiro-app and kiro-e2e Fargate tasks',
      allowAllOutbound: true,
    });

    // ALB security group — created by the ALB construct below.
    // We add the ingress rule after ALB creation so we can reference its SG.
    // The rule allows ALB → task on port 3000 for health checks and traffic.

    // ── CloudWatch log group ───────────────────────────────────────────────
    const appLogGroup = new logs.LogGroup(this, 'KiroAppLogs', {
      logGroupName:  '/ecs/kiro-app',
      retention:     logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Fargate task definition ────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'KiroAppTaskDef', {
      family:         'kiro-app',
      memoryLimitMiB: 512,
      cpu:            256,
    });

    taskDef.addContainer('kiro-app', {
      image: ecs.ContainerImage.fromEcrRepository(this.appRepository, 'latest'),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        PORT:     '3000',
        NODE_ENV: 'production',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup:    appLogGroup,
        streamPrefix: 'kiro-app',
      }),
      healthCheck: {
        command:     ['CMD-SHELL', 'wget -qO- http://localhost:3000/health || exit 1'],
        interval:    cdk.Duration.seconds(30),
        timeout:     cdk.Duration.seconds(5),
        retries:     3,
        startPeriod: cdk.Duration.seconds(10),
      },
    });

    // ── ALB ────────────────────────────────────────────────────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'KiroALB', {
      vpc:            this.vpc,
      internetFacing: true,
    });

    // Allow ALB → task on port 3000 (health checks + traffic forwarding).
    // Both directions must be explicitly set:
    //   1. ALB SG outbound → task SG port 3000
    //   2. Task SG inbound ← ALB SG port 3000
    // CDK's ALB construct defaults to no outbound rules — must add explicitly.
    alb.connections.allowTo(
      this.appSecurityGroup,
      ec2.Port.tcp(3000),
      'ALB to kiro-app task port 3000',
    );

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'KiroTG', {
      vpc:         this.vpc,
      port:        3000,
      protocol:    elbv2.ApplicationProtocol.HTTP,
      targetType:  elbv2.TargetType.IP,
      healthCheck: {
        path:                    '/health',
        healthyHttpCodes:        '200',
        interval:                cdk.Duration.seconds(30),
        timeout:                 cdk.Duration.seconds(5),
        healthyThresholdCount:   2,
        unhealthyThresholdCount: 5,
      },
    });

    alb.addListener('KiroListener', {
      port:          80,
      open:          true,
      defaultAction: elbv2.ListenerAction.forward([targetGroup]),
    });

    // ── Fargate service — desiredCount: 0, no ALB registration ───────────
    // AWS validates that a target group's listener exists before allowing
    // an ECS service to register with it — even at desiredCount=0.
    // So we create the service with no load balancer attachment here.
    // GHA calls update-service after pushing the image to wire the ALB.
    new ecs.CfnService(this, 'KiroAppService', {
      serviceName:    'kiro-app',
      cluster:        this.cluster.clusterArn,
      taskDefinition: taskDef.taskDefinitionArn,
      desiredCount:   0,
      launchType:     'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets:        this.vpc.privateSubnets.map((s) => s.subnetId),
          securityGroups: [this.appSecurityGroup.securityGroupId],
          assignPublicIp: 'DISABLED',
        },
      },
      deploymentConfiguration: {
        minimumHealthyPercent: 0,
        maximumPercent:        200,
      },
      // No loadBalancers property — GHA adds this via update-service
    });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AppEcrRepo', {
      value:       this.appRepository.repositoryUri,
      description: 'ECR URI for kiro-app',
      exportName:  'KiroAppEcrRepo',
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value:       `http://${alb.loadBalancerDnsName}`,
      description: 'ALB URL — set as APP_URL in kiro-app GHA secrets',
      exportName:  'KiroAppUrl',
    });

    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value:       targetGroup.targetGroupArn,
      description: 'Target group ARN — used by GHA update-service to attach ALB',
      exportName:  'KiroAppTargetGroupArn',
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value:       this.cluster.clusterName,
      description: 'ECS cluster name',
      exportName:  'KiroClusterName',
    });
  }
}
