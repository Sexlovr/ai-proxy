FROM node:20-slim

RUN apt-get update &&     apt-get install -y python3 make g++ &&     rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 user
RUN mkdir -p /data && chown -R user:user /data

ENV HOME=/home/user
ENV DATA_DIR=/data
ENV NODE_ENV=production

WORKDIR $HOME/app

COPY --chown=user package*.json ./
RUN npm install --omit=dev

COPY --chown=user . .

USER user

EXPOSE 7860

# Graceful shutdown: WAL checkpoint before exit
COPY --chown=user --chmod=755 <<-'ENTRY' /usr/local/bin/entrypoint.sh
#!/bin/bash
cleanup() {
  echo "[shutdown] running WAL checkpoint..."
  cd $HOME/app && node -e "
    try{const D=require('better-sqlite3');const d=new D('/data/proxy.db');d.pragma('wal_checkpoint(TRUNCATE)');d.close();console.log('[shutdown] checkpoint done')}catch(e){console.error(e.message)}
  " 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT
node server.js &
wait $!
ENTRY

CMD ["/usr/local/bin/entrypoint.sh"]
