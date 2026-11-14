# Host report contract

A host agent sends one report per minute. The API route `POST /api/monitoring/hosts/:host/report` is built from this file.

## Request

```
POST /api/monitoring/hosts/:host/report
Authorization: Bearer <per-host token>
Content-Type: application/json
```

- `:host` is the host key: lowercase letters, digits and `-`. Examples: `rpi`, `macbook`. Chomp answers any other name with `401`.
- The token is per host. The route compares it with the setting for that host (`MONITOR_HOST_TOKEN_RPI`, `MONITOR_HOST_TOKEN_MACBOOK`: the host name in capitals, `-` as `_`) with a constant-time compare.
- Unknown host or wrong token: `401`. Do not say which one was wrong.
- The agent has no retry. It sends again at the next tick.

## Body

```json
{
  "host": "rpi",
  "ts": 1794096948000,
  "agent": "linux",
  "metrics": {
    "cpu_pct": 0.0,
    "mem_pct": 11.9,
    "mem_used_gb": 0.93,
    "mem_total_gb": 7.86,
    "disk_pct": 12.9,
    "disk_used_gb": 28.66,
    "disk_total_gb": 234.04,
    "load1": 0.08,
    "load5": 0.03,
    "uptime_sec": 9480198,
    "temp_c": 55.6
  },
  "listeners": [
    { "bind": "0.0.0.0", "port": 22, "process": "sshd" },
    { "bind": "127.0.0.1", "port": 631 }
  ],
  "containers": [
    { "ID": "b8b3990985d2", "Names": "scraper_app_1", "Image": "scraper_app", "State": "running", "Status": "Up 5 weeks", "Ports": "0.0.0.0:5000->5000/tcp" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `host` | string | Same as `:host` in the path. Reject the report when they differ. |
| `ts` | integer | Epoch milliseconds on the agent's clock. Use the receive time for "last seen"; keep `ts` only for debugging. |
| `agent` | `"linux"` or `"macos"` | Which script sent it. |
| `metrics` | object | Always sent. Numbers are JSON numbers. |
| `listeners` | array | Always sent, may be empty. TCP listeners only. |
| `containers` | array | Always sent. Empty when Docker is missing, not usable, or the host is a Mac. |

### `metrics`

| Key | Unit | Required | Source |
|---|---|---|---|
| `cpu_pct` | percent, 0-100 | yes | Busy share over about 1 s. |
| `mem_pct` | percent | yes | Linux: (MemTotal - MemAvailable) / MemTotal. Mac: (active + wired + compressed) / hw.memsize. |
| `mem_used_gb` | GiB | yes | Same as `mem_pct`. |
| `mem_total_gb` | GiB | yes | |
| `disk_pct` | percent | yes | Used / (used + available), like `df`. Root volume on Linux, the Data volume on macOS. |
| `disk_used_gb` | GiB | yes | |
| `disk_total_gb` | GiB | yes | |
| `load1` | load | yes | 1-minute load average. |
| `load5` | load | yes | 5-minute load average. |
| `uptime_sec` | seconds | yes | Integer. |
| `temp_c` | degrees C | no | Linux only, `thermal_zone0`. Omitted when absent. |
| `battery_pct` | percent | no | macOS only, omitted without a battery. |

An optional value that the host cannot read is left out. It is never `null`.

### `listeners`

| Key | Type | Notes |
|---|---|---|
| `bind` | string | Address as bound: `0.0.0.0`, `::`, `127.0.0.1`, `::1`, a Tailscale IP. A `*` is sent as `0.0.0.0`. IPv6 has no brackets and no `%interface` suffix. |
| `port` | integer | |
| `process` | string, optional | Process name. Omitted when the agent cannot see it. |

IPv4 and IPv6 sockets on the same port are separate entries. Entries are unique by `bind` and `port`.

### `containers`

Each entry is one object from `docker ps --format '{{json .}}'`, unchanged. Keys are Docker's own, in PascalCase: `ID`, `Names`, `Image`, `State`, `Status`, `Ports`, `Labels`, `Networks`, `CreatedAt`, `RunningFor`, `Command`, `Mounts`, `Size`, `LocalVolumes`. Docker may add or drop keys between versions, so read only the keys you need. Only running containers are listed (no `-a`).

## Response

- `204` or `200`: stored. The agent ignores the body.
- `400`: body is not valid JSON, `host` differs from the path, or a required metric is missing.
- `401`: bad token.
- Any other status makes the agent exit non-zero, and the timer logs it.

## Size

A host with many containers sends a large body. The mini sends about 64 KB with 38 containers. Raise the JSON body limit for this route to 1 MB.

## Liveness

No report for 3 minutes means the host is down. A sleeping Mac sends nothing, so it goes stale as well.
