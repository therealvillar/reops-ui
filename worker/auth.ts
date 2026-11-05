import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { User } from '../shared/types'
import type { Env } from './index'
import { HttpError } from './validation'

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export async function authenticate(request: Request, env: Env): Promise<User> {
  const host = new URL(request.url).hostname
  let id: string, name: string
  if (env.DEV_AUTH === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(host) && !env.ACCESS_TEAM_DOMAIN && !env.ACCESS_AUD) {
    id = 'local-developer'; name = 'Local Developer'
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(503, 'Cloudflare Access authentication is not configured')
    const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '').replace(/\/$/, '')
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(domain)) throw new HttpError(503, 'Invalid Access team domain')
    const issuer = `https://${domain}`
    let jwks = jwksCache.get(issuer)
    if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksCache.set(issuer, jwks) }
    const token = request.headers.get('Cf-Access-Jwt-Assertion')
    if (!token) throw new HttpError(401, 'Cloudflare Access authentication required')
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] })
      if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string') throw new Error('Invalid identity')
      id = `${issuer}|${payload.sub}`; name = payload.email.slice(0, 200)
    } catch { throw new HttpError(401, 'Invalid or expired Access session') }
  }
  const stamp = crypto.randomUUID().slice(0, 8).toUpperCase()
  await env.DB.prepare('INSERT INTO users(id,name,stamp) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').bind(id, name, stamp).run()
  const user = await env.DB.prepare('SELECT id,name,stamp FROM users WHERE id=?').bind(id).first<User>()
  if (!user) throw new HttpError(500, 'Identity unavailable')
  await env.DB.prepare("INSERT OR IGNORE INTO bins(id,owner_id,name,color,position) VALUES(?,?,'Inbox','#64748b',0)").bind(`inbox:${id}`, id).run()
  return user
}
export function protectOrigin(request: Request, env: Env) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
  const origin = request.headers.get('Origin')
  const requestUrl = new URL(request.url)
  const local = env.DEV_AUTH === 'true' && !env.ACCESS_TEAM_DOMAIN && !env.ACCESS_AUD && ['localhost', '127.0.0.1', '[::1]'].includes(requestUrl.hostname)
  const allowedOrigins = new Set<string>()
  if (local) {
    allowedOrigins.add(requestUrl.origin)
    if (env.APP_ORIGIN) {
      try {
        const configured = new URL(env.APP_ORIGIN)
        if (['http:', 'https:'].includes(configured.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname) &&
          !configured.username && !configured.password && configured.pathname === '/' && !configured.search && !configured.hash) allowedOrigins.add(configured.origin)
      } catch { /* An invalid development origin must not broaden the allowlist. */ }
    }
  } else if (env.PREVIEW_WORKER_HOSTNAME) {
    const suffix = `-${env.PREVIEW_WORKER_HOSTNAME}`
    const previewName = requestUrl.hostname.endsWith(suffix) ? requestUrl.hostname.slice(0, -suffix.length) : ''
    if (requestUrl.protocol !== 'https:' || requestUrl.port || !/^[a-z0-9-]+$/.test(previewName)) {
      throw new HttpError(403, 'Cross-origin mutations are forbidden')
    }
    allowedOrigins.add(requestUrl.origin)
  } else {
    if (!env.APP_ORIGIN) throw new HttpError(503, 'Application origin is not configured')
    allowedOrigins.add(env.APP_ORIGIN)
  }
  if (origin && !allowedOrigins.has(origin)) throw new HttpError(403, 'Cross-origin mutations are forbidden')
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpError(403, 'Cross-site mutations are forbidden')
  const contentType = request.headers.get('Content-Type')?.split(';')[0].trim()
  if (request.method !== 'DELETE' && contentType !== 'application/json') throw new HttpError(415, 'Use application/json')
}
