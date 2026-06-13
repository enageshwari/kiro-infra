#!/bin/bash
# Full restore — recreates all AWS infrastructure from scratch.
# Run this after teardown to bring everything back for demo.
#
# Usage:
#   bash scripts/restore.sh

set -e

echo "=== Restoring kiro infrastructure ==="

# 1. Bootstrap CDK if CDKToolkit stack doesn't exist
#    (only needed if teardown was run with --all flag)
TOOLKIT_STATUS=$(aws cloudformation describe-stacks \
  --stack-name CDKToolkit \
  --query 'Stacks[0].StackStatus' \
  --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$TOOLKIT_STATUS" = "DOES_NOT_EXIST" ]; then
  echo "CDKToolkit not found — bootstrapping CDK..."
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
  REGION=$(aws configure get region)
  npx cdk bootstrap "aws://${ACCOUNT}/${REGION}"
  echo "Bootstrap complete."
else
  echo "CDKToolkit exists (status: $TOOLKIT_STATUS) — skipping bootstrap."
fi

# 2. Install dependencies
npm install

# 3. Deploy all CDK stacks
echo ""
echo "Deploying CDK stacks..."
npx cdk deploy --all --require-approval never

# 4. Print all stack outputs
echo ""
echo "=== Stack outputs ==="
for STACK in KiroAppStack KiroE2EPipelineStack KiroGitHubOidcStack; do
  echo "--- $STACK ---"
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' \
    --output table
done

# 5. Retrieve API key (not in CFN outputs)
echo ""
echo "=== API Gateway API key ==="
API_KEY=$(aws apigateway get-api-keys \
  --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' \
  --output text)
echo "E2E_API_KEY: $API_KEY"

# 6. Print GHA secret update commands
echo ""
echo "=== Update GHA secrets (copy-paste these) ==="
APP_URL=$(aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs[?OutputKey==`AppUrl`].OutputValue' --output text)
TG_ARN=$(aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs[?OutputKey==`TargetGroupArn`].OutputValue' --output text)
E2E_URL=$(aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs[?OutputKey==`E2ETriggerUrl`].OutputValue' --output text)
APP_ROLE=$(aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs[?OutputKey==`KiroAppRoleArn`].OutputValue' --output text)
E2E_ROLE=$(aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs[?OutputKey==`KiroE2ERoleArn`].OutputValue' --output text)
E2E_ECR=$(aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs[?OutputKey==`E2EEcrRepo`].OutputValue' --output text)

echo ""
echo "# kiro-app secrets:"
echo "gh secret set APP_URL          --repo enageshwari/kiro-app --body \"$APP_URL\""
echo "gh secret set TARGET_GROUP_ARN --repo enageshwari/kiro-app --body \"$TG_ARN\""
echo "gh secret set E2E_TRIGGER_URL  --repo enageshwari/kiro-app --body \"$E2E_URL\""
echo "gh secret set E2E_API_KEY      --repo enageshwari/kiro-app --body \"$API_KEY\""
echo "gh secret set AWS_ROLE_ARN     --repo enageshwari/kiro-app --body \"$APP_ROLE\""
echo ""
echo "# kiro-e2e secrets:"
echo "gh secret set AWS_ROLE_ARN        --repo enageshwari/kiro-e2e --body \"$E2E_ROLE\""
echo "gh secret set ECR_REPOSITORY_E2E  --repo enageshwari/kiro-e2e --body \"$E2E_ECR\""

echo ""
echo "=== Next steps ==="
echo "1. Run the gh secret set commands above"
echo "2. Rebuild the E2E runner image:"
echo "   cd ../kiro-e2e && git commit --allow-empty -m 'ci: rebuild runner' && git push"
echo "3. Trigger the full pipeline:"
echo "   cd ../kiro-app && git commit --allow-empty -m 'ci: restore run' && git push"
echo "   Watch: https://github.com/enageshwari/kiro-app/actions"
echo ""
echo "✅ Infrastructure restored."
