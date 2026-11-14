#!/usr/bin/env bash
# Pushes this Linux machine's stats to Chomp's monitoring. Body format: CONTRACT.md.
# Usage: linux.sh [--dry-run]   (--dry-run prints the JSON and sends nothing)
set -euo pipefail

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

cpu_sample() { awk '/^cpu /{printf "%d %d\n", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit}' /proc/stat; }
read -r total1 idle1 < <(cpu_sample)
sleep 1
read -r total2 idle2 < <(cpu_sample)

read -r mem_total_kb mem_avail_kb < <(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print t, a}' /proc/meminfo)
read -r disk_total_kb disk_used_kb disk_avail_kb < <(df -P -k / | awk 'NR==2{print $2, $3, $4}')
read -r load1 load5 _ < /proc/loadavg
uptime_sec=$(awk '{printf "%d", $1}' /proc/uptime)

metrics=$(awk -v dt="$((total2 - total1))" -v di="$((idle2 - idle1))" \
  -v mt="$mem_total_kb" -v ma="$mem_avail_kb" \
  -v dtot="$disk_total_kb" -v dused="$disk_used_kb" -v davail="$disk_avail_kb" \
  -v l1="$load1" -v l5="$load5" -v up="$uptime_sec" 'BEGIN {
    gb = 1048576
    printf "{\"cpu_pct\":%.1f,\"mem_pct\":%.1f,\"mem_used_gb\":%.2f,\"mem_total_gb\":%.2f,", \
      (dt > 0 ? (dt - di) * 100 / dt : 0), (mt - ma) * 100 / mt, (mt - ma) / gb, mt / gb
    printf "\"disk_pct\":%.1f,\"disk_used_gb\":%.2f,\"disk_total_gb\":%.2f,", \
      dused * 100 / (dused + davail), dused / gb, dtot / gb
    printf "\"load1\":%s,\"load5\":%s,\"uptime_sec\":%d", l1, l5, up
  }')
temp_file=/sys/class/thermal/thermal_zone0/temp
if [ -r "$temp_file" ]; then
  metrics+=$(awk '{printf ",\"temp_c\":%.1f", $1 / 1000}' "$temp_file")
fi
metrics+="}"

# Without root, ss shows process names only for this user's sockets.
listeners=
if command -v ss >/dev/null; then
  listeners=$(ss -tlnHp 2>/dev/null | awk '
    {
      i = match($4, /:[0-9]+$/)
      if (!i) next
      bind = substr($4, 1, i - 1); port = substr($4, i + 1)
      gsub(/^\[|\]$/, "", bind); sub(/%.*/, "", bind)
      if (bind == "*") bind = "0.0.0.0"
      if (seen[bind ":" port]++) next
      proc = ""
      if (match($0, /users:\(\("[^"]*"/)) proc = substr($0, RSTART + 9, RLENGTH - 10)
      gsub(/["\\]/, "", proc)
      printf "%s{\"bind\":\"%s\",\"port\":%d", sep, bind, port
      if (proc != "") printf ",\"process\":\"%s\"", proc
      printf "}"
      sep = ","
    }') || listeners=
fi

# docker ps already prints one JSON object per line.
containers=
if command -v docker >/dev/null; then
  limit=(); if command -v timeout >/dev/null; then limit=(timeout 5); fi
  containers=$("${limit[@]}" docker ps --format '{{json .}}' </dev/null 2>/dev/null | paste -sd, -) || containers=
fi

body=$(printf '{"host":"%s","ts":%s000,"agent":"linux","metrics":%s,"listeners":[%s],"containers":[%s]}' \
  "$HOST" "$(date +%s)" "$metrics" "$listeners" "$containers")

if (( dry_run )); then
  printf '%s\n' "$body"
  exit 0
fi

# The token goes in through a curl config on a pipe, so it never shows in `ps`.
printf '%s' "$body" | curl -fsS -m 10 --connect-timeout 5 -o /dev/null \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN") \
  -H 'Content-Type: application/json' --data @- \
  "${CHOMP_URL%/}/api/monitoring/hosts/$HOST/report"
