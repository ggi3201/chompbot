import { useState } from "react";
import type { HostToken, HostTiles as Tiles } from "../../hooks/useMonitoring";
import { Button, Input } from "../ui";
import AgentSetup from "./AgentSetup";
import HostTile from "./HostTile";

interface HostTilesProps {
  data: Tiles;
  issueToken: (host: string) => Promise<HostToken>;
}

/** A tile per host, in the Dashboard's grid. "Set up agent" on a host with none makes its token and shows the install steps under the row. */
export default function HostTiles({ data, issueToken }: HostTilesProps) {
  const [token, setToken] = useState<HostToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [os, setOs] = useState<"linux" | "macos">("linux");

  const setUp = async (host: string) => {
    setBusy(true);
    try {
      setToken(await issueToken(host));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make a token");
    } finally {
      setBusy(false);
    }
  };

  // A machine added here has no tile until its first report, so the steps use the name and system typed in.
  const target = data.hosts.find((tile) => tile.host === token?.host) ?? (token && { title: token.host, agent: os });
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.hosts.map((tile) => <HostTile key={tile.host} tile={tile} limits={data.limits} onSetUp={setUp} busy={busy} />)}
      </div>
      {adding ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); void setUp(name.trim().toLowerCase()).then(() => setAdding(false)); }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, such as nas" aria-label="Machine name" className="h-8 w-48" autoFocus />
          <Input as="select" value={os} onChange={(e) => setOs((e.target as HTMLSelectElement).value as "linux" | "macos")} aria-label="System" className="h-8 w-32 !py-0">
            <option value="linux">Linux</option>
            <option value="macos">macOS</option>
          </Input>
          <Button type="submit" size="sm" variant="primary" disabled={busy || !name.trim()}>Make its token</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAdding(true)}>Add a machine</Button>
      )}
      {error && <p className="m-0 text-sm text-error">{error}</p>}
      {token && target && <AgentSetup tile={target} token={token} onDone={() => setToken(null)} />}
    </>
  );
}
