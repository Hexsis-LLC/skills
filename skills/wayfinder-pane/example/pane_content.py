"""Words for the example wayfinder pane. Every value here is made up.

Inline syntax in any text: `code`, **bold**, [label](https://...), and #NN for a link to a ticket page.
States come from issues/*.md; WAITING_ON_YOU and NEEDS_OTHERS refine the open tickets.
"""

PANE = ""  # this Pane's Latest Link, saved after the first publish; the builder ignores it

INDEX = dict(
    eyebrow="Wayfinder map · Example",
    title="Move the team wiki",
    page_title="Move the team wiki: map",
    lede=(
        "This map shows every decision we need before we move the team wiki to a new tool. "
        "Each card is one ticket. Click a card to see its context, then leave a thread on the pane to give feedback."
    ),
)

# A step drops out when a {state} it names has no tickets. Link sibling Panes by their Latest Link.
NEXT_STEPS = [
    "Answer the open questions on {you}. Open a card, then leave a thread on any point.",
    "Wait for an answer from other people on {others}.",
    "When you say go, I start: {ready}.",
    "Then open the [home page prototypes](https://example.com/prototypes) and pick a variant.",
]

WAITING_ON_YOU = {"03"}
NEEDS_OTHERS = {"04"}

# (key, label, tickets). The list order sets how cards stack inside one column.
LANES = [
    ("content", "Content and owners", ["01", "03", "05", "07"]),
    ("platform", "Tool and access", ["02", "04", "06"]),
]

PANELS = [
    dict(heading="The goal", text="One plan that moves every kept page to the new wiki, with an owner for each section and a date for the switch."),
    dict(heading="Agreed before this map", items=[
        "The new wiki uses the company single sign-on.",
        "The old wiki stays readable for one year after the move.",
    ]),
    dict(heading="Not in this work", items=[
        "Rewriting page content. Pages move as they are.",
        "Chat or ticketing tools.",
    ]),
    dict(heading="Words we use", terms=[
        ("Archive", "A read-only copy of the old wiki. Nobody edits it."),
        ("Section owner", "The person who keeps one section of the new wiki up to date (#05)."),
    ]),
]

T = {}

T["01"] = dict(
    short="Page audit",
    one="Find out what the current wiki holds and who owns it.",
    why="We cannot choose what to move until we know how much there is.",
    result=[
        "412 pages. 61% have had no edit in two years.",
        "Three teams own most pages edited this year.",
        "The page list feeds #03.",
    ],
)

T["02"] = dict(
    short="Tool shortlist",
    one="Find the wiki tools that meet our sign-in, history and import needs.",
    why="Access rules and the home page both depend on the tool.",
    decision=[
        "Tool B. It passes every constraint and costs less per seat.",
        "Tool A stays the fallback if the import test fails.",
    ],
)

T["03"] = dict(
    short="What to archive",
    one="Decide which old pages we archive and which we move.",
    why="Every page we move needs an owner. Moving fewer pages makes #05 smaller.",
    ask="Do you agree to archive every page with no edit in two years, unless a team lead asks to keep it?",
    know=[
        "From #01: 251 pages have had no edit in two years.",
        "Team leads can list pages they still use.",
    ],
    rec=[
        "Archive pages with no edit in two years by default.",
        "Give team leads two weeks to rescue pages from the archive list.",
    ],
    open=["What happens to pages whose owner has left the company?"],
)

T["04"] = dict(
    short="Sign-in and access",
    one="Decide who can read, edit and publish on the new wiki.",
    why="The wrong default either hides pages people need or shows pages that should stay private.",
    note="IT and Security are checking whether contractors can use single sign-on. The answer is due this week.",
    know=[
        "From #02: Tool B supports single sign-on and groups.",
        "Contractors have accounts today, but no single sign-on.",
    ],
    related=[
        dict(tag="Q1", label="Contractor sign-in question", href="https://example.com/questions", note="Open, for IT"),
    ],
)

T["05"] = dict(
    short="Section owners",
    one="Choose one owner for each section we keep.",
    why="Pages without an owner go stale again within a year.",
)

T["06"] = dict(
    short="Home page prototype",
    one="Make two rough versions of the new home page to react to.",
    why="The home page decides whether new joiners find their team's pages.",
    know=[
        "Tool B lets us pin sections and add a search box at the top.",
        "Variant A leads with search. Variant B leads with a list of teams.",
    ],
)

T["07"] = dict(
    short="Move order",
    one="Put the sections in move order and set the read-only date for the old wiki.",
    why="This is the last step before the move starts, which is the goal of this map.",
)
