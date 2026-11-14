import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import FormModal from "../components/FormModal";
import { Button, Input, PageHeader, Switch } from "../components/ui";

interface Plugin {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  enabled: boolean;
  description: string;
}

/** Claude Code's installed plugins. Every switch and button runs Claude Code's own plugin command. */
export default function Plugins() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useEffect(() => {
    void call("list", "/plugins");
  }, []);

  async function call(key: string, path: string, init?: RequestInit) {
    setBusy(key);
    setError(null);
    try {
      const res = await apiFetch(path, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Plugin command failed");
      setPlugins(data);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    if (await call("install", "/plugins", { method: "POST", body: JSON.stringify({ id: newId.trim() }) })) {
      setAdding(false);
      setNewId("");
    }
  }

  return (
    <div className="p-6">
      <PageHeader title="Plugins" action={<Button onClick={() => setAdding(true)}>Install plugin</Button>} />
      <p className="m-0 mb-6 max-w-2xl text-[13px] leading-relaxed text-text-secondary">
        The Claude Code plugins on this machine. Switching one off here switches it off for every Claude Code session, Chomp's chats included.
      </p>
      {error && <p className="m-0 mb-4 text-[13px] text-error">{error}</p>}
      {plugins === null ? (
        <p className="text-[13px] text-text-muted">{busy ? "Asking Claude Code" : "Could not read the plugins"}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-xl border border-border bg-glass p-0">
          {plugins.map((p) => (
            <li key={p.id} className="flex items-center gap-4 px-4 py-3">
              <Switch
                on={p.enabled}
                label={`${p.enabled ? "Disable" : "Enable"} ${p.name}`}
                disabled={busy !== null}
                onChange={(on) => call(p.id, `/plugins/${encodeURIComponent(p.id)}`, { method: "PUT", body: JSON.stringify({ enabled: on }) })}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[14px] text-text-primary">{p.name}</span>
                  <span className="font-mono text-xs text-text-muted">{p.marketplace} · {p.version}</span>
                </div>
                {p.description && <p className="m-0 mt-0.5 truncate text-[13px] text-text-secondary">{p.description}</p>}
              </div>
              {confirmRemove === p.id ? (
                <span className="flex gap-2">
                  <Button variant="danger" size="sm" disabled={busy !== null} onClick={() => { setConfirmRemove(null); void call(p.id, `/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" }); }}>Uninstall</Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                </span>
              ) : (
                <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRemove(p.id)}>{busy === p.id ? "Working" : "Uninstall"}</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormModal title="Install plugin" open={adding} onClose={() => setAdding(false)} onSubmit={install}>
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Plugin, as name@marketplace
          <Input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="code-review@claude-plugins-official" className="font-mono" />
        </label>
        <p className="m-0 text-[13px] text-text-muted">Or ask Chomp in the chat to find and install one for you.</p>
      </FormModal>
    </div>
  );
}
