# Troubleshooting

Failure modes this setup has hit, by symptom. Most of them end **green with nothing posted**: the job does not fail over them, and the job summary reports them as warnings. Treat a quiet success as a failure until the summary and the transcript artifact prove otherwise. Read the job summary first (turns, denied calls, sub-agents, lines read, the review this run left), then the transcript.

## The run ends early, before any review is submitted

**Cause: background sub-agents.** When a sub-agent runs in the background, Claude ends its turn while it works, and the action stops reading at the first result message. The review is never submitted.
**Fix:** keep `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1'` in the job env. With it, a parallel launch of sub-agents yields one result message.

## The job fails with `bubblewrap is required for subprocess env scrubbing`

**Cause:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` needs bubblewrap on Linux, and the runner image lacks it, or Ubuntu's AppArmor blocks unprivileged user namespaces.
**Fix:** keep the `Install subprocess isolation` step. It installs `bubblewrap` and `socat`, sets `kernel.apparmor_restrict_unprivileged_userns=0`, and probes `bwrap`. Do not drop the scrub to make the error go away. On a self-hosted runner without `sudo`, bake bubblewrap into the image instead.

## Shell commands fail inside the sandbox; the review reads nothing and passes

**Cause:** with the scrub on, every Bash call runs in bubblewrap, which can fail on hosts that run Docker (`bwrap: Can't mkdir parents for /run/containerd/containerd.sock: Permission denied`). Separately, `Bash(gh pr view:*)`-style allowlists deny any command whose shape the pattern misses. Claude gives up and ends without reading the diff.
**Fix:** this is why the reviewer has no shell. Read through native GitHub MCP tools and the pre-fetched context files; keep `Bash` denied.

## Green check, nothing posted

**Cause:** a prompt that says "post nothing when you find nothing" makes a failed review and a clean review look the same.
**Fix:** every automatic review ends with exactly one formal review: `APPROVE` or `REQUEST_CHANGES`. The job summary warns when no review was submitted in this run; the job still passes, so read the summary.

## Green check, "submitted no review", and the transcript says a pending review already exists

**Cause: a cancelled run left a draft review.** To request changes, Claude creates a pending review, adds the inline comments, then submits it. A push between those steps cancels the run (`cancel-in-progress`) and leaves `claude[bot]`'s pending review on the PR. GitHub allows one pending review per account per pull request, so every later run's create and approve calls fail with "this account already has a pending review". Claude cannot list reviews, and only the `claude[bot]` identity can see or delete its pending review; a human token cannot.
**Fix:** the template's prompt now calls `mcp__github__delete_pending_pull_request_review` before it creates a review, and deletes and retries once if a create or submit is still rejected. For an older install, update the verdict step of the review prompt from the template; the tool is already in `REVIEW_TOOLS`. Do not add `get_pull_request_reviews` or change the concurrency settings. A fresh pull request also works.

## The review read a fraction of the diff

**Cause:** a reviewer's account of what it read is a claim. One unchecked reviewer approved after reading about a quarter of the diff lines and none of most source files, and cited the PR body's "tests pass" as evidence.
**Fix:** the parallel `diff-reviewer` chunks and the untrusted-data framing make a full read likely. Nothing enforces it: the job summary counts the `diff.patch` lines actually returned by `Read` calls in the transcript and names the source files not read in full, for information only. Check it before you rely on an approval.

## Claude cannot read large diffs

**Cause:** an oversized MCP tool result is saved as a single-line file outside the allowed read directories, and `Read` truncates long lines.
**Fix:** the context step writes `diff.patch` and friends as line-oriented files under `$RUNNER_TEMP/pr-context`, added with `--add-dir`, and the prompt pages them with `Read` offset and limit.

## `gh pr diff` fails on a very large pull request

**Cause:** GitHub refuses diffs past its size limit.
**Fix:** the context step writes an empty `diff.patch`, and the context script rebuilds it from the per-file patches in `files.jsonl`. Files GitHub returns no patch for get a stub section telling the reviewer to read the working tree.

## MCP tools are missing; the GitHub server never connected

**Cause:** the action starts the GitHub MCP server with `docker run` of an image tag; pulling it on a cold runner can outlast Claude's MCP startup timeout.
**Fix:** keep the `Pull GitHub MCP server` step, which pulls by digest and tags the image locally. After changing the action pin, re-read the image tag from the action's `src/mcp/install-mcp-server.ts` at the new SHA and re-resolve its digest.

## A pull request that changes the workflow is not reviewed

**Cause:** the OIDC token exchange refuses a workflow that differs from the default branch's copy, and the action skips with a warning and a success outcome but no `conclusion`.
**Expected.** The job passes, and its summary warns "The action skipped Claude", so a human must review the PR. The new workflow takes effect once merged.

## The setup pull request's review job fails with `MODULE_NOT_FOUND`

**Cause:** `Fetch pull-request context` runs `claude-review-gate.mjs` from `$RUNNER_TEMP/trusted-rules`, the default branch's copy. On the first setup PR the script is not on the default branch yet, so Node cannot find it and the job fails before Claude starts.
**Expected.** It is harmless: a human reviews the setup PR, and the job works once the PR merges. Later PRs that edit the workflow get the skip described above and pass. If the failure persists after the merge, check that the script directory in the two `node` lines matches where the scripts live on the default branch.

## A mention fails before Claude starts on a private repository

**Cause:** the action runs `git fetch origin <head branch>` before it sets any git credentials, and the checkout keeps none (`persist-credentials: false`). A private repository refuses the anonymous fetch, prepare throws, and `claude[bot]`'s comment stays at "Claude Code is working…".
**Fix:** keep the credential helper in the `Run Claude` step's `env` (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_VALUE_0`). It answers the fetch with the action's own read-only token. Do not set `persist-credentials: true` or write a token with `git config`; the policy check blocks both. See [security-model.md](security-model.md#private-repositories-the-mention-fetch).

## A tracking comment still says "working"

**Cause:** the action ends its `claude[bot]` comment only after its prepare phase, so a run that fails or is cancelled earlier leaves it stuck.
**Expected.** Job `report` posts a `github-actions` note that links the failed job and the stuck comment, for commenters with write access. If no note appears, read job `report`'s log: it says when write access was not confirmed, and it fails when a GitHub API call fails. For automatic review, `report` edits the `github-actions` tracking comment itself; if that comment never ends, check that `report` ran.

## Commenting fails with `Resource not accessible by integration`

**Cause:** the job token needs `pull-requests: write` to comment on a pull request; `issues: write` is not enough.
**Fix:** keep the comments in jobs `track` and `report`, which hold only `pull-requests: write`. Never give job `review` that scope: its token could then submit or dismiss reviews.

## A mention was ignored during a burst of comments

**Cause:** GitHub keeps only the newest pending run in a concurrency group, so a shared per-PR group drops older mentions.
**Fix:** keep the concurrency key that puts each mention in its own group (`github.event.comment.id`), and only automatic reviews in the per-PR `auto` group with `cancel-in-progress`.

## A built-in sub-agent ran with the main agent's tools

**Cause:** the `Agent` tool needs no permission in headless mode, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` was dropped or stopped applying, and a newer Claude Code added a built-in type the deny list does not name.
**Fix:** keep the variable set. After every action pin change, read the built-in sub-agent list in the Claude Code sub-agents documentation for the bundled version (the action's `base-action/action.yml` names it), and add each type as `Agent(<type>)` to `DENIED_TOOLS` and to `builtInAgents` in the policy check. The job summary's sub-agent count names every type the run started.

## The policy check blocks a comment

**Cause:** the check scans every `${{ … }}` expression in the review workflow text, comments included, so a commented-out `${{ secrets.X }}` counts as a second secret access.
**Fix:** write secret names in comments without the expression syntax.
