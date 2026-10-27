import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySuggestion,
  bareMentions,
  checkComment,
  chooseEvent,
  finalBody,
  hintWords,
  matchThreads,
  parseHunks,
  renderMarkdown,
  suggestions,
} from './pair-review.mjs';

// A file whose diff has two hunks: new lines 3-9 and 20-20.
const diff = [
  'diff --git a/lib/a.dart b/lib/a.dart',
  '--- a/lib/a.dart',
  '+++ b/lib/a.dart',
  '@@ -3,6 +3,7 @@ class A {',
  '@@ -19 +20 @@',
  '',
].join('\n');
const hunks = parseHunks(diff);
const headLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
const draft = (fields) => ({ id: 'P1', kind: 'review', fix: 'none', path: 'lib/a.dart', line: 5, body: 'Broken.', ...fields });
const problems = (fields) => checkComment(draft(fields), { hunks, headLines }).problems;

test('hunk ranges are read for both sides, with a missing count meaning one line', () => {
  // Given the two-hunk diff.
  // When it is parsed.
  // Then each hunk has its old and new range.
  assert.deepEqual(hunks, [
    { LEFT: { start: 3, count: 6 }, RIGHT: { start: 3, count: 7 } },
    { LEFT: { start: 19, count: 1 }, RIGHT: { start: 20, count: 1 } },
  ]);
});

test('a draft anchored inside a hunk passes and records its anchored lines', () => {
  // Given a two-line draft inside the first hunk.
  // When it is checked.
  const result = checkComment(draft({ start_line: 4, line: 5 }), { hunks, headLines });
  // Then it has no problems and the anchor is the head text of those lines.
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.anchor, ['line 4', 'line 5']);
});

test('anchors outside the diff, across hunks, or reversed are rejected', () => {
  // Given drafts on a line outside every hunk, spanning two hunks, and with start_line above line.
  // When each is checked.
  // Then each names its anchor problem.
  assert.match(problems({ line: 15 }).join(), /outside the diff hunks/);
  assert.match(problems({ start_line: 8, line: 20 }).join(), /in one hunk/);
  assert.match(problems({ start_line: 6, line: 5 }).join(), /below line/);
  assert.match(checkComment(draft({}), { hunks: [], headLines }).problems.join(), /not in the pull request's diff/);
});

test('a recorded anchor that no longer matches the head is stale', () => {
  // Given a draft whose recorded anchor differs from the head text.
  // When it is checked.
  // Then it is reported stale.
  assert.match(problems({ anchor: ['old line 5'] }).join(), /stale/);
  assert.deepEqual(problems({ anchor: ['line 5'] }), []);
});

test('only an exact fix carries a suggestion, exactly one, on the RIGHT side', () => {
  const block = 'Use the guard.\n```suggestion\nif (x) return;\n```\n';
  // Given drafts whose fix kind and suggestion blocks disagree.
  // When each is checked.
  // Then the mismatch is reported, and a matching exact fix passes.
  assert.deepEqual(problems({ fix: 'exact', body: block }), []);
  assert.match(problems({ fix: 'exact' }).join(), /exactly one suggestion/);
  assert.match(problems({ fix: 'exact', body: block + block }).join(), /exactly one suggestion/);
  assert.match(problems({ fix: 'approach', body: block }).join(), /must not carry/);
  assert.match(problems({ fix: 'exact', body: block, side: 'LEFT', line: 4 }).join(), /RIGHT side/);
});

test('kind and fix must be known values', () => {
  // Given drafts with an unknown kind and an unknown fix.
  // When they are checked.
  // Then both are rejected before the anchor is looked at.
  assert.match(problems({ kind: 'nit' }).join(), /kind must be/);
  assert.match(problems({ fix: 'maybe' }).join(), /fix must be/);
});

test('suggestion blocks are read with longer fences and as empty deletions', () => {
  // Given a four-backtick block holding a fence, and an empty block.
  const nested = '````suggestion\nfinal a = 1;\n```\n````\n';
  // When they are parsed.
  // Then the replacement lines are returned, and the empty block deletes the range.
  assert.deepEqual(suggestions(nested), [['final a = 1;', '```']]);
  assert.deepEqual(suggestions('```suggestion\n```'), [[]]);
});

test('applying a suggestion replaces exactly the anchored range', () => {
  // Given a suggestion replacing lines 4-5 with three lines.
  const comment = draft({ start_line: 4, line: 5, body: '```suggestion\na\nb\nc\n```' });
  // When it is applied to the head file.
  const after = applySuggestion(headLines, comment);
  // Then lines 4-5 become a, b, c and the rest is unchanged.
  assert.deepEqual(after.slice(2, 7), ['line 3', 'a', 'b', 'c', 'line 6']);
  assert.equal(after.length, headLines.length + 1);
});

test('mentions are found only outside code, and listed mentions are allowed', () => {
  // Given prose mentions, code mentions, and an email address.
  const body = 'Ask @alice or @org/team. `@override` is fine.\n```dart\n@visibleForTesting\n```\nmail a@b.com';
  // When the body is scanned.
  // Then only the prose mentions are returned.
  assert.deepEqual(bareMentions(body), ['alice', 'org/team']);
  assert.match(problems({ body: 'Ping @alice.' }).join(), /bare mention @alice/);
  assert.deepEqual(problems({ body: 'Ping @alice.', mentions: ['alice'] }), []);
});

test('the word "hint" is flagged outside code', () => {
  // Given prose that says hint, and code that does.
  // When each is scanned.
  // Then only the prose is flagged.
  assert.deepEqual(hintWords('A hint: try X. Hints help.'), ['hint', 'Hints']);
  assert.deepEqual(hintWords('Set `hint` on the field.'), []);
  assert.match(problems({ body: 'Hint: move it.' }).join(), /name the approach/);
});

test('FYI comments get the non-blocking prefix once', () => {
  // Given an FYI draft with and without the prefix, and a review draft.
  // When the final bodies are built.
  // Then FYI bodies start with the prefix exactly once and review bodies are unchanged.
  assert.equal(finalBody(draft({ kind: 'fyi', body: 'Context.' })), '**FYI (non-blocking)** Context.');
  assert.equal(finalBody(draft({ kind: 'fyi', body: '**FYI (non-blocking)** Context.' })), '**FYI (non-blocking)** Context.');
  assert.equal(finalBody(draft({})), 'Broken.');
});

test('any review comment requests changes, FYI-only comments, and an override wins', () => {
  // Given a mixed set and an FYI-only set.
  // When the event is chosen.
  // Then the rule applies, and an explicit event replaces it.
  assert.equal(chooseEvent([draft({ kind: 'fyi' }), draft({})]), 'REQUEST_CHANGES');
  assert.equal(chooseEvent([draft({ kind: 'fyi' })]), 'COMMENT');
  assert.equal(chooseEvent([draft({})], 'COMMENT'), 'COMMENT');
  assert.throws(() => chooseEvent([], 'LGTM'), /--event must be/);
});

const thread = (id, path, originalLine, body, login = 'me') =>
  ({ id, path, originalLine, comments: { nodes: [{ body, author: { login } }] } });

test('threads map to drafts by body, then by unique path and line, else to their author', () => {
  // Given three drafts and threads matching by body, by position, and by nothing.
  const drafts = [draft({}), draft({ id: 'S1', kind: 'fyi', body: 'Note.' }),
    draft({ id: 'X1', path: 'lib/b.dart', line: 9, body: 'Spec gap.' })];
  const threads = [
    thread('T1', 'lib/a.dart', 5, 'Broken.\r\n'),
    thread('T2', 'lib/a.dart', 5, '**FYI (non-blocking)** Note.'),
    thread('T3', 'lib/b.dart', 9, 'Edited after posting.'),
    thread('T4', 'lib/c.dart', 1, 'From the bot.', 'ci-bot'),
  ];
  // When they are matched.
  // Then each gets its finding ID, or other:<author>.
  assert.deepEqual(matchThreads(threads, drafts), { T1: 'P1', T2: 'S1', T3: 'X1', T4: 'other:ci-bot' });
});

test('drafts with the same body are told apart by path and line', () => {
  // Given two drafts that both say "Same as above." on different files.
  const drafts = [draft({ body: 'Same as above.' }), draft({ id: 'P2', path: 'lib/b.dart', line: 9, body: 'Same as above.' })];
  // When their threads are matched.
  const ids = matchThreads([thread('T1', 'lib/b.dart', 9, 'Same as above.'), thread('T2', 'lib/a.dart', 5, 'Same as above.')], drafts);
  // Then each thread gets its own draft.
  assert.deepEqual(ids, { T1: 'P2', T2: 'P1' });
});

test('the rendered drafts show id, kind, fix, and range', () => {
  // Given a multi-line FYI draft.
  // When the drafts are rendered.
  const md = renderMarkdown(56, [draft({ kind: 'fyi', start_line: 4 })]);
  // Then the heading carries its metadata and the body its prefix.
  assert.match(md, /## 1\. P1 · fyi · fix: none · `lib\/a\.dart:4-5`/);
  assert.match(md, /\*\*FYI \(non-blocking\)\*\* Broken\./);
});
