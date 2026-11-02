# RE:OPS — property workspace

A TypeScript property-record workspace deployed as a Cloudflare Worker with D1 persistence. The map, table, and board use the same records and filters; opening a record uses one shared detail editor.

## Architecture and defaults

- **Frontend:** vanilla TypeScript, Vite, and Leaflet. No framework existed in the original workspace. Property data and preferences are not persisted in browser storage.
- **Backend:** Cloudflare Workers and D1, signed Cloudflare Access identity, server-side address and AI adapters, and a once-per-minute Cron Trigger.
- **Access:** private records by default, owned by a stable authenticated user ID. Stamps are display identifiers, never authentication credentials. Collaboration across owners is not enabled by default.
- **Verification:** geocoding and verification are separate. An address remains a draft until a user selects a server-validated candidate. Missing credentials, ambiguous matches, and verification failures must not be treated as verified.
- **Reminders:** timestamps are stored as UTC instants with an IANA time-zone label. Cron delivers durable in-app notifications without an open tab; the browser polls for delivery. No email/SMS channel is configured.
- **AI:** read-only analysis by default. Manual actions and opted-in automatic rules share only selected fields. Results are not executed as instructions and cannot modify records or invoke tools.
- **Visual reference:** `therealvillar/newwest-calendar` returned 404 during inspection. The interface uses an independent accessible neutral design; screenshots or source files are needed to match that reference.

## Local setup

Requires Node 22.12+ (Node 24 recommended), npm, and a Cloudflare account for deployment.

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:local
npm run build
```

Run these in separate terminals:

```sh
npm run dev:api
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite proxy forwards `/api` to the Worker at port 8787. Development authentication is deliberately loopback-only and uses a fixed development user; never configure `DEV_AUTH` in production. Local records use Wrangler's local D1 database, not fixtures.

```sh
npm run check
npm test
npm run build
```

The tests exercise the Worker against an isolated D1 runtime and frontend state utilities. Build output, local D1 state, secrets, and dependencies are ignored by Git.

## Cloudflare deployment

1. Authenticate Wrangler: `npx wrangler login`.
2. Create D1: `npx wrangler d1 create reops`. Replace the zero `database_id` in `wrangler.jsonc` with the returned ID.
3. Set `APP_ORIGIN` to the exact HTTPS origin where this app will be served.
4. Create a Cloudflare Zero Trust **Access self-hosted application** covering the entire application hostname, with an explicit allow policy. Set `ACCESS_TEAM_DOMAIN` (hostname only, e.g. `team.cloudflareaccess.com`) and `ACCESS_AUD` to that application's audience.
5. Do **not** set `DEV_AUTH` on the deployed Worker. The API must fail closed when production identity configuration is missing.
6. Apply migrations: `npm run db:remote`.
7. Configure optional server-side secrets below; then `npm run deploy`.
8. Check the deployed Access login, create an unverified draft, verify an address if configured, move a card, and schedule a near-term reminder. Check Worker logs and Cron events for delivery. Cron changes can take several minutes to propagate.

Never put API keys in `VITE_*` variables, source files, `wrangler.jsonc`, or committed `.dev.vars`. Back up D1 before schema changes. Configure Cloudflare request-rate limits for the address and AI endpoints according to provider quotas and monitor billing.

## Integrations requiring credentials

### Addresses

Enable the provider APIs required by the Worker adapter and configure a restricted server-side key:

```sh
npx wrangler secret put ADDRESS_API_KEY
npx wrangler secret put ADDRESS_TOKEN_SECRET
```

Use a cryptographically random signing secret of at least 32 bytes for candidate tokens. API-key restrictions must permit the server adapter, not arbitrary browser calls. No coordinates or verification claims supplied by a browser are trusted. Without these secrets users can still save unverified drafts; lookup errors are shown explicitly.

### AI

Configure a trusted HTTPS analysis service using the adapter protocol implemented in the Worker:

```sh
npx wrangler secret put AI_ENDPOINT
npx wrangler secret put AI_API_KEY
```

The endpoint is deployment-controlled, not record-controlled. It must honor the supplied idempotency key to avoid duplicate upstream work on retries. Provider responses are stored and displayed as untrusted text. Opt-in rules authorize analysis only, not record changes or external actions. Without a configured adapter, AI requests fail clearly rather than producing simulated results.

## Scope and operational limits

This repository is an initial implementation, not a claim that external services have been provisioned. Production requires D1, Access, secrets, and deployment configuration. Matching the inaccessible visual reference, shared multi-owner collaboration, additional notification channels, and write-capable AI agents are not included. OpenStreetMap supplies the basemap and has its own attribution, availability, and tile-usage policy; use an appropriate tile service for high traffic.

Layer data is Cloudflare-hosted. Only approved D1 data sources and geographic fields should be exposed, never user-provided SQL or arbitrary URLs. Non-property layer features are reference data, not editable property records.

Reminder delivery is minute-resolution, not a real-time alarm guarantee. Inspect failed jobs and provider limits before retrying. Local loopback identity is for development only; security acceptance in production includes exercising Access with separate users and verifying that one user cannot read or update another's records.
