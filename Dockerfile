# The web app is the same on every platform: it is built once, on the builder's own.
FROM --platform=$BUILDPLATFORM node:24-alpine AS web
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/home/package.json apps/home/
COPY packages/protocol/package.json packages/protocol/
COPY packages/avatar/package.json packages/avatar/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/web apps/web
# The consent dialog shows the privacy text as it is written there.
COPY docs/privacy.md docs/
RUN pnpm --filter @wizards-bot/web build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/home/package.json apps/home/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/avatar/package.json packages/avatar/
RUN pnpm install --frozen-lockfile --prod --filter @wizards-bot/home...
COPY packages packages
COPY apps/home/src apps/home/src
COPY --from=web /app/apps/web/dist apps/web/dist
RUN printf '#!/bin/sh\nexec node /app/apps/home/src/cli.ts "$@"\n' > /usr/local/bin/wizards-bot && chmod +x /usr/local/bin/wizards-bot
ENV WIZARDS_BOT_DATA=/data WIZARDS_BOT_PORT=4747 WIZARDS_BOT_SUBSCRIPTIONS=""
VOLUME /data
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4747/health || exit 1
CMD ["wizards-bot", "start"]
