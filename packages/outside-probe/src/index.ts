import { connect } from "cloudflare:sockets";
import { runProbe } from "./run.ts";
import type { Env } from "./types.ts";

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runProbe(
      env,
      {
        kv: env.TARGETS,
        // Wrapped on purpose: the global fetch throws "Illegal invocation" when called as a method of another object.
        fetch: (url, init) => fetch(url, init),
        connect,
        now: Date.now,
      },
      controller.scheduledTime,
    );
  },
};
