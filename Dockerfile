FROM node:24-alpine AS web
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
CMD ["wizards-bot", "start"]
