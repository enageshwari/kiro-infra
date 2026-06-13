#!/bin/bash
# Full teardown — deletes all AWS resources including ECR repos
# Run this to stop all costs

set -e

echo "=== Tearing down kiro infrastructure ==="

# 1. Destroy CDK stacks (VPC, ECS, ALB, Lambda, API GW, CW logs)
echo "Destroying CDK stacks..."
npx cdk destroy --all --force

# 2. Delete ECR repos (not managed by CDK to avoid import conflicts)
echo "Deleting ECR repositories..."
aws ecr delete-repository --repository-name kiro-app --force 2>/dev/null || echo "kiro-app ECR already deleted"
aws ecr delete-repository --repository-name kiro-e2e --force 2>/dev/null || echo "kiro-e2e ECR already deleted"

echo ""
echo "✅ Teardown complete. All resources deleted."
