import type { HostTile, HostToken } from "../../hooks/useMonitoring";
import PanelTitle from "../dashboard/PanelTitle";
import { Button, GlassCard } from "../ui";

// The steps of packages/api/scripts/host-agent/README.md, with this host's name filled in.
const INSTALL = {
  linux: (host: string) => `# On your laptop, in packages/api/scripts/host-agent, with host-agent.env saved there:
scp linux.sh host-agent.env chomp-host-agent.service chomp-host-agent.timer ${host}:/tmp/
ssh ${host}
sudo install -d -m 755 /opt/chomp-host-agent
sudo install -m 755 /tmp/linux.sh /opt/chomp-host-agent/linux.sh
sudo install -m 600 /tmp/host-agent.env /opt/chomp-host-agent/host-agent.env
sudo install -m 644 /tmp/chomp-host-agent.service /tmp/chomp-host-agent.timer /etc/systemd/system/
rm /tmp/host-agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now chomp-host-agent.timer`,
  macos: () => `# On the Mac, in packages/api/scripts/host-agent, with host-agent.env saved there:
mkdir -p ~/.chomp-host-agent
cp macos.sh host-agent.env ~/.chomp-host-agent/
chmod 600 ~/.chomp-host-agent/host-agent.env
sed "s|__HOME__|$HOME|g" app.chomp.host-agent.plist > ~/Library/LaunchAgents/app.chomp.host-agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.chomp.host-agent.plist`,
} as const;

const Block = ({ children }: { children: string }) => (
  <pre className="m-0 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-text-secondary select-all">{children}</pre>
);

/** The install steps for one host, with its new token. The token is not stored in readable form, so this is the only time it shows. */
export default function AgentSetup({ tile, token, onDone }: { tile: Pick<HostTile, "title" | "agent">; token: HostToken; onDone: () => void }) {
  const env = `CHOMP_URL=${window.location.origin}\nHOST=${token.host}\nTOKEN=${token.token}`;
  return (
    <GlassCard className="flex flex-col gap-3 p-6">
      <PanelTitle title={`Set up the agent on ${tile.title}`} meta={<Button variant="ghost" size="sm" onClick={onDone}>Done</Button>} />
      <p className="m-0 text-[13px] text-text-secondary">
        Save this as <span className="font-mono">host-agent.env</span> next to the script. Chomp keeps the token only encrypted, so it is not shown again.
        Make sure CHOMP_URL is an address {tile.title} can reach, such as this machine's tailnet name.
      </p>
      <Block>{env}</Block>
      <Block>{INSTALL[tile.agent ?? "linux"](token.host)}</Block>
      <p className="m-0 font-mono text-xs text-text-muted">The tile fills in within a minute of the first run. More in packages/api/scripts/host-agent/README.md.</p>
    </GlassCard>
  );
}
