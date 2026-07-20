# CLAUDE.md

Rules for Claude Code sessions in this project. Read this at the start of every session.

## About the user

Taylor is new to coding and does not read code fluently. Do not assume familiarity with
programming terms, tools, or workflows.

- Explain things in plain language — describe what a change does in terms of what will
  appear or behave differently on screen, not in terms of syntax or code structure.
- Define any technical term the first time you use it in a session (e.g. "commit",
  "repository", "function") in one short clause, not a lecture.
- Don't assume Taylor can review a code diff and judge it — describe the effect of a
  change in words as well.

## When asking questions

Any time you're going to ask Taylor a question (a decision, a choice between options,
a clarification), always include your top 3 recommendations as part of it, ranked, with
a short reason for each — don't just present an open-ended question with no guidance.

## Project

CapEX Dashboard — currently a single `index.html` file (a "Work Orders Dashboard" — a
self-contained HTML/CSS/JS page with no build step, no server, no dependencies to
install). It's meant to be opened directly in a browser.

## How much to check in before acting

- **Small changes** (wording, colors, layout tweaks, fixing a bug, adjusting a number or
  filter): go ahead and make them, then explain what changed afterward.
- **Big or structural changes** (adding new sections/features, changing how data is
  loaded, restructuring the file, adding new files/tools/frameworks): explain the plan in
  plain language first and wait for a go-ahead before making the change.
- When in doubt about whether something counts as "small," treat it as big and ask.

## Safety net: always commit first

Before making any change, make sure the current state of the file(s) is saved as a git
commit. This means: if a change goes wrong or Taylor doesn't like it, we can always
undo it and get back to exactly where we were.

- Check `git status` before editing. If there are uncommitted changes already sitting
  there, commit them first (or ask what they are) before adding new edits on top.
- After a meaningful change is confirmed good, commit it with a plain-language message
  describing what changed and why (not just "update file").
- Never use destructive git commands (`reset --hard`, `push --force`, `clean -f`,
  deleting branches) without explicitly asking first and explaining what will be lost.

## Manual test steps

After any major change or new feature, provide a short numbered list of manual steps
Taylor can follow in the browser to confirm it works (what to click, what to look for,
what the expected result is). Skip this for tiny tweaks (e.g. a color or wording change)
where "refresh and look" is enough.

## Branching, committing, and pushing

- Any new feature gets built on its own new git branch (branched off the current work),
  not directly on `main`. Name it something descriptive of the feature.
- Small fixes/tweaks to existing features can stay on the current branch.
- Do not commit or push on your own initiative. After a change is tested and confirmed
  good, tell Taylor that it's ready and recommend committing (and pushing, if it's a
  good stopping point) — then wait for a go-ahead before running those commands.
- When recommending a push, briefly note what branch it's going to and why now is a
  good point to save it.

## Technical approach

No hard requirement to keep this as a single HTML file — if a structural change (e.g.
splitting into multiple files, adding a small framework) is genuinely the better
long-term approach, it's fine to propose it. But:

- Always explain *why* the change is worth the added complexity in plain terms (e.g.
  "this makes it load faster" or "this makes it easier to add new pages later"),
  since Taylor can't judge that from the code itself.
- Default to the simplest approach that works. Don't introduce build tools, package
  managers, or frameworks unless there's a clear, explained benefit — added complexity
  has a real cost for someone who can't read the code.
- After any change, state clearly how to see it: usually "save the file and refresh the
  page in your browser."
