# StoryOS web — Next.js standalone output.
# NEXT_PUBLIC_API_URL is inlined at BUILD time (Next.js constraint).
# Default "" = same-origin relative /api/v1 calls (caddy routes them) — right
# for compose deploys. Pass an absolute URL only for split-origin setups.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# #163: the MCP endpoint shown on the connect pages. Self-host sets this to their
# own MCP origin; unset = the hosted default (mcp.storyos.dev), baked at build time.
ARG NEXT_PUBLIC_MCP_URL=
ENV NEXT_PUBLIC_MCP_URL=$NEXT_PUBLIC_MCP_URL
# PostHog analytics — NEXT_PUBLIC_* are inlined into the client bundle at BUILD
# time (Next.js constraint), so the values must be present here, not just at
# runtime. Passed through from docker-compose (see the web service build args).
ARG NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=$NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
ARG NEXT_PUBLIC_POSTHOG_HOST=
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
# #593 — next/metadata's metadataBase (og:image/twitter:image) is read at
# BUILD time for every statically prerendered route (/, /login, /signup, …),
# not just at request time like the dynamic routes #566 already fixed. The
# compose `environment:` block only reaches `docker compose up`, never `build`
# — so the running container had WEB_URL and the build that froze its static
# HTML did not. Both are kept: this build arg fixes the static pages, the
# runtime env (docker-compose.yml) keeps the dynamic ones correct.
ARG WEB_URL=http://localhost:3000
ENV WEB_URL=$WEB_URL
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config ./packages/config
COPY packages/schemas ./packages/schemas
COPY packages/sdk ./packages/sdk
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @storyos/web...
RUN pnpm --filter @storyos/schemas build && pnpm --filter @storyos/sdk build && pnpm --filter @storyos/web build

FROM node:22-bookworm-slim AS runtime
# #553 — baked at IMAGE build time (build-images.yml passes --build-arg
# GIT_SHA/BUILD_TIME from the CI checkout), never read from a deploy-time
# .env — a value burned into this specific image can only ever report what
# this specific image was actually built from, even if a later deploy fails
# to swap the running container. Mirrors api.Dockerfile's identical pattern.
ARG GIT_SHA
ARG BUILD_TIME
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
