# Base agent runtime image.
#
# Project images inherit from this one (FROM asel-agent-runtime:latest) and add
# their own toolchains. Requirements imposed by Sandcastle: a non-root `agent`
# user, git, gh and the Claude Code CLI on PATH.
#
# Built by ./asel.sh build, not by docker compose.

FROM node:22-bookworm-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
ARG GH_VERSION=2.63.2

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git \
       curl \
       ca-certificates \
       ripgrep \
       jq \
       less \
       openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI: the agent reads issues and creates task issues with it. It opens
# no pull requests: runs end with commits pushed to the plan branch.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o /tmp/gh.tgz; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    mv "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_${arch}"

RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# pnpm via corepack: the substrate commands of a node project (pnpm tsc, pnpm
# lint, pnpm test) run in THIS container, and a missing binary reads as exit
# 127, which the TDD chain rightly treats as a broken image rather than a red
# suite. corepack ships with node but is inactive until enabled. COREPACK_HOME
# is world-readable on purpose: the prepare runs as root, the agent user runs
# pnpm, and the default per-user cache would make every container re-download.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && chmod -R a+rX "$COREPACK_HOME"

# The node base image already owns uid 1000 as user `node`. Rename it to
# `agent` (the name Sandcastle expects) and align it with the host uid/gid so
# bind mounted worktrees stay writable without a chown. The host gid may
# already exist in the image (macOS staff is 20, dialout in Debian): reuse
# that group as the agent's primary group instead of failing on groupmod.
RUN set -eux; \
    groupmod -n agent node; \
    usermod -l agent -d /home/agent -m node; \
    if [ "$(id -g agent)" != "${AGENT_GID}" ]; then \
      if getent group "${AGENT_GID}" >/dev/null; then \
        usermod -g "${AGENT_GID}" agent; \
        groupdel agent; \
      else \
        groupmod -g "${AGENT_GID}" agent; \
      fi; \
    fi; \
    if [ "$(id -u agent)" != "${AGENT_UID}" ]; then usermod -u "${AGENT_UID}" agent; fi; \
    chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

USER agent
WORKDIR /workspace

ENV CLAUDE_CONFIG_DIR=/home/agent/.claude

# Worktrees are bind mounted from the host, so git needs them whitelisted.
RUN git config --global --add safe.directory '*' \
    && git config --global init.defaultBranch main

# Matt Pocock's skills, installed as a Claude Code plugin. The wayfinder run
# invokes the /wayfinder skill by slash command, so the skill set has to exist
# in this image or the prompt refers to nothing. A fresh config has NO
# marketplace configured (the official one is not bootstrapped headless), so
# the skills repo is added as its own marketplace first and the plugin is
# installed from there. The plugin version is whatever the marketplace serves
# at build time; updating it means rebuilding the image.
RUN claude plugin marketplace add mattpocock/skills \
    && claude plugin install -y mattpocock-skills@mattpocock

# Sandcastle starts this image with `docker run -d` and no command, then execs
# into the running container. The default command therefore has to outlive an
# EOF on stdin: `bash` exits immediately in detached mode, `sleep infinity`
# stays until the sandbox is closed.
CMD ["sleep", "infinity"]
