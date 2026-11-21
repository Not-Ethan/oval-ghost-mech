# Mech Royale bot (mechfight/1). Build: docker build -t my-bot .
# Runs with no network, read-only root (writable /tmp), 1 CPU, 512 MB, map mounted at /arena, uid 65534.
FROM node:24.11.1-bookworm-slim
WORKDIR /bot
COPY package.json /bot/package.json
COPY src/ /bot/src/
COPY data/ /bot/data/
ENV NODE_ENV=production
ENTRYPOINT ["node", "--expose-gc", "--max-semi-space-size=32", "--max-old-space-size=256", "--disable-warning=ExperimentalWarning", "/bot/src/main.ts"]
