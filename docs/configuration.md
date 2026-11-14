# Local configuration

Keep installation-specific values in ignored local files. Commit only neutral
examples. Copy `.env.example` to `.env` for backend and web configuration. The
normal API startup loads `.env`; restart the app after changing runtime values.
API credentials belong in the encrypted Settings UI, except bootstrap secrets
already documented in `.env.example`.

## API defaults

| Variable | Default / behavior |
|---|---|
| `HOST` | `127.0.0.1`; set `0.0.0.0` to listen on every network, which also lets the first visitor choose the password |
| `PREVIEW_SITES_DIR` | `~/preview-sites`; filesystem directory for published sites |
| `PREVIEW_DOMAIN` | Unset: Chomp serves sites at `<CHOMP_DOMAIN>/pub/<site>/`. Set it to the hostname where your own web server serves `PREVIEW_SITES_DIR` |
| `CHOMP_DOMAIN` | The address you open Chomp at, with `https://`; used in the links Chomp sends |
| `SITE_GIT_AUTHOR_NAME` | `Chomp`; author name for site commits |
| `SITE_GIT_AUTHOR_EMAIL` | `chomp@example.invalid`; author email for site commits |
| `SITE_GIT_INVITE_COLLABORATOR` | Empty; GitHub login invited as admin to each new site repo |
| `HOMEASSISTANT_LOCATION_ENTITY` | Empty; set to a device tracker entity to enable location context |
| `HOMEASSISTANT_GEOCODED_ENTITY` | Empty; optional sensor containing a readable location name |
| `WORKTREE_CLEANUP_REPOS` | `[]`; explicit opt-in list of repositories whose stale worktrees may be removed |
| `PHONE_CALENDAR_WORK_NAMES` | `calendar`; comma-separated calendar names treated as work calendars |
| `PHONE_CALENDAR_SKIP_NAMES` | Generic holiday calendar names; comma-separated names to exclude |
| `PHONE_CALENDAR_TIMEZONE` | `UTC`; timezone for phone calendar processing |
| `APNS_BUNDLE_ID` | `com.example.chomp`; bundle id of your iOS build, so push notifications reach it |
| `SEC_USER_AGENT` | Empty; SEC enrichment is skipped until configured with your own identifying user agent |

An explicitly empty `PHONE_CALENDAR_WORK_NAMES` or `PHONE_CALENDAR_SKIP_NAMES`
disables that name list.

For Home Assistant location, also configure `HOMEASSISTANT_URL` and
`HOMEASSISTANT_TOKEN` in Settings. Leave the location entity unset to use only
server time. The geocoded entity is optional; coordinates remain available when
it is unset.

Example cleanup configuration:

```dotenv
WORKTREE_CLEANUP_REPOS=[{"path":"/absolute/path/to/repo","remote":"origin"}]
```

Only list repositories whose worktrees this installation should manage. A fresh
installation does not scan or remove worktrees from any repository.

New site repositories are private by default. No GitHub collaborator is invited
unless `SITE_GIT_INVITE_COLLABORATOR` is set or the agent supplies `invite_collaborator`.
An explicitly invited collaborator receives admin permission.

## Embedded canvas origins

`VITE_EMBED_ALLOWED_ORIGINS` is a comma-separated list of exact origins allowed
as iframe sources in canvas content. It defaults to empty. Set only the origins
you need, including scheme and port if present, then rebuild the web app:

```dotenv
VITE_EMBED_ALLOWED_ORIGINS=https://app.example.com,https://tools.example.com
```

This value is public in the built web bundle. Do not put secrets in it. Existing
installations using an embedded canvas must configure their allowed origins
before rebuilding with the new defaults.

`VITE_WEBHOOKS_ORIGIN` is the public address of a webhook tunnel, such as
`https://webhooks.example.com`. The Webhooks page shows receive URLs on it. Empty
shows this server's own address. Like the embed list, it is public and needs a
web rebuild.

## Docker Compose

The production Compose overlay forwards the runtime variables above to the API
container explicitly. `.env` provides Compose substitution values; it is not
copied into the image. Paths such as `PREVIEW_SITES_DIR` and cleanup repository
paths refer to the container filesystem, so mount any directories you need.

Compose passes only `VITE_EMBED_ALLOWED_ORIGINS` to the web build as a public build
argument. Changes to this value require rebuilding the web image. API secrets
are not forwarded to that build.

## iOS build defaults

The sign-in screen already lets each user set the server hostname and TLS mode.
Saved settings take precedence over build defaults. Fresh builds start without a
server hostname.

To prefill a host or set the Apple signing team for your own builds:

```sh
cd packages/ios
cp Config.local.xcconfig.example Config.local.xcconfig
# Edit the hostname and signing team in Config.local.xcconfig.
xcodegen generate
```

`Config.xcconfig` contains neutral defaults and optionally includes the ignored
`Config.local.xcconfig`. Use a hostname only, without a scheme or path. Do not put
credentials in build configuration: these values are included in the app bundle.

## Deployment checkout

The GitHub Actions deploy workflow reads the checkout path from the repository
variable `CHOMP_DEPLOY_DIR`. It has no hardcoded host path. See the
[migration checklist](deploy.md#migration-before-merging-configurable-defaults)
before merging this change into an installation that deploys `main`.
