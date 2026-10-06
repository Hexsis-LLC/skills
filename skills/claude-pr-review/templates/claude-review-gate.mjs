import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The Claude review job builds the reviewer's change manifest with this script and summarizes the
// run with it. The summary is informational and gates nothing. The job runs the default branch's
// copy, so a pull request cannot rewrite the script that builds its context.

// PARAMETER: file classes. Source files are chunked for diff-reviewer sub-agents to read in full;
// lock files, fixtures and golden data, and documentation may be skimmed. Anything under
// alwaysSource, and any file of unknown kind, is source, so it gets a reader too. Widen skim only
// for files whose defects a reviewer could not find by reading the diff.
const alwaysSource = /^\.github\//;
const lockFiles = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]+\.lock)$/;
const fixtures = /(^|\/)(fixtures?|golden|snapshots|__snapshots__|testdata)\/|\.snap$/;
const docs = /^docs\/|\.(md|mdx|rst|txt)$/;
// PARAMETER: diff lines per source chunk; the reviewer starts one diff-reviewer per chunk.
const defaultChunkLines = 800;

export function classifyPath(path) {
  if (alwaysSource.test(path)) return 'source';
  if (lockFiles.test(path) || fixtures.test(path) || docs.test(path)) return 'skim';
  return 'source';
}

function unquote(path) {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path);
  } catch {
    return path.slice(1, -1);
  }
}

// The file a `diff --git` section changes, from its +++/---/rename lines or, failing that, its header.
function sectionPath(lines) {
  let removed;
  for (const line of lines) {
    const path = () => unquote(line.slice(4)).replace(/^[ab]\//, '');
    if (line.startsWith('+++ ') && line !== '+++ /dev/null') return path();
    if (line.startsWith('--- ') && line !== '--- /dev/null') removed = path();
    if (line.startsWith('rename to ')) return unquote(line.slice(10));
    if (line.startsWith('@@')) break;
  }
  if (removed) return removed;
  const header = lines[0].slice('diff --git '.length);
  const half = (header.length - 1) / 2;
  return header.startsWith('a/') && header.slice(half + 1).startsWith('b/') ? header.slice(half + 3) : header;
}

function sections(diff) {
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const found = new Map();
  let start = null;
  const close = (end) => {
    if (start !== null) found.set(sectionPath(lines.slice(start - 1, end)), { start, end });
  };
  lines.forEach((line, index) => {
    if (line.startsWith('diff --git ')) {
      close(index);
      start = index + 1;
    }
  });
  close(lines.length);
  return { lines, found };
}

function synthesize(file) {
  const before = file.status === 'added' ? '/dev/null' : `a/${file.previous_filename ?? file.filename}`;
  const after = file.status === 'removed' ? '/dev/null' : `b/${file.filename}`;
  const missing = 'GitHub returned no patch for this file. Read it in the working tree.';
  return [`diff --git a/${file.previous_filename ?? file.filename} b/${file.filename}`, `--- ${before}`,
    `+++ ${after}`, ...(file.patch ? file.patch.split('\n') : [missing])];
}

// Builds the manifest the reviewer partitions: each changed file's class and diff.patch line range,
// and source chunks of about chunkLines diff lines. Files missing from the full diff (all of them when
// GitHub refuses it) get a section rebuilt from their per-file patch, so every file has a range.
export function buildContext({ files, diff, chunkLines = defaultChunkLines }) {
  const { lines, found } = sections(diff);
  const missing = files.filter((file) => !found.has(file.filename));
  for (const file of missing) {
    const start = lines.length + 1;
    lines.push(...synthesize(file));
    found.set(file.filename, { start, end: lines.length });
  }
  const manifest = files.map((file) => ({
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    fileClass: classifyPath(file.filename),
    patch: Boolean(file.patch),
    ...found.get(file.filename),
    chunks: [],
  }));
  const chunks = [];
  let chunk = 0;
  let size = 0;
  const source = manifest.filter(({ fileClass }) => fileClass === 'source').sort((a, b) => a.start - b.start);
  for (const entry of source) {
    // A file that does not fit starts a new chunk; only a file larger than a chunk is split.
    if (chunk === 0 || (size > 0 && size + entry.end - entry.start + 1 > chunkLines)) {
      chunk += 1;
      size = 0;
    }
    for (let start = entry.start; start <= entry.end;) {
      if (size >= chunkLines) {
        chunk += 1;
        size = 0;
      }
      const end = Math.min(entry.end, start + chunkLines - size - 1);
      chunks.push({ chunk, path: entry.path, start, end });
      entry.chunks.push(chunk);
      size += end - start + 1;
      start = end + 1;
    }
  }
  return { diff: `${lines.join('\n')}\n`, manifest, chunks, synthesized: missing.length > 0 };
}

export function formatManifest({ manifest }) {
  return ['# class\tstatus\tadditions\tdeletions\tdiff_start\tdiff_end\tchunk\tpath',
    ...manifest.map((e) => [e.fileClass, e.status, e.additions, e.deletions, e.start, e.end,
      e.chunks.length ? e.chunks.join(',') : '-', e.path].join('\t'))].join('\n') + '\n';
}

export function formatChunks({ chunks }) {
  const rows = chunks.map((c) => [c.chunk, c.start, c.end, c.path].join('\t'));
  return ['# chunk\tdiff_start\tdiff_end\tpath', ...rows].join('\n') + '\n';
}

const contentBlocks = (message) => (Array.isArray(message.message?.content) ? message.message.content : []);

// diff.patch line numbers that a successful Read by Claude or any sub-agent returned. Read numbers
// each returned line as `N<tab>`; older Claude Code releases used `N→`.
function linesRead(messages, diffPath) {
  const readCallIds = new Set();
  const readLines = new Set();
  for (const message of messages) {
    for (const block of contentBlocks(message)) {
      if (block?.type === 'tool_use' && block.name === 'Read' &&
        resolve(String(block.input?.file_path ?? '')) === resolve(diffPath)) readCallIds.add(block.id);
      if (block?.type === 'tool_result' && readCallIds.has(block.tool_use_id) && block.is_error !== true) {
        const text = typeof block.content === 'string' ? block.content
          : (Array.isArray(block.content) ? block.content : []).map((part) => part?.text ?? '').join('\n');
        for (const [, number] of text.matchAll(/^\s*(\d+)(?:\t|→)/gm)) readLines.add(Number(number));
      }
    }
  }
  return readLines;
}

function fullyRead(entry, readLines) {
  for (let line = entry.start; line <= entry.end; line += 1) if (!readLines.has(line)) return false;
  return true;
}

const code = (path) => `\`${path}\``;

// Summarizes one automatic review run for the job summary: turns, denied tool calls, sub-agents, the
// diff.patch lines and files that Claude and its sub-agents read, and the review this run left. It is
// informational: nothing here fails the job, dismisses a review, or judges coverage, and the counts
// never decide a verdict.
export function summarizeReview({ manifest, messages, reviews, headSha, started, conclusion, claudeOutcome,
  diffPath }) {
  const warnings = [];
  const notes = [];
  if (!conclusion && claudeOutcome === 'success') {
    warnings.push('The action skipped Claude, which happens when a pull request changes this workflow. ' +
      'This pull request was not reviewed.');
    return { warnings, summary: warnings.map((w) => `Warning: ${w}`).join('\n\n') };
  }

  const result = messages.filter((m) => m.type === 'result').at(-1);
  const denials = result?.permission_denials ?? [];
  const agents = messages.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id)
    .flatMap(contentBlocks)
    .filter((block) => block?.type === 'tool_use' && ['Agent', 'Task'].includes(block.name))
    .map((block) => block.input?.subagent_type ?? 'unknown');
  if (result) {
    const types = Object.entries(Object.groupBy(agents, (type) => type))
      .map(([type, runs]) => `${runs.length} ${type}`).join(', ');
    notes.push(`Turns: ${result.num_turns}. Denied tool calls: ${denials.length}. ` +
      `Sub-agents: ${agents.length}${agents.length ? ` (${types})` : ''}.`);
  }
  for (const denial of denials) warnings.push(`Claude was denied ${denial.tool_name}`);

  const readLines = linesRead(messages, diffPath);
  const total = Math.max(0, ...manifest.map((entry) => entry.end));
  const unread = (fileClass) => manifest.filter((entry) => entry.fileClass === fileClass &&
    !fullyRead(entry, readLines)).map((entry) => code(entry.path));
  const source = manifest.filter((entry) => entry.fileClass === 'source').length;
  const unreadSource = unread('source');
  const unreadSkim = unread('skim');
  notes.push(`diff.patch lines read: ${[...readLines].filter((line) => line <= total).length} of ${total}.`);
  notes.push(`Source files read in full: ${source - unreadSource.length} of ${source}` +
    `${unreadSource.length ? `; not read in full: ${unreadSource.join(', ')}` : ''}.`);
  notes.push(`Skim files not read in full: ${unreadSkim.length ? unreadSkim.join(', ') : 'none'}.`);

  const runReviews = reviews.filter((r) => r.commit_id === headSha && r.state !== 'PENDING' &&
    (r.submitted_at ?? '') >= started);
  if (claudeOutcome !== 'success') warnings.push(`Claude did not finish (step outcome: ${claudeOutcome || 'unknown'}).`);
  if (!runReviews.length) {
    warnings.push(`Claude submitted no review on ${headSha} in this run.`);
  } else {
    if (runReviews.length > 1) warnings.push(`Claude submitted ${runReviews.length} reviews in this run.`);
    for (const review of runReviews) notes.push(`Review: ${review.state}.\n\n${review.body ?? ''}`);
  }
  return { warnings, summary: [...notes, ...warnings.map((w) => `Warning: ${w}`)].join('\n\n') };
}

const jsonLines = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line));

function contextCommand(dir) {
  const diffPath = join(dir, 'diff.patch');
  const context = buildContext({
    files: jsonLines(join(dir, 'files.jsonl')),
    diff: existsSync(diffPath) ? readFileSync(diffPath, 'utf8') : '',
  });
  if (context.synthesized) writeFileSync(diffPath, context.diff);
  writeFileSync(join(dir, 'manifest.tsv'), formatManifest(context));
  writeFileSync(join(dir, 'chunks.tsv'), formatChunks(context));
  const files = context.manifest.length;
  const source = context.manifest.filter((entry) => entry.fileClass === 'source').length;
  const chunks = new Set(context.chunks.map((c) => c.chunk)).size;
  console.log(`${files} changed files: ${source} source, ${files - source} skim; ${chunks} chunks.` +
    `${context.synthesized ? ' Rebuilt missing diff sections.' : ''}`);
}

// Never fails: a summary that cannot be built is reported as a warning.
function summaryCommand(dir, reviewsPath, transcriptPath) {
  try {
    const diffPath = join(dir, 'diff.patch');
    let messages = [];
    try {
      messages = JSON.parse(readFileSync(transcriptPath, 'utf8')).filter((m) => m && typeof m === 'object');
    } catch (error) {
      console.log(`::warning::Could not read the Claude transcript: ${error.message}`);
    }
    const report = summarizeReview({
      manifest: buildContext({ files: jsonLines(join(dir, 'files.jsonl')), diff: readFileSync(diffPath, 'utf8') })
        .manifest,
      messages,
      reviews: existsSync(reviewsPath) ? jsonLines(reviewsPath) : [],
      headSha: process.env.HEAD_SHA,
      started: process.env.STARTED,
      conclusion: process.env.CONCLUSION,
      claudeOutcome: process.env.CLAUDE_OUTCOME,
      diffPath,
    });
    for (const warning of report.warnings) console.log(`::warning::${warning}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${report.summary}\n`);
  } catch (error) {
    console.log(`::warning::Could not summarize the Claude review: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'context' && args.length === 1) contextCommand(args[0]);
    else if (command === 'summary' && args.length === 3) summaryCommand(...args);
    else throw new Error('Usage: claude-review-gate.mjs context DIR | summary DIR REVIEWS TRANSCRIPT.');
  } catch (error) {
    console.log(`::error::Claude review context failed: ${error.message}`);
    process.exitCode = 1;
  }
}
