# Product principles

Rulings we keep re-ruling. Each is decided; do not re-litigate without new evidence. Check the live ticket first.

## One gate per risk

- A switched-on agent wakes by itself. A person's choice in the install review ("Wake it automatically") is the only switch. (Source: Issues #1212 ruling, Ievgen 2026-11-04; PR #1401 merged.)
- Approvals hold actions, not runs. Anything outward or destructive waits in approvals. (Source: Issues #1212, details.)
- `human_gate` stays available as "ask me before each run". (Source: Issues #1212, details.)
- Existing installs are not migrated: an enabled trigger does not show a person chose it. (Source: Issues #1212, Otto ruling 2026-11-10.)

## Anything a pack installs that acts outward installs OFF

Automations that send outside the workspace (email, webhook, publish) or run an agent install switched off. The install review lists each one, and only the person can switch it on. A manifest cannot force it on. (Source: Issues #1107 and #1192, Otto's rulings.)

## Gold means agency

Human work is silent. Every non-human actor (agent, automation, MCP) is gold. Do not decorate the human case, or the exception stops reading. Do not add a new color for it. (Source: Issues #831, details.)

## Guests are always free

A guest never counts as a billable seat, at any grant role. Billable seats are admins and members only. (Source: Issues #1258, Ievgen 2026-11-10.)

## API-first, and MCP descriptions are instructions

A new API capability ships with its MCP tool in the same PR, or an entry saying why not. Descriptions in MCP tools are instructions to an agent, so update them when behaviour changes. (Source: CLAUDE.md, 'Before you push'; Issues #1212, details.)

## Personal space and views

Personal space is private from admins and excluded from export. A view keeps its owning database and also has a place in the sidebar tree. (Source: CLAUDE.md, 'Personal space' and 'Where a view lives'.)

## Design fidelity needs side-by-sides

A designed surface is checked against the designer's spec, measured from the rendered output. A ticket that promises a look needs visual criteria. (Source: house rules, 'Honesty rules' 7.)

## Formulas: stop growing the function library

Open, not decided. Ievgen closed `map()` with a lambda as too complex, and asked for a plan to make formulas human. The plan (Issues #873) is in ToDo and awaits Ievgen's choice of direction. (Source: Issues #873.) Nothing shipped is removed.

## Unsourced: needs an owner

- "Nothing hover-only": only the #1271 spec lists it.
