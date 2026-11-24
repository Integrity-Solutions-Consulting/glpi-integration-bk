FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tests ./tests

ENV NODE_ENV=production
ENV TZ=America/Guayaquil

RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node","src/auto-sync.mjs"]
