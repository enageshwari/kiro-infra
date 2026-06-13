#!/bin/bash
# Full restore — recreates all AWS infrastructure from scratch
# Run this after teardown to bring everything back for demo

set -e

echo "=== Restoring kiro infrastructure ==="

# 1. Deploy all CDK stacks
echo "Deploying CDK stacks..."
npm install
npx cdk deploy --all --require-approval never

echo ""
echo "=== Stack outputs ==="
aws cloudformation describe-stacks --stack-name KiroAppStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

aws cloudformation describe-stacks --stack-name KiroE2EPipelineStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

aws cloudformation describe-stacks --stack-name KiroGitHubOidcStack \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' --output table

echo ""
echo "=== API Gateway API key ==="
API_KEY=$(aws apigateway get-api-keys \
  --include-values \
  --query 'items[?name==`kiro-gha-trigger-key`].value' \
  --output text)
echo "E2E_API_KEY: $API_KEY"

echo ""
echo "=== Update GHA secrets with the values above ==="
echo "Commands to run (fill in values from outputs above):"
echo ""
echo "  gh secret set APP_URL          --repo enageshwari/kiro-app --body '<AppUrl>'"
echo "  gh secret set TARGET_GROUP_ARN --repo enageshwari/kiro-app --body '<TargetGroupArn>'"
echo "  gh secret set E2E_TRIGGER_URL  --repo enageshwari/kiro-app --body '<E2ETriggerUrl>'"
echo "  gh secret set E2E_API_KEY      --repo enageshwari/kiro-app --body '$API_KEY'"
echo ""
echo "=== Next steps ==="
echo "1. Update GHA secrets above"
echo "2. Push kiro-e2e to rebuild runner image:"
echo "   cd ../kiro-e2e && git commit --allow-empty -m 'ci: rebuild runner' && git push"
echo "3. Push kiro-app to trigger full pipeline:"
echo "   cd ../kiro-app && git commit --allow-empty -m 'ci: restore run' && git push"
echo ""
echo "✅ Infrastructure restored."
