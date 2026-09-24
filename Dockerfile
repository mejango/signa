FROM node:22.23.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --ignore-scripts --no-audit --no-fund && npm --prefix mcp ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/rest ./scripts/rest
COPY docs/rest ./docs/rest
COPY client ./client
COPY wallet-client ./wallet-client
COPY mcp/tsconfig.json mcp/tsconfig.build.json ./mcp/
COPY mcp/src ./mcp/src
RUN npm run build

FROM node:22.23.1-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm --prefix mcp ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM production-dependencies AS runtime
# Protocol libraries and evidence remain packaged; src/index.ts owns the Signa runtime.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/mcp/dist ./mcp/dist
COPY mcp/data ./mcp/data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]
