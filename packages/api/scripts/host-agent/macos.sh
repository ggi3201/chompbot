#!/usr/bin/env bash
# Pushes this Mac's stats to Chomp's monitoring. Body format: CONTRACT.md.
# Usage: macos.sh [--dry-run]   (--dry-run prints the JSON and sends nothing)
set -euo pipefail
# launchd starts with a short PATH; this also keeps Homebrew tools out.
PATH=/usr/bin:/bin:/usr/sbin:/sbin

dry_run=0
case "${1-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) echo "usage: ${0##*/} [--dry-run]" >&2; exit 2 ;;
esac

# Env vars win over the config file. The file is parsed, never sourced.
conf=${HOST_AGENT_ENV:-$(dirname "${BASH_SOURCE[0]:-.}")/host-agent.env}
if [ -r "$conf" ]; then
  while IFS='=' read -r key value; do
    value=${value%$'\r'}; value=${value#\"}; value=${value%\"}
    case $key in
      CHOMP_URL|HOST|TOKEN) [ -n "${!key-}" ] || printf -v "$key" %s "$value" ;;
    esac
  done < "$conf"
fi

if (( dry_run )); then
  HOST=${HOST:-$(hostname -s)}
else
  : "${CHOMP_URL:?CHOMP_URL is not set}" "${HOST:?HOST is not set}" "${TOKEN:?TOKEN is not set}"
fi
# HOST goes into the URL and the JSON unescaped.
case $HOST in *[!A-Za-z0-9._-]*) echo "HOST may only contain letters, digits, . _ -" >&2; exit 2 ;; esac

# The second sample covers the 1 s interval; the first is the average since boot.
cpu_idle=$(top -l 2 -n 0 -s 1 | awk '/^CPU usage:/{idle = $7} END{sub(/%/, "", idle); print idle}')

# Used = active + wired + compressed pages.
mem_total_bytes=$(sysctl -n hw.memsize)
mem_used_bytes=$(vm_stat | awk '
  /page size of/ {size = $8}
  /^Pages active:/ {used += $3}
  /^Pages wired down:/ {used += $4}
  /^Pages occupied by compressor:/ {used += $5}
  END {printf "%d", used * size}')

data_volume=/System/Volumes/Data
if [ ! -d "$data_volume" ]; then data_volume=/; fi
read -r disk_total_kb disk_used_kb disk_avail_kb < <(df -P -k "$data_volume" | awk 'NR==2{print $2, $3, $4}')

read -r _ load1 load5 _ < <(sysctl -n vm.loadavg)
boot_epoch=$(sysctl -n kern.boottime | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p')
now=$(date +%s)

metrics=$(awk -v idle="$cpu_idle" -v mt="$mem_total_bytes" -v mu="$mem_used_bytes" \
  -v dtot="$disk_total_kb" -v dused="$disk_used_kb" -v davail="$disk_avail_kb" \
  -v l1="$load1" -v l5="$load5" -v up="$((now - boot_epoch))" 'BEGIN {
    gb = 1073741824
    printf "{\"cpu_pct\":%.1f,\"mem_pct\":%.1f,\"mem_used_gb\":%.2f,\"mem_total_gb\":%.2f,", \
      100 - idle, mu * 100 / mt, mu / gb, mt / gb
    printf "\"disk_pct\":%.1f,\"disk_used_gb\":%.2f,\"disk_total_gb\":%.2f,", \
      dused * 100 / (dused + davail), dused / 1048576, dtot / 1048576
    printf "\"load1\":%s,\"load5\":%s,\"uptime_sec\":%d", l1, l5, up
  }')
battery_pct=$(pmset -g batt | sed -n 's/.*[[:space:]]\([0-9]\{1,3\}\)%.*/\1/p' | head -n 1)
if [ -n "$battery_pct" ]; then
  metrics+=",\"battery_pct\":$battery_pct"
fi
metrics+="}"

# lsof -F prints p<pid>, c<command>, then n<bind:port> once per socket.
listeners=$(lsof -nP -iTCP -sTCP:LISTEN -Fcn 2>/dev/null | awk '
  /^c/ {proc = substr($0, 2); gsub(/["\\]/, "", proc)}
  /^n/ {
    name = substr($0, 2)
    i = match(name, /:[0-9]+$/)
    if (!i) next
    bind = substr(name, 1, i - 1); port = substr(name, i + 1)
    gsub(/^\[|\]$/, "", bind)
    if (bind == "*") bind = "0.0.0.0"
    if (seen[bind ":" port]++) next
    printf "%s{\"bind\":\"%s\",\"port\":%d,\"process\":\"%s\"}", sep, bind, port, proc
    sep = ","
  }') || listeners=

body=$(printf '{"host":"%s","ts":%s000,"agent":"macos","metrics":%s,"listeners":[%s],"containers":[]}' \
  "$HOST" "$now" "$metrics" "$listeners")

if (( dry_run )); then
  printf '%s\n' "$body"
  exit 0
fi

# The token goes in through a curl config on a pipe, so it never shows in `ps`.
printf '%s' "$body" | curl -fsS -m 10 --connect-timeout 5 -o /dev/null \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN") \
  -H 'Content-Type: application/json' --data @- \
  "${CHOMP_URL%/}/api/monitoring/hosts/$HOST/report"
