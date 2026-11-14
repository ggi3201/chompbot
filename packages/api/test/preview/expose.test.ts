import { expect, test, vi } from "vitest";

const calls: string[][] = [];
vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void) => {
    calls.push([cmd, ...args]);
    if (cmd === "tailscale" && args[0] === "serve") return cb(new Error("access denied: not the operator"));
    const stdout = args[0] === "status" ? JSON.stringify({ Self: { DNSName: "box.example.ts.net." } }) : "";
    cb(null, { stdout, stderr: "" });
  },
}));

const { exposeOnTailnet } = await import("../../src/preview/expose.js");

test("refuses ports it cannot map onto the tailnet, and ports that are not a dev server", async () => {
  for (const url of ["http://localhost:80/", "http://localhost:1000/"]) {
    await expect(exposeOnTailnet(url), url).rejects.toThrow(/cannot be mapped onto the tailnet/);
  }
  for (const port of [9222, 6080, 3002]) {
    await expect(exposeOnTailnet(`http://localhost:${port}/`), String(port)).rejects.toThrow(/is not a dev server/);
  }
});

test("leaves a page that is not on this host as it is", async () => {
  expect(await exposeOnTailnet("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
});

test("falls back to sudo when the service user is not Tailscale's operator", async () => {
  expect(await exposeOnTailnet("http://localhost:5173/app?x=1")).toBe("https://box.example.ts.net:45173/app?x=1");
  expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["tailscale serve --bg", "sudo -n tailscale", "tailscale status --json"]);
});
