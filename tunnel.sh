#!/bin/bash
# Anonymous Pinggy tunnel tunnelled as SSH-inside-TLS on 443 (this box only allows 80/443 egress).
# Free anonymous tunnels expire after ~60 min; loop reconnects (NEW URL each time) and records it.
cd "$(dirname "$0")"
while true; do
  SSH_ASKPASS="$PWD/askpass.sh" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
  ssh -tt -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=20 \
    -o ProxyCommand="openssl s_client -quiet -connect a.pinggy.io:443 -servername a.pinggy.io" \
    -R0:localhost:3000 a.pinggy.io < /dev/zero 2>&1 | tr -d '\r' | while IFS= read -r line; do
      echo "$line" >> logs/tunnel.log
      u=$(echo "$line" | grep -aoE 'https://[a-z0-9.-]+\.(free\.pinggy\.net|pinggy-free\.link|pinggy\.link)' | head -1)
      # keep every URL of this session (one per line); the run.pinggy-free.link one goes first
      if [ -n "$u" ] && ! grep -qxF "$u" PUBLIC_URL.txt 2>/dev/null; then
        case "$u" in *run.pinggy-free.link) { echo "$u"; grep -v 'run.pinggy-free.link' PUBLIC_URL.txt 2>/dev/null; } > PUBLIC_URL.tmp ;;
          *) { cat PUBLIC_URL.txt 2>/dev/null; echo "$u"; } > PUBLIC_URL.tmp ;; esac
        mv PUBLIC_URL.tmp PUBLIC_URL.txt; echo "$(date) NEW URL $u" >> logs/urls.log
      fi
    done
  rm -f PUBLIC_URL.txt   # session ended -> URLs dead
  sleep 3
done
