import { SignJWT, jwtVerify } from 'jose'
import type { AddressCandidate, AddressParts, Property, User } from '../shared/types'
import type { Env } from './index'
import { assert, HttpError, text } from './validation'

const encoder = new TextEncoder()
const provider = 'US Census Geocoder'
const benchmark = 'Public_AR_Current'
const accuracyMessage = 'US Census street-interpolated match, not rooftop accuracy or legal address validation.'
const matchMessage = `${accuracyMessage} Explicit selection enables map coordinates.`
type Match = { matched_address: string; latitude: number; longitude: number; components?: AddressParts | null }
const componentFields = {
  preDirection: 'predirectional', streetName: 'street', suffixType: 'streetSuffix',
  suffixDirection: 'postdirectional', unit: 'unit', city: 'city', state: 'state', zip: 'zip',
} as const
function addressParts(value: unknown): AddressParts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const result: AddressParts = {}
  const houseNumber = raw.houseNumber ?? (raw.fromAddress === raw.toAddress ? raw.fromAddress : undefined)
  if (typeof houseNumber === 'string' && houseNumber.trim())
    result.houseNumber = houseNumber.trim().slice(0, 40)
  for (const [source, target] of Object.entries(componentFields)) {
    const part = raw[source] ?? raw[target]
    if (typeof part === 'string' && part.trim()) result[target as keyof AddressParts] = part.trim().slice(0, 100)
  }
  return Object.keys(result).length ? result : null
}
function normalizedQuery(query: string) {
  // Keep punctuation, unit identifiers, and street suffixes distinct.
  return query.trim().replace(/\s+/g, ' ').toUpperCase()
}
function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === 'number' && typeof longitude === 'number' &&
    Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
}
function validMatch(match: Match): boolean {
  return typeof match.matched_address === 'string' && match.matched_address.trim().length > 0 &&
    match.matched_address.length <= 1000 && validCoordinates(match.latitude, match.longitude)
}
async function censusResponse(response: Response) {
  if (!response.body) throw new Error('Empty Census response')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let size = 0, body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 100000) {
        await reader.cancel()
        throw new Error('Census response too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(body + decoder.decode()) as { result?: { addressMatches?: unknown } } | null
  } finally { reader.releaseLock() }
}
function signingKey(env: Env) {
  if (!env.ADDRESS_TOKEN_SECRET || env.ADDRESS_TOKEN_SECRET.length < 32) throw new HttpError(503, 'Address selection signing is not configured; unique addresses can still geocode on save, or save an unverified draft')
  return encoder.encode(env.ADDRESS_TOKEN_SECRET)
}
async function censusMatches(env: Env, query: string): Promise<Match[]> {
  const cacheKey = normalizedQuery(query)
  const cached = await env.DB.prepare('SELECT matched_address,latitude,longitude,components FROM property_gps WHERE normalized_query=? AND provider=? AND benchmark=? ORDER BY match_order,matched_address')
    .bind(cacheKey, provider, benchmark).all<Match & { components: string | null }>()
  let matches: Match[] = cached.results.filter(validMatch).map(match => ({
    ...match, components: match.components ? addressParts(JSON.parse(match.components)) : null,
  }))
  if (!matches.length) {
    try {
      const url = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress')
      url.search = new URLSearchParams({ address: query, benchmark, format: 'json' }).toString()
      const response = await fetch(url, {
        // Workers do not support redirect:"error"; manual plus the status check rejects redirects.
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('Unavailable')
      const body = await censusResponse(response)
      if (!Array.isArray(body?.result?.addressMatches) || body.result.addressMatches.length > 100) throw new Error('Malformed Census response')
      matches = body.result.addressMatches.flatMap(value => {
        if (!value || typeof value !== 'object') return []
        const entry = value as { matchedAddress?: unknown; coordinates?: { x?: unknown; y?: unknown } | null; addressComponents?: unknown }
        const match = { matched_address: entry.matchedAddress, latitude: entry.coordinates?.y, longitude: entry.coordinates?.x,
          components: addressParts(entry.addressComponents) } as Match
        return validMatch(match) ? [match] : []
      })
      matches = matches.filter((match, index) => matches.findIndex(other => other.matched_address === match.matched_address &&
        other.latitude === match.latitude && other.longitude === match.longitude) === index)
    } catch { throw new HttpError(502, 'US Census geocoding unavailable or malformed; your draft can still be saved') }
    if (matches.length) {
      const fetchedAt = new Date().toISOString()
      // Only single-match searches have an unambiguous canonical-address alias.
      const aliases = [...new Set([cacheKey, ...(matches.length === 1 ? [normalizedQuery(matches[0].matched_address)] : [])])]
      await env.DB.batch(aliases.flatMap(alias => matches.map((match, index) =>
        env.DB.prepare('INSERT OR IGNORE INTO property_gps(normalized_query,matched_address,latitude,longitude,provider,benchmark,fetched_at,match_order,components) VALUES(?,?,?,?,?,?,?,?,?)')
          .bind(alias, match.matched_address, match.latitude, match.longitude, provider, benchmark, fetchedAt, index,
            match.components ? JSON.stringify(match.components) : null))))
    }
  }
  return matches
}
type Location = Pick<Property, 'normalizedAddress' | 'addressComponents' | 'verificationStatus' | 'verificationMessage' | 'latitude' | 'longitude'>
const unlocated = (status: Property['verificationStatus'], message: string): Location => ({
  normalizedAddress: null, addressComponents: null, verificationStatus: status, verificationMessage: message, latitude: null, longitude: null,
})
export async function geocodeAddress(env: Env, address: string): Promise<Location> {
  if (!address.trim()) return unlocated('unverified', 'No address entered. Add a complete US street address to locate this property.')
  const matches = await censusMatches(env, address)
  if (!matches.length) return unlocated('failed', 'No valid US Census matches found. Refine the address and save it again.')
  if (matches.length > 1) return unlocated('ambiguous', 'Multiple US Census matches found. Select the correct address in the property editor.')
  const match = matches[0]
  return { normalizedAddress: match.matched_address, addressComponents: match.components ?? null, verificationStatus: 'verified',
    verificationMessage: `${accuracyMessage} Automatically geocoded from a single match.`,
    latitude: match.latitude, longitude: match.longitude }
}
export async function savedAddress(env: Env, address: string): Promise<Location> {
  try { return await geocodeAddress(env, address) } catch (error) {
    if (error instanceof HttpError && error.status === 502) return unlocated('unverified', `${error.message}. Geocoding will retry automatically.`)
    throw error
  }
}
export async function backfillAddresses(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT id,version,data FROM properties WHERE json_extract(data,'$.verificationStatus')='unverified' AND json_extract(data,'$.latitude') IS NULL AND length(trim(json_extract(data,'$.enteredAddress')))>0 ORDER BY created_at,id LIMIT 5")
    .all<{ id: string; version: number; data: string }>()
  const results = await Promise.allSettled(rows.results.map(async row => {
    const property = JSON.parse(row.data) as Property
    const location = await geocodeAddress(env, property.enteredAddress)
    const updatedAt = new Date().toISOString()
    const next: Property = { ...property, ...location, version: property.version + 1, updatedBy: 'system:geocoder', updatedAt }
    await env.DB.prepare("UPDATE properties SET version=?,updated_by=?,updated_at=?,data=? WHERE id=? AND version=? AND json_extract(data,'$.verificationStatus')='unverified'")
      .bind(next.version, next.updatedBy, next.updatedAt, JSON.stringify(next), row.id, row.version).run()
  }))
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
export async function searchAddress(env: Env, user: User, query: string): Promise<{ candidates: AddressCandidate[]; message: string }> {
  const key = signingKey(env)
  const matches = await censusMatches(env, query)
  const candidates = await Promise.all(matches.map(async match => {
    const { matched_address: normalized, latitude, longitude, components } = match
    const token = await new SignJWT({ query, normalized, latitude, longitude, components: components ?? null, verified: true, message: matchMessage })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('reops-address').setAudience('property-selection').setIssuedAt().setExpirationTime('15m').sign(key)
    return { token, label: normalized, latitude, longitude, verified: true, message: matchMessage }
  }))
  return { candidates, message: candidates.length ? `${matchMessage} Your entered address remains unchanged.` : 'No valid US Census matches found. Refine the address or save an unverified draft.' }
}
export async function addressSelection(env: Env, user: User, enteredAddress: string, token: unknown): Promise<Location> {
  if (token === undefined || token === null || token === '') return {
    normalizedAddress: null, addressComponents: null, verificationStatus: 'unverified', verificationMessage: 'Not verified. Search and explicitly select a provider candidate.', latitude: null, longitude: null,
  }
  text(token, 'addressToken', 10000)
  try {
    const { payload: p } = await jwtVerify(token as string, signingKey(env), { algorithms: ['HS256'], issuer: 'reops-address', audience: 'property-selection', subject: user.id, requiredClaims: ['exp', 'iat'] })
    assert(p.query === enteredAddress, 'Candidate does not match the entered address')
    assert(typeof p.normalized === 'string' && p.normalized.trim().length > 0 && p.normalized.length <= 1000 && typeof p.verified === 'boolean', 'Invalid candidate')
    assert(!p.verified || validCoordinates(p.latitude, p.longitude), 'Invalid candidate coordinates')
    return { normalizedAddress: p.normalized, addressComponents: addressParts(p.components),
      verificationStatus: p.verified ? 'verified' : 'ambiguous', verificationMessage: typeof p.message === 'string' ? p.message : null,
      latitude: p.verified ? p.latitude as number : null, longitude: p.verified ? p.longitude as number : null }
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error
    throw new HttpError(400, 'Invalid, expired, or mismatched address selection. Search again.')
  }
}
