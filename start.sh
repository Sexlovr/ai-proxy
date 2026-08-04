#!/bin/bash
# start.sh — HF Space entrypoint for ai-proxy.
# Handles bucket sync (restore on startup, backup on shutdown) around node.
set -e

# Restore state from bucket on startup (bypasses FUSE if it's broken)
if [ -n "$HF_TOKEN" ] && [ -n "$HF_BUCKET" ]; then
  echo "[entrypoint] restoring from bucket: $HF_BUCKET"
  hf buckets sync "hf://buckets/$HF_BUCKET/" /data/ --ignore-times 2>/dev/null || true
  echo "[entrypoint] restore complete"
fi

# Start the proxy
node server.js &
NODE_PID=$!

# On shutdown: flush node state, then sync to bucket
cleanup() {
  echo "[entrypoint] shutting down..."
  kill -TERM "$NODE_PID" 2>/dev/null
  wait "$NODE_PID" 2>/dev/null || true
  if [ -n "$HF_TOKEN" ] && [ -n "$HF_BUCKET" ]; then
    echo "[entrypoint] syncing to bucket: $HF_BUCKET"
    hf buckets sync /data/ "hf://buckets/$HF_BUCKET/" --ignore-times 2>/dev/null || true
  fi
  exit 0
}
trap cleanup SIGTERM SIGINT

wait "$NODE_PID"
