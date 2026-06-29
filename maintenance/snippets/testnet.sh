#!/usr/bin/env bash
# Manage the single SHARED pubky-testnet used by the snippet-test stage.
# The testnet binds fixed ports, so there must be exactly ONE instance; the main agent
# (via /sync-references) starts it before invoking the workflow and stops it after.
# Snippet-test agents CONNECT to it — they must never start their own.
#
#   maintenance/snippets/testnet.sh start    # build (if needed) + run; waits for readiness
#   maintenance/snippets/testnet.sh stop     # graceful SIGTERM (drops ephemeral DBs)
#   maintenance/snippets/testnet.sh status
#   maintenance/snippets/testnet.sh endpoints  # prints the relay/homeserver URLs as JSON
#
# Requires: native Postgres 18 reachable at localhost:5432 with a CREATEDB role.
set -euo pipefail

CACHE_DIR="${CACHE_DIR:-$HOME/.cache/pubky-agent-skills/upstream}"
CORE_DIR="$CACHE_DIR/pubky-core"
PIDFILE="${PIDFILE:-/tmp/pubky-testnet.pid}"
LOGFILE="${LOGFILE:-/tmp/pubky-testnet.log}"
export TEST_PUBKY_CONNECTION_STRING="${TEST_PUBKY_CONNECTION_STRING:-postgres://localhost:5432/postgres?pubky-test=true}"

# Fixed endpoints the testnet exposes (see pubky-testnet README / observed boot log).
PKARR_RELAY="http://localhost:15411/"
HTTP_RELAY="http://localhost:15412/"
HOMESERVER_PUBKY="8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo"

cmd="${1:-status}"
case "$cmd" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    [ -d "$CORE_DIR" ] || { echo "missing clone: $CORE_DIR (run /sync-references which clones it)"; exit 1; }
    ( cd "$CORE_DIR" && cargo build -q -p pubky-testnet ) || { echo "build failed"; exit 1; }
    # launch directly (no wrapping subshell) so $! is the testnet binary's pid, not a subshell's
    cd "$CORE_DIR"
    RUST_LOG=info nohup ./target/debug/pubky-testnet >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    i=0; until grep -q "Testnet running" "$LOGFILE" 2>/dev/null || [ $i -ge 60 ]; do i=$((i+1)); sleep 1; done
    if grep -q "Testnet running" "$LOGFILE"; then echo "testnet up (pid $(cat "$PIDFILE"))"; else
      echo "testnet failed to start; see $LOGFILE"; tail -20 "$LOGFILE"; exit 1; fi
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
    pkill -f 'target/debug/pubky-testnet' 2>/dev/null || true   # belt-and-suspenders
    echo "stopped"
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "running (pid $(cat "$PIDFILE"))"; else echo "stopped"; fi
    ;;
  endpoints)
    printf '{"up":true,"pkarrRelay":"%s","httpRelay":"%s","homeserverPubky":"%s"}\n' "$PKARR_RELAY" "$HTTP_RELAY" "$HOMESERVER_PUBKY"
    ;;
  *) echo "usage: testnet.sh {start|stop|status|endpoints}"; exit 2 ;;
esac
