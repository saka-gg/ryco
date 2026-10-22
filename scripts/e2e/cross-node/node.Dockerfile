# syntax=docker/dockerfile:1.7
# Node B of the cross-node E2E: the server from this checkout's source on Linux.
# Build from the repository root:
#   docker build -f scripts/e2e/cross-node/node.Dockerfile -t ryco-xnode-node:e2e .
# node.Dockerfile.dockerignore (next to this file) keeps node_modules and build
# output out of the context.
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git libsecret-1-0 curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm i -g bun@1.4.3 node-gyp@11
# Bind-mounted fixture repositories belong to the host user, so every directory
# is safe; the identity covers any commit the node makes itself.
RUN git config --system safe.directory '*' && git config --system user.name 'Linux Box' && git config --system user.email 'linux-box@example.test' && git config --system init.defaultBranch main
# The node's "normal code directory": a well-known code root for projects.pathHints.
RUN mkdir -p /root/code
# Every git@fixture.test:/abs/path remote runs locally (see fake-ssh). Copied
# before the source so a source change keeps this layer cached.
COPY --chmod=0755 scripts/e2e/cross-node/fake-ssh /usr/local/bin/ryco-fake-ssh
ENV GIT_SSH_COMMAND=/usr/local/bin/ryco-fake-ssh \
    GIT_SSH_VARIANT=simple \
    RYCO_TELEMETRY_ENABLED=false \
    RYCO_HUB_CONNECTOR_ENABLED=false
WORKDIR /app
COPY . /app
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --filter=ryco-cli
# The harness overrides the port so the node listens on the same port inside
# the container and on the host.
CMD ["node", "/app/apps/server/src/bin.ts", "serve", "--host", "0.0.0.0", "--port", "14001", "--base-dir", "/data/ryco", "--no-browser"]
