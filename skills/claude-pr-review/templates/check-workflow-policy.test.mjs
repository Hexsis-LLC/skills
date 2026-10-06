import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./check-workflow-policy.mjs', import.meta.url));
// Another workflow that keeps its own secrets and permissions.
const deploy = `name: Deploy
on:
  push:
permissions:
  contents: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
`;
const review = `name: Claude review
on:
  pull_request:
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: write
      id-token: write
    env:
      REVIEW_TOOLS: >-
        Read,Grep,Agent,
        mcp__github__create_and_submit_pull_request_review
      MENTION_TOOLS: >-
        Read,Grep,
        mcp__github_inline_comment__create_inline_comment
      DENIED_TOOLS: >-
        Edit,Write,Bash,Workflow,
        Agent(general-purpose),Agent(claude),Agent(Explore),Agent(Plan),
        Agent(statusline-setup),Agent(claude-code-guide),
        mcp__github__merge_pull_request
      REVIEW_AGENTS: >-
        {"diff-reviewer": {"description": "Reads a diff range.",
        "tools": ["Read", "Grep", "mcp__github__get_file_contents"], "prompt": "Review
        it."}}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: anthropics/claude-code-action@86d88e619d8e6caf07b5c3944dd14f441c533718 # v1.0.243
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          additional_permissions: |
            contents: read
          claude_args: >-
            --agents '\${{ github.event_name == 'pull_request' && env.REVIEW_AGENTS || '{}' }}'
            --allowedTools "\${{ github.event_name == 'pull_request' && env.REVIEW_TOOLS || env.MENTION_TOOLS }}"
            --disallowedTools "\${{ env.DENIED_TOOLS }}"
`;
const otherJob = `  other:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - run: echo ok
`;

function run(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-workflow-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  const all = { '.github/workflows/claude-review.yml': review, '.github/workflows/deploy.yml': deploy, ...files };
  for (const [path, text] of Object.entries(all).filter(([, text]) => text !== undefined)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
}

test('the review workflow beside another workflow with its own secrets passes', (t) => {
  // Given the review workflow with its scoped grant and a deploy workflow with its own secret.
  // When the policy check reads them.
  const result = run(t);
  // Then the policy passes.
  assert.equal(result.status, 0, result.stderr);
});

test('a missing review workflow fails', (t) => {
  // Given a repository without the review workflow.
  // When the policy check reads it.
  const result = run(t, { '.github/workflows/claude-review.yml': undefined });
  // Then it names the missing file.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /claude-review\.yml is missing/);
});

test('the review exception does not widen to other scopes, secrets, jobs, or workflows', (t) => {
  // Given review workflows that widen the grant, and other files or jobs that borrow it.
  const cases = [
    ['claude-review.yml', review.replace('contents: read\n      pull', 'contents: write\n      pull'), /write permissions/],
    ['claude-review.yml', review.replace('id-token: write', 'id-token: write\n      actions: write'), /write permissions/],
    ['claude-review.yml', review.replace('pull-requests: read', 'pull-requests: write'), /write permissions/],
    ['claude-review.yml', review.replace('CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'), /may read a secret/],
    ['claude-review.yml', review.replace('secrets.CLAUDE_CODE_OAUTH_TOKEN', "secrets['CLAUDE_CODE_OAUTH_TOKEN']"), /may read a secret/],
    ['claude-review.yml', review.replace('secrets.CLAUDE_CODE_OAUTH_TOKEN', 'Secrets.CLAUDE_CODE_OAUTH_TOKEN'), /may read a secret/],
    ['claude-review.yml', review.replace('@86d88e619d8e6caf07b5c3944dd14f441c533718 # v1.0.243', '@v1'), /may read a secret/],
    ['claude-review.yml', `${review}${otherJob}`, /write permissions/],
    ['claude-review.yml', `${review}${otherJob.replace('      - run: echo ok', '      - run: echo ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}')}`, /may read a secret/],
    ['claude-review.yml', review.replace('  review:\n', '  reviewer:\n'), /write permissions/],
    ['claude-review.yml', review.replace('pull_request:\n', 'pull_request_target:\n'), /pull_request_target/],
    ['claude-review.yml', review.replace('persist-credentials: false', 'fetch-depth: 1'), /persist-credentials: false/],
    ['deploy.yml', deploy.replace('DEPLOY_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'), /only .*claude-review\.yml may read/],
    ['deploy.yml', deploy.replace('secrets.DEPLOY_TOKEN', 'toJSON(secrets)'), /only .*claude-review\.yml may read/],
    ['deploy.yml', `${deploy}  call:\n    uses: ./.github/workflows/reusable.yml\n    secrets: inherit\n`,
      /only .*claude-review\.yml may read/],
  ];
  for (const [name, text, message] of cases) {
    // When the policy check reads each one.
    const result = run(t, { [`.github/workflows/${name}`]: text });
    // Then it rejects the widened grant.
    assert.equal(result.status, 1, text);
    assert.match(result.stderr, message);
  }
});

test('the approving reviewer keeps a read-only token and no merge tool or Bash', (t) => {
  // Given review workflows that let the app token write, or let Claude merge or run Bash.
  const cases = [
    [review.replace('          additional_permissions: |\n            contents: read\n', ''),
      /claude-review\.yml:34: the review app token must request exactly contents: read/],
    [review.replace('            contents: read\n', '            contents: write\n'),
      /the review app token must request exactly contents: read/],
    [review.replace('            contents: read\n', '            contents: read\n            actions: write\n'),
      /the review app token must request exactly contents: read/],
    [review.replace('Edit,Write,Bash,', 'Edit,Write,'), /must deny Bash in DENIED_TOOLS/],
    [review.replace(',\n        mcp__github__merge_pull_request', ''),
      /must deny mcp__github__merge_pull_request in DENIED_TOOLS/],
    [review.replace('Read,Grep,Agent,\n        mcp__github__create', 'Read,Grep,Agent,Bash(gh pr diff:*),\n        mcp__github__create'),
      /must not allow Bash in REVIEW_TOOLS/],
    [review.replace('Read,Grep,\n        mcp__github_inline', 'Read,Bash,\n        mcp__github_inline'),
      /must not allow Bash in MENTION_TOOLS/],
    [review.replace('--allowedTools "', '--allowedTools "Bash,'), /claude_args must take its tools only from the job's tool lists/],
    [review.replace('            --disallowedTools "\${{ env.DENIED_TOOLS }}"\n', ''),
      /claude_args must take its tools only from the job's tool lists/],
    [review.replace('--disallowedTools', '--allowedTools "Read" --disallowedTools'),
      /claude_args must take its tools only from the job's tool lists/],
  ];
  for (const [text, message] of cases) {
    // When the policy check reads each one.
    const result = run(t, { '.github/workflows/claude-review.yml': text });
    // Then it rejects the weakened reviewer.
    assert.equal(result.status, 1, text);
    assert.match(result.stderr, message);
  }
});

test('reviewer sub-agents stay read-only and built-in sub-agent types stay denied', (t) => {
  // Given review workflows that let a built-in sub-agent run, widen a defined sub-agent, or
  // pass sub-agents from outside the job's REVIEW_AGENTS.
  const cases = [
    [review.replace('Agent(general-purpose),', ''), /must deny Agent\(general-purpose\) in DENIED_TOOLS/],
    [review.replace('Agent(claude),', ''), /must deny Agent\(claude\) in DENIED_TOOLS/],
    [review.replace('Bash,Workflow,', 'Bash,'), /must deny Workflow in DENIED_TOOLS/],
    [review.replace('"tools": ["Read", "Grep", "mcp__github__get_file_contents"], ', ''),
      /sub-agent diff-reviewer must list only read tools/],
    [review.replace('["Read", "Grep",', '["Read", "Bash",'), /sub-agent diff-reviewer must list only read tools/],
    [review.replace('"mcp__github__get_file_contents"]', '"mcp__github__create_and_submit_pull_request_review"]'),
      /sub-agent diff-reviewer must list only read tools/],
    [review.replace('["Read", "Grep",', '["Read", "Agent",'), /sub-agent diff-reviewer must list only read tools/],
    [review.replace('{"diff-reviewer": {', '{"diff-reviewer": '), /REVIEW_AGENTS must be valid JSON/],
    [review.replace('it."}}', 'its range\'s lines."}}'), /REVIEW_AGENTS must not contain single quotes/],
    [review.replace('Reads a diff range.', 'Costs $1.'), /REVIEW_AGENTS must not contain single quotes, \$/],
    [review.replace("--agents '${{ github.event_name == 'pull_request' && env.REVIEW_AGENTS || '{}' }}'",
      `--agents '{"helper": {"description": "x", "prompt": "x"}}'`),
      /claude_args must take its sub-agents only from REVIEW_AGENTS/],
  ];
  for (const [text, message] of cases) {
    // When the policy check reads each one.
    const result = run(t, { '.github/workflows/claude-review.yml': text });
    // Then it rejects the widened sub-agent boundary.
    assert.equal(result.status, 1, text);
    assert.match(result.stderr, message);
  }
});
