# Local / non-HuggingFace Docker build.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production PORT=7860 DATA_DIR=/data HOME=/home/node
RUN mkdir -p /home/node/app /data && chown -R node:node /home/node/app && chmod 777 /data

USER node
WORKDIR /home/node/app

COPY --chown=node:node package.json ./
RUN npm install --omit=dev

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node store ./store
COPY --chown=node:node lib ./lib
COPY --chown=node:node admin ./admin
COPY --chown=node:node public ./public

EXPOSE 7860
CMD ["node", "server.js"]
