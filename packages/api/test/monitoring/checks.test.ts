import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

const child = vi.hoisted(() => {
  const exec = vi.fn();
  return { execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }), exec };
});
vi.mock("child_process", () => ({ execFile: child.execFile }));

import net from "net";
import express from "express";
import { checkContainer, checkHttp, checkPing, checkPush, checkTcp, runCheck, viaContainerAddress } from "../../src/monitoring/checks.js";
import { addTarget, clearMonitoring, NOW, serve } from "./helpers.js";

let status = 200;
let site: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  const app = express();
  app.get("/redirect", (_req, res) => { res.redirect(302, "/elsewhere"); });
  app.get("/status", (_req, res) => { res.status(status).send("x"); });
  app.get("/health", (_req, res) => { res.send("ok"); });
  site = await serve(app);
});
afterAll(() => site.close());
beforeEach(() => { status = 200; clearMonitoring(); });

test("http: any answer below 500 is up and a redirect is not followed; 500 and above is down unless expected; a refused connection is down with a reason", async () => {
  for (const code of [200, 401, 404]) {
    status = code;
    expect(await checkHttp(`${site.url}/status`, null)).toMatchObject({ ok: true, statusCode: code });
  }
  expect(await checkHttp(`${site.url}/redirect`, null)).toMatchObject({ ok: true, statusCode: 302 });
  status = 503;
  expect(await checkHttp(`${site.url}/status`, null)).toMatchObject({ ok: false, statusCode: 503, error: "HTTP 503" });
  expect(await checkHttp(`${site.url}/status`, 502)).toMatchObject({ ok: false });
  expect(await checkHttp(`${site.url}/status`, 503)).toMatchObject({ ok: true, statusCode: 503 });
  const result = await checkHttp("http://127.0.0.1:1/", null);
  expect(result.ok).toBe(false);
  expect(result.error).toBeTruthy();
});

test("tcp: up when the port accepts a connection, down when it does not", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  expect(await checkTcp("127.0.0.1", port)).toMatchObject({ ok: true });
  await new Promise((resolve) => server.close(resolve));
  expect(await checkTcp("127.0.0.1", port)).toMatchObject({ ok: false });
});

test("ping: reads the latency from the reply and runs ping without a shell; no reply is down, and a host that looks like an option is refused", async () => {
  child.exec.mockResolvedValue({ stdout: "64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=0.612 ms\n", stderr: "" });
  expect(await checkPing("10.0.0.1")).toEqual({ ok: true, statusCode: null, latencyMs: 1, error: null });
  expect(child.exec).toHaveBeenCalledWith("ping", expect.arrayContaining(["-c", "1", "10.0.0.1"]), expect.anything());
  child.exec.mockRejectedValue(new Error("exit 1"));
  expect(await checkPing("10.0.0.1")).toMatchObject({ ok: false, error: "No ping reply" });
  child.exec.mockClear();
  expect(await checkPing("-f")).toMatchObject({ ok: false, error: "Invalid host" });
  expect(child.exec).not.toHaveBeenCalled();
});

test("push: up until its deadline, down after, and down at once when the job said so", () => {
  const job = addTarget({ key: "backup", kind: "push", pushIntervalSec: 600, lastPushAt: NOW, lastPushOk: true });
  expect(checkPush(job, NOW + 659_000).ok).toBe(true);
  expect(checkPush(job, NOW + 661_000)).toMatchObject({ ok: false, error: "No push in time" });
  expect(checkPush({ ...job, lastPushOk: false, lastPushMsg: "disk full" }, NOW)).toMatchObject({ ok: false, error: "disk full" });
  expect(checkPush({ ...job, lastPushAt: null }, NOW + 661_000)).toMatchObject({ ok: false, error: "Never pushed" });
});

test("runCheck picks the check by kind and reports a target that lacks what it needs", async () => {
  expect(await runCheck({ ...addTarget({ key: "a", kind: "http" }) })).toMatchObject({ ok: false, error: "No URL" });
  expect(await runCheck({ ...addTarget({ key: "b", kind: "tcp" }) })).toMatchObject({ ok: false, error: "No host or port" });
  expect(await runCheck({ ...addTarget({ key: "c", kind: "ping" }) })).toMatchObject({ ok: false, error: "No host" });
  expect(await runCheck(addTarget({ key: "d", kind: "container" }))).toMatchObject({ ok: false, error: "No container" });
  child.execFile.mockImplementationOnce((_c: string, _args: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => cb(null, "running healthy\n", ""));
  expect(await runCheck(addTarget({ key: "e", kind: "container", container: "langfuse-postgres" }))).toMatchObject({ ok: true });
  expect(child.execFile).toHaveBeenCalledWith("docker", ["inspect", "--format", expect.any(String), "langfuse-postgres"], expect.anything(), expect.any(Function));
});

const info = (ip: string | null) => ({ state: "running", health: null, restarts: 0, oomKilled: false, ip });

test("a URL that names the target's container goes to the container's address, keeping port, path and query; otherwise it is left as it is", () => {
  const target = { url: "http://shop-app-app-1:8080/health?x=1", container: "shop-app-app-1", containerInfo: info("172.18.0.9") };
  expect(viaContainerAddress(target)).toBe("http://172.18.0.9:8080/health?x=1");
  expect(viaContainerAddress({ ...target, url: "http://shop-app-app-1/" })).toBe("http://172.18.0.9/");
  // Left as it is when its host is not the container, or the container has no address.
  expect(viaContainerAddress({ ...target, url: "https://apps.example.net/" })).toBeNull();
  expect(viaContainerAddress({ ...target, url: "http://shop-app-app-1/", containerInfo: info(null) })).toBeNull();
  expect(viaContainerAddress({ ...target, url: "http://shop-app-app-1/", containerInfo: null })).toBeNull();
  expect(viaContainerAddress({ ...target, url: "http://shop-app-app-1/", container: null })).toBeNull();
});

test("http: a container-name URL is checked through the container's address; by name alone it cannot be reached", async () => {
  const url = `http://shop-app-app-1:${new URL(site.url).port}/health`;
  expect(await runCheck(addTarget({ key: "by-name", url }))).toMatchObject({ ok: false });
  const linked = addTarget({ key: "app", url, container: "shop-app-app-1", containerInfo: info("127.0.0.1") });
  expect(await runCheck(linked)).toMatchObject({ ok: true, statusCode: 200 });
});

test("tcp: a target on the mini connects to loopback, or to the address it is bound to", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  expect(await runCheck(addTarget({ key: "db", kind: "tcp", host: "mini", port, bindAddress: "0.0.0.0" }))).toMatchObject({ ok: true });
  expect(await runCheck(addTarget({ key: "db2", kind: "tcp", host: "mini", port, bindAddress: "127.0.0.1" }))).toMatchObject({ ok: true });
  expect(await runCheck(addTarget({ key: "db3", kind: "tcp", host: "mini", port, bindAddress: "100.64.0.42" }))).toMatchObject({ ok: false });
  await new Promise((resolve) => server.close(resolve));
});

test("container: up while it runs and is healthy; down when stopped, unhealthy or starting; no Docker is a reason, not a throw", async () => {
  const reply = (stdout: string) => child.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => cb(null, stdout, ""));
  reply("running healthy\n");
  expect(await checkContainer("db")).toMatchObject({ ok: true, error: null });
  reply("running \n");
  expect(await checkContainer("redis")).toMatchObject({ ok: true });
  reply("exited \n");
  expect(await checkContainer("old")).toMatchObject({ ok: false, error: "Container is exited" });
  reply("running unhealthy\n");
  expect(await checkContainer("db")).toMatchObject({ ok: false, error: "Container is unhealthy" });
  reply("running starting\n");
  expect(await checkContainer("db")).toMatchObject({ ok: false, error: "Container is starting" });
  child.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error, out: string, err: string) => void) => cb(Object.assign(new Error("x"), { code: "ENOENT" }), "", ""));
  expect(await checkContainer("db")).toMatchObject({ ok: false, error: "docker is not installed" });
  child.execFile.mockImplementationOnce((_c: string, _a: string[], _o: unknown, cb: (e: Error, out: string, err: string) => void) => cb(new Error("x"), "", "Error: No such object: gone\n"));
  expect(await checkContainer("gone")).toMatchObject({ ok: false, error: "Error: No such object: gone" });
});
