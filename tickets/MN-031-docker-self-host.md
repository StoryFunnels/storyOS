---
id: MN-031
title: Self-host — Docker images + compose
status: done
depends_on: [MN-014, MN-029]
size: M
---

The "free forever for everyone" promise made real. Multi-stage Dockerfiles (`docker/api.Dockerfile` runs migrations on boot then starts; `docker/web.Dockerfile` uses Next standalone output); `docker-compose.yml` = postgres + api + web with healthcheck-ordered startup, plus an optional `minio` profile for S3 attachment storage; single required secret documented; GHCR publish on release tags (workflow ready even while the repo is local); `docs/self-hosting.md` (requirements, full env matrix, upgrade = pull + up, backup = pg_dump + attachments volume).

## Acceptance criteria

- [ ] `git clone && docker compose up -d` → working app at localhost with signup enabled
- [ ] Migrations run automatically and idempotently on api boot
- [ ] Images build multi-arch (amd64/arm64), each < ~300 MB
- [ ] Upgrade path tested: vN → vN+1 with data intact
- [ ] `--profile minio` switches attachment storage to S3 driver end-to-end
- [ ] docs/self-hosting.md complete: env matrix (SMTP, Google OAuth, storage, limits — all optional except DB/secret)
