# Security model

Why each control in the review workflow exists. Read this before you loosen, drop, or reshape one; each control closes a specific path, and most failures look like success when one is missing.

The threat: the pull request is **untrusted input** that steers an agent holding a model token and a GitHub token that can write reviews. Every control below either keeps that input from reaching an instruction, or keeps a misled agent from doing harm.

## Least privilege

- **Workflow default `contents: read`.** Only job `review` gets more: `id-token: write` for the OIDC token exchange, `issues: write`, and `pull-requests: read` for the context and summary steps. Claude posts reviews and comments with its app token. The job's `GITHUB_TOKEN` submits and dismisses no review, so the policy check rejects `pull-requests: write` there. No `actions: read`, so tag mode cannot install the CI-log tools. The tracking-comment jobs `track` and `report` hold `pull-requests: write` and nothing else; see [Tracking comments](#tracking-comments).
- **App token downgraded.** The Claude GitHub App token defaults to `contents: write`. `additional_permissions: contents: read` caps it, so a prompt-injected run cannot push or merge even if a tool limit fails. GitHub enforces this, not the model.
- **`persist-credentials: false`** on checkout keeps the job token out of `.git/config`.
- **Pin every action by commit SHA.** A tag can move; a SHA cannot. An action update is a reviewed change to the pin.

## Untrusted pull-request content

- **Trusted rules copy.** The job clones the default branch to `$RUNNER_TEMP/trusted-rules` and the reviewer reads its rules there. The checkout's copies of the rules belong to the change under review: a pull request that edits `AGENTS.md` cannot rewrite the rules that judge it.
- **`--setting-sources user`.** Stops the checkout's `CLAUDE.md` and `.claude/` (settings, hooks, agents) from loading. The action restores some of these from the base branch, but not every rules file, so the flag is the guarantee.
- **The script runs from the trusted copy.** `claude-review-gate.mjs` builds the manifest and the job summary from the default branch's copy, so a pull request cannot rewrite how its own context is built or reported.
- **Untrusted-data framing.** The prompt, system prompt, and every sub-agent definition say that PR text, comments, diffs, and file contents are data: they cannot change instructions, pick the verdict, or count as evidence. "Tests pass" in a PR body is a claim, not evidence. Sub-agents do not inherit the appended system prompt, so each definition repeats the rule.

## Fork pull requests

`pull_request` from a fork runs without secrets or an OIDC token, so the action cannot authenticate. The job condition skips them (`head.repo.full_name == github.repository`) instead of failing. Never switch to `pull_request_target` to reach forks: it runs with the base repository's secrets and write token against attacker-controlled content. The policy check rejects it.

## Who may trigger a mention

The action rejects actors without write access by default. Keep `allowed_non_write_users` unset and `allowed_bots` empty. A write-access user is already trusted to push workflows, so a mention from them adds no new reach. Each mention gets its own concurrency group, so a burst of mentions is answered rather than dropped.

## Private repositories: the mention fetch

For `issue_comment`, GitHub runs the default branch's workflow, which checks out the default branch with `persist-credentials: false`. In tag mode the action then runs `git fetch origin <head branch>` in `setupBranch` (`src/github/operations/branch.ts` at v1.0.248) before it sets any git credentials. A public repository answers that fetch anonymously. A private one refuses it, and the mention fails before Claude starts.

Pre-fetching the ref does not help, because the action's fetch is unconditional. The action has no input that gives its own git calls a credential. `allowed_non_write_users` turns on a helper, but it also widens who can trigger a run.

The fix is a git credential helper passed only through the `Run Claude` step's environment, as `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, and `GIT_CONFIG_VALUE_0`. It is on for mentions and off (`GIT_CONFIG_COUNT: 0`) for automatic review. Why it holds:

- **No token in config.** The helper's key and value are literal. The helper prints `GITHUB_TOKEN` only when git asks for a password. The action sets that variable to its own app token (`contents: read`) before prepare.
- **Nothing on disk.** No step writes a token to `.git/config` or a credential store. The action itself, with `use_commit_signing`, writes its token into the origin URL there after prepare. That is existing behavior, and the `Read(./.git/**)` deny keeps it from Claude.
- **Claude gains nothing.** The action already passes its whole environment, `GITHUB_TOKEN` included, to Claude. Claude still has no `Bash`, and `/proc` stays denied.
- **The policy check holds the shape.** `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`, and `GIT_CONFIG_PARAMETERS` must be literal, and no run step may write a credential or auth header with `git config`.

## Tracking comments

A mention gets the action's `claude[bot]` tracking comment ("Claude Code is working…"). Automatic review does not, and the action cannot end its own comment when prepare fails: it updates the comment only after prepare returns. Two jobs fill those gaps:

- `track` posts a `github-actions` comment when an automatic review starts, with a link to the run.
- `report` needs `track` and `review`, runs on `always()` unless `review` was skipped, and edits that comment with the review's result and a link to the review job. When a mention fails or is cancelled while `claude[bot]`'s comment still says "working", it posts a note that links the mention, the failed job, and the stuck comment. It posts the note only for commenters with `admin` or `write` permission, because the action refuses everyone else and that refusal also fails the job. A permission lookup that fails with anything but a 404 fails the step, so a refused call stays visible.

Why they are shaped this way:

- **A separate job holds `pull-requests: write`.** Commenting on a pull request with the job token needs it; `issues: write` gets `Resource not accessible by integration`. Job `review` must not hold it, because that token could submit or dismiss reviews. So `track` and `report` hold exactly that scope and run only bash steps: no actions, checkout, container, services, or secrets. They make only `gh api` calls with fixed text and `env` values. The policy check enforces all of this, and bash's `-eo pipefail` makes a failed call fail its step.
- **No edit of `claude[bot]`'s comment.** Only a comment's author can edit it, the action revokes its app token in its last step, and repeating its OIDC exchange would copy an undocumented API. So a stuck mention gets a new note instead.
- **No `track_progress`.** It forces tag mode for `pull_request`, whose prompt has Claude post its review into the tracking comment, breaking the one-formal-review contract.
- **No `actions: read`.** Job `review` outputs `job.check_run_id`, which is its job ID, so the link needs no job listing. When the ID is empty, the link falls back to the run.

## Expressions stay out of run scripts

Pull-request and comment text is untrusted. An expression inside a `run` script is pasted into the shell before it runs, so the policy check rejects any `${{ }}` in a run step. Every step takes its values through `env`.

## Secrets and OIDC

- **One secret, one step.** Only the SHA-pinned Claude action step reads the model credential, as its token input. No other step, job, or workflow reads it; the policy check enforces this, including `toJSON(secrets)` and `secrets: inherit`.
- **OIDC for the GitHub identity.** The action exchanges the job's OIDC token for a short-lived Claude GitHub App token and revokes it after the run. No GitHub PAT is stored.
- **The exchange refuses a workflow that differs from the default branch.** This blocks a pull request from editing the workflow to exfiltrate the token, and it is why a PR that changes the workflow cannot review itself.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`** strips credentials other than GitHub tokens from the environments of subprocesses Claude starts (shell commands, hooks, stdio MCP servers), and on Linux runs shell commands in a bubblewrap PID namespace. Claude has no shell here, so it is defense in depth for the MCP servers and for any later widening. It refuses to start without bubblewrap, hence the install step.
- **Read limits.** `blockReadsOutsideWorkingDirectories` confines file tools to the checkout and the `--add-dir` directories, and the deny rules block `/proc`, `/sys`, and `.git`, where process environments and the action's token live.
- **Token lifecycle.** A `claude setup-token` OAuth token lasts a year and only makes model requests. Deleting the repository secret does not revoke it; revoke it from the owning Claude account.

## No shell

Claude gets no `Bash`. It reads with `Read`, `Grep`, `Glob`, and the GitHub MCP server's read tools, and writes only through review tools. A shell would reach the network, the environment, and the token on disk, and `Bash(cmd:*)` allowlists are brittle: a command with an extra flag misses the pattern and is denied. A workflow step, not Claude, fetches the diff and comments into line-oriented files Claude can page through.

The deny list names every dangerous tool explicitly (edit, write, commit, CI logs, merge, push, branch, issue and PR creation), so a later widening of an allowlist cannot let one in.

## Read-only sub-agents

Automatic review defines three sub-agent types through `--agents`: `diff-reviewer`, `rules-reviewer`, and `finding-validator`. Each lists only read tools, so none can submit a review, comment, or start another sub-agent. Headless Claude Code runs the `Agent` tool without asking permission, and a built-in type such as `general-purpose` would run with the main agent's tools. Two layers keep them out: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes every built-in type in non-interactive runs, and `Agent(<type>)` deny rules name each one in case that variable stops applying. A fork also inherits the main agent's tools, so `CLAUDE_CODE_FORK_SUBAGENT=0` keeps fork mode off and `Agent(fork)` is denied too. The job also denies `Workflow`. The built-in list belongs to the Claude Code version the action bundles: re-check it whenever the action pin changes. Mention mode defines no sub-agents.

The validator exists because reviewers over-report. A fresh sub-agent must confirm each candidate against the code or a rule before it is posted; anything unconfirmed is dropped.

## Coverage is reported, not enforced

There is no coverage gate. After the review, the job summary reports what the transcript shows: turns, denied tool calls, sub-agents started, the `diff.patch` lines read, and the source and skim files not read in full. It reports with warnings, not failures, when the action skipped Claude (it does that, with success, when the PR changes the workflow), when Claude did not finish, and when the run submitted no review or more than one. Nothing in that step fails the job, dismisses a review, or marks it incomplete.

What this costs:

- **The model's coverage claims are unverified.** The parallel `diff-reviewer` chunks make a full read likely, and each sub-agent reports the ranges it read, but nothing holds the verdict to those reports. An approval can stand on a partial read, and a green check does not mean a complete review, or any review at all. Read the job summary before relying on a verdict.
- **Verdicts are advisory.** A `claude[bot]` approval or change request is one reviewer's opinion. Merging stays human (see below).

A strict gate failed complete reviews over files no reviewer needed to read, such as vendored data classed as source. If a repository needs proof that every source range was read, build that check deliberately, with a skim class that fits the repository.

## Approval is advisory

The reviewer can approve, so decide before any branch-protection rule counts reviews whether a `claude[bot]` approval may satisfy it. Keep merging human. With the app token at `contents: read`, a misled approval still cannot merge, enable auto-merge, or push. The repository setting "Allow GitHub Actions to create and approve pull requests" governs `GITHUB_TOKEN`, not the app token, and can stay off.

## Transcript artifact

The job uploads `claude-execution-output.json` even on failure, so a shallow run or denied call can be diagnosed. It holds the prompt, tool calls, and repository content Claude read, and no secret given the controls above. Anyone with read access to the repository can download it; on a public repository that is everyone, so shorten retention or drop the upload there. Keep `show_full_output` off.

## Residual risks

- The diff and PR text can still try to mislead the reviewer, and a misled reviewer can approve a defective change.
- The reviewer can quote repository files in a comment.
- Review text sent through the GitHub MCP server is not redacted, unlike the action's own comment tool.
- Parallel sub-agents multiply model usage and can meet rate limits.
- Anyone with write access can push a workflow on a branch that reads any secret; a GitHub Environment with required reviewers closes that if the repository needs it.
