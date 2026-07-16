# StoryOS hosted MCP — Streamable HTTP endpoint (MN-105/MN-143).
# Serves the same @storyos/mcp tools over HTTP with per-request PAT auth.
# Dependency chain: config → sdk → schemas → mcp. schemas is imported by tools.ts
# (markdown round-trip) and inlined by esbuild, so it must be BUILT here, not stubbed.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
# package.json stubs so pnpm can resolve the workspace graph (not built)
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
# packages we actually build
COPY packages/config ./packages/config
COPY packages/schemas ./packages/schemas
COPY packages/sdk ./packages/sdk
COPY packages/mcp ./packages/mcp
RUN pnpm install --frozen-lockfile --filter @storyos/mcp... --filter @storyos/sdk --filter @storyos/config
# Bundle (esbuild) so the runtime image is self-contained — inlines @storyos/sdk, which is a
# devDependency and therefore excluded by the --prod install below. Only @modelcontextprotocol/sdk
# + zod stay external, and those are prod deps. (Fixes the 502 from a missing @storyos/sdk.)
RUN pnpm --filter @storyos/schemas build \
  && pnpm --filter @storyos/sdk build \
  && pnpm --filter @storyos/mcp bundle

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
