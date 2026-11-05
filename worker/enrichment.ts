import type { EnrichmentJob, EnrichmentSource, Property, SourceAttribute, SourceRecord } from '../shared/types'
import type { Env } from './index'
import { assert, HttpError } from './validation'

const sourceId = 'philadelphia_opa'
const catalogUrl = 'https://opendataphilly.org/datasets/philadelphia-properties-and-assessment-history/'
const cartoUrl = 'https://phl.carto.com/api/v2/sql'
const columns = [
  'parcel_number', 'location', 'zip_code', 'unit', 'market_value', 'taxable_land', 'taxable_building',
  'year_built', 'total_livable_area', 'total_area', 'number_of_bedrooms', 'number_of_bathrooms',
  'number_stories', 'zoning', 'assessment_date', 'market_value_date', 'sale_date', 'sale_price',
  'building_code_description',
] as const
type SourceValue = string | number | boolean | null
type SourceRow = Partial<Record<typeof columns[number], SourceValue>>
type JobRow = {
  id: string; property_id: string; owner_id: string; source_id: string; status: EnrichmentJob['status']
  attempts: number; last_error: string | null; created_at: string; completed_at: string | null
  lease_token: string | null; lease_until: string | null; event_key: string; matched_address: string | null; requested_by: string
}

export function enrichmentSources(env: Env): EnrichmentSource[] {
  return [
    { id: sourceId, name: 'Philadelphia OPA assessment', dataset: 'opa_properties_public', url: catalogUrl,
      coverage: 'Philadelphia only', enabled: env.PHILADELPHIA_OPA_ENABLED === 'true',
      message: env.PHILADELPHIA_OPA_ENABLED === 'true' ? 'Exact property lookup by parcel ID or street address and ZIP; verify each match.'
        : 'Persistent ingestion disabled until City dataset reuse terms and CARTO field schema are confirmed by the operator.',
      refreshDays: 30, sourceType: 'carto_sql', baseUrl: cartoUrl,
      identifierFields: ['parcel_number'], addressFields: ['location', 'zip_code', 'unit'],
      parcelFields: ['parcel_number'], spatialReference: 'none (non-spatial exact match)',
      retrievalMethod: 'Exact parcel number (verified identity), otherwise exact street and 5-digit ZIP; validate returned unit.',
      license: 'City of Philadelphia custom data terms; operator must verify reuse and storage before enabling.',
      requestLimit: 3, timeoutMs: 8000, mappingRules: 'Allowlisted assessment and building attributes only; no owner or mailing fields.',
      provenance: 'City of Philadelphia OPA, via Philadelphia CARTO SQL API' },
    ...(['rtt_summary', 'permits', 'violations', 'clean_seal', 'business_licenses', 'demolitions'] as const).map(dataset => ({
      id: `philadelphia_${dataset}`, name: `Philadelphia ${dataset.replaceAll('_', ' ')}`, dataset, url: 'https://metadata.phila.gov/',
      coverage: 'Philadelphia only', enabled: false,
      message: 'Nearby context only. Exact parcel identifier, field schema and storage permissions require verification before enabling persistent matching.',
      refreshDays: ['permits', 'violations', 'clean_seal', 'demolitions'].includes(dataset) ? 7 : 30,
      sourceType: 'carto_sql' as const, baseUrl: cartoUrl, identifierFields: [], addressFields: [], parcelFields: [],
      spatialReference: 'unverified', retrievalMethod: 'disabled until exact identifier join is verified',
      license: 'City of Philadelphia dataset-specific terms must be reviewed before persistent ingestion.',
      requestLimit: 0, timeoutMs: 0, mappingRules: 'No unverified columns or nearby-only records are persisted.',
      provenance: 'City of Philadelphia open data; nearby context only',
    })),
    ...([
      ['montgomery_parcels', 'https://services1.arcgis.com/kOChldNuKsox8qZD/arcgis/rest/services/Montgomery_County_Parcels/FeatureServer/6'],
      ['bucks_parcels', 'https://services3.arcgis.com/SP47Tddf7RK32lBU/arcgis/rest/services/Bucks_County_Parcels/FeatureServer/0'],
      ['delaware_zoning', 'https://gis.delcopa.gov/arcgis/rest/services/SLD_Review/Delaware_County_Zoning/FeatureServer/0'],
    ] as const).map(([dataset, endpoint]) => ({
      id: dataset, name: dataset.replaceAll('_', ' '), dataset, url: endpoint,
      coverage: dataset.split('_')[0], enabled: false,
      message: dataset === 'bucks_parcels' ? 'Commercial ingestion restricted by published parcel terms.'
        : dataset === 'delaware_zoning' ? 'Reuse permission has not been granted.'
        : 'Exact parcel matching and field schema not yet verified; nearby lookup remains available.',
      refreshDays: 30, sourceType: 'arcgis' as const, baseUrl: endpoint, identifierFields: [], addressFields: [], parcelFields: [],
      spatialReference: 'unverified', retrievalMethod: 'disabled until exact subject-parcel matching is verified',
      license: dataset === 'bucks_parcels' ? 'Published terms restrict commercial use/resale; do not ingest.'
        : dataset === 'delaware_zoning' ? 'Permission required; do not ingest.' : 'Open as-is parcel resource; exact adapter not verified.',
      requestLimit: 0, timeoutMs: 0, mappingRules: 'No county data persisted without a verified adapter.',
      provenance: 'County GIS reference layer; nearby context only',
    })),
  ]
}

function subject(property: Property): { street: string; zip: string } | null {
  if (property.verificationStatus !== 'verified' || property.latitude === null || property.longitude === null ||
      !Number.isFinite(property.latitude) || !Number.isFinite(property.longitude) ||
      Math.abs(property.latitude) > 90 || Math.abs(property.longitude) > 180) return null
  const match = /^([^,]+),\s*PHILADELPHIA,\s*PA,?\s*(\d{5})(?:-\d{4})?$/i.exec(property.normalizedAddress?.trim() ?? '')
  if (!match) return null
  return { street: match[1].trim().toUpperCase().replace(/\s+/g, ' '), zip: match[2] }
}

export function jobInsert(env: Env, property: Property, requestedBy: string, eventKey: string): D1PreparedStatement | null {
  if (!subject(property)) return null
  return env.DB.prepare("INSERT OR IGNORE INTO property_enrichment_jobs(id,property_id,owner_id,source_id,created_at,event_key,requested_by,matched_address) SELECT ?,p.id,p.owner_id,?,?,?,?,? FROM properties p WHERE p.id=? AND p.version=?")
    .bind(crypto.randomUUID(), sourceId, new Date().toISOString(), eventKey, requestedBy, property.normalizedAddress, property.id, property.version)
}

export function jobModel(row: JobRow): EnrichmentJob {
  return { id: row.id, sourceId: row.source_id, status: row.status, attempts: row.attempts,
    lastError: row.last_error, createdAt: row.created_at, completedAt: row.completed_at }
}

export async function enqueueRefresh(env: Env, property: Property, requestedBy: string, key: string): Promise<EnrichmentJob> {
  assert(subject(property), 'An exact Philadelphia address with a geocoded location and ZIP is required for OPA enrichment', 422)
  const eventKey = `manual:${requestedBy}:${property.id}:${key}`
  const previous = await env.DB.prepare('SELECT * FROM property_enrichment_jobs WHERE event_key=?').bind(eventKey).first<JobRow>()
  if (previous) {
    assert(previous.matched_address === property.normalizedAddress, 'Idempotency key was already used for a different address', 409)
    return jobModel(previous)
  }
  const active = await env.DB.prepare("SELECT id FROM property_enrichment_jobs WHERE property_id=? AND source_id=? AND status IN ('pending','running') LIMIT 1")
    .bind(property.id, sourceId).first()
  assert(!active, 'Enrichment is already queued or running', 409)
  const recent = await env.DB.prepare("SELECT id FROM property_enrichment_jobs WHERE property_id=? AND source_id=? AND created_at>? ORDER BY created_at DESC LIMIT 1")
    .bind(property.id, sourceId, new Date(Date.now() - 10 * 60000).toISOString()).first()
  assert(!recent, 'Wait ten minutes before requesting another enrichment refresh', 429)
  await jobInsert(env, property, requestedBy, eventKey)!.run()
  const row = await env.DB.prepare('SELECT * FROM property_enrichment_jobs WHERE event_key=? AND property_id=?')
    .bind(eventKey, property.id).first<JobRow>()
  assert(row, 'Property changed. Reload before refreshing enrichment.', 409)
  return jobModel(row)
}

export async function propertyEnrichment(env: Env, property: Property): Promise<{
  enrichment: EnrichmentJob[]; sourceRecords: SourceRecord[]; sourceAttributes: SourceAttribute[]
}> {
  const [jobs, records, attrs] = await Promise.all([
    env.DB.prepare('SELECT * FROM property_enrichment_jobs WHERE property_id=? ORDER BY created_at DESC LIMIT 30').bind(property.id).all<JobRow>(),
    env.DB.prepare('SELECT id,source_id,source_record_id,match_method,match_confidence,raw_json,fetched_at,source_updated_at FROM property_source_records WHERE property_id=? AND matched_address=? AND superseded_at IS NULL ORDER BY fetched_at DESC LIMIT 30')
      .bind(property.id, property.normalizedAddress ?? '').all<{
        id: string; source_id: string; source_record_id: string; match_method: SourceRecord['matchMethod']
        match_confidence: SourceRecord['matchConfidence']; raw_json: string; fetched_at: string; source_updated_at: string | null
      }>(),
    env.DB.prepare('SELECT a.attribute_key,a.value_json,a.source_id,a.observed_at FROM property_attributes a JOIN property_source_records r ON r.id=a.source_record_id WHERE a.property_id=? AND r.matched_address=? AND r.superseded_at IS NULL ORDER BY a.attribute_key LIMIT 50')
      .bind(property.id, property.normalizedAddress ?? '').all<{ attribute_key: string; value_json: string; source_id: string; observed_at: string }>(),
  ])
  return {
    enrichment: jobs.results.map(jobModel),
    sourceRecords: records.results.map(r => ({
      id: r.id, sourceId: r.source_id, sourceRecordId: r.source_record_id, matchMethod: r.match_method,
      matchConfidence: r.match_confidence, data: JSON.parse(r.raw_json), fetchedAt: r.fetched_at, sourceUpdatedAt: r.source_updated_at,
    })),
    sourceAttributes: attrs.results.map(a => ({ key: a.attribute_key, value: JSON.parse(a.value_json), sourceId: a.source_id, observedAt: a.observed_at })),
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function sourceRows(property: Property, existingParcel: string | null): Promise<SourceRow[]> {
  const address = subject(property)!
  const query = existingParcel
    ? `SELECT ${columns.join(',')} FROM opa_properties_public WHERE parcel_number=${literal(existingParcel)} LIMIT 3`
    : `SELECT ${columns.join(',')} FROM opa_properties_public WHERE UPPER(TRIM(location))=${literal(address.street)} AND LEFT(zip_code,5)=${literal(address.zip)} LIMIT 3`
  const url = new URL(cartoUrl)
  url.searchParams.set('q', query)
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' })
  if (!response.ok || !response.body) throw new Error('OPA service unavailable')
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 120000) { await reader.cancel(); throw new Error('OPA response exceeds size limit') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('rows' in data) ||
      !Array.isArray(data.rows) || data.rows.length > 3 || 'error' in data) throw new Error('Invalid OPA service response')
  return data.rows.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid OPA record')
    const row = value as Record<string, unknown>
    if (typeof row.parcel_number !== 'string' || typeof row.location !== 'string' || typeof row.zip_code !== 'string')
      throw new Error('OPA identifier or address fields are missing; review the live source schema')
    for (const key of columns) {
      const field = row[key]
      if (field !== undefined && field !== null &&
          !(typeof field === 'string' && field.length <= 2000) &&
          !(typeof field === 'number' && Number.isFinite(field)) && typeof field !== 'boolean') {
        throw new Error('Invalid OPA field type or size')
      }
    }
    return Object.fromEntries(columns.filter(key => row[key] !== undefined).map(key => [key, row[key]])) as SourceRow
  })
}

function matchRow(property: Property, row: SourceRow, parcel: string | null): boolean {
  const address = subject(property)!
  const sourceStreet = row.location?.toString().trim().toUpperCase().replace(/\s+/g, ' ')
  const zip = row.zip_code?.toString().slice(0, 5)
  const unit = row.unit?.toString().trim()
  return sourceStreet === address.street && zip === address.zip &&
    (!unit || new RegExp(`(?:\\bUNIT\\s*|\\bAPT\\s*|#)${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(address.street)) &&
    (!parcel || row.parcel_number === parcel)
}

function normalizedAttributes(row: SourceRow): Record<string, string | number> {
  const fields: Record<string, typeof columns[number]> = {
    assessedValue: 'market_value', landValue: 'taxable_land', improvementValue: 'taxable_building',
    yearBuilt: 'year_built', buildingArea: 'total_livable_area', lotArea: 'total_area',
    bedrooms: 'number_of_bedrooms', bathrooms: 'number_of_bathrooms', stories: 'number_stories',
    zoning: 'zoning', propertyType: 'building_code_description',
  }
  const attributes: Record<string, string | number> = {}
  for (const [key, field] of Object.entries(fields)) {
    const value = row[field]
    if (typeof value === 'number' && Number.isFinite(value)) attributes[key] = value
    else if (typeof value === 'string' && value.trim() && (key === 'zoning' || key === 'propertyType')) attributes[key] = value
  }
  return attributes
}

async function saveMatch(env: Env, property: Property, row: SourceRow, parcelMatch: boolean): Promise<void> {
  const parcel = row.parcel_number!.toString()
  const fetchedAt = new Date().toISOString()
  const raw = JSON.stringify(row)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const existing = await env.DB.prepare('SELECT id,content_hash FROM property_source_records WHERE property_id=? AND source_id=? AND source_record_id=? AND matched_address=? AND superseded_at IS NULL')
    .bind(property.id, sourceId, parcel, property.normalizedAddress).first<{ id: string; content_hash: string }>()
  const priorVersion = await env.DB.prepare('SELECT id FROM property_source_records WHERE property_id=? AND source_id=? AND source_record_id=? AND matched_address=? AND content_hash=?')
    .bind(property.id, sourceId, parcel, property.normalizedAddress, hash).first<{ id: string }>()
  const id = priorVersion?.id ?? crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  if (existing && existing.content_hash !== hash) statements.push(env.DB.prepare('UPDATE property_source_records SET superseded_at=? WHERE id=? AND superseded_at IS NULL').bind(fetchedAt, existing.id))
  statements.push(env.DB.prepare('UPDATE property_source_records SET superseded_at=? WHERE property_id=? AND source_id=? AND matched_address=? AND source_record_id!=? AND superseded_at IS NULL')
    .bind(fetchedAt, property.id, sourceId, property.normalizedAddress, parcel))
  statements.push(env.DB.prepare('INSERT INTO property_source_records(id,property_id,source_id,source_record_id,matched_address,match_method,match_confidence,raw_json,content_hash,fetched_at,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id,source_id,source_record_id,matched_address,content_hash) DO UPDATE SET fetched_at=excluded.fetched_at,match_method=excluded.match_method,match_confidence=excluded.match_confidence,superseded_at=NULL')
    .bind(id, property.id, sourceId, parcel, property.normalizedAddress, parcelMatch ? 'parcel_id' : 'exact_address',
      parcelMatch ? 'exact_parcel' : 'strong_address', raw, hash, fetchedAt, typeof row.assessment_date === 'string' ? row.assessment_date : null))
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO property_identity(property_id,jurisdiction,identifier_type,identifier_value,source_id,matched_address,verified_at) VALUES(?,?,?,?,?,?,?)')
    .bind(property.id, 'philadelphia', 'opa_parcel_number', parcel, sourceId, property.normalizedAddress, fetchedAt))
  for (const [key, value] of Object.entries(normalizedAttributes(row))) {
    statements.push(env.DB.prepare('INSERT INTO property_attributes(property_id,source_id,attribute_key,value_json,source_record_id,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(property_id,source_id,attribute_key) DO UPDATE SET value_json=excluded.value_json,source_record_id=excluded.source_record_id,observed_at=excluded.observed_at')
      .bind(property.id, sourceId, key, JSON.stringify(value), id, fetchedAt))
  }
  await env.DB.batch(statements)
}

async function processJob(env: Env, job: JobRow): Promise<void> {
  const lease = crypto.randomUUID()
  const now = new Date().toISOString()
  const claimed = await env.DB.prepare("UPDATE property_enrichment_jobs SET status='running',attempts=attempts+1,started_at=?,lease_token=?,lease_until=? WHERE id=? AND attempts<3 AND ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='running' AND lease_until<=?)) RETURNING *")
    .bind(now, lease, new Date(Date.now() + 45000).toISOString(), job.id, now, now).first<JobRow>()
  if (!claimed) return
  try {
    const row = await env.DB.prepare('SELECT data FROM properties WHERE id=? AND owner_id=?')
      .bind(claimed.property_id, claimed.owner_id).first<{ data: string }>()
    if (!row) throw new HttpError(403, 'Property ownership changed')
    const property = JSON.parse(row.data) as Property
    if (claimed.requested_by !== 'system:enricher' && claimed.requested_by !== claimed.owner_id) {
      const grant = await env.DB.prepare("SELECT 1 FROM property_members WHERE property_id=? AND user_id=? AND role='editor'")
        .bind(property.id, claimed.requested_by).first()
      if (!grant) throw new HttpError(403, 'Enrichment requester access was revoked before execution')
    }
    let status: EnrichmentJob['status'] = 'manual_review'
    let message: string | null = null
    if (claimed.source_id !== sourceId) {
      status = 'unavailable'
      message = 'Exact-property adapter is not enabled for this source.'
    } else if (!subject(property) || claimed.matched_address !== property.normalizedAddress)
      message = 'Address changed or is not an exact geocoded Philadelphia address; refresh after correcting it.'
    else if (env.PHILADELPHIA_OPA_ENABLED !== 'true') {
      status = 'unavailable'
      message = 'OPA ingestion requires operator approval of dataset reuse terms and live schema.'
    } else {
      const identity = await env.DB.prepare('SELECT identifier_value FROM property_identity WHERE property_id=? AND source_id=? AND matched_address=? ORDER BY verified_at DESC LIMIT 1')
        .bind(property.id, sourceId, property.normalizedAddress).first<{ identifier_value: string }>()
      const candidates = await sourceRows(property, identity?.identifier_value ?? null)
      const current = await env.DB.prepare("SELECT p.version FROM properties p WHERE p.id=? AND p.owner_id=? AND json_extract(p.data,'$.normalizedAddress')=? AND (? IN (p.owner_id,'system:enricher') OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor'))")
        .bind(property.id, claimed.owner_id, property.normalizedAddress, claimed.requested_by, claimed.requested_by).first<{ version: number }>()
      if (!current || current.version !== property.version) throw new HttpError(409, 'Property changed during lookup; refresh the match for the current address')
      const matches = candidates.filter(candidate => matchRow(property, candidate, identity?.identifier_value ?? null))
      if (matches.length === 1 && /^[A-Za-z0-9-]{5,32}$/.test(matches[0].parcel_number?.toString() ?? '')) {
        const parcel = matches[0].parcel_number!.toString()
        const duplicate = await env.DB.prepare("SELECT i.property_id FROM property_identity i JOIN properties p ON p.id=i.property_id WHERE i.jurisdiction='philadelphia' AND i.identifier_type='opa_parcel_number' AND i.identifier_value=? AND i.property_id!=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=?)) LIMIT 1")
          .bind(parcel, property.id, claimed.requested_by, claimed.requested_by).first<{ property_id: string }>()
        if (duplicate) message = `OPA parcel is already linked to another accessible property (${duplicate.property_id}); review duplicates before associating.`
        else {
          await saveMatch(env, property, matches[0], Boolean(identity))
          status = 'complete'
        }
      } else {
        message = candidates.length > 1 || matches.length > 1
          ? 'Ambiguous OPA matches: review the parcel identifier manually; no record was associated.'
          : 'No exact OPA street, ZIP and unit match; no source record was associated.'
        await env.DB.prepare('UPDATE property_source_records SET superseded_at=? WHERE property_id=? AND source_id=? AND matched_address=? AND superseded_at IS NULL')
          .bind(new Date().toISOString(), property.id, sourceId, property.normalizedAddress).run()
      }
    }
    await env.DB.prepare("UPDATE property_enrichment_jobs SET status=?,last_error=?,completed_at=?,lease_token=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=? AND status='running' AND lease_token=?")
      .bind(status, message, new Date().toISOString(), claimed.id, lease).run()
  } catch (error) {
    const retry = claimed.attempts < 3 && !(error instanceof HttpError)
    const message = error instanceof HttpError ? error.message : 'OPA source unavailable or returned an unsupported schema; no record was associated.'
    const delay = 30000 * 2 ** (claimed.attempts - 1) + Math.floor(Math.random() * 5000)
    await env.DB.prepare("UPDATE property_enrichment_jobs SET status=?,last_error=?,completed_at=?,lease_token=NULL,lease_until=NULL,next_attempt_at=? WHERE id=? AND status='running' AND lease_token=?")
      .bind(retry ? 'pending' : 'failed', message, retry ? null : new Date().toISOString(),
        retry ? new Date(Date.now() + delay).toISOString() : null, claimed.id, lease).run()
  }
}

export async function processEnrichmentJobs(env: Env): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare("UPDATE property_enrichment_jobs SET status='failed',last_error='Enrichment lease expired after maximum attempts',completed_at=?,lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=? AND attempts>=3")
    .bind(now, now).run()
  const jobs = await env.DB.prepare("SELECT * FROM property_enrichment_jobs WHERE attempts<3 AND ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='running' AND lease_until<=?)) ORDER BY created_at LIMIT 2")
    .bind(now, now).all<JobRow>()
  for (const job of jobs.results) await processJob(env, job)
}

export async function scheduleEnrichment(env: Env): Promise<void> {
  if (env.PHILADELPHIA_OPA_ENABLED !== 'true') return
  const rows = await env.DB.prepare("SELECT p.data FROM properties p WHERE json_extract(p.data,'$.verificationStatus')='verified' AND upper(json_extract(p.data,'$.normalizedAddress')) LIKE '%, PHILADELPHIA, PA,%' AND NOT EXISTS(SELECT 1 FROM property_enrichment_jobs j WHERE j.property_id=p.id AND j.source_id=? AND (j.status IN ('pending','running','manual_review') OR (j.status!='unavailable' AND j.created_at>?))) ORDER BY p.created_at LIMIT 2")
    .bind(sourceId, new Date(Date.now() - 30 * 86400000).toISOString()).all<{ data: string }>()
  for (const row of rows.results) {
    const property = JSON.parse(row.data) as Property
    const statement = jobInsert(env, property, 'system:enricher', `scheduled:${property.id}:${new Date().toISOString().slice(0, 10)}`)
    if (statement) await statement.run()
  }
}
