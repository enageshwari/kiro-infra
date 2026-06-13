#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { KiroAppStack } from '../lib/kiro-app-stack';
import { KiroE2EPipelineStack } from '../lib/kiro-e2e-pipeline-stack';
import { KiroGitHubOidcStack } from '../lib/kiro-github-oidc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region:  process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// GitHub org/user — update if repo ownership changes
const GITHUB_ORG = 'enageshwari';

// Stack 1: VPC, ECS cluster, app ECR repo, ALB Fargate service
const appStack = new KiroAppStack(app, 'KiroAppStack', { env });

// Stack 2: E2E ECR repo, Playwright Fargate task, Lambda trigger, API Gateway, CW logs
new KiroE2EPipelineStack(app, 'KiroE2EPipelineStack', {
  env,
  vpc:              appStack.vpc,
  cluster:          appStack.cluster,
  appSecurityGroup: appStack.appSecurityGroup,
});

// Stack 3: IAM OIDC provider + roles for GitHub Actions (no stored keys)
new KiroGitHubOidcStack(app, 'KiroGitHubOidcStack', {
  env,
  githubOrg: GITHUB_ORG,
});
