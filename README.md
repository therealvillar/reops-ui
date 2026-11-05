# RE:OPS — property workspace

A TypeScript property-record workspace deployed as a Cloudflare Worker with D1 persistence. The map, table, and board use the same records and filters; opening a record uses one shared detail editor.

## Architecture and defaults

- **Frontend:** vanilla TypeScript, Vite, and Leaflet. No framework existed in the original workspace. Property data and preferences are not persisted in browser storage. An empty map starts over Philadelphia; populated maps fit their locations.
- **Backend:** Cloudflare Workers and D1, signed Cloudflare Access identity, server-side address and AI adapters, and a once-per-minute Cron Trigger.
- **Access:** private records by default, owned by a stable authenticated user ID. Owners can explicitly grant viewer/editor access to another registered user's exact ID. Stamps are display identifiers, never authentication credentials. Editors preserve the original creator; viewers cannot mutate records.
- **Addresses:** US Census geocoding is free, keyless, and US-only. A single valid match is geocoded and stored with the property on save; multiple matches require explicit selection of a signed candidate. The legacy `verified` status means a geocoded match, not USPS, rooftop, occupancy, or legal address verification. Census coordinates can be interpolated along a street.
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
   Branch Previews use `PREVIEW_WORKER_HOSTNAME` instead: set it to the exact production Worker hostname (without a scheme) so only same-origin requests on `<preview-name>-<worker-hostname>` are accepted. Protect Preview hostnames with Cloudflare Access before serving private records.
4. Create a Cloudflare Zero Trust **Access self-hosted application** covering the entire application hostname, with an explicit allow policy. Set `ACCESS_TEAM_DOMAIN` (hostname only, e.g. `team.cloudflareaccess.com`) and `ACCESS_AUD` to that application's audience.
5. Do **not** set `DEV_AUTH` on the deployed Worker. The API must fail closed when production identity configuration is missing.
6. Apply migrations: `npm run db:remote`.
7. Configure optional server-side secrets below; then `npm run deploy`.
8. Check the deployed Access login, create a property with a full US address and confirm its coordinates in D1, move a card, and schedule a near-term reminder. Check Worker logs and Cron events for delivery and address backfill. Cron changes can take several minutes to propagate.

For a first release on `workers.dev`, obtain the account's existing Workers subdomain from Cloudflare and use the exact `reops-ui.<subdomain>.workers.dev` hostname for both `APP_ORIGIN` and the Access application. Protect only this application, not all Workers on the account. Start with an allow policy for the verified account owner's exact email, not an entire domain or everyone. Workers/D1 deployment permission alone does not grant Access application management permission: an Access API `403 auth.forbidden` requires an authorized administrator to configure Access before deployment. Do not deploy a placeholder with incomplete identity settings or enable development authentication as a substitute.

The initial release target, confirmed by the account's Workers subdomain API, is `https://reops-ui.anthonyrvillar.workers.dev`. Release preparation created only the app's `reops` D1 database (`7a1cc07b-395b-4bf2-8331-ddcd740e183d`) in the existing Cloudflare account and applied all four repository migrations. Remote schema inspection confirmed the migration ledger and application tables, no foreign-key violations, and zero property records. The actual database ID and `APP_ORIGIN` are configured; unrelated databases were not changed.

The first iteration is deployed at **https://reops-ui.anthonyrvillar.workers.dev** behind hostname-scoped Cloudflare Access. The user-authorized management profile resolved the earlier Access permission blocker. The application allows only the verified account owner's exact email; its actual team domain and audience are configured. Anonymous requests to the root, HTML, JavaScript asset, and API redirect to Access login. Preview URLs are disabled so alternate version hostnames cannot serve an unprotected copy. Production `DEV_AUTH` is absent, the existing D1 database is preserved, and no paid upgrade or unrelated Access policy change was made.

Authenticated production flow checks require the allowed user to sign in through Access; an anonymous redirect check alone does not verify record editing or reminder delivery. Selecting among multiple address matches requires a server-side signing secret; single-match geocoding does not. AI requires the optional credentials documented below.

Automated production-mode integration coverage runs the real Worker bundle against isolated D1 with locally generated RSA keys and mock JWKS, without `DEV_AUTH`. It verifies that valid issuer/audience assertions reach the D1 identity API and a file-backed `ASSETS` service serving repository HTML/CSS, while missing, malformed, wrong-issuer, and wrong-audience assertions reject both asset and API requests. This checks Worker authentication and asset-binding delegation, not a real browser login or Cloudflare's internal static-asset router. The deployed version and bindings, remote migration ledger, exact-owner Access policy, and anonymous production redirects were also checked independently.

Never put API keys in `VITE_*` variables, source files, `wrangler.jsonc`, or committed `.dev.vars`. Back up D1 before schema changes. Configure Cloudflare request-rate limits for the address and AI endpoints according to provider quotas and monitor billing.

## Integrations requiring credentials

### Addresses

Property creation and address edits use the server-side US Census Bureau geocoder at `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` with the current public benchmark. Enter a complete US street address, city, state, and ZIP for best results; this is not a partial-address autocomplete provider. A single valid match is saved automatically with coordinates in the property's D1 JSON record. Multiple matches remain unlocated until a signed match is selected. No match or an upstream failure leaves the property unlocated with an explanatory status; blank-address drafts remain possible. No geocoding API key is needed.

```sh
npx wrangler secret put ADDRESS_TOKEN_SECRET
```

Use a cryptographically random signing secret of at least 32 bytes for candidate tokens. No coordinates or verification claims supplied by a browser are trusted. Without the signing secret, single-match addresses can still geocode on save but users cannot select among multiple results. Lookup errors are shown explicitly. Selecting a match preserves the entered address and separately saves the normalized address.

Apply migrations before using address lookup (`npm run db:local` or, after backing up production, `npm run db:remote`). The D1 `property_gps` table caches public geocoding results, while the property row stores its selected coordinates and status. Address lookup checks this cache before calling Census. The minute-scheduled worker backfills up to five older unlocated properties per run, attributing changes to `system:geocoder` and preserving their edit history; ambiguous or unmatched addresses remain unlocated with instructions to refine or select a result. Provider outages are retried on later scheduled runs. Remove the obsolete `ADDRESS_API_KEY` deployment secret if present.

### Nearby public data

The shared property dossier includes an explicit **Load nearby data** action. Select Philadelphia, Montgomery, Bucks, or Delaware County. The authenticated `GET /api/properties/:id/area?county=...` endpoint enforces the same owner/member access as the dossier, and queries only server-approved public services using the saved coordinates. It does not accept arbitrary upstream URLs or SQL. Loading sends the location to those services; results are read-only and do not change the property, its AI opt-in, or map layers.

Queries use a fixed 500-meter radius and return at most 25 records per source, with retrieval time, source attribution, truncation notices, and isolated service errors. Empty results are distinct from unavailable sources. Public data may be stale or incomplete and is not a legal, title, zoning, or flood determination. Sheriff auctions and post-sale distributions are reference links, not scraped auction feeds; verify current details on the source sites. Links omit analytics parameters such as `_ga`.

Philadelphia queries the City CARTO `opa_properties_public`, `rtt_summary`, `permits`, `violations`, `clean_seal`, `business_licenses`, and `demolitions` datasets. Montgomery uses County GIS parcels (FeatureServer layer 6). Bucks parcels (layer 0) and Delaware zoning (layer 0) have adapters but are **disabled by default**: Bucks publishes a no-commercial-use/resale restriction, and Delaware's catalog requests permission with no reuse license provided. Obtain the necessary permission before setting deployment variables `BUCKS_PARCELS_ENABLED="true"` or `DELAWARE_ZONING_ENABLED="true"`. Otherwise these appear as reference links with the reason, not empty successful lookups. ArcGIS queries intersect a 64-segment geodesic approximation of the 500-meter circle; parcel/zoning polygons may intersect the area without their centers lying inside it. County selection is explicit, not inferred from an address or asserted to be a county-boundary check.

Review the published [Bucks parcel terms](https://www.arcgis.com/home/item.html?id=3a4d9c4305874312a2a74da7bd55a22d&sublayer=0), [Delaware zoning licensing page](https://delaware-county-pennsylvania-dcpd.hub.arcgis.com/datasets/delaware-county-zoning/about), and [Montgomery parcel terms](https://www.montcopa.maps.arcgis.com/home/item.html?id=228cad7975554088a350bee4caf3ca45&sublayer=6). Montgomery describes its parcels as a free and open, as-is resource.

Source endpoints were verified against public catalogs and published REST metadata; live requests could not be exercised from the development sandbox because the source hosts did not resolve. Test coverage uses mocked public responses. Verify service availability and applicable reuse terms before production use. The Bucks floodplain viewer remains a reference link; no flood-zone determination is inferred from parcels. The supplied Berks auction link is retained as a supplemental reference outside the four-county proximity coverage.

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
