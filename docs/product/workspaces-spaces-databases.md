# Workspaces, spaces and databases

Three levels of container. Most tools have some version of this and give you no help deciding
what goes where, so here is the short answer first, then the reasoning.

| Level | The question it answers | Example |
|---|---|---|
| **Workspace** | What is this company doing here? | *Acme — our client work, from first call to final invoice.* |
| **Space** | What is this area of work? | *Delivery — active client projects and everything they need.* |
| **Database** | What belongs in this table? | *Voices — tone-of-voice profiles we write in, one per publication.* |

A newcomer asks those three questions in that order. So does a model. That ordering is the whole
design.

## Workspace

The outermost boundary. Members, billing, connections, agents and every space live inside one
workspace, and nothing crosses between two of them. If you are wondering whether to make a second
workspace, the test is whether the *people* differ — separate workspaces are for separate groups,
not for separate projects.

## Space

A named area of work inside a workspace, holding databases, dashboards, documents and folders.
Spaces are how a workspace stays navigable once it has more than a dozen databases. They carry an
icon and a colour, so the sidebar is scannable rather than a list of similar words.

## Database

A table of records with typed fields, its own views, buttons and automation rules. This is where
the actual work lives.

## Every level can say what it is for

Each of the three carries an optional one-line **description** — plain text, not a rich-text
document. The MCP tools cap it at 200 characters, which is the right length: it is a purpose line,
not a README.

**Why bother.** One sentence — *"Voices — tone-of-voice profiles we write in, one per
publication"* — tells a reader more than fifteen field definitions do. It is the cheapest context
the product can hand the next person who opens this thing, and the next person is very often not
you.

### Where it shows up

- **Under the database title**, as a single line. Only when set: an unset description renders
  nothing at all — no placeholder, no reserved empty row. Absent means absent.
- **As the sidebar row's tooltip**, when you hover a database.
- **In the empty state** of a database with no records yet — the moment someone most needs to know
  what is supposed to go in here.
- **In `list_workspaces`, `list_spaces`, `list_databases` and `describe_database`** over MCP, which
  is what makes it useful to an agent.

### Setting one

Today this is an **API and MCP capability, not a UI one.** There is no field in the app for typing
a description; the app renders descriptions but has no editor for them. Set one with:

- `create_database` / `update_database`, `create_space` / `update_space`, `update_workspace` over
  MCP — all take `description`, and the update tools accept `null` to clear it.
- The equivalent REST endpoints.

The best moment is **at creation**, whether you are clicking or an agent is building: you know the
purpose then, and if you skip it the sentence is thrown away at the only point it existed.

> **Not the record description.** A database also has `description_hidden` and `description_order`,
> which configure the per-*record* description block — a versioned rich-text document that appears
> on each record. That is a different feature that happens to share a prefix. This page is about the
> database's own one-line purpose.
