import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildContext, classifyPath, judgeReview } from './claude-review-gate.mjs';

const cli = fileURLToPath(new URL('./claude-review-gate.mjs', import.meta.url));

// A three-file diff: lines 1-6 change a source file, 7-11 a lock file, 12-17 a guide.
const diff = [
  'diff --git a/src/session/store.ts b/src/session/store.ts',
  'index 1111111..2222222 100644',
  '--- a/src/session/store.ts',
  '+++ b/src/session/store.ts',
  '@@ -1 +1 @@',
  '-old',
  'diff --git a/package-lock.json b/package-lock.json',
  '--- a/package-lock.json',
  '+++ b/package-lock.json',
  '@@ -1 +1 @@',
  '+lock',
  'diff --git a/docs/guides/development.md b/docs/guides/development.md',
  'deleted file mode 100644',
  '--- a/docs/guides/development.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  '',
].join('\n');
const files = [
  { filename: 'src/session/store.ts', status: 'modified', additions: 0, deletions: 1, patch: '@@ -1 +1 @@\n-old' },
  { filename: 'package-lock.json', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+lock' },
  { filename: 'docs/guides/development.md', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-gone' },
];

test('changed files are classed as source or skim', () => {
  // Given paths from each class.
  const source = ['src/a.ts', 'apps/web/main.py', 'scripts/x.mjs', '.github/workflows/ci.yml',
    '.github/CODEOWNERS', 'package.json', 'Cargo.toml', 'Makefile', '.tool-versions', 'Dockerfile'];
  const skim = ['package-lock.json', 'yarn.lock', 'Cargo.lock', 'src/a/tests/fixtures/run.json',
    'src/a/tests/golden/plan.txt', 'src/__snapshots__/a.snap', 'docs/guides/setup.md', 'README.md', 'AGENTS.md'];
  // When each path is classified.
  // Then source paths need a full read and the rest may be skimmed.
  for (const path of source) assert.equal(classifyPath(path), 'source', path);
  for (const path of skim) assert.equal(classifyPath(path), 'skim', path);
});

test('the manifest gives each file its diff.patch range and class', () => {
  // Given GitHub's file list and the full diff.
  // When the context is built.
  const context = buildContext({ files, diff });
  // Then each file maps to the lines of its own section.
  assert.equal(context.synthesized, false);
  assert.deepEqual(context.manifest.map(({ path, fileClass, start, end }) => [path, fileClass, start, end]), [
    ['src/session/store.ts', 'source', 1, 6],
    ['package-lock.json', 'skim', 7, 11],
    ['docs/guides/development.md', 'skim', 12, 17],
  ]);
  assert.deepEqual(context.chunks, [{ chunk: 1, path: 'src/session/store.ts', start: 1, end: 6 }]);
});

test('source files group into chunks of about the chunk size, splitting only large files', () => {
  // Given four source files of 4, 4, 4, and 13 diff lines and a chunk size of 8.
  const section = (path, body) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body];
  const lines = [
    ...section('src/a.ts', ['@@']),
    ...section('src/b.ts', ['@@']),
    ...section('src/c.ts', ['@@']),
    ...section('src/d.ts', Array(10).fill('+x')),
  ];
  const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  // When the context is built.
  const { chunks } = buildContext({
    files: paths.map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 0, patch: '@@' })),
    diff: `${lines.join('\n')}\n`,
    chunkLines: 8,
  });
  // Then small files stay whole and only the 13-line file is split.
  assert.deepEqual(chunks, [
    { chunk: 1, path: 'src/a.ts', start: 1, end: 4 },
    { chunk: 1, path: 'src/b.ts', start: 5, end: 8 },
    { chunk: 2, path: 'src/c.ts', start: 9, end: 12 },
    { chunk: 3, path: 'src/d.ts', start: 13, end: 20 },
    { chunk: 4, path: 'src/d.ts', start: 21, end: 25 },
  ]);
});

test('a refused full diff is rebuilt from per-file patches', () => {
  // Given GitHub refused the full diff and one file has no patch.
  const withoutPatch = [...files.slice(0, 2), { ...files[2], patch: undefined }];
  // When the context is built.
  const context = buildContext({ files: withoutPatch, diff: '' });
  // Then every file still has a section, and the missing patch is named.
  assert.equal(context.synthesized, true);
  assert.deepEqual(context.manifest.map(({ start, end, patch }) => [start, end, patch]),
    [[1, 5, true], [6, 10, true], [11, 14, false]]);
  assert.match(context.diff.split('\n')[13], /GitHub returned no patch/);
});

// Transcript helpers: a Read call and its result, from the main agent or a sub-agent.
let nextId = 0;
function read(path, from, to, { parent = null, error = false } = {}) {
  const id = `toolu_${(nextId += 1)}`;
  const text = Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline`).join('\n');
  return [
    { type: 'assistant', parent_tool_use_id: parent, message: { content: [
      { type: 'tool_use', id, name: 'Read', input: { file_path: path, offset: from, limit: to - from + 1 } }] } },
    { type: 'user', parent_tool_use_id: parent, message: { content: [
      { type: 'tool_result', tool_use_id: id, is_error: error, content: error ? 'error' : text }] } },
  ];
}
const patch = '/runner/_temp/pr-context/diff.patch';
const result = { type: 'result', num_turns: 9, permission_denials: [] };
const head = 'a'.repeat(40);
const started = '2026-10-06T10:00:00Z';
const body = (files = 3) => `## Claude review: Approved\n\n**Reviewed ${files} of 3 changed files**\n\n` +
  'I checked the session store change against the review rules and found no material defect.\n';
const review = (overrides = {}) => ({
  id: 41, state: 'APPROVED', commit_id: head, submitted_at: '2026-10-06T10:05:00Z', body: body(), ...overrides,
});
const judge = (overrides = {}) => judgeReview({
  manifest: buildContext({ files, diff }).manifest,
  messages: [...read(patch, 1, 6, { parent: 'toolu_agent' }), result],
  reviews: [review()],
  changedFiles: 3,
  headSha: head,
  started,
  conclusion: 'success',
  claudeOutcome: 'success',
  diffPath: patch,
  ...overrides,
});

test('a complete approval or change request passes', () => {
  // Given a sub-agent read the only source file and Claude submitted a verdict this run.
  for (const state of ['APPROVED', 'CHANGES_REQUESTED']) {
    // When the verdict is judged.
    const decision = judge({ reviews: [review({ state })] });
    // Then it passes and reports the skimmed files that went unread.
    assert.equal(decision.errors.length, 0, decision.errors.join('\n'));
    assert.deepEqual(decision.dismiss, []);
    assert.match(decision.summary, /Source files read: 1 of 1/);
    assert.match(decision.summary, /Skim files not read: `package-lock\.json`, `docs\/guides\/development\.md`/);
  }
});

test('stale, other-commit, and pending reviews do not count', () => {
  // Given only a stale review, a review of another commit, and a pending review.
  const reviews = [
    review({ submitted_at: '2026-10-06T09:59:59Z' }),
    review({ commit_id: 'b'.repeat(40) }),
    review({ state: 'PENDING' }),
  ];
  // When the verdict is judged.
  const decision = judge({ reviews });
  // Then it fails without dismissing anything.
  assert.match(decision.errors.join('\n'), /without submitting a review on a{40} in this run/);
  assert.deepEqual(decision.dismiss, []);
});

test('an incomplete COMMENT review fails and cannot be dismissed', () => {
  // Given Claude left a COMMENT review.
  // When the verdict is judged.
  const decision = judge({ reviews: [review({ state: 'COMMENTED' })] });
  // Then it fails as not a verdict.
  assert.match(decision.errors.join('\n'), /left a COMMENTED review, not a verdict/);
  assert.deepEqual(decision.dismiss, []);
});

test('a wrong file count fails and dismisses the verdict', () => {
  // Given an approval that claims 2 of 3 files.
  // When the verdict is judged.
  const decision = judge({ reviews: [review({ body: body(2) })] });
  // Then the approval is dismissed.
  assert.match(decision.errors.join('\n'), /does not state that it reviewed all 3 changed files/);
  assert.deepEqual(decision.dismiss, [41]);
});

test('an unread source range fails and names the file in the dismissal', () => {
  // Given the source range was only partly read, and one read of the rest failed.
  const messages = [...read(patch, 1, 4), ...read(patch, 5, 6, { error: true }), ...read('/x/diff.patch.bak', 1, 6),
    result];
  // When the verdict is judged.
  const decision = judge({ messages, reviews: [review({ state: 'CHANGES_REQUESTED' })] });
  // Then the job fails, and the dismissal message names the unread source file.
  assert.match(decision.errors.join('\n'), /did not read 1 changed source file/);
  assert.deepEqual(decision.dismiss, [41]);
  assert.match(decision.dismissMessage, /^## Claude review: Incomplete/);
  assert.match(decision.dismissMessage, /^- Claude and its sub-agents did not read 1 changed source file in diff\.patch\.$/m);
  assert.match(decision.dismissMessage, /- `src\/session\/store\.ts`/);
});

test('a run where Claude did not finish dismisses any verdict it left', () => {
  // Given Claude approved and then the step failed, with or without a conclusion.
  for (const conclusion of ['failure', '']) {
    const decision = judge({ claudeOutcome: 'failure', conclusion });
    // When the verdict is judged.
    // Then the approval is dismissed with the whole reason.
    assert.match(decision.errors.join('\n'), /Claude did not finish/);
    assert.deepEqual(decision.dismiss, [41]);
    assert.match(decision.dismissMessage, /^- Claude did not finish \(step outcome: failure\)\.$/m);
  }
});

test('a skipped review fails without dismissing anything', () => {
  // Given the action skipped Claude because the pull request changes the workflow.
  // When the verdict is judged.
  const decision = judge({ conclusion: '', messages: [], reviews: [] });
  // Then it fails as unreviewed.
  assert.match(decision.errors.join('\n'), /action skipped Claude/);
  assert.deepEqual(decision.dismiss, []);
});

test('the CLI builds the context files and writes the verdict decision', (t) => {
  // Given a context directory with the file list and diff, and a review list.
  const dir = mkdtempSync(join(tmpdir(), 'claude-review-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'files.jsonl'), files.map((file) => JSON.stringify(file)).join('\n'));
  writeFileSync(join(dir, 'diff.patch'), diff);
  writeFileSync(join(dir, 'reviews.jsonl'), JSON.stringify(review({ body: body(2) })));
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify([...read(join(dir, 'diff.patch'), 1, 6), result]));
  const env = { ...process.env, HEAD_SHA: head, STARTED: started, CONCLUSION: 'success', CLAUDE_OUTCOME: 'success',
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
  // When the context and verdict commands run.
  const context = spawnSync(process.execPath, [cli, 'context', dir], { encoding: 'utf8' });
  const verdict = spawnSync(process.execPath, [cli, 'verdict', dir, join(dir, 'reviews.jsonl'),
    join(dir, 'transcript.json'), '3'], { encoding: 'utf8', env });
  // Then the manifest is written, the wrong count fails, and the dismissal is recorded.
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /^3 changed files: 1 source, 2 skim; 1 chunks\.$/m);
  assert.match(readFileSync(join(dir, 'manifest.tsv'), 'utf8'), /^source\tmodified\t0\t1\t1\t6\t1\tsrc\/session\/store\.ts$/m);
  assert.match(readFileSync(join(dir, 'chunks.tsv'), 'utf8'), /^1\t1\t6\tsrc\/session\/store\.ts$/m);
  assert.equal(verdict.status, 1);
  assert.match(verdict.stdout, /::error::Claude's review does not state/);
  assert.equal(readFileSync(join(dir, 'dismiss-ids.txt'), 'utf8'), '41\n');
  assert.match(readFileSync(join(dir, 'dismiss-message.md'), 'utf8'), /^## Claude review: Incomplete\n/);
  assert.match(readFileSync(join(dir, 'summary.md'), 'utf8'), /Verdict: APPROVED/);
});

test('more than one review in a run fails and dismisses each verdict', () => {
  // Given Claude submitted a change request and then an approval in the same run.
  // When the verdict is judged.
  const decision = judge({ reviews: [review({ id: 40, state: 'CHANGES_REQUESTED' }), review()] });
  // Then the run fails, and both verdicts are dismissed.
  assert.match(decision.errors.join('\n'), /submitted 2 reviews in this run, not exactly one/);
  assert.deepEqual(decision.dismiss, [40, 41]);
});

test('a summary that names no skim file draws no warning', () => {
  // Given an approval whose body is the heading, the coverage line, and one paragraph.
  // When the verdict is judged.
  const decision = judge();
  // Then it passes without warnings, although the skim files went unread and unnamed.
  assert.deepEqual(decision.errors, []);
  assert.deepEqual(decision.warnings, []);
});
