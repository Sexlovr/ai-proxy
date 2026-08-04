# Local / non-HuggingFace Docker build.
# For HF Spaces, use Dockerfile.hf instead.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages huggingface_hub

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
COPY --chown=node:node start.sh ./start.sh

RUN chmod +x start.sh

EXPOSE 7860
CMD ["bash", "start.sh"]
