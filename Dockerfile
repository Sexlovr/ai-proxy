FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g github:Sexlovr/ai-proxy

ENV DATA_DIR=/data/proxy
ENV PORT=7860
ENV NODE_ENV=production
ENV HOME=/home/node

WORKDIR /usr/local/lib/node_modules/ai-proxy
EXPOSE 7860

RUN cat << 'EOF' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#!/bin/bash
set -e

mkdir -p /data/proxy

cleanup() {
  echo "[shutdown] running WAL checkpoint..."
  cd /usr/local/lib/node_modules/ai-proxy
  node -e "
    try {
      const D = require('better-sqlite3');
      const d = new D('/data/proxy/proxy.db');
      d.pragma('wal_checkpoint(TRUNCATE)');
      d.close();
      console.log('[shutdown] checkpoint done');
    } catch(e) {
      console.error(e.message);
    }
  "
  exit 0
}
trap cleanup SIGTERM SIGINT

echo '[startup] DATA_DIR=/data/proxy'
node server.js &
wait $!
EOF

CMD ["/usr/local/bin/entrypoint.sh"]
