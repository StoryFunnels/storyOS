# StoryOS hosted MCP — Streamable HTTP endpoint (MN-105/MN-143).
# Serves the same @storyos/mcp tools over HTTP with per-request PAT auth.
# Dependency chain is just config → sdk → mcp (no schemas).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
# package.json stubs so pnpm can resolve the workspace graph (not built)
COPY packages/schemas/package.json ./packages/schemas/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
# packages we actually build
COPY packages/config ./packages/config
COPY packages/sdk ./packages/sdk
COPY packages/mcp ./packages/mcp
RUN pnpm install --frozen-lockfile --filter @storyos/mcp... --filter @storyos/sdk --filter @storyos/config
RUN pnpm --filter @storyos/sdk build && pnpm --filter @storyos/mcp build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/turbo.json ./
COPY --from=build /app/packages/schemas/package.json packages/schemas/package.json
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/web/package.json apps/web/package.json
COPY --from=build /app/packages/config/package.json packages/config/package.json
COPY --from=build /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /app/packages/sdk/dist packages/sdk/dist
COPY --from=build /app/packages/mcp/package.json packages/mcp/package.json
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
RUN pnpm install --frozen-lockfile --prod --filter @storyos/mcp... \
  && pnpm store prune \
  && rm -rf /pnpm/store

WORKDIR /app/packages/mcp
ENV PORT=3002
EXPOSE 3002
CMD ["node", "dist/http.js"]
