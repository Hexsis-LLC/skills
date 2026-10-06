# Records and Schema

The reference shapes behind [SKILL.md](SKILL.md): front matter, history modes, change and decision records, rollups, and registry rows. Every placeholder is a default, and a repository may rename it.

## Front Matter

| Field | Contract |
| --- | --- |
| `id` | Globally unique, stable, never reused. For example `DOC-GOVERNANCE-CHANGE-CONTROL`. A planning aggregate may use its record ID. |
| `kind` | `index`, `instruction`, `governance`, `product`, `architecture`, `planning`, `operational`, `decision`, `change`, `research`, `guide`, `generated`, or `presentation`. |
| `authority` | `instruction`, `product`, `architecture`, `planning`, `operational`, `decision`, `evidence`, `historical`, `generated`, or `communication`. |
| `status` | `proposed`, `accepted`, `current`, `active`, `completed`, `superseded`, or `archived`. |
| `scope` | The repository area or record scope that the document governs. |
| `owner` | The role accountable for semantic correctness. For example `product-owner` or `engineering-owner`. |
| `history_mode` | `inline`, `registry`, or `immutable-record`. |
| `history` | At most ten recent changes, plus one `compacted` mapping when older changes exist. Immutable records and registry-managed files may omit it. |
| `generated_from` | The source and generator. Set only on reproducible generated files. |

Extend an enum only through an accepted `governance` change.

```yaml
---
id: DOC-PLANNING-ROADMAP
kind: planning
authority: planning
status: current
scope: planning
owner: product-owner
history_mode: inline
history:
  - compacted: {record: CHG-YYYY-MM-DD-NNN, through: CHG-YYYY-MM-DD-NNN}
  - CHG-YYYY-MM-DD-NNN
  - [DEC-YYYY-MM-DD-NNN, CHG-YYYY-MM-DD-NNN]
---
```

## History Modes

- `inline`: a mutable authoritative file. Its front-matter `history` matches a closing `## Change history` section in the body. Each entry is one event or one linked `DEC-*`/`CHG-*` pair. When a rollup exists, it is listed first.
- `registry`: standalone evidence, raw historical material, or a binary file. The document registry and Git cover its history, and its body stays untouched.
- `immutable-record`: a single `DEC-*` or `CHG-*` file whose body is never rewritten. The only edit it may receive is a reciprocal supersession pointer.

A matching body history looks like this:

```markdown
## Change history

- [Compacted history through CHG-YYYY-MM-DD-NNN](../changes/records/chg-yyyy-mm-dd-nnn.md#compacted-history) keeps the older facts that still explain current state.
- [CHG-YYYY-MM-DD-NNN](../changes/records/chg-yyyy-mm-dd-nnn.md): one line on what changed.
- [DEC-YYYY-MM-DD-NNN](../decisions/records/dec-yyyy-mm-dd-nnn.md) · [CHG-YYYY-MM-DD-NNN](../changes/records/chg-yyyy-mm-dd-nnn.md): one line on the decision and its reconciliation.
```

## Filenames

- Change record: `chg-yyyy-mm-dd-nnn.md`.
- Decision record: `dec-yyyy-mm-dd-nnn.md`.
- Planning aggregate: its lowercased record ID. For example `e-{phase}-{nn}.md`.
- Mutable document: a short name for its role. Indexes carry the reading order, so filenames carry no numbering.

## Change Record (`CHG-*`)

A standalone event contains every field below. When the event is paired with a `DEC-*`, the decision carries the rationale and the `CHG-*` carries the repository impact.

```markdown
---
id: CHG-YYYY-MM-DD-NNN
kind: change
authority: decision
status: accepted
scope: <area>
owner: product-owner
history_mode: immutable-record
---

# CHG-YYYY-MM-DD-NNN: <imperative summary>

[Registry](../README.md) · [Change control](../../governance/change-control.md) · [Decision](../../decisions/records/dec-yyyy-mm-dd-nnn.md)

- Date: YYYY-MM-DD
- Kind and state: `<kind>`, `<state>`
- Requested by: <role and request source>
- Summary: <what changed>
- Rationale: <why>
- Previous state: <before>
- New state: <after>
- Affected files and records: <paths and IDs>
- Impact: <milestone, requirement, dependency, gate, security, compatibility, migration, and tracker impact, or "none">
- Related or superseded: <IDs>
- Validation: <checks run and their results>
- Unknowns and follow-up owner: <items, or "none">
```

## Decision Record (`DEC-*`)

```markdown
---
id: DEC-YYYY-MM-DD-NNN
kind: decision
authority: decision
status: accepted
scope: <area>
owner: product-owner
history_mode: immutable-record
---

# DEC-YYYY-MM-DD-NNN: <decision in a few words>

[Registry](../README.md) · [Reconciliation](../../changes/records/chg-yyyy-mm-dd-nnn.md)

- Date: YYYY-MM-DD
- Request source: <role and where the decision was made>
- Decision: <what was decided>
- Scope: <what it governs, and what it leaves unchanged>
- Supersedes: <IDs, or "none">
- Evidence: <sources, and their limits>

## Consequences and controls

- Consequences: <positive and negative>
- Residual risk: <what remains>
- Revisit: <the trigger that reopens the decision>
- Recovery: <how to reverse it through a new governed change>
```

When an open candidate is resolved, record the outcome as a `DEC-*`. Then update the `D-NN` row in the open-decision register and release the Tickets it blocked. A record that only selects a route releases only the work it explicitly authorizes.

## Rollup Record

A rollup is a `CHG-*` of kind `baseline` that replaces older history entries in one or more documents.

```markdown
# CHG-YYYY-MM-DD-NNN: Roll forward compacted document history

- Date, kind (`baseline`) and state, requested by, summary, rationale, previous state, new state, impact.

## Compacted history

| Document or record | Through | Historically relevant state retained |
| --- | --- | --- |
| `<document id>` | `CHG-YYYY-MM-DD-NNN` | <one line on the older facts that still explain current state> |

## Retrieval

Resolve an older event by its stable filename under the records directories. Use Git for the exact prior wording.
```

The rollup's limits are:

- 100 lines and 1,000 words at most.
- It names no pruned IDs.
- When a newer rollup replaces it, the newer rollup summarizes the older one instead of copying its table.

## Registry Indexes

The change and decision indexes each list one compacted-history row and the ten most recent records:

```markdown
| Event | Date | Kind | State | Summary |
| --- | --- | --- | --- | --- |
| [Compacted history through CHG-YYYY-MM-DD-NNN](records/chg-yyyy-mm-dd-nnn.md#compacted-history) | through YYYY-MM-DD | rollup | accepted | Older records stay resolvable by stable ID path and Git. |
| [CHG-YYYY-MM-DD-NNN](records/chg-yyyy-mm-dd-nnn.md) | YYYY-MM-DD | planning | accepted | <one line> |
```

The document registry lists every artifact exactly once:

```markdown
| Canonical file | Stable document ID | Kind | Authority | Status | History mode |
| --- | --- | --- | --- | --- | --- |
| [`docs/planning/roadmap.md`](../planning/roadmap.md) | `DOC-PLANNING-ROADMAP` | `planning` | `planning` | `current` | `inline` |
```

## Planning Record IDs

| Record | Default pattern |
| --- | --- |
| Epic | `E-{phase}-{NN}` |
| Use Case | `UC-{phase}-{NN}-{NN}` |
| Feature | `F-{phase}-{NN}-{NN}` |
| Delivery Ticket | `T-{phase}-{NN}-{NN}-{NN}` |
| Open decision | `D-{NN}` |

`{phase}` is a short code for the owning milestone. It does not reflect the record's current state. To move a record to another milestone, the product owner records a scope decision, and the record gains a supersession note. Its ID stays the same.

Each record heading starts with the record's ID, so the heading anchor can be traced. A Ticket record also carries its tracker import metadata, such as labels, parent, `depends_on`, and `history`, in a fenced block that the importer reads.
