# StoryOS API — multi-stage, runs migrations on boot (RUN_MIGRATIONS=true)
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config ./packages/config
COPY packages/schemas ./packages/schemas
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/api ./apps/api
RUN pnpm install --frozen-lockfile --filter @storyos/api... --filter @storyos/config
RUN pnpm --filter @storyos/schemas build && pnpm --filter @storyos/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/turbo.json ./
COPY --from=build /app/packages/config/package.json packages/config/package.json
COPY --from=build /app/packages/schemas/package.json packages/schemas/package.json
COPY --from=build /app/packages/schemas/dist packages/schemas/dist
COPY --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
RUN pnpm install --frozen-lockfile --prod --filter @storyos/api... \
  && pnpm store prune \
  && rm -rf /pnpm/store

WORKDIR /app/apps/api
ENV RUN_MIGRATIONS=true
EXPOSE 3001
CMD ["node", "dist/main.js"]
