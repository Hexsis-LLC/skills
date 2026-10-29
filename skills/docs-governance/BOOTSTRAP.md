# Set Up Docs Governance

Use this file to adopt the method in a repository that does not have it yet. Explore first, show the owner a plan, settle it, then write. Create only the folders the repository has content for now; the rest come when their first doc does.

## 1. Explore

Read what exists, and assume nothing:

- `AGENTS.md`, `CLAUDE.md`, and any nested ones. For each `CLAUDE.md`, note whether it is a symlink, a file with content, or a file that only imports another file (such as `@AGENTS.md`).
- `README.md`, everything under `docs/`, `GLOSSARY.md` or `GLOSSARY-MAP.md`, and any ADR folder.
- A legacy glossary: `CONTEXT.md`, `CONTEXT-MAP.md`, or `docs/CONTEXT.md`. With the owner's agreement, `git mv` each `CONTEXT.md` to `GLOSSARY.md` and `CONTEXT-MAP.md` to `GLOSSARY-MAP.md`, with `docs/CONTEXT.md` going to the root, following SKILL.md section 4 for every reference.
- The issue tracker (`git remote -v`) and where unfinished work is tracked today.
- `.gitignore`, and the skills directory (for example `.agents/skills/`).

The step is done when you can name a home (SKILL.md section 2) for every existing doc, or say it is scratch.

## 2. Settle the Shape With the Owner

Present a recommendation for each, and settle them one at a time:

1. **Owner:** who makes product decisions.
2. **Folders:** which of the default homes the repository needs now, and any renames.
3. **Each existing doc:** lasting (and its folder), a dated record, or scratch to remove.
4. **Decisions already made:** where they live today, and how they move into the register.
5. **Issue tracker:** where unfinished work and plans go.
6. **Instruction file:** `AGENTS.md` as the one canonical file, with `CLAUDE.md` a symlink to it (section 3).

## 3. Make `AGENTS.md` the Canonical Instruction File

Claude Code reads `CLAUDE.md`, and most other agents read `AGENTS.md`. By default `AGENTS.md` holds the content and `CLAUDE.md` is a relative symlink to it, so the two cannot drift. A deliberate repository convention wins.

| Found | Propose |
| --- | --- |
| Neither file | Create `AGENTS.md`, then symlink `CLAUDE.md` to it. |
| Only `AGENTS.md` | Symlink `CLAUDE.md` to it. |
| Only `CLAUDE.md`, with content | Move its content into `AGENTS.md`, then replace `CLAUDE.md` with the symlink, once the owner agrees. |
| Both, with content | Merge both into `AGENTS.md`, show the owner the result, and replace `CLAUDE.md` with the symlink once they agree. |
| A deliberate other convention | Keep it, and edit the file it names as canonical. |

```sh
ln -s AGENTS.md CLAUDE.md
git add AGENTS.md CLAUDE.md
readlink CLAUDE.md          # prints AGENTS.md
```

Where Git checks symlinks out as plain files (`core.symlinks=false`), use a `CLAUDE.md` whose only line is `@AGENTS.md`.

## 4. Create the Homes

1. Add `.scratch/` to `.gitignore`.
2. Create `docs/README.md`: start-here reading order, then one section per folder listing each current doc and when to read it. List record folders (`qualification/`, `research/`, `adr/`) as folders.
3. Create root `GLOSSARY.md` (the glossary; `GLOSSARY-MAP.md` for several contexts) and `docs/product-decisions.md` (the register, SKILL.md section 3). Move existing decisions into register entries, each dated when the owner decided it if known, otherwise noted as "Recorded on YYYY-MM-DD from <source>".
4. Move each lasting doc into its folder, following SKILL.md section 4 for every reference. Remove scratch and stale docs the owner agreed to remove, repointing their links at Git history.

## 5. Install the Skill and Route Agents

1. Install `docs-governance` into the repository's skills directory and lock file, so every agent and automated reviewer has it: `npx -y skills add hexsis-llc/skills --skill docs-governance -y`.
2. Add these lines to `AGENTS.md`, adapted to the repository:

```markdown
Read these before changing anything:

- docs/README.md: the docs index
- docs/product-decisions.md: owner decisions; don't reverse one without asking
- GLOSSARY.md: the glossary
- <docs/agents/...>: <release process, review rules, issue tracker, domain conventions>

Load the docs-governance skill before you add, move, or remove a doc, write a note,
plan, or spec, or record or rely on an owner decision.
```

The step is done when a fresh agent asked to write a plan puts it in `.scratch/`.

## 6. From the Record-Based Model

A repository on the earlier version of this skill has `CHG-*` change records, `DEC-*` decision records, document front matter with histories, and a document registry. To move it to this method, with the owner's agreement:

1. Turn each current `DEC-*` into a register entry dated with its decision date, and fold later changes into `Changed on` notes. Note superseded ones.
2. Remove the `CHG-*` records, the registry, front-matter histories, and `## Change history` sections. Git and the pull requests keep that history.
3. Map the old classes onto the default homes (vision and planning → `docs/product/`, governance → `AGENTS.md` and `docs/agents/`, guides and operations → `docs/operations/`), then move docs as in SKILL.md section 4.
4. Move delivery records and tickets into the issue tracker.

## 7. Check the Setup

1. Every relative link resolves, and `readlink CLAUDE.md` prints `AGENTS.md`.
2. `git status --short` shows no scratch.
3. Start a fresh agent session and ask it to record a decision. The setup works when it reaches the register and runs the agreement search from SKILL.md section 3.
