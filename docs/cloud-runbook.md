# StoryOS Cloud runbook

How the hosted product (app.storyos.dev, mcp.storyos.dev) is run. Self-hosters
want [self-hosting.md](self-hosting.md) instead. This page covers the managed
instance only.

## Where production lives

| What | Where |
|---|---|
| Host | Hetzner Cloud `storyos-prod`, fsn1, defined in the `storyos-infra` repo (Terraform) |
| Stack | the official Compose stack, `~/storyOS` as user `deploy`, prebuilt GHCR images (`COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml`) |
| Version | `IMAGE_TAG=<sha>` in `~/storyOS/.env`; the checkout is detached at the same sha |
| Edge | Cloudflare (proxied DNS), Full (strict) with a Cloudflare Origin CA cert in `docker/certs` + `docker/tls.d/origin.caddy` (not in git) |

Production moved here from a Kamatera VPS on 2026-10-11 (ticket #890). The
old box is powered off and kept only as a rollback. **Never power it on to
deploy**: two live instances with separate databases split the data and
run every background job twice.

## Deploy

1. Pick a commit on `main` whose **Build & push images** run is green. Every
   main commit gets `:<sha>` images for api, web and mcp.
2. GitHub → Actions → **Deploy production** → *Run workflow* → paste the full
   40-character sha.
3. The workflow refuses a sha that is not on `main` or has no images, before it
   touches the server. Then it:
   - records the currently deployed sha,
   - takes a pre-deploy backup on the box (`~/storyos-backups/pre-<sha>-<time>`,
     newest 10 kept),
   - checks out the sha, sets `IMAGE_TAG`, pulls and restarts,
   - confirms `https://app.storyos.dev/api/v1/build-info` reports the new sha.

There is no deploy on merge: production changes only when someone runs this.

## Roll back

- **Automatic:** if the new version does not report itself live within about
  3 minutes, the workflow rolls back to the version it recorded, then fails red.
- **Manual:** run **Deploy production** again with the previous sha. Each run's
  summary prints it as "previous".

A rollback restores code, not data. The api applies migrations on boot and
they only go forward, so rolling back across a migration is only safe when
the older code tolerates the newer schema. To undo a data change, restore the
pre-deploy backup ([backup-restore.md](backup-restore.md)).

## Secrets

`~/storyOS/.env` on the box. `BETTER_AUTH_SECRET` and `CONNECTIONS_MASTER_KEY`
encrypt data in the database: **never rotate them casually**. Changing either
logs everyone out and makes every stored connection credential unreadable.
Deploy credentials (`PROD_HOST`, `PROD_SSH_KEY`, `PROD_KNOWN_HOSTS`) live in
the GitHub **production** environment, which releases them only to runs from
`main`.
