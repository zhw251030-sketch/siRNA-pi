# Keep the upstream runtime protocol; install only this project's locked Pi.
FROM chaitin/agent-compose-guest:v2609.3.0@sha256:14f0740fe39ba22da96edeff9d40c1fd41185389bbb1edcf5cb68e7af85f7b7b

WORKDIR /opt/sirna-pi
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --engine-strict

COPY config/pi/compose-settings.json /opt/sirna-pi/settings.json
COPY packages/domain/sirna-tools/ /opt/sirna-pi/packages/domain/sirna-tools/
COPY apps/mcp/ /opt/sirna-pi/apps/mcp/
COPY scripts/verify-guest-mcp.mjs /opt/sirna-pi/scripts/verify-guest-mcp.mjs
COPY scripts/verify-guest-tool-gap.mjs /opt/sirna-pi/scripts/verify-guest-tool-gap.mjs
# The official adapter imports adjacent TypeScript modules. Expose its complete
# package, keeping the upstream MIT license and locked implementation intact.
RUN test -L /usr/local/share/agent-compose/pi-mcp-adapter/index.ts \
    && rm /usr/local/share/agent-compose/pi-mcp-adapter/index.ts \
    && rmdir /usr/local/share/agent-compose/pi-mcp-adapter \
    && ln -s /usr/lib/node_modules/pi-mcp-adapter /usr/local/share/agent-compose/pi-mcp-adapter
COPY containers/agent-compose-guest/patch-mcp-config.mjs /opt/sirna-pi/patch-mcp-config.mjs
RUN node /opt/sirna-pi/patch-mcp-config.mjs /usr/lib/node_modules/pi-mcp-adapter
COPY containers/agent-compose-guest/patch-mcp-refresh.mjs /opt/sirna-pi/patch-mcp-refresh.mjs
RUN node /opt/sirna-pi/patch-mcp-refresh.mjs /usr/lib/node_modules/pi-mcp-adapter
COPY containers/agent-compose-guest/patch-mcp-builder-timeout.mjs /opt/sirna-pi/patch-mcp-builder-timeout.mjs
RUN node /opt/sirna-pi/patch-mcp-builder-timeout.mjs /usr/lib/node_modules/pi-mcp-adapter
COPY --chmod=755 containers/agent-compose-guest/pi.sh /usr/local/bin/pi
COPY containers/agent-compose-guest/goal-verifier-guard.mjs /opt/sirna-pi/goal-verifier-guard.mjs
RUN test "$(/usr/local/bin/pi --version)" = "1.2.0"

# Inherit the official tini entrypoint and keep-running command.
WORKDIR /workspace
