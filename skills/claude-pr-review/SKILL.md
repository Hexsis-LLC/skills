---
name: claude-pr-review
description: Set up automated Claude pull-request review in a GitHub repository with anthropics/claude-code-action, as a review-only workflow with read-only sub-agents, a source-coverage gate, and one formal review with inline findings. Use when adding, hardening, or debugging Claude PR review or @claude mentions in GitHub Actions.
---

# Claude PR Review

The Hexsis method for automated Claude pull-request review. The pull request is **untrusted input** steering an agent that holds a model token and a GitHub token, so the setup is **review-only**: Claude reads, judges, and posts one formal review, and can do nothing else. Every control in the templates closes a path that has failed in practice. Keep them all unless the user decides otherwise with the trade-off in front of them.

What the setup does:

- **Automatic review** of ready, same-repository pull requests. A workflow step writes the diff as line-oriented files. Read-only `diff-reviewer` sub-agents read every source chunk in parallel, a `rules-reviewer` checks the change against the repository's rules, and a fresh `finding-validator` confirms each candidate finding. Claude then submits exactly one formal review on the head commit.
- **`@claude` mentions** on pull requests from users with write access, answered inline. Mentions cannot submit a verdict.
- **A coverage gate** that fails the job, and dismisses the verdict, unless the transcript proves every changed source file's diff range was read.

## Files

| File | Becomes | Role |
| --- | --- | --- |
| [`templates/claude-review.yml`](templates/claude-review.yml) | `.github/workflows/claude-review.yml` | The review workflow |
| [`templates/claude-review-gate.mjs`](templates/claude-review-gate.mjs) | `scripts/claude-review-gate.mjs` | Builds the diff manifest and judges the verdict |
| [`templates/check-workflow-policy.mjs`](templates/check-workflow-policy.mjs) | `scripts/check-workflow-policy.mjs` | Enforces the secret and permission boundary in CI |
| `templates/*.test.mjs` | `scripts/*.test.mjs` | `node:test` suites for both scripts |

The scripts need Node.js 22 or later and no dependencies. Search the templates for `PARAMETER` to find each repo-specific choice.

## Parameters

| Parameter | Default | Where it lives |
| --- | --- | --- |
| Runner label | `ubuntu-latest` | `runs-on`. A self-hosted label also goes in `.github/actionlint.yaml` under `self-hosted-runner.labels`. The runner needs `sudo` apt access and Docker, or bubblewrap and the MCP image baked in. |
| Model | `claude-sonnet-5-5` | `--model` in `claude_args` |
| Review rules location | `AGENTS.md, CLAUDE.md` | `REVIEW_RULES` in the job env. Read from the default branch's copy, plus the nearest same-named file above each changed path. |
| Trigger set | automatic review and `@claude` mentions | `on:`, the job `if:`, and `trigger_phrase` |
| Docs-governance mode | `off` | `REVIEW_GOVERNANCE` in the job env. See [Docs-governance mode](#docs-governance-mode). |
| Auth | `CLAUDE_CODE_OAUTH_TOKEN` secret | the action's token input, plus `reviewSecret` and `reviewTokenInput` in the policy check. For an Anthropic API key, use `anthropic_api_key` and `ANTHROPIC_API_KEY`. |
| Source and skim classes | everything is source except lock files, fixtures, snapshots, and docs | the regexes at the top of the gate |
| Chunk size | 800 diff lines | `defaultChunkLines` in the gate |
| Max turns, timeout | 100 turns, 30 minutes | `--max-turns`, `timeout-minutes`. Sub-agent turns do not count toward max turns. |
| Transcript retention | 7 days | the upload step. On a public repository, anyone can download the transcript. |
| Script directory | `scripts/` | the two `node "$RUNNER_TEMP/trusted-rules/scripts/..."` lines, and the policy check's default root |

## Set Up

### 1. Survey the target repository

Read, don't assume:

- the default branch, the existing workflows, and the CI job where Node checks run;
- the rules files (`AGENTS.md`, `CLAUDE.md`, `REVIEW.md`, or nested ones);
- the runner the repository already uses;
- branch protection and rulesets on the default branch, especially who may dismiss reviews;
- whether any workflow uses `secrets: inherit` or `toJSON(secrets)`. The policy check blocks both, because they would hand the review secret to another workflow;
- the docs-governance markers (see [Docs-governance mode](#docs-governance-mode)).

Then show the user the parameter table with the values you chose, and get their confirmation. **Done when** every parameter has a value the user has seen.

### 2. Resolve the pins

The template pins every action by commit SHA. Re-resolve each pin rather than trusting the template's:

1. **Claude action.** Take the latest release with `gh release list -R anthropics/claude-code-action`, then get its commit with `gh api repos/anthropics/claude-code-action/commits/<tag> --jq .sha`.
2. **GitHub MCP image.** At that SHA, read the image tag from `src/mcp/install-mcp-server.ts`. Get its digest with `docker buildx imagetools inspect ghcr.io/github/github-mcp-server:<tag>`. Update `TAG` and `DIGEST` in the `Pull GitHub MCP server` step.
3. **Built-in sub-agent types.** At that SHA, `base-action/action.yml` names the bundled Claude Code version. List that version's built-in sub-agent types from the Claude Code sub-agents docs. Put each type as `Agent(<type>)` in `DENIED_TOOLS` and in `builtInAgents` in the policy check.
4. **Action inputs.** Check the action's `action.yml` at that SHA for every input the template passes. Inputs are renamed across major versions.
5. **Other actions.** Resolve `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` to their latest release SHAs.

**Done when** every `uses:` line carries a SHA you resolved in this session, with its tag in a comment.

### 3. Install the templates

Copy the files into place and set every parameter. Keep each security control intact. Before you change one, read [references/security-model.md](references/security-model.md); it explains what each control closes. Keep the review prompt's output contract and the gate's checks in step: the gate parses the heading and the coverage line.

Add `node --test scripts/claude-review-gate.test.mjs scripts/check-workflow-policy.test.mjs` and `node scripts/check-workflow-policy.mjs` to the repository's existing CI. Adapt the test fixtures to the repository's own paths when you change the classes.

### 4. Validate locally

Run all of these:

- `actionlint` on the workflow. The template passes with no findings.
- The two test suites.
- The policy check against the repository.

**Done when** all three are green. Report any check you could not run.

### 5. Hand the manual steps to the user

The agent cannot do these. Give them to the user as a checklist:

1. **Install the Claude GitHub App** on the repository: <https://github.com/apps/claude>. It is the identity that posts reviews, through the OIDC token exchange.
2. **Create the model credential and add it as a repository secret.** For a Claude subscription, run `claude setup-token` and save the result as `CLAUDE_CODE_OAUTH_TOKEN`. For an API key, save it as `ANTHROPIC_API_KEY`. The OAuth token lasts a year, and deleting the secret does not revoke it.
3. **Merge the setup pull request without its own review.** The token exchange refuses a workflow that differs from the default branch's copy. So the setup PR, and every later PR that edits the workflow, fails its review job by design. A human reviews those.
4. **If branch protection restricts dismissals,** allow GitHub Actions to dismiss reviews on the default branch. Otherwise accept that failed verdicts stand until a human dismisses them.
5. **Decide whether a `claude[bot]` approval counts** toward any required-review rule. The safe default is that it does not, and merging stays human.

If the user runs `/install-github-app` instead, keep the app and the secret it creates. Discard its generated workflow in favor of this one.

### 6. Verify on a test pull request

After the setup is merged, open a small same-repository PR that changes one source file, one lock or doc file, and holds a planted defect. Then check:

- [ ] The `Claude review` job runs, and the GitHub MCP server connects.
- [ ] The job summary shows zero denied tool calls, one `diff-reviewer` per chunk, and `Source files read: N of N`.
- [ ] `claude[bot]` posts exactly one review on the head commit: `REQUEST_CHANGES`, with the planted defect as its own inline comment, following the [output contract](#review-output-contract).
- [ ] A follow-up push that fixes the defect re-runs the review and yields `APPROVE`. A run still in progress for the older commit is cancelled.
- [ ] A PR comment with `@claude <question>` from a write-access user gets an inline reply and no verdict.
- [ ] A draft PR and a fork PR are skipped.
- [ ] The transcript artifact downloads.

**Done when** every box is checked, or each unchecked box is reported to the user with its run link. A green job that posted nothing is a failure; see [references/troubleshooting.md](references/troubleshooting.md).

## Review Output Contract

The automatic review always ends with **one formal review on the head commit**:

- **Confirmed findings:** `REQUEST_CHANGES`, with each finding as its own inline comment on its diff line. Findings never go into the body or a separate PR comment.
- **No confirmed finding:** `APPROVE`.
- **Incomplete** (a source range unread, or the rules unreadable): `COMMENT` naming what was not read. The gate fails the job.

The body is a short summary, never a list:

```markdown
## Claude review: Changes requested

**Reviewed 37 of 37 changed files**

One or two paragraphs: what was checked, at most two findings by name (most severe
first), and the rest counted by severity ("there are 1 more critical, 3 major, and 2
minor findings, each in its own inline comment").
```

Each inline comment opens with `**<Severity> · <Category>: <title>**`, then **Trigger**, **Impact**, and **Evidence** with links, and adds a `suggestion` block only when it fully fixes the issue.

- Severity is **Critical** (breaks security, data, or a review rule, or fails for ordinary input), **Major** (fails on a reachable but narrower path), or **Minor** (a real defect with limited impact).
- Category is **Correctness**, **Security**, or **Rules**.
- Style, naming, and preference are never findings.

The prompt in the template carries the full contract. The gate checks the heading, the coverage line, the review state, the commit, and the count.

## Docs-governance mode

Some repositories follow the docs-governance method, where documentation is product authority. The `docs-governance` skill covers that method; this skill does not depend on it. Detect such a repository by an `AGENTS.md` or `CLAUDE.md` that routes to a product-authority document, a decision registry, and a change registry (often `docs/governance/`, `docs/decisions/`, `docs/changes/`).

When you detect it, suggest `REVIEW_GOVERNANCE: 'on'` to the user. With it on, the `rules-reviewer` also does three things:

- It follows the trusted route to the authority document.
- It finds the Delivery Ticket the PR implements, from the ticket IDs or issue numbers in the PR title or body, and reads its acceptance.
- It reads each decision and operations record the ticket, the route, or the changed files rely on.

A change that contradicts current authority is a **Rules** finding that cites the record ID. Leave the mode off everywhere else.

## References

- [references/security-model.md](references/security-model.md): read before changing any control, and when a user asks why the workflow is shaped this way. It covers least privilege, untrusted content, forks, mention triggers, secrets and OIDC, no shell, read-only sub-agents, the coverage gate, and residual risks.
- [references/troubleshooting.md](references/troubleshooting.md): read when a run fails, ends early, posts nothing, or reads too little.
