#!/usr/bin/env bash
# start-llm-proxy.sh — launchd wrapper for the proxy bridge
#
# Decides whether to route the bridge's egress through the corporate proxy,
# in this priority order (see probe_corp_network):
#   1. Health-coordinator network.location (authoritative; retried on cold boot)
#   2. DIRECT upstream reachability — if the LLM is reachable with NO proxy, we
#      are not firewalled → stay public (this is the definitive discriminator)
#   3. Local px/proxydetox probe (only trusted once direct egress is blocked)
#   4. PAC-host DNS check
# When corporate: fetch the PAC / use local px, but ONLY export HTTPS_PROXY after
# verifying the chosen proxy is actually reachable — never pin a dead proxy.
# When public: leave proxy env unset, exec the bridge directly.
#
# Why: launchd does not inherit shell env, so the bridge has no HTTPS_PROXY set
# when on corporate. Copilot's HTTPS calls then go direct → blocked by corporate
# firewall → ObservationWriter falls back to "[Raw]". This wrapper closes that
# gap without breaking home/public use. The guards in steps 2 and the pre-export
# reachability check exist because the inverse — pinning a dead corporate proxy
# at home — caused repeated multi-hour outages (2026-05-21, 2026-07-22).

set -u

# Defensive unset: a previous launchd-inherited or KeepAlive-restart-inherited
# value of HTTPS_PROXY can poison the bridge's env. We re-decide below from
# scratch; clearing here guarantees we never carry forward a stale corporate
# proxy URL into a public-network restart (which caused a 9-hr observation
# silence on 2026-05-21: HTTPS_PROXY=corp-proxy:8080 held over from a VPN-on
# startup, every claude-code call returned `fetch failed` in 3-7ms).
unset HTTPS_PROXY HTTP_PROXY NO_PROXY

# launchd's PATH is minimal — ensure dig/curl/grep/awk are findable on macOS+Linux
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

PAC_HOST="${PAC_HOST:-}"
# Everything is found from this checkout and PATH, never from one machine's layout.
PROXY_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_BRIDGE="$PROXY_ROOT/proxy-bridge/server.mjs"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

log() { printf '[start-llm-proxy] %s\n' "$*" >&2; }

# Source optional .env in the repo root so users can drop ANTHROPIC_API_KEY /
# OPENAI_API_KEY / GROQ_API_KEY there without having to maintain them inside
# the launchd plist (rebuild-on-edit, brittle). Each line in .env should be
# KEY=value (no `export` prefix required); set -a lets the shell re-export
# everything sourced between set -a and set +a.
ENV_FILE="$PROXY_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  log_keys=""
  [ -n "${ANTHROPIC_API_KEY:-}" ] && log_keys="$log_keys ANTHROPIC_API_KEY"
  [ -n "${OPENAI_API_KEY:-}" ]    && log_keys="$log_keys OPENAI_API_KEY"
  [ -n "${GROQ_API_KEY:-}" ]      && log_keys="$log_keys GROQ_API_KEY"
  if [ -n "$log_keys" ]; then
    log "loaded$log_keys from $ENV_FILE"
  fi
fi

# Health-coordinator state is the single source of truth for network location.
# The statusline reads from /health/state and shows [N:HOME] / [N:CORP] from
# network.location; we must not drift from that. Local probes only run as a
# last-resort fallback when the coordinator is unreachable (e.g. on cold boot
# before the coordinator's launchd job comes up).
COORDINATOR_URL="${HEALTH_COORDINATOR_URL:-http://127.0.0.1:3034}"

# Cold-boot race tolerance: the coordinator (authoritative) may not be up yet
# when this proxy launches (both are RunAtLoad launchd jobs). Poll it a bounded
# number of times before dropping to local probes, so a transient unreachable
# window can't push us onto the mis-pinning fallback path.
COORDINATOR_WAIT_TRIES="${COORDINATOR_WAIT_TRIES:-5}"
COORDINATOR_WAIT_SLEEP="${COORDINATOR_WAIT_SLEEP:-2}"

# Definitive corporate-vs-public discriminator. This proxy exists to reach LLM
# upstreams; if those upstreams are reachable WITHOUT any proxy, we are by
# definition NOT behind a blocking corporate firewall and must stay public — no
# matter what else is running locally. curl returns 0 for ANY HTTP response
# (even 401/405); only a connect/DNS/TLS failure or timeout is non-zero, so this
# tests reachability, not auth. Proxy env is cleared for the probe so a stale
# value can't mask a working direct path.
DIRECT_EGRESS_HOSTS=("https://api.anthropic.com/v1/messages" "https://api.github.com")
can_reach_upstream_direct() {
  local h
  for h in "${DIRECT_EGRESS_HOSTS[@]}"; do
    if env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
         curl -so /dev/null --max-time 4 "$h" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

probe_corp_network() {
  # Returns 0 when on corporate/VPN, else 1. Verdict priority:
  #   1. Coordinator /health/state.network.location (authoritative; retried on cold boot)
  #   2. DIRECT upstream reachability — if the LLM is reachable with no proxy, stay public
  #   3. Local px-proxy probe (only meaningful once direct egress is confirmed blocked)
  #   4. PAC-host DNS check (last-resort fallback)
  local state location proxy_running try
  for try in $(seq 1 "$COORDINATOR_WAIT_TRIES"); do
    state=$(curl -sf --max-time 2 "${COORDINATOR_URL}/health/state" 2>/dev/null || true)
    if [ -n "$state" ]; then
      location=$(printf '%s' "$state" | /usr/bin/python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('network',{}).get('location','') or d.get('proxy',{}).get('networkMode',''))" 2>/dev/null || true)
      proxy_running=$(printf '%s' "$state" | /usr/bin/python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('network',{}).get('proxy_running', False)).lower())" 2>/dev/null || true)
      if [ -n "$location" ]; then
        case "$location" in
          corporate|vpn)
            log "coordinator: location=$location proxy_running=$proxy_running — corporate (try $try/$COORDINATOR_WAIT_TRIES)"
            return 0
            ;;
          home|public|open|direct)
            # 'open' is the coordinator's canonical term for non-corporate (matches
            # the dashboard "Open (Home)" label); 'direct' covers no-proxy networks.
            log "coordinator: location=$location proxy_running=$proxy_running — public/home (try $try/$COORDINATOR_WAIT_TRIES)"
            return 1
            ;;
        esac
      fi
      log "coordinator reachable but network.location empty (try $try/$COORDINATOR_WAIT_TRIES)"
    else
      log "coordinator at ${COORDINATOR_URL} unreachable (try $try/$COORDINATOR_WAIT_TRIES)"
    fi
    [ "$try" -lt "$COORDINATOR_WAIT_TRIES" ] && sleep "$COORDINATOR_WAIT_SLEEP"
  done
  log "coordinator gave no verdict after $COORDINATOR_WAIT_TRIES tries — falling back to local probes"

  # Fallback Guard (DEFINITIVE): if the LLM upstream is reachable WITHOUT any
  # proxy, we are not firewalled — stay public and do NOT pin HTTPS_PROXY. This
  # short-circuits the proxydetox trap: at home, proxydetox holds a cached
  # corporate ticket and CAN reach github via :3128, which the px-probe below
  # used to read as "corporate", baking a dead corp-proxy:8080 into the bridge
  # (every fetch failed → 502). Recurring bug: 2026-05-21, 2026-07-22.
  if can_reach_upstream_direct; then
    log "fallback: LLM upstream reachable DIRECT (no proxy) — staying public (skipping px/PAC probes)"
    return 1
  fi

  # Fallback Check 1: direct egress is blocked — is px reachable to the corporate
  # proxy upstream? (Only meaningful now that we've confirmed we ARE firewalled.)
  if curl -so /dev/null --max-time 4 --proxy http://127.0.0.1:3128 https://api.github.com 2>/dev/null; then
    log "fallback: direct egress blocked AND px on :3128 reaches upstream — assuming corporate"
    return 0
  fi
  # Fallback Check 2: PAC host resolves to a corporate IP
  if [ -z "$PAC_HOST" ]; then
    log "fallback: no PAC_HOST configured and no local proxy — assuming public"
    return 1
  fi
  local resolved
  resolved=$(dig +short +time=2 +tries=1 "$PAC_HOST" 2>/dev/null | head -5 || true)
  if [ -z "$resolved" ]; then
    log "fallback: PAC host '$PAC_HOST' did not resolve and no local proxy — assuming public"
    return 1
  fi
  if echo "$resolved" | grep -qE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)'; then
    log "fallback: PAC host '$PAC_HOST' resolved to corporate IP(s) — assuming corporate"
    return 0
  fi
  log "fallback: PAC host '$PAC_HOST' resolved to non-corporate IP(s) — assuming public"
  return 1
}

extract_proxy_url() {
  # Fetches the PAC file and extracts the first 'PROXY host:port' from any
  # FindProxyForURL return statement. Falls through to empty string if the
  # PAC is unreachable, malformed, or contains only DIRECT.
  local pac
  pac=$(curl -fsS --max-time 5 "https://$PAC_HOST/proxy.pac" 2>/dev/null || true)
  if [ -z "$pac" ]; then
    log "PAC fetch failed (https://$PAC_HOST/proxy.pac unreachable or empty)"
    return 1
  fi
  local proxy
  proxy=$(echo "$pac" | grep -oE 'PROXY[[:space:]]+[A-Za-z0-9._-]+:[0-9]+' | head -1 | awk '{print $2}')
  if [ -z "$proxy" ]; then
    log "PAC parsed but no PROXY directive found (likely DIRECT-only)"
    return 1
  fi
  printf '%s' "$proxy"
  return 0
}

probe_local_px_proxy() {
  # Returns 0 (and prints "127.0.0.1:3128") if proxydetox/px is running locally
  # and can reach upstream via the corporate proxy. Used as a fallback when
  # the PAC server is unreachable (e.g. off-VPN with proxydetox holding a
  # Kerberos ticket that still authenticates against the corporate egress).
  if curl -so /dev/null --max-time 4 --proxy http://127.0.0.1:3128 https://api.github.com 2>/dev/null; then
    printf '%s' "127.0.0.1:3128"
    return 0
  fi
  return 1
}

if probe_corp_network; then
  # Tell the bridge's network detector unambiguously — single source of truth.
  export LLM_NETWORK_MODE=corporate
  # Proxy URL preference order (TRANSITION-PROOF — 2026-07-26):
  #   1. Local proxydetox on 127.0.0.1:3128 — the ADAPTIVE proxy. It re-reads the
  #      PAC per request and, with --direct-fallback (set in proxydetoxrc since
  #      the 2026-07-25 redesign), routes via the corporate proxy WHILE on VPN and
  #      falls back to DIRECT once VPN drops. Pinning THIS instead of a raw PAC
  #      proxy is what makes the bridge survive a VPN→home transition mid-process-
  #      life. The 2026-07-26 502 outage came from the OLD order: it baked the raw
  #      `corp-proxy:8080` (source=PAC) while on VPN, the user then left VPN, and
  #      corp-proxy:8080 became unreachable but stayed frozen in the process env
  #      (you cannot un-export env in a running process) → every /v1/messages
  #      passthrough fetch-failed → 502. Had :3128 been pinned, proxydetox would
  #      have transparently fallen back to direct — no restart, no outage. Since
  #      the redesign proxydetox is ALWAYS loaded, so this path is reliable.
  #   2. Raw PAC-extracted PROXY directive — ONLY as a last resort when proxydetox
  #      is not running (degraded box). This is the fragile, non-adaptive pin; it
  #      is the exact thing that stranded the process on 2026-07-26 and is now
  #      demoted below the adaptive proxy.
  proxy_url=""
  if proxy_url=$(probe_local_px_proxy) && [ -n "$proxy_url" ]; then
    proxy_source="local-px-adaptive"
  elif proxy_url=$(extract_proxy_url) && [ -n "$proxy_url" ]; then
    proxy_source="PAC-raw"
  else
    proxy_url=""
  fi
  if [ -n "$proxy_url" ]; then
    # NEVER pin a proxy we haven't just proven reachable — a dead proxy URL baked
    # into the bridge is the exact failure this wrapper keeps hitting (2026-05-21,
    # 2026-07-22: HTTPS_PROXY=corp-proxy:8080 held at home → every call fetch-failed
    # in a few ms → 502). This catches a wrong "corporate" verdict AND a stale PAC.
    if curl -so /dev/null --max-time 4 --proxy "http://${proxy_url}" https://api.github.com 2>/dev/null; then
      export HTTPS_PROXY="http://${proxy_url}"
      export HTTP_PROXY="http://${proxy_url}"
      export NO_PROXY="localhost,127.0.0.1,::1"
      log "exported HTTPS_PROXY=$HTTPS_PROXY (source: ${proxy_source}, reachability-verified) LLM_NETWORK_MODE=corporate"
    elif can_reach_upstream_direct; then
      unset HTTPS_PROXY HTTP_PROXY NO_PROXY
      export LLM_NETWORK_MODE=public
      log "corporate verdict but proxy ${proxy_url} is DEAD and direct egress works — overriding to PUBLIC (no proxy pinned)"
    else
      unset HTTPS_PROXY HTTP_PROXY NO_PROXY
      log "corporate verdict but proxy ${proxy_url} is DEAD and direct egress also blocked — HTTPS_PROXY unset; upstream calls will likely fail (genuine connectivity gap)"
    fi
  else
    log "corporate network detected but no usable proxy from PAC or local px — HTTPS_PROXY remains unset; upstream calls will go direct and likely fail"
  fi
else
  # Already unset at top of script — re-assert for symmetry/readability.
  unset HTTPS_PROXY HTTP_PROXY NO_PROXY
  export LLM_NETWORK_MODE=public
  log "public network — HTTPS_PROXY unset, LLM_NETWORK_MODE=public"
fi

# Ensure the consumer-scoped data dir exists before exec. The bridge's
# token-usage module writes to ${LLM_PROXY_DATA_DIR}/llm-proxy/token-usage.db
# and the launchd plist points StandardOut/ErrorPath at
# ${LLM_PROXY_DATA_DIR}/llm-proxy/logs/{stdout,stderr}.log.
if [ -n "${LLM_PROXY_DATA_DIR:-}" ]; then
  mkdir -p "${LLM_PROXY_DATA_DIR}/llm-proxy/logs" 2>/dev/null || \
    log "warn: could not mkdir ${LLM_PROXY_DATA_DIR}/llm-proxy/logs (continuing)"
  log "LLM_PROXY_DATA_DIR=${LLM_PROXY_DATA_DIR}"
else
  log "warn: LLM_PROXY_DATA_DIR unset — token-usage DB will fall back to \$cwd/.data/llm-proxy/"
fi

# Phase 36: multi-user token-usage filename hash (mirrors LSL convention).
# Hash generation via env-var-driven dynamic import — passing the path via
# process.env.USER_HASH_SCRIPT (NOT process.argv[1]) prevents the generator's
# runIfMain block from firing and contaminating stdout with debug output.
USER_HASH_SCRIPT="${CODING_REPO:-${CODING_TOOLS_PATH:-$(cd "$PROXY_ROOT/../.." && pwd)/coding}}/scripts/user-hash-generator.js"
if [ -f "$USER_HASH_SCRIPT" ] && [ -x "$NODE_BIN" ]; then
  _hash=$(USER_HASH_SCRIPT="$USER_HASH_SCRIPT" "$NODE_BIN" -e "import(process.env.USER_HASH_SCRIPT).then(m => process.stdout.write(m.default.generateHash())).catch(e => { process.stderr.write(String(e)); process.exit(1); })" 2>/dev/null || true)
  if ! echo "$_hash" | grep -Eq '^[a-z][a-z0-9]{5}$'; then
    log "warn: user-hash-generator returned unexpected value '${_hash}' — falling back to 'unknown'"
    _hash=unknown
  fi
  export LLM_PROXY_USER_HASH="$_hash"
  log "exported LLM_PROXY_USER_HASH=$LLM_PROXY_USER_HASH"
else
  export LLM_PROXY_USER_HASH=unknown
  log "warn: user-hash-generator script or node binary missing — LLM_PROXY_USER_HASH=unknown"
fi

# Phase 36: canonical timezone source for the proxy's Intl.DateTimeFormat
# calls (token-usage.ts in Plan 36-03 reads this at module init).
export LSL_TIMEZONE="${LSL_TIMEZONE:-Europe/Berlin}"
log "exported LSL_TIMEZONE=$LSL_TIMEZONE"

# Phase 36 follow-up: relocate per-(window, user_hash) JSON exports into
# the private coding-history repo (alongside LSL transcripts) so the
# row-level `prompt_preview` content doesn't leak into the public coding
# repo. token-usage.ts honours LLM_PROXY_TOKEN_EXPORT_DIR as an absolute
# override in resolveTokenExportDir().
#
# Resolve the coding repo root.
#
# This used to be `CODING_REPO_ROOT="${LLM_PROXY_DATA_DIR%/.data}"` — recovering the
# repo root by stripping a suffix off the DATA dir. That only held while the data
# lived inside the repo. It no longer does (the data root is resolved per scope,
# e.g. ~/.coding/data/<scope>/var), so the strip matches nothing and would silently
# yield the data dir itself as the "repo root" — after which the
# history-dir test below fails and token exports stop, with no error.
#
# The repo root is now stated explicitly. The old walk-up fallback was also wrong:
# this script lives at <somewhere>/_work/rapid-llm-proxy/bin/, a SIBLING of the
# coding checkout rather than a child of it, so `../../../` resolved to the parent
# of both.
if [ -n "${CODING_REPO:-}" ]; then
  CODING_REPO_ROOT="$CODING_REPO"
elif [ -n "${CODING_TOOLS_PATH:-}" ]; then
  CODING_REPO_ROOT="$CODING_TOOLS_PATH"
else
  # Last resort: the sibling checkout next to _work/. Warn, because a wrong answer
  # here is silent — it only shows up as token exports quietly not being written.
  CODING_REPO_ROOT="$(cd "$(dirname "$0")/../../../" && pwd)/coding"
  echo "[start-llm-proxy] WARNING: neither CODING_REPO nor CODING_TOOLS_PATH set;" \
       "guessing CODING_REPO_ROOT=$CODING_REPO_ROOT" >&2
fi
# Where coding's transcripts live is coding's to say (per-repo tenancy T9:
# <coding>/.coding/history, resolved by its scripts/lib/history-dir.sh). The old
# <coding>/.specstory/history symlink is gone; pinning the export under it made
# the proxy recreate that path as a real directory the readers no longer look at.
CODING_HISTORY_DIR=""
if [ -f "${CODING_REPO_ROOT}/scripts/lib/history-dir.sh" ]; then
  # shellcheck source=/dev/null
  source "${CODING_REPO_ROOT}/scripts/lib/history-dir.sh"
  CODING_HISTORY_DIR="$(repo_history_dir "$CODING_REPO_ROOT")"
fi
if [ -n "$CODING_HISTORY_DIR" ] && [ -d "$CODING_HISTORY_DIR" ]; then
  export LLM_PROXY_TOKEN_EXPORT_DIR="${CODING_HISTORY_DIR}/logs/llm-proxy-export"
  mkdir -p "$LLM_PROXY_TOKEN_EXPORT_DIR" 2>/dev/null || \
    log "warn: could not mkdir $LLM_PROXY_TOKEN_EXPORT_DIR (continuing)"
  log "exported LLM_PROXY_TOKEN_EXPORT_DIR=$LLM_PROXY_TOKEN_EXPORT_DIR"
else
  log "warn: no history dir for ${CODING_REPO_ROOT} (${CODING_HISTORY_DIR:-resolver not found}) — leaving LLM_PROXY_TOKEN_EXPORT_DIR unset (token exports fall back to .data/llm-proxy-export/)"
fi

# Singleton guard: if another bridge already holds the port, exec would die on
# EADDRINUSE and launchd would crash-loop this job forever while the orphan
# (unmanaged, never restarted on network flips) keeps serving stale state —
# exactly the 2026-07-24 incident: coordinator heal actions restarted the
# launchd job (which died instantly) instead of the actual serving process.
# Only kill a listener whose command line is OUR bridge; never an unknown one.
BRIDGE_PORT="${LLM_CLI_PROXY_PORT:-12435}"
port_pid=$(lsof -ti "tcp:${BRIDGE_PORT}" -sTCP:LISTEN 2>/dev/null | head -1)
if [ -n "$port_pid" ]; then
  port_cmd=$(/bin/ps -o command= -p "$port_pid" 2>/dev/null || true)
  case "$port_cmd" in
    *proxy-bridge/server.mjs*)
      log "port ${BRIDGE_PORT} held by stale bridge pid=$port_pid — killing it (launchd job owns the port)"
      kill "$port_pid" 2>/dev/null
      for _i in 1 2 3 4 5 6 7 8 9 10; do
        lsof -ti "tcp:${BRIDGE_PORT}" -sTCP:LISTEN >/dev/null 2>&1 || break
        sleep 0.5
      done
      if lsof -ti "tcp:${BRIDGE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
        kill -9 "$port_pid" 2>/dev/null
        sleep 1
      fi
      ;;
    *)
      log "FATAL: port ${BRIDGE_PORT} held by pid=$port_pid ('$port_cmd') which is NOT a proxy bridge — refusing to kill; exiting"
      exit 1
      ;;
  esac
fi

log "exec node $PROXY_BRIDGE"

# NOTE: there is deliberately no post-startup routing step any more.
#
# This used to background a script that waited 3s and then PUT ~26 processOverrides
# into the proxy's runtime settings. That made routing depend on a script having
# run, in a repo the proxy does not own, with a race against the proxy's own boot —
# and it meant the answer to "where does this call go?" lived in a shell file's
# comments. Worse, a failure only logged a warning, so a proxy could serve traffic
# on completely different routing than intended and look healthy.
#
# Routing is now read from config/llm-routing.yaml + config/llm-fallback.yaml at
# boot, by the proxy itself. A config that will not parse aborts startup rather
# than being silently skipped. Nothing needs to be applied after the fact.

exec "$NODE_BIN" "$PROXY_BRIDGE"
