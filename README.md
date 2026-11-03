# RE:OPS — property workspace

A TypeScript property-record workspace deployed as a Cloudflare Worker with D1 persistence. The map, table, and board use the same records and filters; opening a record uses one shared detail editor.

## Architecture and defaults

- **Frontend:** vanilla TypeScript, Vite, and Leaflet. No framework existed in the original workspace. Property data and preferences are not persisted in browser storage. An empty map starts over New Westminster; populated maps fit their locations.
- **Backend:** Cloudflare Workers and D1, signed Cloudflare Access identity, server-side address and AI adapters, and a once-per-minute Cron Trigger.
- **Access:** private records by default, owned by a stable authenticated user ID. Owners can explicitly grant viewer/editor access to another registered user's exact ID. Stamps are display identifiers, never authentication credentials. Editors preserve the original creator; viewers cannot mutate records.
- **Verification:** geocoding and verification are separate. An address remains a draft until a user selects a server-validated candidate. Missing credentials, ambiguous matches, and verification failures must not be treated as verified.
- **Reminders:** timestamps are stored as UTC instants with an IANA time-zone label. Enter an explicit UTC offset matching that zone to disambiguate daylight-saving transitions. Cron delivers durable in-app notifications without an open tab; the browser polls for delivery. Editing a delivered reminder does not reschedule it—create a new reminder for another alarm. No email/SMS channel is configured.
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
2. Use the existing release D1 database configured in `wrangler.jsonc`. For a separate account, create a new database with `npx wrangler d1 create reops` and replace `database_id` with its returned ID; do not apply migrations to an unrelated database.
3. Set `APP_ORIGIN` to the exact HTTPS origin where this app will be served.
4. Create a Cloudflare Zero Trust **Access self-hosted application** covering the entire application hostname, with an explicit allow policy. Set `ACCESS_TEAM_DOMAIN` (hostname only, e.g. `team.cloudflareaccess.com`) and `ACCESS_AUD` to that application's audience.
5. Do **not** set `DEV_AUTH` on the deployed Worker. The API must fail closed when production identity configuration is missing.
6. Apply migrations: `npm run db:remote`.
7. Configure optional server-side secrets below; then `npm run deploy`.
8. Check the deployed Access login, create an unverified draft, verify an address if configured, move a card, and schedule a near-term reminder. Check Worker logs and Cron events for delivery. Cron changes can take several minutes to propagate.

For a first release on `workers.dev`, obtain the account's existing Workers subdomain from Cloudflare and use the exact `reops-ui.<subdomain>.workers.dev` hostname for both `APP_ORIGIN` and the Access application. Protect only this application, not all Workers on the account. Start with an allow policy for the verified account owner's exact email, not an entire domain or everyone. Workers/D1 deployment permission alone does not grant Access application management permission: an Access API `403 auth.forbidden` requires an authorized administrator to configure Access before deployment. Do not deploy a placeholder with incomplete identity settings or enable development authentication as a substitute.

The initial release target, confirmed by the account's Workers subdomain API, is `https://reops-ui.anthonyrvillar.workers.dev`. Release preparation created only the app's `reops` D1 database (`7a1cc07b-395b-4bf2-8331-ddcd740e183d`) in the existing Cloudflare account and applied all four repository migrations. Remote schema inspection confirmed the migration ledger and application tables, no foreign-key violations, and zero property records. The actual database ID and `APP_ORIGIN` are configured; unrelated databases were not changed.

The first iteration is deployed at **https://reops-ui.anthonyrvillar.workers.dev** behind hostname-scoped Cloudflare Access. The user-authorized management profile resolved the earlier Access permission blocker. The application allows only the verified account owner's exact email; its actual team domain and audience are configured. Anonymous requests to the root, HTML, JavaScript asset, and API redirect to Access login. Preview URLs are disabled so alternate version hostnames cannot serve an unprotected copy. Production `DEV_AUTH` is absent, the existing D1 database is preserved, and no paid upgrade or unrelated Access policy change was made.

Authenticated production flow checks require the allowed user to sign in through Access; an anonymous redirect check alone does not verify record editing or reminder delivery. Address verification and AI remain optional server-side integrations requiring the credentials documented below.

Automated production-mode integration coverage runs the real Worker bundle against isolated D1 with locally generated RSA keys and mock JWKS, without `DEV_AUTH`. It verifies that valid issuer/audience assertions reach the D1 identity API and a file-backed `ASSETS` service serving repository HTML/CSS, while missing, malformed, wrong-issuer, and wrong-audience assertions reject both asset and API requests. This checks Worker authentication and asset-binding delegation, not a real browser login or Cloudflare's internal static-asset router. The deployed version and bindings, remote migration ledger, exact-owner Access policy, and anonymous production redirects were also checked independently.

Never put API keys in `VITE_*` variables, source files, `wrangler.jsonc`, or committed `.dev.vars`. Back up D1 before schema changes. Configure Cloudflare request-rate limits for the address and AI endpoints according to provider quotas and monitor billing.

## Integrations requiring credentials

### Addresses

Enable **Google Places API (New)** for autocomplete and **Google Address Validation API** for verification, then configure a restricted server-side key. Exact premise-level validation is required; a geocoded suggestion alone is never verified. Provider coverage varies by country.

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

The endpoint is deployment-controlled, not record-controlled. It must honor the supplied idempotency key to avoid duplicate upstream work on retries. It receives a JSON analysis request and must return a JSON string in `result` or `output`, or OpenAI-style message content. Provider responses are stored and displayed as untrusted text. Opt-in rules authorize analysis only, not record changes or external actions. Set defaults **before creation** to analyze new records; per-record rules govern subsequent field and reminder events. Without a configured adapter, AI requests fail clearly rather than producing simulated results.

The generic adapter uses bearer authentication and an `Idempotency-Key` header, with `{ "instruction": "...analysis-only...", "fields": ["name"], "record": { "name": "Selected record name" }, "tools": [] }`. A minimal response is `{ "result": "Plain-text analysis" }`. This is a provider-independent service protocol, **not** a drop-in request to a raw OpenAI/Anthropic chat endpoint; deploy a trusted adapter that translates it into your provider's API. Credentials and that provider-specific service are not provisioned by this repository.

## Scope and operational limits

This repository is an initial implementation, not a claim that external services have been provisioned. Production requires D1, Access, secrets, and deployment configuration. Matching the inaccessible visual reference, team-wide tenancy/role administration, additional notification channels, and write-capable AI agents are not included. Sharing is an explicit per-record grant, not a global shared workspace. OpenStreetMap supplies the basemap and has its own attribution, availability, and tile-usage policy; use an appropriate tile service for high traffic.

Layer data is Cloudflare-hosted. The initial approved reference source is D1's `layer_points` table, using `latitude`, `longitude`, and `label`, with `category` and `status` as filterable attributes. The layer dialog accepts an optional JSON import of up to 200 locations. For later bulk imports, use trusted D1 administration with the layer ID and owner ID. The owner ID is a stable Access identity, not an email or stamp. Multiple layers have independent colors and visibility. Adding other table shapes requires a reviewed server-side source adapter; arbitrary SQL and URLs are intentionally disallowed. Non-property layer features are reference data, not editable property records.

Reminder delivery is minute-resolution, not a real-time alarm guarantee. Inspect failed jobs and provider limits before retrying. Local loopback identity is for development only; security acceptance in production includes exercising Access with separate users and verifying that one user cannot read or update another's records.
