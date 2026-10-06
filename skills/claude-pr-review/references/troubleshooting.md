# Troubleshooting

Failure modes this setup has hit, by symptom. Most of them end **green with nothing posted**, which is why the gate exists: treat a quiet success as a failure until the transcript artifact proves otherwise. Read the job summary first (turns, denied calls, sub-agents, lines read), then the transcript.

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
**Fix:** every automatic review ends with exactly one formal review: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` when incomplete. The gate fails the job when no review was submitted in this run.

## The review claims full coverage but read a fraction of the diff

**Cause:** the model's own "Reviewed N of N" is a claim. One unchecked reviewer approved after reading about a quarter of the diff lines and none of most source files, and cited the PR body's "tests pass" as evidence.
**Fix:** the parallel `diff-reviewer` chunks, the untrusted-data framing, and the gate, which counts the `diff.patch` lines actually returned by `Read` calls in the transcript and dismisses the verdict when a source range is unread.

## Claude cannot read large diffs

**Cause:** an oversized MCP tool result is saved as a single-line file outside the allowed read directories, and `Read` truncates long lines.
**Fix:** the context step writes `diff.patch` and friends as line-oriented files under `$RUNNER_TEMP/pr-context`, added with `--add-dir`, and the prompt pages them with `Read` offset and limit.

## `gh pr diff` fails on a very large pull request

**Cause:** GitHub refuses diffs past its size limit.
**Fix:** the context step writes an empty `diff.patch`, and the gate rebuilds it from the per-file patches in `files.jsonl`. Files GitHub returns no patch for get a stub section telling the reviewer to read the working tree.

## MCP tools are missing; the GitHub server never connected

**Cause:** the action starts the GitHub MCP server with `docker run` of an image tag; pulling it on a cold runner can outlast Claude's MCP startup timeout.
**Fix:** keep the `Pull GitHub MCP server` step, which pulls by digest and tags the image locally. After changing the action pin, re-read the image tag from the action's `src/mcp/install-mcp-server.ts` at the new SHA and re-resolve its digest.

## A pull request that changes the workflow is not reviewed

**Cause:** the OIDC token exchange refuses a workflow that differs from the default branch's copy, and the action skips with a warning and a success outcome but no `conclusion`.
**Expected.** The gate fails the job with "The action skipped Claude", so the PR shows that a human must review it. The new workflow takes effect once merged. The same applies to the very first setup PR.

## A failed review's verdict was not dismissed

**Cause:** branch protection or a ruleset that limits who may dismiss reviews blocks the job's `GITHUB_TOKEN`.
**Fix:** allow the GitHub Actions app to dismiss reviews on that branch, or accept that failed verdicts stand until a human dismisses them, and note it in the repository's security docs.

## A mention was ignored during a burst of comments

**Cause:** GitHub keeps only the newest pending run in a concurrency group, so a shared per-PR group drops older mentions.
**Fix:** keep the concurrency key that puts each mention in its own group (`github.event.comment.id`), and only automatic reviews in the per-PR `auto` group with `cancel-in-progress`.

## A built-in sub-agent ran with the main agent's tools

**Cause:** the `Agent` tool needs no permission in headless mode, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` was dropped or stopped applying, and a newer Claude Code added a built-in type the deny list does not name.
**Fix:** keep the variable set. After every action pin change, read the built-in sub-agent list in the Claude Code sub-agents documentation for the bundled version (the action's `base-action/action.yml` names it), and add each type as `Agent(<type>)` to `DENIED_TOOLS` and to `builtInAgents` in the policy check. The job summary's sub-agent count names every type the run started.

## The policy check blocks a comment

**Cause:** the check scans every `${{ … }}` expression in the review workflow text, comments included, so a commented-out `${{ secrets.X }}` counts as a second secret access.
**Fix:** write secret names in comments without the expression syntax.

## The review body fails the coverage check

**Cause:** the coverage line has letters, a formula, or a count other than the PR's changed-file count, or the reviewer added sections.
**Fix:** the body must contain the line `**Reviewed N of N changed files**` with N equal to the PR's changed-file count. Keep the prompt's template intact; the gate's regex in `claude-review-gate.mjs` is the contract.
