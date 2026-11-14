import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { createServer, type Server } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { SERVER_IDLE_MS, isListening, listServers, readLaunchConfigs, serverLogs, startServer, stopServer, stopUnshownServers } from "../../src/preview/servers.js";

// A dev server in one line: answers on PORT and says so.
const HELLO = "require('http').createServer((q, s) => s.end('hi')).listen(process.env.PORT, () => console.log('ready on ' + process.env.PORT))";

function project(configurations: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "chomp-preview-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "launch.json"), JSON.stringify({ version: "0.0.1", configurations }));
  return dir;
}

function takenPort(): Promise<{ port: number; server: Server }> {
  return new Promise((done) => {
    const server = createServer().listen(0, () => done({ port: (server.address() as { port: number }).port, server }));
  });
}

const started: { dir: string; name: string }[] = [];
afterEach(async () => {
  for (const { dir, name } of started.splice(0)) await stopServer(dir, name).catch(() => {});
});

describe("readLaunchConfigs", () => {
  test("reads Claude Code's format; a project without the file has no configurations", () => {
    const dir = project([{ name: "web", runtimeExecutable: "pnpm", runtimeArgs: ["dev"], port: 5173 }]);
    expect(readLaunchConfigs(dir)).toEqual([{ name: "web", runtimeExecutable: "pnpm", runtimeArgs: ["dev"], port: 5173, url: undefined, cwd: undefined, env: {}, autoPort: false }]);
    expect(readLaunchConfigs(mkdtempSync(join(tmpdir(), "chomp-preview-")))).toEqual([]);
  });

  test("says what is wrong with a bad entry", () => {
    expect(() => readLaunchConfigs(project([{ name: "web", runtimeExecutable: "pnpm" }]))).toThrow(/configurations\[0\] needs a "port"/);
  });
});

describe("dev servers", () => {
  test("starts a configuration, waits for its port, keeps its output, and stops it", async () => {
    const { port, server } = await takenPort();
    server.close();
    const dir = project([{ name: "hello", runtimeExecutable: process.execPath, runtimeArgs: ["-e", HELLO], port }]);
    started.push({ dir, name: "hello" });

    const running = await startServer(dir, "hello");
    expect(running).toMatchObject({ name: "hello", port, status: "running", url: `http://localhost:${port}/` });
    expect(serverLogs(dir, "hello").map((l) => l.text)).toContain(`ready on ${port}`);
    expect(await startServer(dir, "hello")).toMatchObject({ status: "running" });

    await stopServer(dir, "hello");
    expect(listServers(dir)[0].status).toBe("exited");
    expect(await isListening(port)).toBe(false);
  });

  test("refuses a port something else holds, unless autoPort", async () => {
    const { port, server } = await takenPort();
    const dir = project([
      { name: "fixed", runtimeExecutable: process.execPath, runtimeArgs: ["-e", HELLO], port },
      { name: "auto", runtimeExecutable: process.execPath, runtimeArgs: ["-e", HELLO], port, autoPort: true },
    ]);
    started.push({ dir, name: "auto" });
    try {
      await expect(startServer(dir, "fixed")).rejects.toThrow(`Port ${port} is already in use`);
      const auto = await startServer(dir, "auto");
      expect(auto.port).not.toBe(port);
      expect(auto.status).toBe("running");
    } finally {
      server.close();
    }
  });

  test("stops a server no page has shown for a while, and says why in its output", async () => {
    const { port, server } = await takenPort();
    server.close();
    const dir = project([{ name: "idle", runtimeExecutable: process.execPath, runtimeArgs: ["-e", HELLO], port }]);
    started.push({ dir, name: "idle" });
    await startServer(dir, "idle");

    stopUnshownServers(new Set([port]), Date.now() + SERVER_IDLE_MS * 2);
    expect(listServers(dir)[0].status).toBe("running");

    stopUnshownServers(new Set(), Date.now() + SERVER_IDLE_MS * 4);
    await expect.poll(() => listServers(dir)[0].status).toBe("exited");
    expect(serverLogs(dir, "idle").at(-1)?.text).toMatch(/Chomp stopped this server/);
  });

  test("reports a server that dies before its port opens, with its output", async () => {
    const dir = project([{ name: "broken", runtimeExecutable: process.execPath, runtimeArgs: ["-e", "console.error('no config'); process.exit(3)"], port: 1 }]);
    await expect(startServer(dir, "broken")).rejects.toThrow(/exited with code 3[\s\S]*no config/);
  });
});
