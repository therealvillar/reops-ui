import type { AreaCounty, AreaSource, Property, PropertyArea } from '../shared/types'
import { assert } from './validation'

const radiusMeters = 500
const limit = 25
const carto = 'https://phl.carto.com/api/v2/sql'
export interface AreaOptions {
  BUCKS_PARCELS_ENABLED?: string
  DELAWARE_ZONING_ENABLED?: string
}
const countyGIS = {
  montgomery: { name: 'Montgomery County GIS parcels', url: 'https://services1.arcgis.com/kOChldNuKsox8qZD/arcgis/rest/services/Montgomery_County_Parcels/FeatureServer/6' },
  bucks: { name: 'Bucks County parcels', url: 'https://services3.arcgis.com/SP47Tddf7RK32lBU/arcgis/rest/services/Bucks_County_Parcels/FeatureServer/0' },
  delaware: { name: 'Delaware County Planning Department zoning', url: 'https://gis.delcopa.gov/arcgis/rest/services/SLD_Review/Delaware_County_Zoning/FeatureServer/0' },
}
const references: Record<AreaCounty, { name: string; url: string }[]> = {
  philadelphia: [
    { name: 'Philadelphia metadata catalog', url: 'https://metadata.phila.gov/' },
    { name: 'Philadelphia sheriff auctions', url: 'https://www.bid4assets.com/philaforeclosures' },
  ],
  montgomery: [
    { name: 'Montgomery sheriff auctions', url: 'https://www.bid4assets.com/MontcoPASheriff' },
    { name: 'Montgomery post-sale distributions', url: 'https://www.montgomerycountypa.gov/1475/Post-Sale-Distributions' },
  ],
  bucks: [
    { name: 'Bucks County maps', url: 'https://maps.buckscounty.gov/' },
    { name: 'Bucks parcel and floodplain viewer', url: 'https://bucksgis.maps.arcgis.com/apps/webappviewer/index.html?id=2eda3020dd9847eaa00d1d6c0764a607' },
  ],
  delaware: [
    { name: 'Delaware County zoning catalog', url: 'https://delaware-county-pennsylvania-dcpd.hub.arcgis.com/datasets/delaware-county-zoning/explore' },
  ],
}

async function publicJSON(url: URL): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'manual' })
  if (!response.ok || !response.body) throw new Error('Public service unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1000000) throw new Error('Public response too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid public response')
  return data as Record<string, unknown>
}

function records(rows: unknown[]): AreaSource['records'] {
  return rows.slice(0, limit).map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid public record')
    return Object.fromEntries(Object.entries(row).filter(([key, value]) =>
      key !== 'the_geom' && key !== 'the_geom_webmercator' &&
      (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))))
      .slice(0, 60).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 2000) : value])) as AreaSource['records'][number]
  })
}

async function loadSource(name: string, url: string, query: URL, arcgis = false): Promise<AreaSource> {
  try {
    const data = await publicJSON(query)
    if (data.error || data.errors) throw new Error('Public service error')
    const rows = arcgis ? data.features : data.rows
    if (!Array.isArray(rows)) throw new Error('Invalid public records')
    const result = records(arcgis ? rows.map(feature => feature?.attributes) : rows)
    return { name, url, status: 'ok', message: result.length ? `${result.length} nearby public records. Source: ${name}.` : 'No nearby records returned by this source.',
      records: result, limited: rows.length >= limit || data.exceededTransferLimit === true }
  } catch {
    return { name, url, status: 'unavailable', message: 'This public service is unavailable or returned an unsupported response. Open the source to check directly.', records: [], limited: false }
  }
}

function buffer(longitude: number, latitude: number) {
  const radians = Math.PI / 180
  const lat = latitude * radians, lon = longitude * radians
  const distance = radiusMeters / 6371008.8
  const ring = Array.from({ length: 64 }, (_, index) => {
    const bearing = index * 2 * Math.PI / 64
    const y = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing))
    const x = lon + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(y))
    return [x / radians, y / radians]
  })
  return { rings: [[...ring, ring[0]]], spatialReference: { wkid: 4326 } }
}

export async function propertyArea(property: Property, county: string | null, options: AreaOptions = {}): Promise<PropertyArea> {
  assert(county !== null && Object.hasOwn(references, county), 'Choose Philadelphia, Montgomery, Bucks, or Delaware County')
  assert(property.verificationStatus === 'verified' && typeof property.latitude === 'number' && Number.isFinite(property.latitude) && Math.abs(property.latitude) <= 90 &&
    typeof property.longitude === 'number' && Number.isFinite(property.longitude) && Math.abs(property.longitude) <= 180, 'Select a geocoded address before loading nearby data')
  const selected = county as AreaCounty
  const sources: AreaSource[] = references[selected].map(source => ({
    ...source, status: 'reference', message: 'Reference website only; not an automated or property-matched feed.', records: [], limited: false,
  }))
  const queries: Promise<AreaSource>[] = []
  if (selected === 'philadelphia') {
    for (const [table, name] of [
      ['opa_properties_public', 'Philadelphia property assessments'], ['rtt_summary', 'Philadelphia realty transfers'],
      ['permits', 'Philadelphia permits'], ['violations', 'Philadelphia violations'], ['clean_seal', 'Philadelphia board-ups'],
      ['business_licenses', 'Philadelphia business licenses'], ['demolitions', 'Philadelphia demolitions'],
    ]) {
      const query = new URL(carto)
      query.searchParams.set('q', `SELECT * FROM ${table} WHERE ST_DWithin(the_geom::geography, ST_SetSRID(ST_MakePoint(${property.longitude}, ${property.latitude}), 4326)::geography, ${radiusMeters}) ORDER BY ST_Distance(the_geom::geography, ST_SetSRID(ST_MakePoint(${property.longitude}, ${property.latitude}), 4326)::geography) LIMIT ${limit}`)
      queries.push(loadSource(name!, `https://cityofphiladelphia.github.io/carto-api-explorer/#${table}`, query))
    }
  } else {
    const source = countyGIS[selected]
    const allowed = selected === 'montgomery' || (selected === 'bucks' ? options.BUCKS_PARCELS_ENABLED : options.DELAWARE_ZONING_ENABLED) === 'true'
    if (allowed) {
      const query = new URL(`${source.url}/query`)
      query.search = new URLSearchParams({
        f: 'json', where: '1=1', geometry: JSON.stringify(buffer(property.longitude!, property.latitude!)),
        geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
        outFields: '*', returnGeometry: 'false', resultRecordCount: String(limit),
      }).toString()
      queries.push(loadSource(source.name, source.url, query, true))
    } else {
      sources.unshift({ ...source, status: 'reference', records: [], limited: false, message: selected === 'bucks'
        ? 'Automated lookup disabled: published parcel terms prohibit commercial use or resale. Obtain permission before enabling BUCKS_PARCELS_ENABLED.'
        : 'Automated lookup disabled: the zoning catalog provides no reuse license and requests permission. Obtain permission before enabling DELAWARE_ZONING_ENABLED.' })
    }
  }
  sources.push({ name: 'Berks sheriff auctions (outside the four-county area)', url: 'https://www.bid4assets.com/berkscountysheriffsales', status: 'reference', message: 'Supplemental user-provided reference only; not a nearby or property-matched feed.', records: [], limited: false })
  return { county: selected, radiusMeters, fetchedAt: new Date().toISOString(), sources: [...await Promise.all(queries), ...sources] }
}
