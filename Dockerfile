FROM node:20-slim

# Build tools for better-sqlite3 native compilation + git for npm clone
RUN apt-get update && \
    apt-get install -y python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

# Clone & install the proxy globally from GitHub
RUN npm install -g github:Sexlovr/ai-proxy

ENV DATA_DIR=/data
ENV PORT=7860
ENV NODE_ENV=production
ENV HOME=/home/node

WORKDIR /usr/local/lib/node_modules/ai-proxy
EXPOSE 7860

# Entrypoint: fix /data permissions at runtime + graceful WAL shutdown
RUN cat << 'EOF' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#!/bin/bash
set -e

# HF Spaces mounts /data at runtime — ensure writable
chmod 777 /data 2>/dev/null || true

cleanup() {
  echo "[shutdown] running WAL checkpoint..."
  cd /usr/local/lib/node_modules/ai-proxy
  node -e "
    try {
      const D = require('better-sqlite3');
      const d = new D('/data/proxy.db');
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

echo '[startup] DATA_DIR=/data'
node server.js &
wait $!
EOF

USER node
CMD ["/usr/local/bin/entrypoint.sh"]
