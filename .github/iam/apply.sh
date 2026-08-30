#!/usr/bin/env bash
#
# Applies the IAM roles that GitHub Actions assumes to deploy this repo.
#
# These roles are the definition of who may deploy to production, so they are
# version controlled here rather than living only as AWS state. Run this after
# changing any of the JSON files in this directory.
#
# Idempotent: creates the roles if missing, updates them in place otherwise.
#
#   bash .github/iam/apply.sh
#
# Requires credentials that can write IAM (your own admin user, not the CI roles).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for env in qa prod; do
  role="songupdater-gha-${env}"

  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    echo "==> updating trust policy on $role"
    aws iam update-assume-role-policy \
      --role-name "$role" \
      --policy-document "file://${here}/trust-${env}.json"
  else
    echo "==> creating $role"
    aws iam create-role \
      --role-name "$role" \
      --assume-role-policy-document "file://${here}/trust-${env}.json" \
      --description "GitHub Actions OIDC deploy role for Song Updater (${env})" \
      --query 'Role.Arn' --output text
  fi

  echo "==> putting inline policy on $role"
  aws iam put-role-policy \
    --role-name "$role" \
    --policy-name "songupdater-deploy-${env}" \
    --policy-document "file://${here}/policy-${env}.json"
done

echo
echo "Done. Verify the subjects AWS will now accept:"
for env in qa prod; do
  echo "  songupdater-gha-${env}:"
  aws iam get-role --role-name "songupdater-gha-${env}" \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."token.actions.githubusercontent.com:sub"' \
    --output text | tr '\t' '\n' | sed 's/^/    /'
done
