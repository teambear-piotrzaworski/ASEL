# Orchestrator image. Build context is the repo root (see docker-compose.yml).
# Stage 1 compiles TypeScript, stage 2 runs plain node on the emitted JS.

FROM node:22-bookworm-slim AS build

# better-sqlite3 ships prebuilt binaries, these are the fallback toolchain.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

COPY orchestrator/package.json orchestrator/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY orchestrator/tsconfig.json ./
COPY orchestrator/src ./src
RUN pnpm build

# Drop dev dependencies from the tree that gets copied into the runtime image.
RUN pnpm prune --prod


FROM node:22-bookworm-slim AS runtime

# git plus ca-certificates: the orchestrator clones and fetches the project
# repositories itself, over HTTPS, into the bind mounted repos directory (see
# src/git-sync.ts). Docker CLI to drive sibling containers through the mounted
# socket (Sandcastle spawns siblings, this is not docker in docker).
ARG DOCKER_CLI_VERSION=27.5.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" \
       | tar -xz -C /tmp docker/docker \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV ASEL_CONFIG_DIR=/app/config
ENV ASEL_STATE_DIR=/data/state
# ASEL_REPOS_DIR comes from docker-compose.yml: it must match the host path of
# the repos bind mount, so a baked-in default would only mask a broken setup.

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The orchestrator talks to /var/run/docker.sock, which is root owned on the
# Docker Desktop VM, so it stays root. The agent containers it spawns run as a
# non-root user (see images/agent-runtime/Dockerfile).
VOLUME ["/data/state"]

# The repos directory is bind mounted from the host, so its files carry the
# host user's uid while this process is root - git refuses to touch such a
# repository ("dubious ownership") without a whitelist. Same reasoning as in
# images/agent-runtime/Dockerfile; this process only ever works on the clones
# it makes itself under ASEL_REPOS_DIR.
RUN git config --global --add safe.directory '*'

CMD ["node", "dist/index.js"]
