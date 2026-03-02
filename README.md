# Hexsis Skills

Reusable AI agent skills maintained by Hexsis.

## Installation

Install this skills pack into your agent environment:

```sh
npx -y skills add hexsis-llc/skills
```

## Included Skills

- `git-committer`: Generates concise conventional one-line commit messages from a git diff.
- `gwt-tester`: Helps write or refactor tests into clear Given/When/Then structure.
- `pub-package-explorer`: Finds and reads Dart/Flutter package source from local deps or pub.dev.

## Repository Layout

```text
skills/
  <skill-name>/
    SKILL.md
```

Each skill lives in its own folder with a `SKILL.md` entrypoint.

## Usage

1. Install the pack with the command above.
2. In your AI assistant, reference a skill by name when needed.
3. Follow the skill's local `SKILL.md` instructions for task-specific workflow.

## Contributing

1. Add or update a skill in `skills/<name>/SKILL.md`.
2. Keep instructions practical, explicit, and tool-aware.
3. Open a pull request with a short validation note.
