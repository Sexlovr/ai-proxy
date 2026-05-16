FROM node:20-slim

# Native build tools for better-sqlite3
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# HF Docker Spaces run with UID 1000
RUN useradd -m -u 1000 user

# Make /data writable for that user (bucket/volume mounts commonly use /data)
RUN mkdir -p /data && chown -R user:user /data

ENV HOME=/home/user
WORKDIR $HOME/app

COPY --chown=user package*.json ./
RUN npm install --omit=dev

COPY --chown=user . .

USER user

EXPOSE 7860
ENV NODE_ENV=production

CMD ["node", "server.js"]
