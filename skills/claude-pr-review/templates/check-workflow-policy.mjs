import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Enforces the secret and permission boundary of the Claude review workflow. Only job `review` may
// hold the write scopes below, only its SHA-pinned Claude action step may read the review secret,
// as its token input, and no other workflow may read that secret at all.

// PARAMETERS: keep these in step with the review workflow.
const reviewWorkflow = '.github/workflows/claude-review.yml';
const reviewJob = 'review';
const reviewSecret = 'CLAUDE_CODE_OAUTH_TOKEN';
const reviewTokenInput = 'claude_code_oauth_token';
// Built-in sub-agent types of the Claude Code version the pinned action bundles. Re-check this list
// whenever the action pin changes: a new built-in type would otherwise run unlisted.
const builtInAgents = ['general-purpose', 'claude', 'Explore', 'Plan', 'statusline-setup',
  'claude-code-guide'];

const reviewWriteScopes = new Set(['pull-requests', 'issues', 'id-token']);
const reviewAction = /^anthropics\/claude-code-action@[0-9a-f]{40}$/;
const reviewTokenValue = `\${{ secrets.${reviewSecret} }}`;
// The reviewer may approve, so its app token must stay unable to push or merge, the merge tool and
// Bash stay denied, and no tool allowlist grants Bash.
const reviewAppPermissions = 'contents: read\n';
const reviewToolLists = ['REVIEW_TOOLS', 'MENTION_TOOLS'];
// The Agent tool needs no permission, so every built-in sub-agent type and workflow orchestration
// stay denied, and each sub-agent the job defines may only read.
const reviewDeniedTools = ['Bash', 'Workflow', 'mcp__github__merge_pull_request',
  ...builtInAgents.map((agent) => `Agent(${agent})`)];
const reviewAgentTools = new Set(['Read', 'Grep', 'Glob', 'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files', 'mcp__github__get_file_contents']);
// claude_args passes REVIEW_AGENTS inside single quotes, optionally only for automatic review.
const reviewAgentsArg = new RegExp(String.raw`--agents\s+'\$\{\{\s*(?:github\.event_name == 'pull_request' && )?` +
  String.raw`env\.REVIEW_AGENTS(?: \|\| '\{\}')?\s*\}\}'`, 'g');

class YamlSubsetError extends Error {}
// 1-based source line of each mapping key, used to point errors at steps.
const keyLines = new WeakMap();
const plainKey = /^([A-Za-z0-9_][A-Za-z0-9_./-]*):(?:\s+(.*))?$/;
const isSequenceItem = (text) => /^-(\s|$)/.test(text);
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Parses the block-style YAML subset these workflows use: plain-key mappings, sequences,
// plain or single-line quoted scalars, single-line flow lists of scalars, and `|` literal and
// `>` folded block scalars. Everything else (flow mappings, quoted keys, anchors, aliases, tags, multi-line
// plain or quoted scalars, duplicate keys) throws, so the policy fails closed instead of
// misreading structure that line patterns cannot see.
export function parseWorkflowYaml(text) {
  const lines = text.split('\n');
  let pos = 0;
  let pending = null;
  const fail = (message, index = pos) => {
    throw new YamlSubsetError(`line ${index + 1}: ${message}`);
  };

  function stripComment(raw) {
    let quote = null;
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if ((c === "'" || c === '"') && /(^|[\s:[,-])$/.test(raw.slice(0, i).trimEnd().slice(-1))) {
        quote = c;
      } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
        return raw.slice(0, i).trimEnd();
      }
    }
    return raw.trimEnd();
  }

  function peek() {
    if (pending) return pending;
    while (pos < lines.length) {
      const lead = lines[pos].match(/^[ \t]*/)[0];
      const content = stripComment(lines[pos].slice(lead.length));
      if (content) {
        if (lead.includes('\t')) fail('tabs are not allowed in indentation');
        return { index: pos, indent: lead.length, text: content };
      }
      pos += 1;
    }
    return null;
  }

  function consume() {
    pending = null;
    pos += 1;
  }

  function scalar(value, index) {
    if (/^[{&*!%@`|>]/.test(value) || value.startsWith('? ')) {
      fail('flow mappings, anchors, aliases, tags, and directives are not supported', index);
    }
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) fail('flow lists must close on the same line', index);
      const inner = value.slice(1, -1).trim();
      return inner ? inner.split(',').map((item) => scalar(item.trim(), index)) : [];
    }
    if (value.startsWith("'")) {
      const match = value.match(/^'((?:[^']|'')*)'$/);
      if (!match) fail('single-quoted scalars must close on the same line', index);
      return match[1].replace(/''/g, "'");
    }
    if (value.startsWith('"')) {
      const match = value.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (!match) fail('double-quoted scalars must close on the same line', index);
      try {
        return JSON.parse(`"${match[1]}"`);
      } catch {
        fail('unsupported escape in double-quoted scalar', index);
      }
    }
    if (/:(\s|$)/.test(value)) fail('plain scalars must not contain `: `', index);
    return value;
  }

  function blockScalar(parentIndent, style) {
    const out = [];
    let blockIndent = null;
    while (pos < lines.length) {
      const raw = lines[pos];
      if (!raw.trim()) {
        out.push('');
        pos += 1;
        continue;
      }
      const indent = raw.match(/^ */)[0].length;
      if (indent <= parentIndent) break;
      blockIndent ??= indent;
      if (indent < blockIndent) fail('inconsistent block scalar indentation');
      out.push(raw.slice(blockIndent));
      pos += 1;
    }
    return `${(style === '>' ? fold(out) : out.join('\n')).replace(/\n+$/, '')}\n`;
  }

  // YAML folding: a break between two lines at the block's indentation becomes a space, blank
  // lines become breaks, and breaks around more-indented lines are kept.
  function fold(blockLines) {
    let text = '';
    let blanks = 0;
    let previous = null;
    for (const line of blockLines) {
      if (!line) {
        blanks += 1;
        continue;
      }
      const indented = /^\s/.test(line);
      if (previous === null) text += '\n'.repeat(blanks);
      else if (!indented && !previous) text += blanks ? '\n'.repeat(blanks) : ' ';
      else text += '\n'.repeat(blanks + 1);
      text += line;
      previous = indented;
      blanks = 0;
    }
    return text;
  }

  function value(rest, parentIndent, index, inMapping) {
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(parentIndent, rest[0]);
    if (rest) return scalar(rest, index);
    const next = peek();
    if (next && next.indent > parentIndent) return block();
    if (inMapping && next && next.indent === parentIndent && isSequenceItem(next.text)) {
      return sequence(parentIndent);
    }
    return null;
  }

  function mapping(indent) {
    const map = Object.create(null);
    const lineOf = {};
    keyLines.set(map, lineOf);
    for (let line = peek(); line && line.indent === indent; line = peek()) {
      const match = line.text.match(plainKey);
      if (!match) fail('expected a plain `key: value` mapping entry', line.index);
      const [, key, rest = ''] = match;
      if (Object.hasOwn(map, key)) fail(`duplicate key ${key}`, line.index);
      consume();
      lineOf[key] = line.index + 1;
      map[key] = value(rest, indent, line.index, true);
    }
    const next = peek();
    if (next && next.indent > indent) fail('unexpected indentation', next.index);
    return map;
  }

  function sequence(indent) {
    const items = [];
    for (let line = peek(); line && line.indent === indent && isSequenceItem(line.text); line = peek()) {
      const content = line.text.slice(1).trimStart();
      if (plainKey.test(content) || /^[A-Za-z0-9_][A-Za-z0-9_./-]*:$/.test(content)) {
        // `- key: value` opens a mapping whose keys align with the first key.
        pending = { index: line.index, indent: indent + line.text.length - content.length, text: content };
        items.push(mapping(pending.indent));
      } else {
        consume();
        items.push(value(content, indent, line.index, false));
      }
    }
    return items;
  }

  function block() {
    const line = peek();
    return isSequenceItem(line.text) ? sequence(line.indent) : mapping(line.indent);
  }

  const first = peek();
  if (!first) fail('document is empty');
  if (first.indent !== 0) fail('document must start at column 0', first.index);
  const document = block();
  const rest = peek();
  if (rest) fail('unexpected content', rest.index);
  return document;
}

function parse(file, text, errors) {
  try {
    return parseWorkflowYaml(text);
  } catch (error) {
    if (!(error instanceof YamlSubsetError)) throw error;
    errors.push(`${file}: unsupported YAML at ${error.message}`);
    return undefined;
  }
}

function walk(node, visit) {
  if (Array.isArray(node)) node.forEach((item) => walk(item, visit));
  if (!isMapping(node)) return;
  for (const [key, child] of Object.entries(node)) {
    visit(key, child);
    walk(child, visit);
  }
}

// Expressions that read the `secrets` context (`secrets.X`, `secrets['X']`, `toJSON(secrets)`).
// Expression context names are case-insensitive, so `Secrets.X` reads the same context.
const secretExpressions = (text) => [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1])
  .filter((expression) => /\bsecrets\b/i.test(expression));

function checkCheckouts(file, steps, errors) {
  if (!Array.isArray(steps)) return;
  for (const step of steps) {
    if (!isMapping(step) || typeof step.uses !== 'string' || !/^actions\/checkout@/i.test(step.uses)) continue;
    if (!isMapping(step.with) || step.with['persist-credentials'] !== 'false') {
      errors.push(`${file}:${keyLines.get(step).uses}: checkout must set persist-credentials: false`);
    }
  }
}

function reviewGrant(workflow) {
  if (!isMapping(workflow) || !isMapping(workflow.jobs)) return null;
  const job = workflow.jobs[reviewJob];
  if (!isMapping(job)) return null;
  const tokenSteps = (Array.isArray(job.steps) ? job.steps : []).filter((step) => isMapping(step) &&
    typeof step.uses === 'string' && reviewAction.test(step.uses) &&
    isMapping(step.with) && step.with[reviewTokenInput] === reviewTokenValue);
  return { job, permissions: job.permissions, tokenSteps };
}

function checkReviewTools(file, grant, errors) {
  const tools = (name) => (typeof grant.job.env?.[name] === 'string' ? grant.job.env[name] : '')
    .split(/[\s,]+/).filter(Boolean);
  for (const step of grant.tokenSteps) {
    const line = keyLines.get(step).uses;
    if (step.with.additional_permissions !== reviewAppPermissions) {
      errors.push(`${file}:${line}: the review app token must request exactly contents: read`);
    }
    // The tool lists bind only when claude_args passes them and adds no tool of its own.
    const args = typeof step.with.claude_args === 'string' ? step.with.claude_args : '';
    if (!/--disallowedTools\s+"\$\{\{\s*env\.DENIED_TOOLS\s*\}\}"/.test(args) || /\bBash\b/.test(args) ||
      [...args.matchAll(/--allowedTools\s+"([^"]*)"/g)].some(([, list]) => !/^\$\{\{[^}]*\}\}$/.test(list) ||
        /\bmcp__|\bRead\b/.test(list))) {
      errors.push(`${file}:${line}: claude_args must take its tools only from the job's tool lists`);
    }
    if ((args.match(/--agents\b/g) ?? []).length !== (args.match(reviewAgentsArg) ?? []).length) {
      errors.push(`${file}:${line}: claude_args must take its sub-agents only from REVIEW_AGENTS`);
    }
  }
  checkReviewAgents(file, grant.job.env?.REVIEW_AGENTS, errors);
  const denied = tools('DENIED_TOOLS');
  for (const tool of reviewDeniedTools.filter((name) => !denied.includes(name))) {
    errors.push(`${file}: job ${reviewJob} must deny ${tool} in DENIED_TOOLS`);
  }
  for (const name of reviewToolLists) {
    if (tools(name).some((tool) => /^Bash\b/.test(tool))) {
      errors.push(`${file}: job ${reviewJob} must not allow Bash in ${name}`);
    }
  }
}

// Each defined sub-agent must list its tools, because an agent without a list inherits every tool.
// The JSON must hold no character that would end or expand its single-quoted claude_args value.
function checkReviewAgents(file, json, errors) {
  if (json === undefined) return;
  if (/['$\\]/.test(json)) {
    errors.push(`${file}: job ${reviewJob} REVIEW_AGENTS must not contain single quotes, $, or backslashes`);
  }
  let agents;
  try {
    agents = JSON.parse(json);
  } catch {
    errors.push(`${file}: job ${reviewJob} REVIEW_AGENTS must be valid JSON`);
    return;
  }
  if (!isMapping(agents)) {
    errors.push(`${file}: job ${reviewJob} REVIEW_AGENTS must be a JSON object of agents`);
    return;
  }
  for (const [name, agent] of Object.entries(agents)) {
    const tools = isMapping(agent) ? agent.tools : undefined;
    if (!Array.isArray(tools) || !tools.length || tools.some((tool) => !reviewAgentTools.has(tool))) {
      errors.push(`${file}: job ${reviewJob} sub-agent ${name} must list only read tools: ` +
        `${[...reviewAgentTools].join(', ')}`);
    }
  }
}

// The review workflow is parsed, so its structure cannot hide a wider grant.
function checkReviewWorkflow(file, text, errors) {
  const workflow = parse(file, text, errors);
  const grant = reviewGrant(workflow);
  // The grant allows exactly one secrets access: the review step's token input.
  const secretUses = secretExpressions(text);
  const granted = grant?.tokenSteps.length === 1 && secretUses.length === 1 &&
    `\${{${secretUses[0]}}}` === reviewTokenValue;
  if (!granted) {
    errors.push(`${file}: only the SHA-pinned Claude action step in job ${reviewJob} may read a secret, ` +
      `and only ${reviewSecret} as its ${reviewTokenInput} input`);
  }
  if (/pull_request_target/.test(text)) errors.push(`${file}: pull_request_target is not allowed`);
  if (workflow === undefined) return;
  if (!isMapping(workflow)) {
    errors.push(`${file}: workflow must be a mapping`);
    return;
  }
  const top = workflow.permissions;
  if (!isMapping(top) || Object.keys(top).join() !== 'contents' || top.contents !== 'read') {
    errors.push(`${file}: top-level permissions must be contents: read`);
  }
  walk(workflow, (key, child) => {
    if (key === 'secrets') errors.push(`${file}: secrets keys are not allowed`);
    if (key !== 'permissions') return;
    const reviewScope = (scope, level) =>
      level === 'write' && child === grant?.permissions && reviewWriteScopes.has(scope);
    const readOnly = isMapping(child)
      ? Object.entries(child).every(([scope, level]) =>
        level === 'read' || level === 'none' || reviewScope(scope, level))
      : child === 'read-all';
    if (!readOnly) errors.push(`${file}: write permissions are not allowed outside job ${reviewJob}'s review scopes`);
  });
  if (!isMapping(workflow.jobs)) {
    errors.push(`${file}: jobs must be a mapping`);
    return;
  }
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (isMapping(job) && job.uses !== undefined) {
      errors.push(`${file}: job ${id} calls a reusable workflow; review jobs must run their own steps`);
    }
    if (isMapping(job)) checkCheckouts(file, job.steps, errors);
  }
  if (grant?.tokenSteps.length) checkReviewTools(file, grant, errors);
}

// Every other workflow keeps its own rules, but may not read the review secret, directly, through
// `toJSON(secrets)`, or by passing every secret to a reusable workflow.
function checkOtherWorkflow(file, text, errors) {
  const name = new RegExp(`\\b${reviewSecret}\\b`, 'i');
  if (secretExpressions(text).some((expression) => name.test(expression) || /toJSON\s*\(\s*secrets\s*\)/i.test(expression)) ||
    /^\s*secrets:\s*inherit\b/m.test(text)) {
    errors.push(`${file}: only ${reviewWorkflow} may read ${reviewSecret}`);
  }
}

function yamlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter((file) => /\.ya?ml$/.test(file)).sort();
}

export function checkWorkflowPolicy(root) {
  const errors = [];
  if (!existsSync(join(root, reviewWorkflow))) errors.push(`${reviewWorkflow} is missing`);
  const workflows = join(root, '.github/workflows');
  for (const name of yamlFiles(workflows)) {
    const file = `.github/workflows/${name}`;
    const text = readFileSync(join(workflows, name), 'utf8');
    if (file === reviewWorkflow) checkReviewWorkflow(file, text, errors);
    else checkOtherWorkflow(file, text, errors);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root')) {
    console.error('Usage: node check-workflow-policy.mjs [--root DIR]');
    process.exit(1);
  }
  try {
    // PARAMETER: the default root assumes this script sits one directory below the repository root.
    const errors = checkWorkflowPolicy(args[1] ?? fileURLToPath(new URL('..', import.meta.url)));
    for (const error of errors) console.error(`BLOCKED ${error}`);
    if (!errors.length) console.log('Workflow policy passed');
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error(`Workflow policy failed: ${error.message}`);
    process.exitCode = 1;
  }
}
