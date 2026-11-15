"""Build a wayfinder pane: a static, multi-page dependency map of tickets.

Usage: python3 -I build.py PROJECT [--out DIR]

PROJECT holds:
  issues/<NN>-<slug>.md   one file per ticket (title line plus Type/Status/Owner/Inputs from/Blocked by lines)
  pane_content.py         the plain-language words: index text, lanes, per-ticket content
The bundle is written to DIR (default PROJECT/pane/): index.html, t/<NN>.html, assets/.
See ../SKILL.md for both formats.
"""
import argparse
import html
import importlib.util
import pathlib
import re
import shutil
import sys

sys.dont_write_bytecode = True  # loading pane_content.py must not leave __pycache__ in the project

SKILL = pathlib.Path(__file__).resolve().parent.parent
ASSETS = SKILL / "assets"

STATE_ORDER = ["decided", "you", "ready", "others", "blocked"]
DEFAULT_STATES = {
    "decided": ("Decided", "Decided"),
    "you": ("Needs your answer", "Your answer"),
    "ready": ("Ready to start", "Ready"),
    "others": ("Needs someone else", "Someone else"),
    "blocked": ("Waits on other tickets", "Waiting"),
}
DEFAULT_KINDS = {"research": "Research", "grilling": "Decision", "prototype": "Prototype", "task": "Task"}
DONE_STATUSES = {"resolved", "closed", "done"}

DEFAULT_INDEX = {
    "eyebrow": "Wayfinder map",
    "title": None,
    "page_title": None,
    "lede": (
        "This map shows every ticket in this effort. Each card is one ticket. "
        "Click a card to see its context, then leave a thread on the pane to give feedback."
    ),
    "next_heading": "Your next steps",
    "map_heading": "The map",
    "hint_wide": 'Cards on the left come first. An arrow means "this comes before that". Point at a card to see its chain.',
    "hint_narrow": 'Cards higher in each group come first. "After" shows what a card needs first.',
}

# (content key, heading, kind). kind: callout | text | list (bullets) | steps (numbered).
DEFAULT_SECTIONS = [
    ("ask", "Your answer", "callout"),
    ("note", "Note", "text"),
    ("decision", "The decision", "steps"),
    ("provisional", "Decided for now", "steps"),
    ("rec", "My recommendation", "steps"),
    ("open", "Still open", "list"),
    ("know", "What we know", "list"),
    ("result", "What came out of it", "list"),
    ("waits", "What this waits for", "text"),
]
TICKET_KEYS = {"short", "one", "why", "related"}
PLACEHOLDER = re.compile(r"\{(" + "|".join(STATE_ORDER) + r")\}")


class BuildError(Exception):
    pass


def check(ok, message):
    if not ok:
        raise BuildError(message)


# ---------------------------------------------------------------- inputs


def load_content(project):
    path = project / "pane_content.py"
    check(path.is_file(), f"{path} not found")
    spec = importlib.util.spec_from_file_location("pane_content", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in ("INDEX", "LANES", "T"):
        check(hasattr(module, name), f"pane_content.py needs {name}")
    return module


def parse_ticket(path):
    """Read one ticket file. Only the title line and the header fields matter here."""
    number = re.match(r"(\d+)-", path.name)
    check(number, f"{path.name}: ticket files are named <NN>-<slug>.md")
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    check(lines and lines[0].startswith("# "), f"{path.name}: the first line must be '# <title>'")
    header = re.split(r"^## ", text, maxsplit=1, flags=re.M)[0]  # body lines such as "Status:" under ## Answer never count
    fields = dict(re.findall(r"^(Type|Status|Owner|Inputs from|Blocked by|Labels): *(.*?) *$", header, re.M))
    kind = fields.get("Type", "")
    if not kind:
        label = re.search(r"wayfinder:(\w+)", fields.get("Labels", ""))
        kind = label.group(1) if label and label.group(1) != "map" else ""
    blocked = fields.get("Blocked by", "none")
    blocked = [] if blocked.lower() in ("", "none", "-") else [b.strip().lstrip("#") for b in blocked.split(",") if b.strip()]
    return {
        "n": number.group(1),
        "file": path.name,
        "title": lines[0][2:].strip(),
        "type": kind,
        "status": fields.get("Status", "open").strip().lower(),
        "owner": fields.get("Owner", ""),
        "inputs": fields.get("Inputs from", ""),
        "blocked": blocked,
    }


def load_tickets(project, C):
    files = sorted((project / "issues").glob("*.md"))
    check(files, f"no tickets in {project / 'issues'}")
    every = {}
    for path in files:
        t = parse_ticket(path)
        check(t["n"] not in every, f"two ticket files share number {t['n']}")
        every[t["n"]] = t
    skip = set(getattr(C, "SKIP", set()))
    check(skip <= set(every), f"SKIP names unknown tickets {sorted(skip - set(every))}")
    tickets = {n: t for n, t in every.items() if n not in skip}

    for t in tickets.values():
        for b in t["blocked"]:
            check(b in every, f"#{t['n']} is blocked by #{b}, which has no ticket file")
            check(b not in skip, f"#{t['n']} is blocked by #{b}, which is in SKIP. Drop the edge or the skip.")
    you, others = set(getattr(C, "WAITING_ON_YOU", set())), set(getattr(C, "NEEDS_OTHERS", set()))
    check(you <= set(tickets), f"WAITING_ON_YOU names unknown tickets {sorted(you - set(tickets))}")
    check(others <= set(tickets), f"NEEDS_OTHERS names unknown tickets {sorted(others - set(tickets))}")
    check(not you & others, f"tickets in both WAITING_ON_YOU and NEEDS_OTHERS: {sorted(you & others)}")

    for t in tickets.values():
        t["blocks"] = sorted(n for n, o in tickets.items() if t["n"] in o["blocked"])
        done = all(tickets[b]["status"] in DONE_STATUSES for b in t["blocked"])
        if t["status"] in DONE_STATUSES:
            t["s"] = "decided"
        elif t["n"] in you:
            t["s"] = "you"
        elif t["n"] in others:
            t["s"] = "others"
        else:
            t["s"] = "ready" if done else "blocked"

    depth, visiting = {}, set()

    def d(n):
        if n not in depth:
            check(n not in visiting, f"the Blocked by lines form a cycle through #{n}")
            visiting.add(n)
            depth[n] = 1 + max((d(b) for b in tickets[n]["blocked"]), default=-1)
            visiting.discard(n)
        return depth[n]

    for n in tickets:
        tickets[n]["d"] = d(n)
    return tickets


# ---------------------------------------------------------------- rendering


class Site:
    def __init__(self, C, tickets):
        self.C = C
        self.tickets = tickets
        self.T = C.T
        states = dict(DEFAULT_STATES)
        states.update(getattr(C, "STATES", {}))
        self.state_label = {s: html.escape(states[s][0]) for s in STATE_ORDER}
        self.short_label = {s: html.escape(states[s][1]) for s in STATE_ORDER}
        self.kinds = dict(DEFAULT_KINDS)
        self.kinds.update(getattr(C, "KINDS", {}))
        self.index = dict(DEFAULT_INDEX)
        self.index.update(getattr(C, "INDEX", {}))
        check(self.index["title"], "INDEX['title'] is required")
        self.sections = list(getattr(C, "SECTIONS", DEFAULT_SECTIONS))
        self.lanes = list(C.LANES)
        keys = [key for key, _, _ in self.lanes]
        check(len(set(keys)) == len(keys), f"two lanes share a key: {sorted({k for k in keys if keys.count(k) > 1})}")
        for key, label, ns in self.lanes:
            check(re.fullmatch(r"[a-z0-9-]+", key), f"lane key {key!r}: use lower-case letters, digits and hyphens")
            for n in ns:
                check(n in tickets, f"lane {key!r} names #{n}, which is not a mapped ticket")
        for t in tickets.values():
            t["lane"] = next((key for key, _, ns in self.lanes if t["n"] in ns), "")
        self.order = [n for _, _, ns in self.lanes for n in sorted(ns, key=lambda x: (tickets[x]["d"], int(x)))]
        unplaced = sorted(set(tickets) - set(self.order))
        check(not unplaced, f"every ticket must sit in exactly one lane; not in a lane: {unplaced}")
        twice = sorted({n for n in self.order if self.order.count(n) > 1})
        check(not twice, f"every ticket must sit in exactly one lane; in more than one: {twice}")
        self.check_content()

    def check_content(self):
        missing = sorted(set(self.tickets) - set(self.T))
        check(not missing, f"no content in T for {missing}")
        extra = sorted(set(self.T) - set(self.tickets))
        check(not extra, f"T has content for tickets that are not on the map: {extra}")
        known = TICKET_KEYS | {key for key, _, _ in self.sections}
        lists = {key for key, _, kind in self.sections if kind in ("list", "steps")} | {"related"}
        for n, c in self.T.items():
            for key in ("short", "one"):
                check(c.get(key), f"T[{n!r}] needs {key!r}")
            unknown = sorted(set(c) - known)
            check(not unknown, f"T[{n!r}] has unknown keys {unknown}; add them to SECTIONS or fix the name")
            for key in lists & set(c):
                check(isinstance(c[key], list), f"T[{n!r}][{key!r}] must be a list")
            for item in c.get("related", []):
                check(isinstance(item, dict) and item.get("label") and item.get("href"), f"T[{n!r}]['related'] items need label and href")
                check(item.get("state", "others") in STATE_ORDER, f"T[{n!r}]['related'] state must be one of {STATE_ORDER}")

    def kind(self, t):
        return self.kinds.get(t["type"], t["type"].capitalize())

    def short(self, n):
        return self.T[n]["short"]

    def inline(self, text, prefix):
        """Escape text, then apply `code`, **bold**, [label](https://...) and #NN ticket links."""
        text = html.escape(text, quote=False)
        text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
        text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
        text = re.sub(
            r"\[([^\]]+)\]\((https?://[^)\s]+)\)",
            lambda m: f'<a href="{m.group(2).replace(chr(34), "%22")}" target=_blank rel=noopener>{m.group(1)}</a>',
            text,
        )

        def ref(m):
            n = m.group(1)
            if n not in self.tickets:
                return m.group(0)
            t = self.tickets[n]
            return f'<a class="ref s-{t["s"]}" href="{prefix}{n}.html" title="{html.escape(self.short(n))}">#{n}</a>'

        # Link #NN only outside the anchors made above, so a URL or link label keeps its #NN as text.
        parts = re.split(r"(<a [^>]*>.*?</a>)", text)
        return "".join(p if i % 2 else re.sub(r"(?<![\w&])#(\d+)(?!\d)", ref, p) for i, p in enumerate(parts))

    def page(self, title, body, depth_prefix):
        return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{depth_prefix}assets/site.css">
</head><body>{body}<script src="{depth_prefix}assets/map.js"></script></body></html>
"""

    # ------------------------------------------------------------ index

    def node(self, t):
        n = t["n"]
        tickets = self.tickets
        needs = " ".join(f'<span class="ref s-{tickets[b]["s"]}">#{b}</span>' for b in t["blocked"])
        needs_html = f"<span class=needs>After {needs}</span>" if needs else ""
        return (
            f'<a class="node s-{t["s"]}" href="t/{n}.html" data-n="{n}" data-deps="{" ".join(t["blocked"])}" data-lane="{t["lane"]}" '
            f'style="--d:{t["d"]};view-transition-name:n{n}">'
            f'<span class=top><span class=num>{n}</span><span class=kind>{html.escape(self.kind(t))}</span></span>'
            f"<span class=title>{html.escape(self.short(n))}</span>"
            f'<span class=state title="{self.state_label[t["s"]]}"><i></i>{self.short_label[t["s"]]}</span>{needs_html}</a>'
        )

    def next_steps(self):
        by_state = {s: [t for n in self.order for t in [self.tickets[n]] if t["s"] == s] for s in STATE_ORDER}
        items = []
        for step in getattr(self.C, "NEXT_STEPS", []):
            names = PLACEHOLDER.findall(step)
            if any(not by_state[s] for s in names):
                continue  # a step about an empty group drops out
            text = PLACEHOLDER.sub(lambda m: ", ".join(f'#{t["n"]} {self.short(t["n"])}' for t in by_state[m.group(1)]), step)
            items.append(f"<li>{self.inline(text, 't/')}</li>")
        if not items:
            return ""
        return f'<section class=next><h2>{html.escape(self.index["next_heading"])}</h2><ol class=steps>{"".join(items)}</ol></section>'

    def panel(self, p):
        heading = f'<h2>{html.escape(p["heading"])}</h2>'
        if "text" in p:
            inner = f'<p>{self.inline(p["text"], "t/")}</p>'
        elif "items" in p:
            inner = "<ul>" + "".join(f"<li>{self.inline(i, 't/')}</li>" for i in p["items"]) + "</ul>"
        elif "terms" in p:
            inner = "<dl class=gloss>" + "".join(
                f"<div><dt>{html.escape(term)}</dt><dd>{self.inline(dfn, 't/')}</dd></div>" for term, dfn in p["terms"]
            ) + "</dl>"
        else:
            raise BuildError(f"PANELS entry {p.get('heading')!r} needs text, items or terms")
        return f"<section class=card-sec>{heading}{inner}</section>"

    def index_html(self):
        tickets, ix = self.tickets, self.index
        counts = {s: sum(1 for t in tickets.values() if t["s"] == s) for s in STATE_ORDER}
        stats = "".join(
            f'<div class="stat s-{s}"><b data-count="{counts[s]}">{counts[s]}</b><span>{self.state_label[s]}</span></div>'
            for s in STATE_ORDER
        )
        max_d = max(t["d"] for t in tickets.values())
        lanes = []
        for key, label, ns in self.lanes:
            cells = []
            for d in range(max_d + 1):
                here = [tickets[n] for n in ns if tickets[n]["d"] == d]  # lane order sets the stacking
                cells.append(f'<div class=cell style="grid-column:{d + 1}">' + "".join(self.node(t) for t in here) + "</div>")
            lanes.append(
                f'<section class="lane lane-{key}"><h3 class=lane-label>{html.escape(label)}</h3>'
                f'<div class=lane-grid>{"".join(cells)}</div></section>'
            )
        legend = "".join(f'<span class="leg s-{s}"><i></i>{self.state_label[s]}</span>' for s in STATE_ORDER)
        panels = "".join(self.panel(p) for p in getattr(self.C, "PANELS", []))
        eyebrow = f'<p class=eyebrow>{html.escape(ix["eyebrow"])}</p>' if ix["eyebrow"] else ""
        lede = f'<p class=lede>{self.inline(ix["lede"], "t/")}</p>' if ix["lede"] else ""
        body = f"""
<main class=wide>
<header class=hero>
  {eyebrow}
  <h1>{html.escape(ix["title"])}</h1>
  {lede}
  <div class=stats>{stats}</div>
</header>
{self.next_steps()}
<section class=mapsec>
  <div class=maphead><h2>{html.escape(ix["map_heading"])}</h2><div class=legend>{legend}</div></div>
  <p class=hint><span class=wide-only>{html.escape(ix["hint_wide"])}</span><span class=narrow-only>{html.escape(ix["hint_narrow"])}</span></p>
  <div class=mapwrap><div class=map id=map style="--cols:{max_d + 1}"><svg class=edges aria-hidden=true></svg>{"".join(lanes)}</div></div>
</section>
{f"<div class=cols>{panels}</div>" if panels else ""}
</main>"""
        return self.page(ix["page_title"] or ix["title"], body, "")

    # ------------------------------------------------------------ ticket pages

    def chips(self, ns, empty):
        if not ns:
            return f"<span class=muted>{empty}</span>"
        return "".join(
            f'<a class="chip s-{self.tickets[x]["s"]}" href="{x}.html"><b>#{x}</b> {html.escape(self.short(x))}'
            f'<i>{self.state_label[self.tickets[x]["s"]]}</i></a>'
            for x in ns
        )

    def ticket_html(self, t):
        n, tickets = t["n"], self.tickets
        c = dict(self.T[n])
        i = self.order.index(n)
        prev_n, next_n = self.order[i - 1], self.order[(i + 1) % len(self.order)]
        parts = [f'<p class=one>{self.inline(c["one"], "")}</p>']
        if c.get("why"):
            parts.append(f'<section class=sec><h2>Why it matters</h2><p>{self.inline(c["why"], "")}</p></section>')
        if t["s"] == "blocked":
            pending = [b for b in t["blocked"] if tickets[b]["s"] != "decided"]
            c["waits"] = "Open tickets: " + ", ".join(f"#{b} ({self.short(b)})" for b in pending) + "."
        for key, label, kind in self.sections:
            if not c.get(key):
                continue
            if kind in ("list", "steps"):
                tag = "ol" if kind == "steps" else "ul"
                items = "".join(f"<li>{self.inline(x, '')}</li>" for x in c[key])
                parts.append(f'<section class="sec sec-{key}"><h2>{html.escape(label)}</h2><{tag}>{items}</{tag}></section>')
            elif kind == "callout":
                parts.append(f'<section class="sec callout"><h2>{html.escape(label)}</h2><p>{self.inline(c[key], "")}</p></section>')
            else:
                parts.append(f'<section class="sec sec-{key}"><h2>{html.escape(label)}</h2><p>{self.inline(c[key], "")}</p></section>')
        if c.get("related"):
            links = "".join(
                f'<a class="chip s-{r.get("state", "others")}" href="{html.escape(r["href"])}" target=_blank rel=noopener>'
                f'<b>{html.escape(r.get("tag", "↗"))}</b> {html.escape(r["label"])}'
                + (f'<i>{html.escape(r["note"])}</i>' if r.get("note") else "")
                + "</a>"
                for r in c["related"]
            )
            parts.append(f'<section class="sec flow"><h2>Elsewhere</h2><div class=flowcol>{links}</div></section>')
        parts.append(
            '<section class="sec flow"><h2>Where it sits</h2><div class=flowrow>'
            f'<div class=flowcol><h3>Needs first</h3>{self.chips(t["blocked"], "Nothing. It needs no other ticket.")}</div>'
            f'<div class=flowmid><span class="me s-{t["s"]}">#{n}</span></div>'
            f'<div class=flowcol><h3>Unlocks</h3>{self.chips(t["blocks"], "Nothing waits on it.")}</div>'
            "</div></section>"
        )
        lane = next(label for key, label, ns in self.lanes if n in ns)
        meta = [f"Owner: {html.escape(t['owner'])}" if t["owner"] else "", f"Input from: {html.escape(t['inputs'])}" if t["inputs"] and t["inputs"].lower() != "none" else ""]
        meta.append(f"Source: <code>issues/{html.escape(t['file'])}</code>")
        body = f"""
<main class=narrow>
<nav class=crumbs><a href="../index.html" class=back>← Map</a><span class=lane-tag>{html.escape(lane)}</span>
<span class=pn><a href="{prev_n}.html" title="{html.escape(self.short(prev_n))}">← #{prev_n}</a><a href="{next_n}.html" title="{html.escape(self.short(next_n))}">#{next_n} →</a></span></nav>
<header class="thead s-{t['s']}" style="view-transition-name:n{n}">
  <div class=top><span class=num>{n}</span><span class=kind>{html.escape(self.kind(t))}</span><span class="state"><i></i>{self.state_label[t['s']]}</span></div>
  <h1>{html.escape(c['short'])}</h1>
  <p class=full>{html.escape(t['title'])}</p>
</header>
{"".join(parts)}
<footer class=src>{". ".join(m for m in meta if m)}.</footer>
</main>"""
        return self.page(f"#{n} {c['short']}", body, "../")


# ---------------------------------------------------------------- output


def safe_to_replace(out):
    """Only ever delete an empty folder or a previous build of this script."""
    if not out.exists():
        return True
    if not out.is_dir():
        return False
    entries = {p.name for p in out.iterdir()}
    if not entries:
        return True
    if "index.html" not in entries or not entries <= {"index.html", "t", "assets"}:
        return False
    assets = {p.name for p in (out / "assets").iterdir()} if (out / "assets").is_dir() else set()
    pages = list((out / "t").iterdir()) if (out / "t").is_dir() else []
    return assets <= {"site.css", "map.js"} and all(p.is_file() and p.suffix == ".html" for p in pages)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a wayfinder pane from PROJECT/issues/*.md and PROJECT/pane_content.py.")
    ap.add_argument("project", type=pathlib.Path, help="folder holding issues/ and pane_content.py")
    ap.add_argument("--out", type=pathlib.Path, help="output folder (default PROJECT/pane)")
    args = ap.parse_args(argv)
    project = args.project.resolve()
    out = (args.out or project / "pane").resolve()
    try:
        C = load_content(project)
        tickets = load_tickets(project, C)
        site = Site(C, tickets)
        check(out != project and out not in project.parents, f"refusing to replace {out}, which holds the project")
        check(not out.exists() or out.is_dir(), f"{out} is a file; --out takes a folder")
        check(safe_to_replace(out), f"{out} holds files this script did not write; pick an empty or new --out folder")
        index = site.index_html()
        pages = {n: site.ticket_html(t) for n, t in tickets.items()}
    except BuildError as e:
        sys.exit(f"build failed: {e}")
    if out.exists():
        shutil.rmtree(out)
    (out / "t").mkdir(parents=True)
    (out / "assets").mkdir()
    (out / "index.html").write_text(index, encoding="utf-8")
    for n, text in pages.items():
        (out / "t" / f"{n}.html").write_text(text, encoding="utf-8")
    for name in ("site.css", "map.js"):
        shutil.copy(ASSETS / name, out / "assets" / name)
    counts = ", ".join(f"{sum(1 for t in tickets.values() if t['s'] == s)} {s}" for s in STATE_ORDER)
    print(f"wrote {out}: index.html + {len(pages)} ticket pages + 2 assets = {len(pages) + 3} files ({counts})")


if __name__ == "__main__":
    main()
