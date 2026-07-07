# Приложение на чистых node-builtins, зависимостей нет — образ = рантайм + исходники.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js index.html styles.css ./
COPY src ./src
COPY assets ./assets

# Состояние игры пишется сюда; каталог монтируется томом в compose.
RUN mkdir -p /data && chown node:node /data
ENV PORT=4173 \
    STATE_FILE=/data/game-state.json

USER node
EXPOSE 4173
CMD ["node", "server.js"]
