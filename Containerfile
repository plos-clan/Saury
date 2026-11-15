FROM ghcr.io/pnpm/pnpm:12 AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make \
    && rm -rf /var/lib/apt/lists/*
RUN pnpm runtime set node 26 -g
WORKDIR /saury
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM docker.io/library/node:26-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libgnutls30t64 libx11-xcb1 libxext6 \
        libgssapi-krb5-2 libgcrypt20 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /data && chown node:node /data
WORKDIR /saury
COPY --from=build /saury/dist ./dist
COPY --from=build /saury/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src/saury.sh ./src/
USER node
ENV SAURY_DATA=/data SAURY_HOST=0.0.0.0
ENTRYPOINT ["/saury/src/saury.sh"]
