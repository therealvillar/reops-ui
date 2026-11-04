import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { propertyArea } from '../worker/area'
import type { Property } from '../shared/types'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const property = { verificationStatus: 'verified', latitude: 39.95, longitude: -75.16 } as Property

test('area lookup requires valid county and saved finite geocoded coordinates', async () => {
  globalThis.fetch = async () => { throw new Error('Must not fetch') }
  for (const county of [null, 'berks', 'constructor', 'https://evil.example']) {
    await assert.rejects(propertyArea(property, county), /Choose/)
  }
  for (const overrides of [{ latitude: NaN }, { longitude: Infinity }, { longitude: 181 }, { latitude: null }, { verificationStatus: 'unverified' as const }]) {
    await assert.rejects(propertyArea({ ...property, ...overrides }, 'philadelphia'), /geocoded/)
  }
})

test('Philadelphia requests fixed spatial queries with bounded records and no tracking parameters', async () => {
  const requests: URL[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url)
    assert.equal(url.hostname, 'phl.carto.com')
    assert.equal(init?.redirect, 'error')
    const sql = url.searchParams.get('q')!
    assert.match(sql, /ST_DWithin/)
    assert.match(sql, /-75.16, 39.95/)
    assert.match(sql, /500\)/)
    assert.match(sql, /LIMIT 25$/)
    return Response.json({ rows: Array.from({ length: 25 }, (_, id) => ({ id, address: '<script>untrusted text</script>', the_geom: 'omitted', nested: {} })) })
  }
  const area = await propertyArea(property, 'philadelphia')
  assert.equal(requests.length, 7)
  assert.equal(area.radiusMeters, 500)
  assert.equal(area.county, 'philadelphia')
  assert.ok(Number.isFinite(Date.parse(area.fetchedAt)))
  for (const source of area.sources.filter(source => source.status === 'ok')) {
    assert.equal(source.records.length, 25)
    assert.equal(source.limited, true)
    assert.equal(source.records[0].address, '<script>untrusted text</script>')
    assert.equal(source.records[0].the_geom, undefined)
    assert.equal(source.records[0].nested, undefined)
    assert.equal(new URL(source.url).search, '')
  }
})

test('public source errors are isolated and empty results remain distinct', async () => {
  globalThis.fetch = async input => {
    const sql = new URL(String(input)).searchParams.get('q')!
    if (sql.includes('opa_properties_public')) throw new Error('timeout')
    if (sql.includes('rtt_summary')) return Response.json({ error: ['invalid table'] })
    if (sql.includes('business_licenses')) return new Response('bad response')
    if (sql.includes('demolitions')) return Response.json({ rows: [null] })
    return Response.json({ rows: [] })
  }
  const area = await propertyArea(property, 'philadelphia')
  assert.equal(area.sources.filter(source => source.status === 'unavailable').length, 4)
  assert.equal(area.sources.filter(source => source.status === 'ok').length, 3)
  assert.ok(area.sources.filter(source => source.status === 'ok').every(source => source.records.length === 0 && !source.limited))
})

test('oversized public responses are cancelled and reported unavailable', async () => {
  let cancelled = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1000001)) },
    cancel() { cancelled++ },
  }))
  const area = await propertyArea(property, 'philadelphia')
  assert.equal(cancelled, 7)
  assert.equal(area.sources.filter(source => source.status === 'unavailable').length, 7)
})

test('county reference sites are explicit links, never scraped or treated as matched records', async () => {
  globalThis.fetch = async () => Response.json({ features: [] })
  const area = await propertyArea(property, 'montgomery')
  for (const source of area.sources.filter(source => source.status === 'reference')) {
    assert.match(source.message, /not (an automated or property-matched|a nearby or property-matched) feed/)
    assert.deepEqual(source.records, [])
    assert.equal(source.limited, false)
  }
  assert.ok(area.sources.some(source => source.url === 'https://www.bid4assets.com/MontcoPASheriff'))
})

test('ArcGIS uses explicit WGS84 polygon buffers and permission-gates restricted datasets', async () => {
  const requests: URL[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input)); requests.push(url)
    assert.equal(url.searchParams.get('geometryType'), 'esriGeometryPolygon')
    assert.equal(url.searchParams.get('inSR'), '4326')
    assert.equal(url.searchParams.get('returnGeometry'), 'false')
    assert.equal(url.searchParams.get('resultRecordCount'), '25')
    const geometry = JSON.parse(url.searchParams.get('geometry')!)
    assert.equal(geometry.rings[0].length, 65)
    assert.deepEqual(geometry.rings[0][0], geometry.rings[0][64])
    assert.ok(geometry.rings[0].every(([x, y]: number[]) => Math.abs(x + 75.16) < 0.01 && Math.abs(y - 39.95) < 0.01))
    return Response.json({ features: [{ attributes: { PARCEL_NUM: '1', ADDRESS: 'Example' } }], exceededTransferLimit: true })
  }
  for (const county of ['bucks', 'delaware']) {
    const result = await propertyArea(property, county)
    assert.match(result.sources[0].message, /permission/)
  }
  assert.equal(requests.length, 0)
  for (const county of ['montgomery', 'bucks', 'delaware']) {
    const result = await propertyArea(property, county, { BUCKS_PARCELS_ENABLED: 'true', DELAWARE_ZONING_ENABLED: 'true' })
    assert.equal(result.sources[0].status, 'ok')
    assert.equal(result.sources[0].records[0].PARCEL_NUM, '1')
    assert.equal(result.sources[0].limited, true)
  }
  assert.equal(requests.length, 3)
  assert.match(requests[0].pathname, /FeatureServer\/6\/query$/)
})
