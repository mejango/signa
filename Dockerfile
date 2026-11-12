FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/rest ./scripts/rest
COPY docs/rest ./docs/rest
COPY client ./client
COPY wallet-client ./wallet-client
RUN npm run build

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM production-dependencies AS runtime
# Reviewed account execution artifacts remain packaged; src/index.ts owns the Signa runtime.
ENV NODE_ENV=production
# The source commit /healthz reports; unset leaves it null (scripts/rest/verify-served-build.mjs checks the assets).
ARG SIGNA_BUILD_COMMIT
ENV SIGNA_BUILD_COMMIT=$SIGNA_BUILD_COMMIT
WORKDIR /app
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]
