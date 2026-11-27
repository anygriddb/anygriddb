# AnyGridDB: the API and the web app it serves, in one image (ADR 0011).
# The build stage bundles the API and builds the app; the runtime stage
# holds the bundle, the built files, the migrations, and production
# dependencies only: no compilers, no dev tools.

# The base is pinned by digest: what is built is what was tested, and a
# moved tag cannot change it. The weekly dependency update moves the pin.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
ENV TURBO_TELEMETRY_DISABLED=1
# Node 25 and later ship without Corepack: pnpm comes from npm.
RUN npm install --global --ignore-scripts pnpm@11.28.8
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY patches patches
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/tsconfig packages/tsconfig

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @anygriddb/api... --filter @anygriddb/web...
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/db packages/db
COPY packages/core packages/core
COPY packages/ui packages/ui
# The web build writes the license and the libraries' licenses into what
# the app serves, from what is installed here.
COPY LICENSE LICENSE
COPY scripts/third-party-licenses.mjs scripts/third-party-licenses.mjs
# Which AnyGridDB the bundle reports (ADR 0048). Empty: the root
# package.json's version, commit not recorded. scripts/build-image.sh sets
# them from the checkout; a version that is not package.json's stops here.
ARG ANYGRIDDB_VERSION=""
ARG ANYGRIDDB_COMMIT=""
RUN pnpm --filter @anygriddb/api build && pnpm --filter @anygriddb/web build

# The bundle holds the workspace packages, so only the API's own
# dependencies are installed.
FROM base AS production-dependencies
# TypeScript comes along as a peer of two libraries that only read it for
# types or a config file written in it: nothing here runs it.
RUN pnpm install --frozen-lockfile --prod --filter @anygriddb/api \
    && rm -rf node_modules/.pnpm/typescript@* \
    && find node_modules apps/api/node_modules \( -type l -name typescript \
         -o -path '*/.bin/tsc' -o -path '*/.bin/tsserver' \) -delete

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ENV NODE_ENV=production
# Debian's updates, which the pinned base carries only from its next
# digest: what an operator runs has the fixes Debian had published when it
# was built (its PAM, for one, had a fix the base had not). Nothing is
# added, and the lists go.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
# The process needs node alone. The base image's package manager, which
# nothing here runs, stays out: it would bring its own dependencies, and
# their advisories, into what an operator runs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app/apps/api
COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=production-dependencies /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=build /app/apps/api/dist /app/apps/api/dist
# The API finds the app next to it, in apps/web/dist.
COPY --from=build /app/apps/web/dist /app/apps/web/dist
# The license, where someone who opens the image looks for it. The
# libraries' licenses are served with the app (`/third-party-licenses.txt`).
COPY LICENSE /app/LICENSE
# Files (attachments, exports, staged imports) go to a volume mounted here.
# The directory belongs to the runtime user, so a fresh named volume does too.
RUN mkdir -p /data/files /data/tls && chown 1000:1000 /data/files /data/tls \
    && chmod 700 /data/tls
ENV STORAGE_PATH=/data/files
# HTTPS only (ADR 0029): the instance's own authority and certificate live
# here when the operator brings none.
ENV TLS_DIR=/data/tls
# Operator commands: `docker compose exec app anygriddb storage migrate …`.
RUN printf '#!/bin/sh\nexec node --enable-source-maps /app/apps/api/dist/cli.js "$@"\n' \
      > /usr/local/bin/anygriddb \
    && chmod 755 /usr/local/bin/anygriddb
# The image's `node` user, numeric so runAsNonRoot checks can verify it.
USER 1000:1000
EXPOSE 4000
# Asks the API on the loopback, over HTTPS, its certificate verified
# (ADR 0029). The Compose file says the same, with its own intervals.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["anygriddb", "health"]
CMD ["node", "--enable-source-maps", "dist/index.js"]

# Last, so a new date or commit only relabels the image.
ARG ANYGRIDDB_VERSION=""
ARG ANYGRIDDB_COMMIT=""
ARG ANYGRIDDB_CREATED=""
LABEL org.opencontainers.image.title="AnyGridDB" \
      org.opencontainers.image.description="Open-source spreadsheet interface on real SQL tables" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.url="https://github.com/anygriddb/anygriddb" \
      org.opencontainers.image.source="https://github.com/anygriddb/anygriddb" \
      org.opencontainers.image.documentation="https://github.com/anygriddb/anygriddb/blob/main/docs/operations.md" \
      org.opencontainers.image.version="${ANYGRIDDB_VERSION}" \
      org.opencontainers.image.revision="${ANYGRIDDB_COMMIT}" \
      org.opencontainers.image.created="${ANYGRIDDB_CREATED}"
