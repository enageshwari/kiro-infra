import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export interface KiroE2EPipelineStackProps extends cdk.StackProps {
  vpc:              ec2.Vpc;
  cluster:          ecs.Cluster;
  appSecurityGroup: ec2.SecurityGroup;
}

/**
 * KiroE2EPipelineStack provisions:
 *   - ECR repository for the kiro-e2e Playwright runner image
 *   - Fargate task definition for running Playwright tests
 *   - CloudWatch log group for E2E output (/ecs/kiro-e2e)
 *   - Lambda (kiro-trigger-e2e):
 *       1. Receives webhook from kiro-app GHA
 *       2. Calls ECS RunTask to start Playwright Fargate task
 *       3. Polls ECS until the task stops
 *       4. Returns { result: "PASSED" | "FAILED" } synchronously to GHA
 *   - API Gateway (POST /run-e2e) — protected by API key
 *       GHA in kiro-app POSTs here to trigger the pipeline
 */
export class KiroE2EPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KiroE2EPipelineStackProps) {
    super(scope, id, props);

    const { vpc, cluster, appSecurityGroup } = props;

    // ── ECR repo for Playwright runner image ───────────────────────────────
    const e2eRepository = new ecr.Repository(this, 'KiroE2ERepo', {
      repositoryName: 'kiro-e2e',
      removalPolicy:  cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5, description: 'Keep last 5 e2e runner images' }],
    });

    // ── CloudWatch log group — all Playwright output lands here ───────────
    const e2eLogGroup = new logs.LogGroup(this, 'KiroE2ELogs', {
      logGroupName:  '/ecs/kiro-e2e',
      retention:     logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Fargate task definition for Playwright runner ──────────────────────
    const e2eTaskRole = new iam.Role(this, 'KiroE2ETaskRole', {
      assumedBy:   new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Task role for kiro-e2e Playwright Fargate runner',
    });

    const e2eTaskDef = new ecs.FargateTaskDefinition(this, 'KiroE2ETaskDef', {
      family:         'kiro-e2e',
      memoryLimitMiB: 2048, // Playwright + browser binaries need ~2GB
      cpu:            1024,
      taskRole:       e2eTaskRole,
    });

    e2eTaskDef.addContainer('playwright-runner', {
      image: ecs.ContainerImage.fromEcrRepository(e2eRepository, 'latest'),
      // APP_URL is overridden at runtime by Lambda via ECS container overrides
      environment: {
        APP_URL: 'http://localhost:3000', // placeholder; always overridden
        CI:      'true',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup:    e2eLogGroup,
        streamPrefix: 'playwright',
      }),
      essential: true,
    });

    // ── Lambda — kiro-trigger-e2e ──────────────────────────────────────────
    const triggerLambda = new lambda.Function(this, 'TriggerE2ELambda', {
      functionName: 'kiro-trigger-e2e',
      runtime:      lambda.Runtime.NODEJS_20_X,
      handler:      'index.handler',
      // Inline code — keeps the stack self-contained with no separate build step
      code: lambda.Code.fromInline(buildLambdaCode()),
      // 15 min timeout: Lambda polls ECS until the Playwright Fargate task finishes
      timeout:     cdk.Duration.minutes(15),
      memorySize:  256,
      environment: {
        CLUSTER_ARN:       cluster.clusterArn,
        TASK_DEF_ARN:      e2eTaskDef.taskDefinitionArn,
        SECURITY_GROUP_ID: appSecurityGroup.securityGroupId,
        SUBNETS:           vpc.privateSubnets.map((s) => s.subnetId).join(','),
        LOG_GROUP:         e2eLogGroup.logGroupName,
      },
    });

    // Grant Lambda permission to start and describe ECS tasks
    triggerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask'],
      resources: ['*'],
    }));

    // Grant Lambda permission to pass IAM roles to ECS
    triggerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['iam:PassRole'],
      resources: [
        e2eTaskDef.taskRole.roleArn,
        e2eTaskDef.executionRole!.roleArn,
      ],
    }));

    // Grant Lambda permission to write results to CloudWatch
    triggerLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
        'logs:DescribeLogStreams',
      ],
      resources: [
        `${e2eLogGroup.logGroupArn}`,
        `${e2eLogGroup.logGroupArn}:*`,
      ],
    }));

    // Grant the e2e Fargate task execution role permission to pull from ECR
    e2eTaskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
      ],
      resources: ['*'],
    }));

    // Grant the e2e Fargate task execution role permission to write to CloudWatch
    e2eTaskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [`${e2eLogGroup.logGroupArn}:*`],
    }));

    // ── API Gateway — POST /run-e2e ────────────────────────────────────────
    // Integration timeout set to 29s max for API GW; Lambda is async via proxy.
    // NOTE: Because API Gateway has a hard 29-second timeout, the Lambda is
    // invoked asynchronously (Event) and the GHA job polls CloudWatch for the
    // final result. This is more reliable than trying to hold a 15-min HTTP conn.
    const api = new apigateway.RestApi(this, 'KiroE2EApi', {
      restApiName: 'kiro-e2e-trigger',
      description: 'Webhook endpoint — kiro-app GHA triggers Playwright E2E pipeline',
      deployOptions: {
        stageName:    'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    const runE2E = api.root.addResource('run-e2e');

    // Invoke Lambda asynchronously (X-Amz-Invocation-Type: Event)
    // API Gateway returns 202 immediately; Lambda runs in background.
    // GHA then polls CloudWatch for the result (see ci.yml).
    runE2E.addMethod(
      'POST',
      new apigateway.LambdaIntegration(triggerLambda, {
        proxy: false,
        requestParameters: {
          'integration.request.header.X-Amz-Invocation-Type': "'Event'",
        },
        integrationResponses: [
          { statusCode: '202', selectionPattern: '' },
        ],
      }),
      {
        apiKeyRequired: true,
        methodResponses: [{ statusCode: '202' }],
      },
    );

    // API key so only kiro-app GHA (via secret E2E_API_KEY) can call this
    const apiKey = api.addApiKey('KiroGHAApiKey', {
      apiKeyName:  'kiro-gha-trigger-key',
      description: 'API key for kiro-app GitHub Actions',
    });

    const usagePlan = api.addUsagePlan('KiroUsagePlan', {
      name:     'kiro-e2e-plan',
      throttle: { rateLimit: 10, burstLimit: 5 },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: api.deploymentStage });

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'E2ETriggerUrl', {
      value:       `${api.url}run-e2e`,
      description: 'API Gateway webhook URL — set as E2E_TRIGGER_URL in kiro-app GHA secrets',
    });

    new cdk.CfnOutput(this, 'E2EEcrRepo', {
      value:       e2eRepository.repositoryUri,
      description: 'ECR URI for kiro-e2e runner — set as E2E_ECR_REPO in kiro-e2e GHA secrets',
    });

    new cdk.CfnOutput(this, 'E2ELogGroup', {
      value:       e2eLogGroup.logGroupName,
      description: 'CloudWatch log group for Playwright output',
    });

    new cdk.CfnOutput(this, 'E2ETaskDefArn', {
      value:       e2eTaskDef.taskDefinitionArn,
      description: 'Fargate task definition ARN for the Playwright runner',
    });
  }
}

/**
 * Lambda source — invoked by API Gateway when kiro-app GHA triggers E2E.
 * Starts an ECS Fargate task and polls until it stops, then writes a result
 * marker to CloudWatch so GHA can poll for pass/fail.
 */
function buildLambdaCode(): string {
  return `
const { ECSClient, RunTaskCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');
const { CloudWatchLogsClient, PutLogEventsCommand, CreateLogStreamCommand } = require('@aws-sdk/client-cloudwatch-logs');

const ecs  = new ECSClient({});
const cwl  = new CloudWatchLogsClient({});

const POLL_INTERVAL_MS = 10_000;
const MAX_WAIT_MS      = 14 * 60 * 1000; // 14 min (Lambda timeout is 15 min)
const RESULT_STREAM    = 'e2e-results';

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));

  const body      = typeof event.body === 'string' ? JSON.parse(event.body) : event;
  const { appUrl, imageTag, runId, commitSha } = body;

  if (!appUrl) {
    console.error('appUrl missing from payload');
    return;
  }

  console.log(\`Starting E2E run | runId=\${runId} commitSha=\${commitSha} appUrl=\${appUrl}\`);

  // ── Start Fargate task ────────────────────────────────────────────────
  const runResult = await ecs.send(new RunTaskCommand({
    cluster:        process.env.CLUSTER_ARN,
    taskDefinition: process.env.TASK_DEF_ARN,
    launchType:     'FARGATE',
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets:        process.env.SUBNETS.split(','),
        securityGroups: [process.env.SECURITY_GROUP_ID],
        assignPublicIp: 'DISABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'playwright-runner',
        environment: [
          { name: 'APP_URL',     value: appUrl },
          { name: 'IMAGE_TAG',   value: imageTag  ?? 'unknown' },
          { name: 'RUN_ID',      value: runId     ?? 'unknown' },
          { name: 'COMMIT_SHA',  value: commitSha ?? 'unknown' },
        ],
      }],
    },
  }));

  const taskArn = runResult.tasks?.[0]?.taskArn;
  if (!taskArn) {
    console.error('Failed to start Fargate task:', JSON.stringify(runResult.failures));
    await writeResult(runId, { result: 'FAILED', error: 'Failed to start ECS task', runId });
    return;
  }

  console.log(\`Fargate task started: \${taskArn}\`);

  // ── Poll until task stops ─────────────────────────────────────────────
  const start      = Date.now();
  let   lastStatus = 'PROVISIONING';

  while (Date.now() - start < MAX_WAIT_MS) {
    await sleep(POLL_INTERVAL_MS);

    const desc = await ecs.send(new DescribeTasksCommand({
      cluster: process.env.CLUSTER_ARN,
      tasks:   [taskArn],
    }));

    const task = desc.tasks?.[0];
    if (!task) { console.error('Task disappeared during polling'); break; }

    lastStatus = task.lastStatus ?? 'UNKNOWN';
    console.log(\`Task status: \${lastStatus} (+\${Math.round((Date.now()-start)/1000)}s)\`);

    if (lastStatus === 'STOPPED') {
      const exitCode   = task.containers?.[0]?.exitCode;
      const stopReason = task.stoppedReason;
      const passed     = exitCode === 0;

      console.log(\`Task stopped | exitCode=\${exitCode} reason=\${stopReason}\`);

      const resultPayload = {
        result:      passed ? 'PASSED' : 'FAILED',
        runId,
        commitSha,
        taskArn,
        exitCode,
        stopReason,
        logGroup:    process.env.LOG_GROUP,
      };

      // Write structured result to CW so GHA can poll for it
      await writeResult(runId, resultPayload);
      return;
    }
  }

  // Timeout
  const resultPayload = {
    result:     'FAILED',
    error:      'Timed out waiting for Fargate task',
    runId,
    taskArn,
    lastStatus,
    logGroup:   process.env.LOG_GROUP,
  };
  await writeResult(runId, resultPayload);
};

async function writeResult(runId, payload) {
  const logGroup  = process.env.LOG_GROUP;
  const streamName = \`\${RESULT_STREAM}/\${runId ?? Date.now()}\`;

  try {
    await cwl.send(new CreateLogStreamCommand({ logGroupName: logGroup, logStreamName: streamName }));
  } catch (e) {
    // Stream may already exist — ignore ResourceAlreadyExistsException
  }

  await cwl.send(new PutLogEventsCommand({
    logGroupName:  logGroup,
    logStreamName: streamName,
    logEvents: [{
      timestamp: Date.now(),
      message:   JSON.stringify(payload),
    }],
  }));

  console.log(\`Result written to CW: \${logGroup}/\${streamName}\`);
  console.log('Result:', JSON.stringify(payload));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
`;
}
