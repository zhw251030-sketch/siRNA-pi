# Keep the upstream runtime protocol; install only this project's locked Pi.
FROM chaitin/agent-compose-guest:v2609.3.0@sha256:14f0740fe39ba22da96edeff9d40c1fd41185389bbb1edcf5cb68e7af85f7b7b

WORKDIR /opt/sirna-pi
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --engine-strict

COPY config/pi/compose-settings.json /opt/sirna-pi/settings.json
COPY --chmod=755 containers/agent-compose-guest/pi.sh /usr/local/bin/pi
RUN test "$(/usr/local/bin/pi --version)" = "1.2.0"

# Inherit the official tini entrypoint and keep-running command.
WORKDIR /workspace
