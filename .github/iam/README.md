# Deploy IAM

The two IAM roles GitHub Actions assumes to deploy this repo, kept in version
control because they define **who may deploy to production**. Change a JSON file
here, then run:

```bash
bash .github/iam/apply.sh
```

## The two roles

| Role | Assumed by | Can write to |
|---|---|---|
| `songupdater-gha-qa` | the `deploy-qa` jobs and the daily drift check | the six `*QA` functions only |
| `songupdater-gha-prod` | the `deploy-prod` jobs | the six production functions, plus `APNProd` |

Neither role uses long-lived access keys — both are assumed over OIDC, and each
can only write to its own environment's functions. The QA role can *read* every
function (the drift check needs that) but cannot write to any production one.

## How the production gate is actually enforced

The approval on the `production` GitHub Environment is not just a UI prompt. The
prod role's trust policy only accepts tokens whose subject ends in
`:environment:production`:

```json
"token.actions.githubusercontent.com:sub": [
  "repo:borikanes/spotify-token-lambdas:environment:production",
  "repo:borikanes/apn-lambda-go:environment:production"
]
```

A job that is not running in that environment cannot assume the role, even if
someone edits the workflow to try. AWS enforces the gate, not Actions.

## Gotchas that have already bitten us

**The subject claim carries the repo's CURRENT name.** This repo was renamed
from `spotify-lambdas` to `spotify-token-lambdas`. Git pushes silently follow
GitHub's redirect, but the OIDC `sub` claim does not — so trust policies naming
the old repo fail with a bare `Not authorized to perform
sts:AssumeRoleWithWebIdentity`, which says nothing about why. **If this repo is
ever renamed again, both trust policies must be updated or every deploy breaks.**

**A job with an `environment:` gets a different subject.** With no environment
the subject is `repo:OWNER/REPO:ref:refs/heads/main`; inside one it becomes
`repo:OWNER/REPO:environment:NAME`. The QA role trusts both, because
`deploy-qa` runs in the `qa` environment while the scheduled drift check runs
in no environment at all.

To see the claims a workflow actually presents, request a token in a job and
decode its payload — print only `sub`/`aud`/`repository`, never the token.

**Adding a function means editing `policy-*.json`.** Least privilege is by exact
ARN, so a newly created lambda cannot be deployed until it is listed here. The
failure is a clear `AccessDeniedException` naming the function and action.

## One-time bootstrap not covered by apply.sh

Already done, recorded here so it is reproducible:

1. **GitHub OIDC provider** — `token.actions.githubusercontent.com` with audience
   `sts.amazonaws.com`. Already existed in this account.
2. **GitHub Environments** — `qa` and `production` on this repo and on
   `apn-lambda-go`, with a required reviewer on `production`.
3. **APNs signing key** — stored as an SSM SecureString at
   `/songupdater/apns/signing-key`, read at deploy time by the `apn-lambda-go`
   workflow and packaged into its zip. It is deliberately not in any repo or in
   GitHub secrets: Apple only lets a `.p8` be downloaded once, so the single copy
   lives somewhere with access logging.
