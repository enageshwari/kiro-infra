import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface KiroGitHubOidcStackProps extends cdk.StackProps {
  /**
   * GitHub org/user name. e.g. 'enageshwari'
   */
  readonly githubOrg: string;
}

/**
 * KiroGitHubOidcStack provisions:
 *   - IAM OIDC provider for GitHub Actions
 *   - IAM role for kiro-app GHA  (ECR push, ECS update, Lambda invoke, CW read)
 *   - IAM role for kiro-e2e GHA  (ECR push for runner image)
 *
 * Trust policies are scoped to specific repos + main branch only.
 * No long-lived credentials are stored anywhere.
 */
export class KiroGitHubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: KiroGitHubOidcStackProps) {
    super(scope, id, props);

    const { githubOrg } = props;

    // ── GitHub OIDC provider ───────────────────────────────────────────────
    // One provider per AWS account — if it already exists, import it.
    const oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // Thumbprint list for GitHub's OIDC — AWS now validates these automatically
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1'],
    });

    // ── Shared trust policy condition factory ─────────────────────────────
    const mainBranchCondition = (repo: string): iam.Conditions => ({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      },
      StringLike: {
        // Scoped to the specific repo, main branch only
        'token.actions.githubusercontent.com:sub':
          `repo:${githubOrg}/${repo}:ref:refs/heads/main`,
      },
    });

    // ── IAM role for kiro-app GHA ─────────────────────────────────────────
    const kiroAppRole = new iam.Role(this, 'KiroAppGHARole', {
      roleName:    'kiro-app-gha-role',
      description: 'OIDC role for kiro-app GitHub Actions: ECR push, ECS deploy, E2E trigger',
      assumedBy:   new iam.WebIdentityPrincipal(
        oidcProvider.openIdConnectProviderArn,
        mainBranchCondition('kiro-app'),
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // ECR — authenticate and push kiro-app image
    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid:     'ECRAuth',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRPush',
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:CompleteLayerUpload',
        'ecr:InitiateLayerUpload',
        'ecr:PutImage',
        'ecr:UploadLayerPart',
      ],
      resources: [
        `arn:aws:ecr:${this.region}:${this.account}:repository/kiro-app`,
      ],
    }));

    // ECS — describe task def, register new revision, update service
    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECS',
      actions: [
        'ecs:DescribeTaskDefinition',
        'ecs:RegisterTaskDefinition',
        'ecs:UpdateService',
        'ecs:DescribeServices',
      ],
      resources: ['*'],
    }));

    // IAM PassRole — needed to register task definition
    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid:     'PassRole',
      actions: ['iam:PassRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/KiroAppStack-*`,
      ],
    }));

    // Lambda — invoke the E2E trigger function
    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid:     'LambdaInvoke',
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:kiro-trigger-e2e`,
      ],
    }));

    // CloudWatch Logs — poll for E2E result
    kiroAppRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CWLogs',
      actions: [
        'logs:DescribeLogStreams',
        'logs:GetLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/ecs/kiro-e2e:*`,
      ],
    }));

    // ── IAM role for kiro-e2e GHA ─────────────────────────────────────────
    const kiroE2ERole = new iam.Role(this, 'KiroE2EGHARole', {
      roleName:    'kiro-e2e-gha-role',
      description: 'OIDC role for kiro-e2e GitHub Actions: ECR push for runner image',
      assumedBy:   new iam.WebIdentityPrincipal(
        oidcProvider.openIdConnectProviderArn,
        mainBranchCondition('kiro-e2e'),
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    kiroE2ERole.addToPolicy(new iam.PolicyStatement({
      sid:     'ECRAuth',
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    kiroE2ERole.addToPolicy(new iam.PolicyStatement({
      sid: 'ECRPushE2E',
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:CompleteLayerUpload',
        'ecr:InitiateLayerUpload',
        'ecr:PutImage',
        'ecr:UploadLayerPart',
      ],
      resources: [
        `arn:aws:ecr:${this.region}:${this.account}:repository/kiro-e2e`,
      ],
    }));

    // ── Outputs ────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'KiroAppRoleArn', {
      value:       kiroAppRole.roleArn,
      description: 'Set as AWS_ROLE_ARN secret in kiro-app GitHub repo',
    });

    new cdk.CfnOutput(this, 'KiroE2ERoleArn', {
      value:       kiroE2ERole.roleArn,
      description: 'Set as AWS_ROLE_ARN secret in kiro-e2e GitHub repo',
    });
  }
}
