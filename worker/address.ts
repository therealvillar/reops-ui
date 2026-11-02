import { SignJWT, jwtVerify } from 'jose'
import type { AddressCandidate, Property, User } from '../shared/types'
import type { Env } from './index'
import { assert, HttpError, text } from './validation'

const encoder = new TextEncoder()
function signingKey(env: Env) {
  if (!env.ADDRESS_TOKEN_SECRET || env.ADDRESS_TOKEN_SECRET.length < 32) throw new HttpError(503, 'Address selection signing is not configured')
  return encoder.encode(env.ADDRESS_TOKEN_SECRET)
}
export async function searchAddress(env: Env, user: User, query: string): Promise<{ candidates: AddressCandidate[]; message: string }> {
  if (!env.ADDRESS_API_KEY) throw new HttpError(503, 'Address verification is unavailable: configure ADDRESS_API_KEY. Save the entered address as an unverified draft.')
  const apiKey = env.ADDRESS_API_KEY
  const key = signingKey(env)
  let response: Response
  try {
    response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({ input: query }), signal: AbortSignal.timeout(10000),
    })
  } catch { throw new HttpError(502, 'Address provider unavailable; your draft can still be saved') }
  if (!response.ok) throw new HttpError(502, 'Address suggestions failed; your draft can still be saved')
  const data = await response.json() as { suggestions?: { placePrediction?: { text?: { text?: string } } }[] }
  const labels = [...new Set((data.suggestions ?? []).map(s => s.placePrediction?.text?.text).filter((v): v is string => typeof v === 'string'))].slice(0, 5)
  const candidates = await Promise.all(labels.map(async label => {
    try {
      const validation = await fetch('https://addressvalidation.googleapis.com/v1:validateAddress', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({ address: { addressLines: [label] }, enableUspsCass: false }), signal: AbortSignal.timeout(10000),
      })
      if (!validation.ok) throw new Error('Unavailable')
      const body = await validation.json() as { result?: {
        verdict?: { addressComplete?: boolean; hasUnconfirmedComponents?: boolean; hasInferredComponents?: boolean; hasReplacedComponents?: boolean; validationGranularity?: string; geocodeGranularity?: string }
        address?: { formattedAddress?: string; missingComponentTypes?: string[]; unresolvedTokens?: string[] }
        geocode?: { location?: { latitude?: number; longitude?: number } }
      } }
      const result = body.result, verdict = result?.verdict, loc = result?.geocode?.location
      const verified = !!(verdict?.addressComplete && !verdict.hasUnconfirmedComponents && !result?.address?.missingComponentTypes?.length && !result?.address?.unresolvedTokens?.length &&
        ['PREMISE', 'SUB_PREMISE'].includes(verdict.validationGranularity ?? '') && ['PREMISE', 'SUB_PREMISE'].includes(verdict.geocodeGranularity ?? '') &&
        typeof loc?.latitude === 'number' && typeof loc.longitude === 'number' && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) && Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180)
      const normalized = result?.address?.formattedAddress ?? label
      const message = verified ? 'Provider-validated address. Select this candidate to use it.' : 'Provider could not confirm an exact address; saved as ambiguous without map coordinates.'
      const latitude = verified ? loc!.latitude! : null, longitude = verified ? loc!.longitude! : null
      const token = await new SignJWT({ query, normalized, latitude, longitude, verified, message })
        .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('reops-address').setAudience('property-selection').setIssuedAt().setExpirationTime('15m').sign(key)
      return { token, label: normalized, latitude, longitude, verified, message }
    } catch {
      return { token: '', label, latitude: null, longitude: null, verified: false, message: 'Validation failed; keep an unverified draft or search again.' }
    }
  }))
  return { candidates, message: candidates.length ? 'Explicitly select a candidate; your entered address remains unchanged.' : 'No address candidates found. Refine the address or save an unverified draft.' }
}
export async function addressSelection(env: Env, user: User, enteredAddress: string, token: unknown): Promise<Pick<Property, 'normalizedAddress' | 'verificationStatus' | 'verificationMessage' | 'latitude' | 'longitude'>> {
  if (token === undefined || token === null || token === '') return {
    normalizedAddress: null, verificationStatus: 'unverified', verificationMessage: 'Not verified. Search and explicitly select a provider candidate.', latitude: null, longitude: null,
  }
  text(token, 'addressToken', 10000)
  try {
    const { payload: p } = await jwtVerify(token as string, signingKey(env), { algorithms: ['HS256'], issuer: 'reops-address', audience: 'property-selection', subject: user.id, requiredClaims: ['exp', 'iat'] })
    assert(p.query === enteredAddress, 'Candidate does not match the entered address')
    assert(typeof p.normalized === 'string' && typeof p.verified === 'boolean', 'Invalid candidate')
    assert(!p.verified || (typeof p.latitude === 'number' && typeof p.longitude === 'number' && Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180), 'Invalid candidate coordinates')
    return { normalizedAddress: p.normalized, verificationStatus: p.verified ? 'verified' : 'ambiguous', verificationMessage: typeof p.message === 'string' ? p.message : null,
      latitude: p.verified ? p.latitude as number : null, longitude: p.verified ? p.longitude as number : null }
  } catch (error) {
    if (error instanceof HttpError && error.status === 503) throw error
    throw new HttpError(400, 'Invalid, expired, or mismatched address selection. Search again.')
  }
}
