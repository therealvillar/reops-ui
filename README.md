# RE:OPS — property workspace

A TypeScript property-record workspace deployed as a Cloudflare Worker with D1 persistence. The map, table, and board use the same records and filters; opening a record uses one shared detail editor.

## Architecture and defaults

- **Frontend:** vanilla TypeScript, Vite, and Leaflet. No framework existed in the original workspace. Property data and preferences are not persisted in browser storage. One primary map occupies about 70vh on desktop; an empty map starts over Philadelphia, populated maps fit their locations, and switching views preserves the session viewport. A MapTiler account and browser key are required for live basemap tiles; markers and Table/Board remain available without one.
- **Backend:** Cloudflare Workers and D1, signed Cloudflare Access identity, server-side address and AI adapters, and a once-per-minute Cron Trigger.
- **Access:** private records by default, owned by a stable authenticated user ID. Owners can explicitly grant viewer/editor access to another registered user's exact ID. Stamps are display identifiers, never authentication credentials. Editors preserve the original creator; viewers cannot mutate records.
- **Addresses:** The UUID remains the stable property identity; the geocoded address (or entered address, then abbreviated UUID) is its visible label. Historical `name` values remain in property JSON and old audit snapshots but are not required for new properties. US Census geocoding is free, keyless, and US-only. Standard creation requires one valid match or explicit selection of a signed candidate; an unlocated draft requires an explicit checkbox. The legacy `verified` status means a geocoded match, not USPS, rooftop, occupancy, or legal address verification. Census coordinates can be interpolated along a street.
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
6. Before applying the new additive `0007_property_enrichment.sql` migration to the existing database, export and verify a private D1 backup and rehearse the upgrade against an isolated D1 database. Record existing property counts/IDs and `PRAGMA foreign_key_check` before and after. See [migration and release checks](#migration-and-release-checks).
7. After explicit release authorization and a successful rehearsal, apply migrations with `npm run db:remote`. Configure the tile key below before expecting live tiles. Then build, validate and deploy with `npm run deploy` only after a separate production deployment instruction.
8. Check the deployed Access login, create a property with a full US address and confirm its coordinates in D1, move a card, and schedule a near-term reminder. Check Worker logs and Cron events for delivery and address backfill. Cron changes can take several minutes to propagate.

For a first release on `workers.dev`, obtain the account's existing Workers subdomain from Cloudflare and use the exact `reops-ui.<subdomain>.workers.dev` hostname for both `APP_ORIGIN` and the Access application. Protect only this application, not all Workers on the account. Start with an allow policy for the verified account owner's exact email, not an entire domain or everyone. Workers/D1 deployment permission alone does not grant Access application management permission: an Access API `403 auth.forbidden` requires an authorized administrator to configure Access before deployment. Do not deploy a placeholder with incomplete identity settings or enable development authentication as a substitute.

The initial release target, confirmed by the account's Workers subdomain API, is `https://reops-ui.anthonyrvillar.workers.dev`. The historical first release had an empty D1 database; it has since acquired user-created records. Its current rows and migration ledger were **not** changed or rechecked during this expansion. Do not treat the original empty-database inspection as a current production-data count.

The first iteration is deployed at **https://reops-ui.anthonyrvillar.workers.dev** behind hostname-scoped Cloudflare Access. The user-authorized management profile resolved the earlier Access permission blocker. The application allows only the verified account owner's exact email; its actual team domain and audience are configured. Anonymous requests to the root, HTML, JavaScript asset, and API redirect to Access login. Preview URLs are disabled so alternate version hostnames cannot serve an unprotected copy. Production `DEV_AUTH` is absent, the existing D1 database is preserved, and no paid upgrade or unrelated Access policy change was made.

Authenticated production flow checks require the allowed user to sign in through Access; an anonymous redirect check alone does not verify record editing or reminder delivery. Selecting among multiple address matches requires a server-side signing secret; single-match geocoding does not. AI requires the optional credentials documented below.

Automated production-mode integration coverage runs the real Worker bundle against isolated D1 with locally generated RSA keys and mock JWKS, without `DEV_AUTH`. It verifies that valid issuer/audience assertions reach the D1 identity API and a file-backed `ASSETS` service serving repository HTML/CSS, while missing, malformed, wrong-issuer, and wrong-audience assertions reject both asset and API requests. This checks Worker authentication and asset-binding delegation, not a real browser login or Cloudflare's internal static-asset router. The deployed version and bindings, remote migration ledger, exact-owner Access policy, and anonymous production redirects were also checked independently.

Never put API keys in `VITE_*` variables, source files, `wrangler.jsonc`, or committed `.dev.vars`. Back up D1 before schema changes. Configure Cloudflare request-rate limits for the address and AI endpoints according to provider quotas and monitor billing.

## Integrations requiring credentials

### Addresses

Property creation and address edits use the server-side US Census Bureau geocoder at `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress` with the current public benchmark. Enter a complete US street address, city, state, and ZIP for best results; this is not a partial-address autocomplete provider. A single valid match is saved automatically with coordinates in the property's D1 JSON record. For standard creation, multiple/no matches require a selected candidate or an explicit unlocated-draft choice; an upstream outage fails the standard create without saving a false location. Blank-address drafts are still possible when explicitly selected. Editing a located address will not silently discard its coordinates on an ambiguous or unavailable new lookup. No geocoding API key is needed.

```sh
npx wrangler secret put ADDRESS_TOKEN_SECRET
```

Use a cryptographically random signing secret of at least 32 bytes for candidate tokens. No coordinates or verification claims supplied by a browser are trusted. Without the signing secret, single-match addresses can still geocode on save but users cannot select among multiple results. Lookup errors are shown explicitly. Selecting a match preserves the entered address and separately saves the normalized address.

Apply migrations before using address lookup (`npm run db:local` or, after backing up production, `npm run db:remote`). The D1 `property_gps` table caches public geocoding results, while the property row stores its selected coordinates and status. Address lookup checks this cache before calling Census. The minute-scheduled worker backfills up to five older unlocated properties per run, attributing changes to `system:geocoder` and preserving their edit history; ambiguous or unmatched addresses remain unlocated with instructions to refine or select a result. Provider outages are retried on later scheduled runs. Remove the obsolete `ADDRESS_API_KEY` deployment secret if present.

The geocoder stores house/street/unit/city/state/ZIP components only when Census supplies them; an interpolated range does not become an invented house number. A create request's `idempotencyKey` prevents repeated submissions from creating additional records. An exact entered or normalized address already accessible to the user produces a conflict unless they explicitly opt in to a distinct duplicate; records are never merged by address. When the property is eligible for Philadelphia enrichment, its job is created in the same D1 batch as its row.

### Licensed basemap

The application no longer requests the public OpenStreetMap tile server. It uses [MapTiler raster XYZ tiles with Leaflet](https://docs.maptiler.com/leaflet/) and retains MapTiler and OpenStreetMap attribution. A MapTiler account and an applicable **commercial/production** plan (subject to its current usage terms, quotas and billing) must be obtained separately. Configure a dedicated browser-use key, restricted to the precise production hostname (and any explicitly Access-protected Preview hostname), with MapTiler's domain restrictions:

```sh
npx wrangler secret put MAPTILER_BROWSER_KEY
```

The key is never embedded in Vite source or `VITE_*` variables, but **is returned to an authenticated browser by `GET /api/map/config` and appears in direct tile URLs**: it is a browser key, not a server-only secret. Do not put an unrestricted server credential in this binding. An origin-only cross-site `Referer` supports the provider's domain restrictions without sending the property path or query. There is no tile proxy or CDN license bypass. The default template is `https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png` (512px tiles, Leaflet zoom offset -1). Deployment-controlled `MAP_TILE_URL` may select another MapTiler raster XYZ style on that host; `MAP_TILE_MAX_ZOOM` (1–20) and `MAP_TILE_ATTRIBUTION` (additional escaped text, not a replacement for required credits) are optional. CSP permits the provider's image host only with a configured key. Tile-load errors surface in the map without retries; no live tile rendering can be claimed before a licensed key is configured and checked in an authenticated browser. Monitor tile volume and quota.

### Exact-property public-data enrichment

The existing **Load nearby data** action is unchanged: proximity is context, never a subject-property match. New D1 tables store verified property identifiers, per-source jobs, versioned allowlisted source observations and typed source attributes **separately** from user-maintained `properties.data`. Jobs have bounded leases, up to three attempts with backoff/jitter, and explicit `complete`, `manual_review`, `unavailable` and `failed` states. Cron processes at most two jobs per minute and can schedule up to two eligible 30-day refreshes per run; a job marked unavailable while the source gate is off is retried when that gate is approved and enabled. A current-address `manual_review` pauses automatic refresh until a newer job supersedes it; historical reviews for a previous address do not block the new address. Geocoding outages do not block source jobs. Dossier controls request a refresh and reload status; source updates never edit the property, its version, notes or manually entered attributes.

The first implemented exact adapter is Philadelphia's `opa_properties_public` via the City CARTO SQL endpoint. It looks up a previously verified OPA `parcel_number` for the *same* geocoded address, or queries an exact street and 5-digit ZIP; it validates returned street, ZIP and unit and requires **exactly one** matching parcel. Ambiguous, mismatched and unlicensed responses persist only as job statuses, never as asserted property facts. The adapter requests a small allowlist of physical/assessment fields, omitting public owner names and mailing details, and stores each accepted source version with its fetch time, match method, confidence, hash and provenance. Old matches are hidden on address changes; historic observations remain for auditing. There is **no** automatic matching by distance or artificial valuation/score/heatmap.

**Persistent OPA ingestion defaults to disabled.** The City publishes custom terms and the CARTO host did not resolve from this workspace, so the live field schema and intended storage permission could not be verified here. Before setting `PHILADELPHIA_OPA_ENABLED="true"` as an operator-controlled Worker variable, confirm the applicable dataset reuse/storage terms, query the live CARTO `opa_properties_public` metadata, verify its `parcel_number`, `location`, `zip_code` and selected assessment columns, and perform a representative read-only lookup in a staging environment. If any assumption fails, keep it disabled and update the reviewed adapter. Other Philadelphia datasets and county parcels/zoning remain **nearby-only or reference-only** until their source-specific exact joins, licensing and schemas are verified; Bucks/Delaware ingestion remains disallowed by default. These limitations are shown in the dossier, not reported as successful enrichment.

### Migration and release checks

Do not run the migration on a Preview: the configured Preview D1 binding refers to the same production database. Use an isolated local database or separate test binding for the upgrade rehearsal. `npm test` builds a disposable D1 database, verifies upgrading legacy rows through `0007`, foreign-key integrity, exact matching, ownership and idempotent retry behavior. That is not a substitute for checking the production database backup and live provider.

1. With authorized Cloudflare access, record the remote migration ledger, schema, property count and representative IDs **read-only** (`npx wrangler d1 execute reops --remote --command "SELECT COUNT(*) FROM properties"`). Store the results privately; never print user data in PR logs.
2. Export a supported D1 backup to a private, non-repository path (`npx wrangler d1 export reops --remote --output=/secure/path/reops-before-0007.sql`); check that the export completes, is nonempty and contains the existing tables and records. Restrict its file permissions and test restoring it only into an isolated D1 instance.
3. Run `npm run check`, `npm test`, `npm run build`, rehearse migrations against a copy of the pre-`0007` schema/data, and confirm prior IDs/counts and `PRAGMA foreign_key_check` are unchanged. Verify Access authorization, saved hidden-layer preference, new default map layer, marker/dossier interaction and the MapTiler network responses with a licensed key.
4. Only with explicit production deployment approval: back up again, apply `0007` once using `npm run db:remote`, inspect migration ledger and row counts/foreign keys, deploy, and validate tiles and source jobs under Access. Never re-run old migrations or overwrite the D1 database. If a rehearsal or post-deploy check fails, stop and investigate rather than restoring over user data blindly.

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

The generic adapter uses bearer authentication and an `Idempotency-Key` header, with `{ "instruction": "...analysis-only...", "fields": ["enteredAddress"], "record": { "enteredAddress": "Selected entered address" }, "tools": [] }`. A minimal response is `{ "result": "Plain-text analysis" }`. Existing opted-in legacy `name` rules remain supported and send the address if a new property has no historical name. This is a provider-independent service protocol, **not** a drop-in request to a raw OpenAI/Anthropic chat endpoint; deploy a trusted adapter that translates it into your provider's API. Credentials and that provider-specific service are not provisioned by this repository.

## Scope and operational limits

This repository is an initial implementation, not a claim that external services have been provisioned. Production requires D1, Access, a licensed MapTiler key and deployment configuration. Matching the inaccessible visual reference, team-wide tenancy/role administration, additional notification channels, write-capable AI agents, underwriting/valuation and real deal scoring are not included. Sharing is an explicit per-record grant, not a global shared workspace. OpenStreetMap contributes underlying map data with required attribution; MapTiler supplies the licensed basemap tiles.

Layer data is Cloudflare-hosted. The initial approved reference source is D1's `layer_points` table, using `latitude`, `longitude`, and `label`, with `category` and `status` as filterable attributes. The layer dialog accepts an optional JSON import of up to 200 locations. For later bulk imports, use trusted D1 administration with the layer ID and owner ID. The owner ID is a stable Access identity, not an email or stamp. Multiple layers have independent colors and visibility. Adding other table shapes requires a reviewed server-side source adapter; arbitrary SQL and URLs are intentionally disallowed. Non-property layer features are reference data, not editable property records.

Reminder delivery is minute-resolution, not a real-time alarm guarantee. Inspect failed jobs and provider limits before retrying. Local loopback identity is for development only; security acceptance in production includes exercising Access with separate users and verifying that one user cannot read or update another's records.
