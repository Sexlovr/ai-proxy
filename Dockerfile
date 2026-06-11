FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g github:Sexlovr/ai-proxy

RUN mkdir -p /data && chmod 777 /data

ENV PORT=7860
ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /usr/local/lib/node_modules/ai-proxy
EXPOSE 7860

CMD ["node", "server.js"]
