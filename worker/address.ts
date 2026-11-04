import { SignJWT, jwtVerify } from 'jose'
import type { AddressCandidate, Property, User } from '../shared/types'
import type { Env } from './index'
import { assert, HttpError, text } from './validation'

const encoder = new TextEncoder()
const provider = 'US Census Geocoder'
const benchmark = 'Public_AR_Current'
const matchMessage = 'US Census street-interpolated match, not rooftop accuracy or legal address validation. Explicit selection enables map coordinates.'
type Match = { matched_address: string; latitude: number; longitude: number }
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
  if (!env.ADDRESS_TOKEN_SECRET || env.ADDRESS_TOKEN_SECRET.length < 32) throw new HttpError(503, 'Address selection signing is not configured; save an unverified draft')
  return encoder.encode(env.ADDRESS_TOKEN_SECRET)
}
export async function searchAddress(env: Env, user: User, query: string): Promise<{ candidates: AddressCandidate[]; message: string }> {
  const key = signingKey(env)
  const cacheKey = normalizedQuery(query)
  const cached = await env.DB.prepare('SELECT matched_address,latitude,longitude FROM property_gps WHERE normalized_query=? AND provider=? AND benchmark=? ORDER BY match_order,matched_address')
    .bind(cacheKey, provider, benchmark).all<Match>()
  let matches = cached.results.filter(validMatch)
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
        const entry = value as { matchedAddress?: unknown; coordinates?: { x?: unknown; y?: unknown } | null }
        const match = { matched_address: entry.matchedAddress, latitude: entry.coordinates?.y, longitude: entry.coordinates?.x } as Match
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
        env.DB.prepare('INSERT OR IGNORE INTO property_gps(normalized_query,matched_address,latitude,longitude,provider,benchmark,fetched_at,match_order) VALUES(?,?,?,?,?,?,?,?)')
          .bind(alias, match.matched_address, match.latitude, match.longitude, provider, benchmark, fetchedAt, index))))
    }
  }
  const candidates = await Promise.all(matches.map(async match => {
    const { matched_address: normalized, latitude, longitude } = match
    const token = await new SignJWT({ query, normalized, latitude, longitude, verified: true, message: matchMessage })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('reops-address').setAudience('property-selection').setIssuedAt().setExpirationTime('15m').sign(key)
    return { token, label: normalized, latitude, longitude, verified: true, message: matchMessage }
  }))
  return { candidates, message: candidates.length ? `${matchMessage} Your entered address remains unchanged.` : 'No valid US Census matches found. Refine the address or save an unverified draft.' }
}
export async function addressSelection(env: Env, user: User, enteredAddress: string, token: unknown): Promise<Pick<Property, 'normalizedAddress' | 'verificationStatus' | 'verificationMessage' | 'latitude' | 'longitude'>> {
  if (token === undefined || token === null || token === '') return {
    normalizedAddress: null, verificationStatus: 'unverified', verificationMessage: 'Not verified. Search and explicitly select a provider candidate.', latitude: null, longitude: null,
  }
  text(token, 'addressToken', 10000)
  try {
    const { payload: p } = await jwtVerify(token as string, signingKey(env), { algorithms: ['HS256'], issuer: 'reops-address', audience: 'property-selection', subject: user.id, requiredClaims: ['exp', 'iat'] })
    assert(p.query === enteredAddress, 'Candidate does not match the entered address')
    assert(typeof p.normalized === 'string' && p.normalized.trim().length > 0 && p.normalized.length <= 1000 && typeof p.verified === 'boolean', 'Invalid candidate')
    assert(!p.verified || validCoordinates(p.latitude, p.longitude), 'Invalid candidate coordinates')
    return { normalizedAddress: p.normalized, verificationStatus: p.verified ? 'verified' : 'ambiguous', verificationMessage: typeof p.message === 'string' ? p.message : null,
      latitude: p.verified ? p.latitude as number : null, longitude: p.verified ? p.longitude as number : null }
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error
    throw new HttpError(400, 'Invalid, expired, or mismatched address selection. Search again.')
  }
}
