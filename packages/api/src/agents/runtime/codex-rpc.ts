import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";

type Params = Record<string, unknown>;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Params;
}

/**
 * A `codex app-server` child speaking its JSON-RPC dialect over stdio: one JSON
 * object per line, no `jsonrpc` field. Requests from us get an `id`;
 * notifications have no `id`; requests from the server (approvals) have both
 * `id` and `method` and must be answered with `respond`.
 */
export class CodexRpc {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail = "";
  private exitError: Error | null = null;

  onNotification: (method: string, params: Params) => void = () => {};
  onServerRequest: (request: CodexServerRequest) => void = () => {};
  onExit: (err: Error) => void = () => {};

  constructor(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn("codex", ["app-server", ...args], { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

    createInterface({ input: this.child.stdout! }).on("line", (line) => this.receive(line));
    this.child.stderr!.on("data", (data: Buffer) => {
      this.stderrTail = (this.stderrTail + data.toString()).slice(-4000);
    });
    this.child.on("error", (err) => this.exit(err));
    this.child.on("exit", (code, signal) => {
      const stderr = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
      this.exit(new Error(`codex app-server exited (${signal ?? code})${stderr ? `: ${stderr}` : ""}`));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  request<T>(method: string, params: Params = {}): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Params) {
    this.write(params ? { method, params } : { method });
  }

  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }

  close() {
    this.child.stdin?.end();
    this.child.kill("SIGTERM");
  }

  private write(message: object) {
    if (this.exitError || !this.child.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    let message: { id?: number | string; method?: string; params?: Params; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method) {
      this.onServerRequest({ id: message.id, method: message.method, params: message.params ?? {} });
    } else if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
    } else if (message.method) {
      this.onNotification(message.method, message.params ?? {});
    }
  }

  private exit(err: Error) {
    if (this.exitError) return;
    this.exitError = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    this.onExit(err);
  }
}
