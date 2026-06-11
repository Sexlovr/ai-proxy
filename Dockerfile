FROM node:20-slim

RUN apt-get update && \
    apt-get install -y python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g github:Sexlovr/ai-proxy

ENV PORT=7860
ENV NODE_ENV=production
ENV HOME=/home/node

WORKDIR /usr/local/lib/node_modules/ai-proxy
EXPOSE 7860

RUN cat << 'EOF' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
#!/bin/bash
set -e

# Try /data first, fall back to local dir
if [ -d /data ] && [ -w /data ]; then
  export DATA_DIR=/data/proxy
  mkdir -p /data/proxy 2>/dev/null || true
else
  export DATA_DIR=/usr/local/lib/node_modules/ai-proxy/data
  echo "[startup] /data not writable, using local storage (data lost on sleep)"
fi

cleanup() {
  echo "[shutdown] running WAL checkpoint..."
  cd /usr/local/lib/node_modules/ai-proxy
  node -e "
    try {
      const D = require('better-sqlite3');
      const d = new D(process.env.DATA_DIR + '/proxy.db');
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

echo "[startup] DATA_DIR=$DATA_DIR"
node server.js &
wait $!
EOF

CMD ["/usr/local/bin/entrypoint.sh"]
