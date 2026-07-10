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
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config ./packages/config
COPY packages/schemas ./packages/schemas
COPY packages/sdk ./packages/sdk
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter @storyos/web...
RUN pnpm --filter @storyos/schemas build && pnpm --filter @storyos/sdk build && pnpm --filter @storyos/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
