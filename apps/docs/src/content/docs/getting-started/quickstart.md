---
title: Quickstart
description: Get StoryOS running on your own machine in one command, then create your first database.
sidebar:
  order: 2
---

The whole product runs on your machine: one Postgres, two containers, one command. This page
gets you to a working workspace; the [self-hosting guide](/self-hosting/overview/) covers
production configuration.

## Requirements

- Docker with Compose v2
- ~1 GB RAM / 1 vCPU is plenty for a small team

## Run it

```bash
git clone https://github.com/StoryFunnels/storyOS.git storyos && cd storyos
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open **http://localhost** and sign up. The first account creates its own workspace, and
database migrations run automatically when the API boots.

:::tip
Only `BETTER_AUTH_SECRET` is required to boot. Email, Google sign-in, and S3 attachments are
all optional — see the [configuration matrix](/self-hosting/configuration/).
:::

## Your first database

1. In the sidebar, create a **Space** (a group of databases — also the unit of guest access and
   template installs). A "General" space already exists.
2. Add a **Database** (say, *Tasks*). It starts with a required title field.
3. Add **Fields** — a `select` for status, a `date` for due, a `number` for estimate. See
   [databases & fields](/concepts/databases-and-fields/).
4. Add a **Board view** grouped by status, and drag cards between columns.
5. Create a second database (*Projects*) and a [relation](/concepts/relations/) between them — now
   each Project sees its Tasks and each Task sees its Project.

Prefer a running start? Install a **template pack** (client work, sales CRM, content pipeline, and
more) to get databases, views, and sample data in one click.

## Talk to it from code (or an agent)

Everything you just did in the UI is a REST call. Create a **personal access token** (sidebar →
**API tokens**) and hit the [API](/api/overview/) — or skip the plumbing and let an AI agent drive
via the [MCP server](/mcp/overview/).

## Next steps

- [Self-hosting overview](/self-hosting/overview/) — configuration, TLS, backups, upgrades.
- [Core concepts](/getting-started/concepts/) — the mental model in five minutes.
- [Use with AI (MCP)](/mcp/overview/) — connect Claude or ChatGPT.
