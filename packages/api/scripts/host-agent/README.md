# Host agent

Small bash scripts that push machine stats to Chomp's monitoring once a minute. The body format is in `CONTRACT.md`.

- `linux.sh` for the Raspberry Pi and other Linux boxes.
- `macos.sh` for the MacBook.

The scripts need only what the OS ships: bash, awk, curl, and `ss` (Linux) or `lsof` (Mac). Docker is optional on Linux.

## Config

Create a file `host-agent.env` next to the script (git ignores it). Env vars with the same names win over the file.

```
CHOMP_URL=https://chomp.example.com
HOST=rpi
TOKEN=<the token for this host>
```

- `HOST` is `rpi` for the Pi and `macbook` for the Mac. Lowercase letters, digits and `-` only.
- `TOKEN` comes from "Set up agent" on the host's tile on the Monitoring page. It makes a new token, stores it in Chomp as `MONITOR_HOST_TOKEN_RPI` or `MONITOR_HOST_TOKEN_MACBOOK`, and shows it once. Making a new one replaces the old one.
- No quotes needed. No spaces around `=`.
- Set `CHOMP_URL` to a Chomp address reachable from the reporting host. Prefer HTTPS. If you use HTTP on a trusted local network, the monitoring token crosses that network without transport encryption.

The script never prints the token. It reaches curl through a pipe, so it is not in `ps`.

## Try it

`--dry-run` prints the JSON and sends nothing. It needs no config.

```
./linux.sh --dry-run
./macos.sh --dry-run
```

From your laptop, without installing anything on the Pi:

```
ssh rpi 'bash -s -- --dry-run' < linux.sh
```

## Raspberry Pi (systemd)

The service runs as root, so `ss` shows every process name and `docker ps` works. Keep the files root-owned.

```
scp linux.sh host-agent.env chomp-host-agent.service chomp-host-agent.timer rpi:/tmp/
ssh rpi
sudo install -d -m 755 /opt/chomp-host-agent
sudo install -m 755 /tmp/linux.sh /opt/chomp-host-agent/linux.sh
sudo install -m 600 /tmp/host-agent.env /opt/chomp-host-agent/host-agent.env
sudo install -m 644 /tmp/chomp-host-agent.service /tmp/chomp-host-agent.timer /etc/systemd/system/
rm /tmp/host-agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now chomp-host-agent.timer
```

Check it:

```
sudo systemctl start chomp-host-agent.service
journalctl -u chomp-host-agent.service -n 20 --no-pager
systemctl list-timers chomp-host-agent.timer
```

A run that works prints nothing. A failed run shows the curl error and the exit code.

## MacBook (launchd)

```
mkdir -p ~/.chomp-host-agent
cp macos.sh host-agent.env ~/.chomp-host-agent/
chmod 600 ~/.chomp-host-agent/host-agent.env
sed "s|__HOME__|$HOME|g" app.chomp.host-agent.plist > ~/Library/LaunchAgents/app.chomp.host-agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.chomp.host-agent.plist
```

Check it:

```
launchctl kickstart -k gui/$(id -u)/app.chomp.host-agent
tail ~/Library/Logs/chomp-host-agent.log
```

The log stays empty while all is well. launchd does not run the job while the Mac sleeps, so Chomp sees no reports then.

Stop it:

```
launchctl bootout gui/$(id -u)/app.chomp.host-agent
```

## Update

Copy the new script over the old one. The next tick uses it.
