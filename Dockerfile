FROM node:22-alpine

# git         -- all repository work (the tool shells out rather than using a JS git impl)
# docker-cli
# docker-cli-compose
#             -- deploys run `docker compose up -d` against the host socket. This is the
#                whole point of the tool: a TRUE compose up re-reads labels and image env,
#                which is exactly what WUD's clone-the-running-container recreate does not.
# sqlite      -- the docker-volume-backup archive-pre hook runs `sqlite3 .backup`.
RUN apk add --no-cache git docker-cli docker-cli-compose sqlite

WORKDIR /app

# better-sqlite3 ships prebuilds for musl/arm64+x64; build deps are only needed if the
# prebuild is missing, so install them in the same layer and drop them again.
COPY package.json package-lock.json* ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci \
    && apk del .build-deps

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm run build

# The live homelab checkout is bind-mounted at its own host path so that `docker compose`
# resolves relative volume paths and the project name identically to a host-side run.
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080

EXPOSE 8080

# git refuses to operate on a repo owned by another uid; the container runs as the host
# user (PUID/PGID) but the ownership check still needs an explicit exemption.
RUN git config --system --add safe.directory '*'

CMD ["node", "dist/index.js"]
