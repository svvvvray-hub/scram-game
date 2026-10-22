#!/bin/bash
# Start the Scram server (auto-restarting) + anonymous public HTTPS tunnel, all in background.
cd "$(dirname "$0")"; mkdir -p logs
pkill -f "node server.js"; pkill -f tunnel.sh; pkill -f "a.pinggy.io"; sleep 1
rm -f PUBLIC_URL.txt logs/tunnel.log
setsid nohup bash -c 'while true; do PORT=3000 node server.js >> logs/server.log 2>&1; sleep 2; done' >/dev/null 2>&1 &
setsid nohup ./tunnel.sh >/dev/null 2>&1 &
for i in $(seq 1 30); do [ -s PUBLIC_URL.txt ] && break; sleep 1; done
cat PUBLIC_URL.txt
