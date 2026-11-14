# Outside probe

A Cloudflare Worker. It checks the home-lab services from outside the house and reports to Chomp. See `CONTRACT.md` for the exact formats.

## Develop

No dependencies are needed. Use the root TypeScript and Node 22.

```bash
pnpm --filter @chomp/outside-probe test
pnpm --filter @chomp/outside-probe typecheck
```

## Deploy

Run these in `packages/outside-probe/`. You need a Cloudflare login (`npx wrangler@3 login`).

1. Create the KV namespace.

   ```bash
   npx wrangler@3 kv namespace create TARGETS
   ```

   Copy the `id` into `wrangler.toml`. The namespace in use today is already there.

2. Set `CHOMP_RESULTS_URL` as a secret: `npx wrangler@3 secret put CHOMP_RESULTS_URL`, with `https://<your webhook host>/api/monitoring/outside`.

3. Put the secrets. Wrangler asks for each value.

   ```bash
   npx wrangler@3 secret put MONITOR_OUTSIDE_SECRET
   npx wrangler@3 secret put TELEGRAM_ALERTS_BOT_TOKEN
   npx wrangler@3 secret put TELEGRAM_ALERTS_CHAT_ID
   ```

   `MONITOR_OUTSIDE_SECRET` must be the same value as the setting in Chomp.

4. Deploy.

   ```bash
   pnpm --filter @chomp/outside-probe deploy
   ```

5. Add the tunnel route in Cloudflare so the Worker can reach Chomp: hostname of your webhook host (e.g. `webhooks.example.com`), path `/api/monitoring/outside`, service `http://localhost:3002`. The route needs no login. The signature is the credential.

6. Set these in Chomp (Settings, encrypted):

   | Setting | Value |
   |---|---|
   | `MONITOR_OUTSIDE_SECRET` | The same value as the Worker secret. Chomp answers 503 without it, and 401 when it differs. |
   | `CLOUDFLARE_KV_NAMESPACE_ID` | The `id` from step 1. |
   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Already used by discovery. The token also needs Workers KV Storage: Edit. |
   | `MONITOR_HOME_HOST` | Optional. A hostname or IP for the port checks. Without it, Chomp uses a DNS-only record that points at the home IP, else the home IP itself. It must not be proxied. |

   After each discovery run (every 5 minutes) Chomp writes the target list to KV key `targets`, but only when it changed. Without the namespace id or the token, Chomp skips the write and `GET /api/monitoring/discovery` shows "Outside probe: not configured". Chomp keeps the hash of the last list it wrote in the `settings` table (`monitor:probe-targets`). If you edit the KV value by hand, delete that row to make Chomp write again.

7. To test the Worker by hand, write a list yourself:

   ```bash
   npx wrangler@3 kv key put --binding TARGETS targets '{"version":1,"urls":[{"key":"test","url":"https://example.com"}],"ports":[],"homeHost":"example.com"}'
   ```

8. Watch the logs with `npx wrangler@3 tail`.

## Notes

- `homeHost` must not be behind the Cloudflare proxy. Workers cannot open raw TCP connections to proxied hosts.
- The free plan allows 50 subrequests per run and 1,000 KV writes a day. The Worker keeps to 48 subrequests and writes KV only when its alarm state changes.
