import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Helpers for a review run with a human. Drafts live in comments.json in a review directory
// (.scratch/review-<PR>/, or a round<N>/ folder inside it); this script checks them against the
// pull request's diff, renders them for the human, builds the review payload, and maps, resolves,
// and replies to the review threads. Nothing reaches GitHub without --yes, except the read-only
// calls; the review itself is posted with `gh api` so the agent sends it in the open.

const kinds = ['review', 'fyi'];
const fixes = ['exact', 'approach', 'none'];
const events = ['REQUEST_CHANGES', 'COMMENT', 'APPROVE'];
const fyiPrefix = '**FYI (non-blocking)**';

function run(command, args, { allowFail = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}
const git = (...args) => run('git', args).stdout;
const gh = (...args) => run('gh', args).stdout;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// Each hunk's line range on both sides of a `git diff` for one file.
export function parseHunks(diff) {
  const hunks = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [, oldStart, oldCount = '1', newStart, newCount = '1'] = match;
    hunks.push({
      LEFT: { start: Number(oldStart), count: Number(oldCount) },
      RIGHT: { start: Number(newStart), count: Number(newCount) },
    });
  }
  return hunks;
}

function hunkIndex(hunks, side, line) {
  return hunks.findIndex(({ [side]: { start, count } }) => line >= start && line < start + count);
}

// Prose with fenced and inline code removed, for the checks that look at words only.
function prose(body) {
  return body.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

// The replacement lines of each ```suggestion block, in order.
export function suggestions(body) {
  return [...body.matchAll(/^(`{3,})suggestion[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)].map(([, , content]) =>
    content === '' ? [] : content.replace(/\n$/, '').split('\n'));
}

// @login and @org/team mentions GitHub would notify, outside code.
export function bareMentions(body) {
  return [...prose(body).matchAll(/(?:^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[\w-]+)?)/g)].map((m) => m[1]);
}

export function hintWords(body) {
  return [...prose(body).matchAll(/\bhints?\b/gi)].map((m) => m[0]);
}

export function finalBody(comment) {
  return comment.kind === 'fyi' && !comment.body.startsWith(fyiPrefix) ? `${fyiPrefix} ${comment.body}` : comment.body;
}

export function chooseEvent(comments, override) {
  if (override) {
    if (!events.includes(override)) throw new Error(`--event must be one of ${events.join(', ')}.`);
    return override;
  }
  return comments.some((c) => c.kind === 'review') ? 'REQUEST_CHANGES' : 'COMMENT';
}

// Problems with one draft, given its file's hunks and head lines. Returns the anchored text so the
// caller can record it; a recorded anchor that no longer matches means the code moved under it.
export function checkComment(comment, { hunks, headLines }) {
  const problems = [];
  const { id, path, line, start_line: startLine, body } = comment;
  const side = comment.side ?? 'RIGHT';
  for (const field of ['id', 'path', 'line', 'body']) if (comment[field] === undefined) problems.push(`missing ${field}`);
  if (!kinds.includes(comment.kind)) problems.push(`kind must be ${kinds.join(' or ')}`);
  if (!fixes.includes(comment.fix)) problems.push(`fix must be ${fixes.join(', ')}`);
  if (!['RIGHT', 'LEFT'].includes(side)) problems.push('side must be RIGHT or LEFT');
  if (problems.length) return { id, problems };

  const end = hunkIndex(hunks, side, line);
  if (!hunks.length) problems.push(`${path} is not in the pull request's diff`);
  else if (end < 0) problems.push(`${side} line ${line} is outside the diff hunks of ${path}`);
  if (startLine !== undefined) {
    if (startLine >= line) problems.push('start_line must be below line');
    else if (end >= 0 && hunkIndex(hunks, side, startLine) !== end) problems.push('start_line and line must be in one hunk');
  }

  const blocks = suggestions(body);
  if (comment.fix === 'exact' && blocks.length !== 1) problems.push('fix "exact" needs exactly one suggestion block');
  if (comment.fix !== 'exact' && blocks.length) problems.push(`fix "${comment.fix}" must not carry a suggestion block`);
  if (blocks.length && side !== 'RIGHT') problems.push('a suggestion must be on the RIGHT side');

  const mentions = bareMentions(finalBody(comment)).filter((m) => !(comment.mentions ?? []).includes(m));
  if (mentions.length) problems.push(`bare mention ${mentions.map((m) => `@${m}`).join(', ')} (backtick it, or list it in "mentions")`);
  const hints = hintWords(body);
  if (hints.length) problems.push(`says "${hints[0]}"; name the approach or suggestion instead`);

  let anchor;
  if (side === 'RIGHT' && end >= 0) {
    anchor = headLines.slice((startLine ?? line) - 1, line);
    if (comment.anchor && comment.anchor.join('\n') !== anchor.join('\n')) {
      problems.push('stale: the anchored lines changed since drafting; re-check the comment, then delete "anchor"');
    }
  }
  return { id, problems, anchor };
}

// The file after one exact suggestion is applied.
export function applySuggestion(headLines, comment) {
  const [replacement] = suggestions(comment.body);
  if (!replacement) throw new Error(`${comment.id} has no suggestion block.`);
  const start = (comment.start_line ?? comment.line) - 1;
  return [...headLines.slice(0, start), ...replacement, ...headLines.slice(comment.line)];
}

export function renderMarkdown(pr, comments) {
  const out = [`# PR #${pr}: drafted comments`, ''];
  comments.forEach((c, index) => {
    const range = c.start_line ? `${c.start_line}-${c.line}` : `${c.line}`;
    out.push(`## ${index + 1}. ${c.id} · ${c.kind} · fix: ${c.fix} · \`${c.path}:${range}\``, '', finalBody(c), '');
  });
  return out.join('\n');
}

const normalize = (text) => text.replace(/\r\n/g, '\n').trim();

// Maps each review thread to a finding ID by its first comment's body, narrowed by path and
// original line when bodies repeat, and by path and line alone when the body was edited. Threads
// that match no draft are someone else's, keyed by their author.
export function matchThreads(threads, drafts) {
  const ids = {};
  for (const thread of threads) {
    const first = thread.comments.nodes[0];
    const near = (list) => list.filter((d) => d.path === thread.path && d.line === thread.originalLine);
    let found = drafts.filter((d) => first && normalize(finalBody(d)) === normalize(first.body));
    if (found.length > 1) found = near(found);
    if (!found.length) found = near(drafts);
    ids[thread.id] = found.length === 1 ? found[0].id : `other:${first?.author?.login ?? 'unknown'}`;
  }
  return ids;
}

// The review directory holding meta.json: the given one, or its parent for a round<N>/ folder.
function locate(dir) {
  for (const root of [dir, dirname(dir)]) {
    if (existsSync(join(root, 'meta.json'))) return { root, meta: readJson(join(root, 'meta.json')) };
  }
  throw new Error(`No meta.json in ${dir} or its parent. Run init first.`);
}

function drafts(dir) {
  const path = join(dir, 'comments.json');
  if (!existsSync(path)) throw new Error(`${path} does not exist.`);
  return readJson(path);
}

function allDrafts(root) {
  const dirs = [root, ...readdirSync(root).filter((d) => /^round\d+$/.test(d)).map((d) => join(root, d))];
  return dirs.filter((d) => existsSync(join(d, 'comments.json'))).flatMap(drafts);
}

function prHead(meta) {
  return gh('pr', 'view', String(meta.pr), '-R', meta.repo, '--json', 'headRefOid', '--jq', '.headRefOid').trim();
}

function initCommand(pr) {
  const info = JSON.parse(gh('pr', 'view', pr, '--json', 'number,baseRefName,headRefOid,url'));
  const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').trim();
  const dir = join('.scratch', `review-${info.number}`);
  if (run('git', ['check-ignore', '-q', dir], { allowFail: true }).status !== 0) {
    throw new Error(`${dir} is not ignored by git. Add .scratch/ to .gitignore first (ask the user).`);
  }
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'meta.json'), { repo, pr: info.number, base: info.baseRefName, url: info.url });
  const findings = join(dir, 'findings.md');
  if (!existsSync(findings)) {
    writeFileSync(findings, [
      `# PR #${info.number} review: findings`, '',
      `${info.url} · base \`${info.baseRefName}\``, '',
      'Status: [open] · [discussing] · [agreed] · [drafted] · [dropped: why] · [resolved] · [unresolved: why]',
      'IDs: P bug · S standards · X spec · N the user\'s · other prefixes as the review needs', '',
      '## Findings', '', '## Actions', '', '## Rounds', '',
    ].join('\n'));
  }
  console.log(`${dir} (${existsSync(join(dir, 'comments.json')) ? 'resumed' : 'new'})`);
}

function renderCommand(dir) {
  const { meta } = locate(dir);
  writeFileSync(join(dir, 'comments.md'), renderMarkdown(meta.pr, drafts(dir)));
  console.log(`Wrote ${join(dir, 'comments.md')}.`);
}

// Checks every draft against the pull request head, which must be what is checked out.
function check(dir) {
  const { meta } = locate(dir);
  const head = prHead(meta);
  const local = git('rev-parse', 'HEAD').trim();
  if (local !== head) throw new Error(`HEAD is ${local.slice(0, 7)} but the pull request head is ${head.slice(0, 7)}. Pull first.`);
  git('fetch', '-q', 'origin', meta.base);
  const mergeBase = git('merge-base', `origin/${meta.base}`, head).trim();
  const comments = drafts(dir);
  const ids = new Set();
  const results = comments.map((comment) => {
    let hunks = [];
    let headLines = [];
    if (comment.path) {
      hunks = parseHunks(git('diff', '-U3', '--no-color', mergeBase, head, '--', comment.path));
      const shown = run('git', ['show', `${head}:${comment.path}`], { allowFail: true });
      if (shown.status === 0) headLines = shown.stdout.split('\n');
    }
    const result = checkComment(comment, { hunks, headLines });
    if (ids.has(comment.id)) result.problems.push('duplicate id');
    ids.add(comment.id);
    if (result.anchor && !comment.anchor) comment.anchor = result.anchor;
    return result;
  });
  writeJson(join(dir, 'comments.json'), comments);
  const failed = results.filter((r) => r.problems.length);
  for (const { id, problems } of failed) for (const p of problems) console.log(`${id}: ${p}`);
  console.log(`${comments.length - failed.length}/${comments.length} drafts OK on ${head.slice(0, 7)}.`);
  return { meta, head, comments, ok: failed.length === 0 };
}

function previewCommand(dir, id, apply) {
  const { meta } = locate(dir);
  const comment = drafts(dir).find((c) => c.id === id);
  if (!comment) throw new Error(`No draft ${id}.`);
  const head = prHead(meta);
  const before = git('show', `${head}:${comment.path}`).split('\n');
  const after = applySuggestion(before, comment);
  const start = comment.start_line ?? comment.line;
  console.log(`${comment.path}:${start}-${comment.line} on ${head.slice(0, 7)}`);
  for (const l of before.slice(start - 1, comment.line)) console.log(`- ${l}`);
  for (const l of suggestions(comment.body)[0]) console.log(`+ ${l}`);
  if (!apply) return;
  if (run('git', ['diff', '--quiet', 'HEAD', '--', comment.path], { allowFail: true }).status !== 0) {
    throw new Error(`${comment.path} has local changes; not applying.`);
  }
  writeFileSync(comment.path, after.join('\n'));
  console.log(`Applied to the working tree. Run the checks, then restore it: git checkout -- ${comment.path}`);
}

function payloadCommand(dir, event) {
  const { head, comments, ok } = check(dir);
  if (!ok) throw new Error('Fix the drafts above before building the payload.');
  const bodyPath = join(dir, 'review-body.md');
  if (!existsSync(bodyPath)) throw new Error(`${bodyPath} does not exist.`);
  const body = readFileSync(bodyPath, 'utf8');
  if (bareMentions(body).length) throw new Error(`review-body.md has bare mentions: ${bareMentions(body).join(', ')}.`);
  const chosen = chooseEvent(comments, event);
  writeJson(join(dir, 'review-payload.json'), {
    commit_id: head,
    event: chosen,
    body,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      ...(c.start_line ? { start_line: c.start_line, start_side: c.side ?? 'RIGHT' } : {}),
      body: finalBody(c),
    })),
  });
  const fyi = comments.filter((c) => c.kind === 'fyi').length;
  const user = gh('api', 'user', '--jq', '.login').trim();
  console.log(`${join(dir, 'review-payload.json')}: ${chosen}, ${comments.length - fyi} review + ${fyi} FYI ` +
    `comments on ${head.slice(0, 7)}, posting as ${user}.`);
}

const threadsQuery = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { databaseId author { login } body createdAt } }
        }
      }
    }
  }
}`;

function threadsCommand(dir) {
  const { root, meta } = locate(dir);
  const [owner, name] = meta.repo.split('/');
  const pages = JSON.parse(gh('api', 'graphql', '--paginate', '--slurp', '-f', `query=${threadsQuery}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${meta.pr}`));
  const threads = pages.flatMap((p) => p.data.repository.pullRequest.reviewThreads.nodes);
  const ids = matchThreads(threads, allDrafts(root));
  writeJson(join(root, 'threads.json'), threads);
  writeJson(join(root, 'thread-ids.json'), ids);
  for (const t of threads) {
    const flags = `${t.isResolved ? 'resolved' : 'open'}${t.isOutdated ? ', outdated' : ''}`;
    console.log(`\n${ids[t.id]} [${flags}] ${t.path}:${t.originalLine} -> ${t.line ?? 'gone'}`);
    for (const c of t.comments.nodes.slice(1)) {
      console.log(`  ↳ ${c.author?.login} ${c.createdAt.slice(0, 16)}: ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  console.log(`\n${threads.length} threads, ${threads.filter((t) => t.isResolved).length} resolved. ` +
    `Full replies in ${join(root, 'threads.json')}.`);
}

function threadFor(root, id) {
  const ids = readJson(join(root, 'thread-ids.json'));
  const threads = readJson(join(root, 'threads.json'));
  const matches = Object.keys(ids).filter((t) => ids[t] === id);
  if (matches.length !== 1) throw new Error(`${id} maps to ${matches.length} threads. Run threads, or fix thread-ids.json.`);
  return threads.find((t) => t.id === matches[0]);
}

function resolveCommand(dir, findingIds, yes) {
  const { root } = locate(dir);
  const targets = findingIds.map((id) => ({ id, thread: threadFor(root, id) }));
  for (const { id, thread } of targets) {
    if (!yes) {
      console.log(`would resolve ${id} (${thread.path}:${thread.originalLine})`);
      continue;
    }
    const result = gh('api', 'graphql', '-f',
      'query=mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }',
      '-f', `id=${thread.id}`, '--jq', '.data.resolveReviewThread.thread.isResolved').trim();
    console.log(`${id}: resolved=${result}`);
  }
  if (!yes) console.log('Nothing sent. Add --yes once the user has agreed.');
}

function replyCommand(dir, file, yes) {
  const { root, meta } = locate(dir);
  const replies = readJson(file);
  for (const r of replies) {
    const mentions = bareMentions(r.body).filter((m) => !(r.mentions ?? []).includes(m));
    if (mentions.length) throw new Error(`${r.id}: bare mention ${mentions.join(', ')}.`);
    if (hintWords(r.body).length) throw new Error(`${r.id}: says "hint"; name the approach instead.`);
  }
  for (const r of replies) {
    const first = threadFor(root, r.id).comments.nodes[0].databaseId;
    if (!yes) {
      console.log(`would reply on ${r.id} (comment ${first}): ${r.body.replace(/\s+/g, ' ').slice(0, 120)}`);
      continue;
    }
    const id = gh('api', '--method', 'POST', `repos/${meta.repo}/pulls/${meta.pr}/comments/${first}/replies`,
      '-f', `body=${r.body}`, '--jq', '.html_url').trim();
    console.log(`${r.id}: ${id}`);
  }
  if (!yes) console.log('Nothing sent. Add --yes once the user has agreed.');
}

const usage = `Usage: pair-review.mjs <command>
  init PR                     create or resume .scratch/review-<PR>/
  render DIR                  comments.json -> comments.md
  check DIR                   check drafts against the pull request head
  preview DIR ID [--apply]    show (or apply) an exact suggestion
  payload DIR [--event E]     check, then write review-payload.json
  threads DIR                 fetch review threads, map them to finding IDs
  resolve DIR ID... [--yes]   resolve the threads of these findings
  reply DIR FILE [--yes]      post [{id, body}] replies on their threads`;

// Skills are usually installed through a symlink (~/.claude/skills -> ~/.agents/skills), and
// import.meta.url is the resolved path, so compare against argv[1]'s real path.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? false : argv.splice(i, 1) && true;
  };
  const option = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv.splice(i, 2)[1];
  };
  try {
    const yes = flag('--yes');
    const apply = flag('--apply');
    const event = option('--event');
    const [command, ...args] = argv;
    if (command === 'init' && args.length === 1) initCommand(args[0]);
    else if (command === 'render' && args.length === 1) renderCommand(args[0]);
    else if (command === 'check' && args.length === 1) process.exitCode = check(args[0]).ok ? 0 : 1;
    else if (command === 'preview' && args.length === 2) previewCommand(args[0], args[1], apply);
    else if (command === 'payload' && args.length === 1) payloadCommand(args[0], event);
    else if (command === 'threads' && args.length === 1) threadsCommand(args[0]);
    else if (command === 'resolve' && args.length >= 2) resolveCommand(args[0], args.slice(1), yes);
    else if (command === 'reply' && args.length === 2) replyCommand(args[0], args[1], yes);
    else throw new Error(usage);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
