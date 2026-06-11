FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g github:Sexlovr/ai-proxy

ENV PORT=7860
ENV NODE_ENV=production

WORKDIR /usr/local/lib/node_modules/ai-proxy
EXPOSE 7860

# Match ai-hub-frontend pattern: run as node (UID 1000),
# create subdirectory under /data so node owns it
RUN cat << 'EOF' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#!/bin/bash
set -e
mkdir -p /data/proxy /home/node/data
export DATA_DIR=/data/proxy
echo "[startup] DATA_DIR=$DATA_DIR"
exec node server.js
EOF

USER node
CMD ["/usr/local/bin/entrypoint.sh"]
