import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { enqueueManual, processJobs, scheduledWork } from '../worker/ai'
import { addressSelection, searchAddress } from '../worker/address'
import type { Env } from '../worker/index'
import type { AddressCandidate, AIJob, Bin, Detail, Layer, Notification, Property, Reminder, SavedView, User } from '../shared/types'

let mf: Miniflare, db: D1Database, env: Env
let runtimeDirectory: string | undefined
let tokens: Record<string, string>, privateKey: CryptoKey
let user: User, bin: Bin
let aiCalls: { fields: string[]; record: Record<string, unknown>; tools: unknown[] }[] = []
let aiFailures = 0
let aiOversized = false, aiBodyCancelled = false, aiBodyChunks = 0
const origin = 'https://app.example.com'
const issuer = 'https://test-team.cloudflareaccess.com'
const signingSecret = 'test-only-address-signing-secret-32-characters'
const censusCalls: string[] = []

async function upstream(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (url.hostname === 'test-team.cloudflareaccess.com' && url.pathname === '/cdn-cgi/access/certs') {
    const publicKey = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']))
    return Response.json({ keys: [{ ...publicKey, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
  }
  if (url.hostname === 'geocoding.geo.census.gov') {
    assert.equal(request.method, 'GET')
    assert.equal(url.pathname, '/geocoder/locations/onelineaddress')
    assert.equal(url.searchParams.get('benchmark'), 'Public_AR_Current')
    assert.equal(url.searchParams.get('format'), 'json')
    assert.deepEqual([...url.searchParams.keys()].sort(), ['address', 'benchmark', 'format'])
    const query = url.searchParams.get('address')!
    censusCalls.push(query)
    if (query === 'Provider non-OK') return new Response('unavailable', { status: 503 })
    if (query === 'Provider redirect') return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/private' } })
    if (query === 'Malformed JSON') return new Response('{')
    if (query === 'Malformed result') return Response.json({ result: { addressMatches: {} } })
    if (query === 'Null result') return Response.json(null)
    if (query === 'No matches') return Response.json({ result: { addressMatches: [] } })
    if (query === 'Invalid matches') return Response.json({ result: { addressMatches: [
      null, {}, { matchedAddress: '', coordinates: { x: -73.2, y: 40.1 } },
      { matchedAddress: 'Out of bounds', coordinates: { x: -181, y: 91 } },
      { matchedAddress: 'String coordinates', coordinates: { x: '-73.2', y: '40.1' } },
      { matchedAddress: 'Missing coordinate', coordinates: { x: -73.2 } },
    ] } })
    if (query === 'Single match') return Response.json({ result: { addressMatches: [
      { matchedAddress: '456 OAK ST, SPRINGFIELD, NY, 12345', coordinates: { x: -72.3, y: 41.2 } },
    ] } })
    return Response.json({ result: { addressMatches: [
      { matchedAddress: '123 Main St, Springfield', coordinates: { x: -73.2, y: 40.1 } },
      { matchedAddress: '123 Main Street, Other City', coordinates: { x: -74.3, y: 41.2 } },
      { matchedAddress: 'Invalid partial match', coordinates: { x: -74.3, y: 95 } },
    ] } })
  }
  if (url.hostname === 'ai.example.com') {
    assert.equal(request.headers.get('authorization'), ['Bearer', 'test-ai-key'].join(' '))
    aiCalls.push(await request.json() as typeof aiCalls[number])
    if (aiFailures > 0) { aiFailures--; return new Response('unavailable', { status: 503 }) }
    if (aiOversized) return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        aiBodyChunks++
        if (aiBodyChunks > 20) controller.close()
        else controller.enqueue(new Uint8Array(25000).fill(120))
      },
      cancel() { aiBodyCancelled = true },
    }))
    return Response.json({ result: 'Advisory analysis only. No writes.' })
  }
  throw new Error(`Unexpected upstream ${url.hostname}`)
}
let publicJwk: JsonWebKey
async function token(sub: string, overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: `${sub}@example.com`, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer).setAudience('test-audience')
    .setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(privateKey)
}
async function api<T>(path: string, method = 'GET', value?: unknown, who = 'alice', extra: Record<string, string> = {}): Promise<{ status: number; data: T; res: Response }> {
  const res = await mf.dispatchFetch(`${origin}/api/${path}`, {
    method, headers: { 'Cf-Access-Jwt-Assertion': tokens[who] ?? who, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...extra },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
  return { status: res.status, data: await res.json() as T, res: res as unknown as Response }
}
async function createProperty(name = 'Draft', extras = {}): Promise<Property> {
  const result = await api<Property>('properties', 'POST', { name, enteredAddress: '123 Main', binId: bin.id, tags: ['lead'], attributes: { price: 100, active: true }, ...extras })
  assert.equal(result.status, 201, JSON.stringify(result.data))
  return result.data
}
async function applyMigrations(database: { prepare(sql: string): { run(): Promise<unknown> } }) {
  const directory = new URL('../migrations/', import.meta.url)
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(name, directory), 'utf8')
    // D1's exec helper splits on newlines; prepared statements preserve multi-line trigger bodies.
    for (const sql of migration.match(/CREATE TRIGGER[\s\S]*?END;|(?:PRAGMA|CREATE TABLE|CREATE INDEX|DROP TRIGGER|ALTER TABLE|INSERT|UPDATE)[\s\S]*?;/g)!) await database.prepare(sql).run()
  }
}

before(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  publicJwk = await exportJWK(pair.publicKey)
  tokens = { alice: await token('alice'), bob: await token('bob') }
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
  runtimeDirectory = await mkdtemp(join(process.cwd(), 'worker/.backend-test-runtime-'))
  const assetFiles = new Map([
    ['/', await readFile(new URL('../index.html', import.meta.url), 'utf8')],
    ['/app.css', await readFile(new URL('../src/style.css', import.meta.url), 'utf8')],
  ])
  mf = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-02', d1Databases: ['DB'],
    serviceBindings: { ASSETS: (request: Request) => {
      const path = new URL(request.url).pathname
      const content = assetFiles.get(path)
      return new Response(content ?? 'Not found', {
        status: content === undefined ? 404 : 200,
        headers: { 'Content-Type': path === '/app.css' ? 'text/css' : 'text/html' },
      })
    } },
    bindings: { ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience', APP_ORIGIN: origin,
      ADDRESS_TOKEN_SECRET: signingSecret, AI_ENDPOINT: 'https://ai.example.com/analyze', AI_API_KEY: 'test-ai-key' },
    outboundService: upstream as never,
  }), resourceTmpPath: join(runtimeDirectory, 'main') })
  db = await mf.getD1Database('DB') as unknown as D1Database
  await applyMigrations(db)
  env = { DB: db, ASSETS: {} as Fetcher, AI_ENDPOINT: 'https://ai.example.com/analyze', AI_API_KEY: 'test-ai-key' }
  user = (await api<User>('me')).data
  bin = (await api<Bin[]>('bins')).data[0]
})
after(async () => {
  try { await mf?.dispose() } finally {
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true })
  }
})

test('Access verifies JWTs and isolates owners; cross-origin and forged headers fail closed', async () => {
  const me = await api<User>('me')
  assert.equal(me.status, 200); assert.equal(me.data.stamp, user.stamp)
  assert.equal(me.res.headers.get('cache-control'), 'no-store')
  assert.equal((await api('me', 'GET', undefined, 'not-a-token')).status, 401)
  const wrongAudience = await new SignJWT({ email: 'alice@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience('wrong').setSubject('alice').setIssuedAt().setExpirationTime('1h').sign(privateKey)
  assert.equal((await api('me', 'GET', undefined, wrongAudience)).status, 401)
  const expired = await new SignJWT({ email: 'alice@example.com' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience('test-audience').setSubject('alice').setIssuedAt().setExpirationTime('1s').setExpirationTime(1).sign(privateKey)
  assert.equal((await api('me', 'GET', undefined, expired)).status, 401)
  assert.equal((await api('bins', 'POST', { name: 'Blocked', color: '#ffffff' }, 'alice', { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await api('bins', 'POST', { name: 'Blocked', color: '#ffffff' }, 'alice', { 'Content-Type': 'text/plain' })).status, 415)
  const p = await createProperty('Private')
  assert.equal((await api(`properties/${p.id}`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 1, name: 'Steal' }, 'bob')).status, 404)
  assert.equal((await api(`properties/${p.id}/notes`, 'POST', { body: 'Steal' }, 'bob')).status, 404)
  assert.equal((await api(`bins/${bin.id}`, 'PATCH', { name: 'Steal' }, 'bob')).status, 404)
  assert.deepEqual((await api<Property[]>('properties', 'GET', undefined, 'bob')).data, [])
  const bobBin = (await api<Bin[]>('bins', 'GET', undefined, 'bob')).data[0]
  assert.equal((await api('properties', 'POST', { name: 'No', enteredAddress: '', binId: bobBin.id })).status, 404)
})

test('production-mode Access authenticates real Worker assets and D1 API without development auth', async () => {
  const validHeaders = { 'Cf-Access-Jwt-Assertion': tokens.alice }
  for (const [path, file] of [['/', '../index.html'], ['/app.css', '../src/style.css']]) {
    const result = await mf.dispatchFetch(`${origin}${path}`, { headers: validHeaders })
    assert.equal(result.status, 200)
    assert.equal(await result.text(), await readFile(new URL(file, import.meta.url), 'utf8'))
    assert.equal(result.headers.get('cache-control'), 'no-store')
  }
  const identity = await api<User>('me')
  assert.equal(identity.status, 200)
  assert.equal(identity.data.id, `${issuer}|alice`)
  assert.ok(await db.prepare('SELECT id FROM users WHERE id=?').bind(identity.data.id).first())

  const wrongIssuer = await new SignJWT({ email: 'alice@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://wrong-team.cloudflareaccess.com')
    .setAudience('test-audience').setSubject('alice').setIssuedAt().setExpirationTime('1h').sign(privateKey)
  const wrongAudience = await new SignJWT({ email: 'alice@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer)
    .setAudience('wrong-audience').setSubject('alice').setIssuedAt().setExpirationTime('1h').sign(privateKey)
  for (const path of ['/', '/app.css', '/api/me']) {
    for (const assertion of [undefined, 'invalid-token', wrongIssuer, wrongAudience]) {
      const result = await mf.dispatchFetch(`${origin}${path}`, {
        headers: assertion === undefined ? {} : { 'Cf-Access-Jwt-Assertion': assertion },
      })
      assert.equal(result.status, 401, `${path}: ${assertion === undefined ? 'missing' : 'invalid'} assertion`)
    }
  }
})

test('request byte limits are enforced before JSON decoding', async () => {
  for (const raw of ['{'.repeat(100001), JSON.stringify({ name: 'é'.repeat(50000), color: '#123456' })]) {
    const result = await mf.dispatchFetch(`${origin}/api/bins`, {
      method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': tokens.alice, Origin: origin, 'Content-Type': 'application/json' }, body: raw,
    })
    assert.equal(result.status, 413)
  }
  const malformed = await mf.dispatchFetch(`${origin}/api/bins`, {
    method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': tokens.alice, Origin: origin, 'Content-Type': 'application/json' }, body: '{',
  })
  assert.equal(malformed.status, 400)
})

test('optimistic property updates are atomic, author stamps immutable, history and notes append-only', async () => {
  const p = await createProperty('Concurrent')
  const writes = await Promise.all([
    api<Property>(`properties/${p.id}`, 'PATCH', { version: 1, name: 'First' }),
    api<Property>(`properties/${p.id}`, 'PATCH', { version: 1, name: 'Second' }),
  ])
  assert.deepEqual(writes.map(w => w.status).sort(), [200, 409])
  const d = (await api<Detail>(`properties/${p.id}`)).data
  assert.equal(d.property.version, 2)
  assert.equal(d.property.creatorStamp, user.stamp)
  assert.equal(d.property.creatorId, p.creatorId)
  assert.equal(d.property.createdAt, p.createdAt)
  assert.equal(d.history.length, 2)
  assert.equal(d.history.filter(h => h.action === 'updated').length, 1)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 2, creatorId: 'bob' })).status, 400)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 9007199254740992, name: 'Unsafe version' })).status, 400)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 1.5, name: 'Fractional version' })).status, 400)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 0, name: 'Zero version' })).status, 400)
  await api(`properties/${p.id}/notes`, 'POST', { body: '<script>alert(1)</script> is inert text' })
  const next = (await api<Detail>(`properties/${p.id}`)).data
  assert.equal(next.notes[0].actorStamp, user.stamp)
  assert.equal(next.history.length, 3)
  await assert.rejects(db.prepare("UPDATE properties SET creator_id='bob' WHERE id=?").bind(p.id).run(), /immutable property/)
  await assert.rejects(db.prepare("UPDATE property_history SET action='forged' WHERE property_id=?").bind(p.id).run(), /append-only/)
  await assert.rejects(db.prepare('DELETE FROM property_history WHERE property_id=?').bind(p.id).run(), /append-only/)
  await assert.rejects(db.prepare("UPDATE notes SET body='forged' WHERE property_id=?").bind(p.id).run(), /append-only/)
})

test('explicit viewer/editor grants allow collaboration while preserving the original creator and owner bin scope', async () => {
  const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
  const p = await createProperty('Explicit collaboration')
  const bobBin = (await api<Bin[]>('bins', 'GET', undefined, 'bob')).data[0]
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'viewer' }, 'bob')).status, 404)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: 'unknown-user', role: 'editor' })).status, 404)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'owner' })).status, 400)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: 'system:scheduler', role: 'editor' })).status, 400)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'viewer' })).status, 201)
  assert.equal((await api(`properties/${p.id}`, 'GET', undefined, 'bob')).status, 200)
  assert.equal((await api<Property[]>('properties', 'GET', undefined, 'bob')).data.some(record => record.id === p.id), true)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 1, name: 'Viewer cannot edit' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/notes`, 'POST', { body: 'Viewer cannot annotate' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/reminders`, 'POST', { title: 'Blocked', dueAt: '2030-01-01T00:00Z', timeZone: 'UTC' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/ai`, 'POST', { fields: ['name'], idempotencyKey: 'blocked' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/ai-rule`, 'PUT', { enabled: true, triggers: ['creation'], watchedFields: [], fields: ['name'] }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/members`, 'GET', undefined, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' })).status, 201)
  assert.equal((await api<Bin[]>(`properties/${p.id}/bins`, 'GET', undefined, 'bob')).data.some(b => b.id === bin.id), true)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 1, binId: bobBin.id }, 'bob')).status, 404)
  const edit = await api<Property>(`properties/${p.id}`, 'PATCH', { version: 1, name: 'Editor changed it', binId: bin.id }, 'bob')
  assert.equal(edit.status, 200)
  assert.equal(edit.data.creatorId, user.id); assert.equal(edit.data.creatorStamp, user.stamp); assert.equal(edit.data.creatorName, user.name)
  assert.equal(edit.data.createdAt, p.createdAt); assert.equal(edit.data.updatedBy, bob.id)
  const authorNote = await api(`properties/${p.id}/notes`, 'POST', { body: 'Original author note' })
  assert.equal(authorNote.status, 201)
  const editorNote = await api(`properties/${p.id}/notes`, 'POST', { body: 'Editor note' }, 'bob')
  assert.equal(editorNote.status, 201)
  const reminder = (await api<Reminder>(`properties/${p.id}/reminders`, 'POST', { title: 'Original author reminder', dueAt: '2030-01-01T00:00Z', timeZone: 'UTC' })).data
  const editedReminder = await api<Reminder>(`properties/${p.id}/reminders/${reminder.id}`, 'PATCH', { title: 'Editor changed reminder' }, 'bob')
  assert.equal(editedReminder.status, 200); assert.equal(editedReminder.data.createdBy, user.id)
  assert.equal((await api(`properties/${p.id}/ai-rule`, 'PUT', { enabled: true, triggers: ['field_change'], watchedFields: ['name'], fields: ['name'] }, 'bob')).status, 200)
  const manualJob = await api<AIJob>(`properties/${p.id}/ai`, 'POST', { fields: ['name'], idempotencyKey: 'editor-authorized' }, 'bob')
  assert.equal(manualJob.status, 202)
  const d = (await api<Detail>(`properties/${p.id}`, 'GET', undefined, 'bob')).data
  assert.equal(d.aiJobs.some(job => job.id === manualJob.data.id), true)
  assert.equal((await api<Detail>(`properties/${p.id}`)).data.aiJobs.some(job => job.id === manualJob.data.id), true)
  assert.equal(d.notes[0].actorStamp, user.stamp)
  assert.equal(d.notes[1].actorStamp, bob.stamp)
  assert.equal(d.history.find(h => h.action === 'updated')!.actorStamp, bob.stamp)
  assert.equal(d.history.filter(h => h.action === 'reminder_updated').at(-1)!.actorId, bob.id)
  assert.equal(d.history.find(h => h.action === 'ai_rule_initialized')!.actorId, bob.id)
  assert.equal(d.history.find(h => h.action === 'ai_job_requested')!.actorId, bob.id)
  assert.equal((await api(`properties/${p.id}/members`, 'POST', { userId: user.id, role: 'viewer' }, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE', undefined, 'bob')).status, 403)
  assert.equal((await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')).status, 200)
  assert.equal((await api(`properties/${p.id}`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api(`properties/${p.id}/bins`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api<Property[]>('properties', 'GET', undefined, 'bob')).data.some(record => record.id === p.id), false)
  assert.equal((await api<Detail>(`properties/${p.id}`)).data.history.some(h => h.action === 'member_removed'), true)
})

test('entered drafts are preserved; only explicitly selected signed provider candidates get coordinates', async () => {
  const p = await createProperty('Address draft')
  assert.equal(p.enteredAddress, '123 Main'); assert.equal(p.verificationStatus, 'unverified'); assert.equal(p.latitude, null)
  assert.equal((await api('properties', 'POST', { name: 'Forged', enteredAddress: 'x', binId: bin.id, latitude: 42, verificationStatus: 'verified' })).status, 400)
  const search = await api<{ candidates: AddressCandidate[]; message: string }>('addresses/search', 'POST', { query: '123 Main' })
  assert.equal(search.status, 200)
  assert.equal(search.data.candidates.length, 2)
  assert.equal(search.data.candidates[0].verified, true)
  assert.equal(search.data.candidates[1].verified, true)
  assert.match(search.data.message, /street-interpolated.*not rooftop.*legal address validation/)
  assert.match(search.data.candidates[0].message, /Explicit selection/)
  const verified = await api<Property>(`properties/${p.id}`, 'PATCH', { version: 1, addressToken: search.data.candidates[0].token })
  assert.equal(verified.status, 200); assert.equal(verified.data.latitude, 40.1); assert.equal(verified.data.enteredAddress, '123 Main')
  assert.equal(verified.data.normalizedAddress, '123 Main St, Springfield')
  const map = (await api<{ propertyId?: string; latitude: number }[]>('layers/properties/features')).data
  assert.equal(map.find(feature => feature.propertyId === p.id)?.latitude, 40.1)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 2, enteredAddress: 'different', addressToken: search.data.candidates[0].token })).status, 400)
  assert.equal((await api(`properties/${p.id}`, 'PATCH', { version: 2, addressToken: 'forged' })).status, 400)
  const bobBins = (await api<Bin[]>('bins', 'GET', undefined, 'bob')).data
  assert.equal((await api('properties', 'POST', { name: 'Borrow token', enteredAddress: '123 Main', binId: bobBins[0].id, addressToken: search.data.candidates[0].token }, 'bob')).status, 400)
  const moved = await api<Property>(`properties/${p.id}`, 'PATCH', { version: 2, enteredAddress: 'Changed' })
  assert.equal(moved.data.latitude, null); assert.equal(moved.data.verificationStatus, 'unverified')
  const secondMatch = await createProperty('Selected second Census match', { addressToken: search.data.candidates[1].token })
  assert.equal(secondMatch.verificationStatus, 'verified'); assert.equal(secondMatch.latitude, 41.2)
  assert.equal((await api<{ propertyId?: string }[]>('layers/properties/features')).data.some(feature => feature.propertyId === secondMatch.id), true)
  const expiredToken = await new SignJWT({ query: '123 Main', normalized: 'Fake', latitude: 1, longitude: 2, verified: true })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuer('reops-address').setAudience('property-selection').setIssuedAt().setExpirationTime(1).sign(new TextEncoder().encode(signingSecret))
  assert.equal((await api('properties', 'POST', { name: 'Expired', enteredAddress: '123 Main', binId: bin.id, addressToken: expiredToken })).status, 400)
})

test('Census cache reuses conservatively normalized queries and canonical single-match aliases without fetching', async () => {
  const count = censusCalls.length
  const query = '  123   main  '
  const cached = await api<{ candidates: AddressCandidate[] }>('addresses/search', 'POST', { query })
  assert.equal(cached.status, 200)
  assert.equal(censusCalls.length, count)
  assert.deepEqual(cached.data.candidates.map(c => c.label), ['123 Main St, Springfield', '123 Main Street, Other City'])
  const selected = await createProperty('Normalized cache hit', { enteredAddress: query, addressToken: cached.data.candidates[0].token })
  assert.equal(selected.enteredAddress, query)
  assert.equal(selected.verificationStatus, 'verified')
  assert.equal((await api('properties', 'POST', { name: 'Cache token mismatch', enteredAddress: '123 Main', binId: bin.id, addressToken: cached.data.candidates[0].token })).status, 400)
  const bobCached = await api<{ candidates: AddressCandidate[] }>('addresses/search', 'POST', { query }, 'bob')
  assert.equal(censusCalls.length, count)
  assert.equal((await api('properties', 'POST', { name: 'Wrong user cached token', enteredAddress: query, binId: bin.id, addressToken: bobCached.data.candidates[0].token })).status, 400)
  const rows = await db.prepare('SELECT * FROM property_gps WHERE normalized_query=? ORDER BY match_order').bind('123 MAIN').all()
  assert.equal(rows.results.length, 2)
  for (const row of rows.results) {
    assert.equal(row.provider, 'US Census Geocoder')
    assert.equal(row.benchmark, 'Public_AR_Current')
    assert.ok(Number.isFinite(Date.parse(row.fetched_at as string)))
  }
  await api('addresses/search', 'POST', { query: 'Single match' })
  const afterSingle = censusCalls.length
  const alias = await api<{ candidates: AddressCandidate[] }>('addresses/search', 'POST', { query: ' 456 oak st, springfield, ny, 12345 ' })
  assert.equal(alias.status, 200)
  assert.equal(alias.data.candidates[0].latitude, 41.2)
  assert.equal(censusCalls.length, afterSingle)
  for (const distinct of ['123 Main #1', '123 Main #2', '123 Main,', '123 Main St']) {
    await api('addresses/search', 'POST', { query: distinct })
    assert.equal(censusCalls.at(-1), distinct)
  }
  assert.equal(censusCalls.length, afterSingle + 4)
})

test('Census no/invalid matches and provider failures never become successful cache entries; drafts remain available', async () => {
  for (const query of ['No matches', 'Invalid matches', 'Provider non-OK', 'Provider redirect', 'Malformed JSON', 'Malformed result', 'Null result']) {
    const beforeCalls = censusCalls.length
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await api<{ candidates?: AddressCandidate[]; message?: string }>('addresses/search', 'POST', { query })
      if (query === 'No matches' || query === 'Invalid matches') {
        assert.equal(result.status, 200)
        assert.deepEqual(result.data.candidates, [])
        assert.match(result.data.message!, /unverified draft/)
      } else {
        assert.equal(result.status, 502)
        assert.match(JSON.stringify(result.data), /draft can still be saved/)
      }
    }
    assert.equal(censusCalls.length, beforeCalls + 2)
    assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM property_gps WHERE normalized_query=?').bind(query.toUpperCase()).first('count'), 0)
    const draft = await createProperty(query, { enteredAddress: query })
    assert.equal(draft.verificationStatus, 'unverified')
    assert.equal(draft.latitude, null)
    assert.equal((await api<{ propertyId?: string }[]>('layers/properties/features')).data.some(feature => feature.propertyId === draft.id), false)
  }
})

test('Census request timeout and network errors are recoverable and do not cache results', async () => {
  const originalFetch = globalThis.fetch
  try {
    for (const failure of [new DOMException('Timed out', 'TimeoutError'), new TypeError('Network unavailable')]) {
      globalThis.fetch = (async (_input, options) => {
        assert.equal(options?.method, 'GET')
        assert.equal(options?.redirect, 'manual')
        assert.ok(options?.signal instanceof AbortSignal)
        throw failure
      }) as typeof fetch
      await assert.rejects(searchAddress({ ...env, ADDRESS_TOKEN_SECRET: signingSecret }, user, 'Timeout query'), /draft can still be saved/)
      assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM property_gps WHERE normalized_query='TIMEOUT QUERY'").first('count'), 0)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('oversized Census response streams are cancelled and never cached', async () => {
  const originalFetch = globalThis.fetch
  let chunks = 0, cancelled = false
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++
        controller.enqueue(new Uint8Array(25000).fill(120))
      },
      cancel() { cancelled = true },
    }))) as typeof fetch
    await assert.rejects(searchAddress({ ...env, ADDRESS_TOKEN_SECRET: signingSecret }, user, 'Oversized query'), /draft can still be saved/)
    assert.equal(cancelled, true)
    assert.ok(chunks <= 6)
    assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM property_gps WHERE normalized_query='OVERSIZED QUERY'").first('count'), 0)
  } finally { globalThis.fetch = originalFetch }
})

test('address selection rejects invalid coordinates and wrong token claims even when signed', async () => {
  const key = new TextEncoder().encode(signingSecret)
  const base = { query: '123 Main', normalized: '123 Main St', verified: true, latitude: 40.1, longitude: -73.2 }
  const badPayloads = [
    { latitude: 91 }, { longitude: -181 }, { latitude: NaN }, { longitude: Infinity },
    { latitude: '40.1' }, { longitude: null }, { normalized: '' }, { verified: 'true' },
  ]
  for (const changes of badPayloads) {
    const signed = await new SignJWT({ ...base, ...changes }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id).setIssuer('reops-address').setAudience('property-selection').setIssuedAt().setExpirationTime('15m').sign(key)
    await assert.rejects(addressSelection({ ...env, ADDRESS_TOKEN_SECRET: signingSecret }, user, '123 Main', signed), /Invalid, expired, or mismatched/)
  }
  for (const claim of ['issuer', 'audience', 'subject', 'expiry', 'issuedAt']) {
    let jwt = new SignJWT(base).setProtectedHeader({ alg: 'HS256' })
      .setSubject(claim === 'subject' ? 'someone-else' : user.id)
      .setIssuer(claim === 'issuer' ? 'wrong' : 'reops-address')
      .setAudience(claim === 'audience' ? 'wrong' : 'property-selection')
    if (claim !== 'issuedAt') jwt = jwt.setIssuedAt()
    if (claim !== 'expiry') jwt = jwt.setExpirationTime('15m')
    const signed = await jwt.sign(key)
    await assert.rejects(addressSelection({ ...env, ADDRESS_TOKEN_SECRET: signingSecret }, user, '123 Main', signed), /Invalid, expired, or mismatched/)
  }
})

test('area lookup requires property access, selected coordinates, and a supported county', async () => {
  const draft = await createProperty('Area lookup draft')
  assert.equal((await api(`properties/${draft.id}/area?county=philadelphia`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api(`properties/${draft.id}/area?county=philadelphia`)).status, 400)
  const search = await api<{ candidates: AddressCandidate[] }>('addresses/search', 'POST', { query: '123 Main' })
  const located = await createProperty('Area lookup selected Census match', { addressToken: search.data.candidates[0].token })
  assert.equal((await api(`properties/${located.id}/area?county=philadelphia`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api(`properties/${located.id}/area?county=unsupported`)).status, 400)
})

test('safe owner-scoped layer configuration and saved preferences persist server-side', async () => {
  const layerInput = { name: 'Owner layer', color: '#12abcd', source: 'layer_points', latitudeField: 'latitude', longitudeField: 'longitude', labelField: 'label', filterableAttributes: ['category'],
    features: [{ label: 'Office', latitude: 1, longitude: 2, attributes: { category: 'office' } }] }
  const created = await api<Layer>('layers', 'POST', layerInput)
  assert.equal(created.status, 201)
  assert.equal((await api('layers', 'POST', { ...layerInput, source: 'users; DROP TABLE users' })).status, 400)
  assert.equal((await api('layers', 'POST', { ...layerInput, labelField: 'owner_id' })).status, 400)
  assert.equal((await api('layers', 'POST', { ...layerInput, features: [{ label: 'Bad', latitude: 91, longitude: 2 }] })).status, 400)
  const features = (await api<{ label: string }[]>(`layers/${created.data.id}/features`)).data
  assert.equal(features[0].label, 'Office')
  assert.equal((await api(`layers/${created.data.id}/features`, 'GET', undefined, 'bob')).status, 404)
  assert.equal((await api<Layer[]>('layers', 'GET', undefined, 'bob')).data.length, 1)
  const view = (await api<SavedView>('view')).data
  view.columns = ['name', 'attributes.price']; view.layers = ['properties', created.data.id]
  assert.equal((await api('view', 'PUT', view)).status, 200)
  assert.deepEqual((await api('view')).data, view)
  assert.notDeepEqual((await api('view', 'GET', undefined, 'bob')).data, view)
  assert.equal((await api('view', 'PUT', { ...view, columns: ['secret'] })).status, 400)
  assert.equal((await api('view', 'PUT', view, 'bob')).status, 400)
})

test('saved bin filters accept shared-owner catalogs without granting bin mutation privileges', async () => {
  const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
  const p = await createProperty('Shared owner bin filter')
  const extra = await api<Bin>('bins', 'POST', { name: 'Shared owner unused stage', color: '#654321' })
  assert.equal(extra.status, 201)
  const view = (await api<SavedView>('view', 'GET', undefined, 'bob')).data
  view.filters.binId = extra.data.id
  assert.equal((await api('view', 'PUT', view, 'bob')).status, 404)
  await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'viewer' })
  assert.equal((await api<Bin[]>(`properties/${p.id}/bins`, 'GET', undefined, 'bob')).data.some(b => b.id === extra.data.id), true)
  assert.equal((await api('view', 'PUT', view, 'bob')).status, 200)
  assert.equal((await api<SavedView>('view', 'GET', undefined, 'bob')).data.filters.binId, extra.data.id)
  assert.equal((await api(`bins/${extra.data.id}`, 'PATCH', { name: 'Cannot manage shared bins' }, 'bob')).status, 404)
  await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
  assert.equal((await api('view', 'PUT', view, 'bob')).status, 404)
  view.filters.binId = (await api<Bin[]>('bins', 'GET', undefined, 'bob')).data[0].id
  assert.equal((await api('view', 'PUT', view, 'bob')).status, 200)
})

test('cron reminder delivery has atomic persisted notifications, stable authors, and no redelivery', async () => {
  const p = await createProperty('Reminders')
  const created = await api<Reminder>(`properties/${p.id}/reminders`, 'POST', { title: 'Call owner', dueAt: '2020-01-01T10:00:00-05:00', timeZone: 'America/New_York' })
  assert.equal(created.status, 201); assert.equal(created.data.dueAt, '2020-01-01T15:00:00.000Z')
  const rid = created.data.id
  assert.equal((await api(`properties/${p.id}/reminders`, 'POST', { title: 'Bad', dueAt: '2026-01-01T10:00', timeZone: 'UTC' })).status, 400)
  assert.equal((await api(`properties/${p.id}/reminders`, 'POST', { title: 'Bad date', dueAt: '2026-02-30T10:00Z', timeZone: 'UTC' })).status, 400)
  for (const invalid of ['2026-02-31T10:00Z', '2026-02-01T25:00Z', '2026-02-01T24:00Z', '2026-02-01T10:61Z', '2026-02-01T10:00:61Z', '2026-02-01T10:00+24:00', '2026-02-01T10:00+01:60', '2026-02-01T10:00+14:01', '2026-02-01T10:00+15:00']) {
    assert.equal((await api(`properties/${p.id}/reminders`, 'POST', { title: 'Invalid components', dueAt: invalid, timeZone: 'UTC' })).status, 400, invalid)
  }
  const utcWithLabel = await api<Reminder>(`properties/${p.id}/reminders`, 'POST', { title: 'UTC with display timezone', dueAt: '2030-02-01T10:00:00.000Z', timeZone: 'America/Los_Angeles' })
  assert.equal(utcWithLabel.status, 201)
  assert.equal(utcWithLabel.data.dueAt, '2030-02-01T10:00:00.000Z')
  assert.equal(utcWithLabel.data.timeZone, 'America/Los_Angeles')
  assert.equal((await api(`properties/${p.id}/reminders`, 'POST', { title: 'Bad', dueAt: '2020-01-01T10:00Z', timeZone: 'Fake/Timezone' })).status, 400)
  assert.equal((await api(`properties/${p.id}/reminders/${rid}`, 'PATCH', { state: 'delivered' })).status, 400)
  assert.equal((await api(`properties/${p.id}/reminders/${rid}`, 'PATCH', { title: 'Steal' }, 'bob')).status, 404)
  const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
  await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' })
  assert.equal((await api(`properties/${p.id}/reminders/${rid}`, 'PATCH', { title: 'Human editor changed title' }, 'bob')).status, 200)
  await Promise.all([scheduledWork(env), scheduledWork(env)])
  await scheduledWork(env)
  const notifications = (await api<Notification[]>('notifications')).data.filter(n => n.propertyId === p.id)
  assert.equal(notifications.length, 1)
  const d = (await api<Detail>(`properties/${p.id}`)).data
  assert.equal(d.reminders[0].state, 'delivered'); assert.equal(d.reminders[0].createdBy, user.id)
  const delivery = d.history.filter(h => h.action === 'reminder_delivered')
  assert.equal(delivery.length, 1)
  assert.equal(delivery[0].actorId, 'system:scheduler')
  assert.equal(delivery[0].actorStamp, 'SYSTEM-SCHEDULER')
  assert.notEqual(delivery[0].actorId, user.id)
  assert.notEqual(delivery[0].actorId, bob.id)
  assert.equal(d.history.find(h => h.action === 'reminder_updated')!.actorId, bob.id)
  assert.deepEqual((await api('notifications', 'GET', undefined, 'bob')).data, [])
  assert.equal((await api(`notifications/${notifications[0].id}`, 'PATCH', { read: true }, 'bob')).status, 404)
  const read = await api<Notification>(`notifications/${notifications[0].id}`, 'PATCH', { read: true })
  const reread = await api<Notification>(`notifications/${notifications[0].id}`, 'PATCH', { read: true })
  assert.equal(read.data.readAt, reread.data.readAt)
  assert.equal((await api(`properties/${p.id}/reminders/${rid}`, 'PATCH', { state: 'scheduled' })).status, 409)
  await assert.rejects(db.prepare("UPDATE reminders SET created_by='bob' WHERE id=?").bind(rid).run(), /immutable reminder/)
  await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
})

test('pending AI execution rechecks collaborator grants and current automatic rule consent before sending', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => upstream(new Request(input, init))) as typeof fetch
  const previousRule = (await api('ai-default-rule')).data
  try {
    aiCalls = []
    const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
    const p = await createProperty('Revoked pending manual analysis')
    await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' })
    const queued = await enqueueManual(env, bob.id, p, ['name'], 'revoked-before-send')
    await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
    await processJobs(env)
    const failed = (await api<Detail>(`properties/${p.id}`)).data.aiJobs.find(job => job.id === queued.id)!
    assert.equal(failed.state, 'failed'); assert.match(failed.error!, /authorization.*revoked/i)
    assert.equal(aiCalls.length, 0)
    assert.equal((await api<Detail>(`properties/${p.id}`)).data.property.version, 1)
    const changedByEditor = await createProperty('Revoked automatic requester')
    await api(`properties/${changedByEditor.id}/ai-rule`, 'PUT', { enabled: true, triggers: ['field_change'], watchedFields: ['name'], fields: ['name'] })
    await api(`properties/${changedByEditor.id}/members`, 'POST', { userId: bob.id, role: 'editor' })
    await api(`properties/${changedByEditor.id}`, 'PATCH', { version: 1, name: 'Editor requested this automatic event' }, 'bob')
    await api(`properties/${changedByEditor.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
    await processJobs(env)
    const revokedAutomatic = (await api<Detail>(`properties/${changedByEditor.id}`)).data
    assert.equal(revokedAutomatic.aiJobs[0].state, 'failed')
    assert.match(revokedAutomatic.aiJobs[0].error!, /authorization.*revoked/i)
    assert.equal(revokedAutomatic.history.find(h => h.action === 'ai_job_requested')!.actorId, bob.id)
    assert.equal(aiCalls.length, 0)

    const enabled = { enabled: true, triggers: ['creation'], watchedFields: [], fields: ['name', 'enteredAddress'] }
    for (const changedRule of [
      { ...enabled, enabled: false },
      { ...enabled, triggers: ['reminder'] },
      { ...enabled, fields: ['name'] },
    ]) {
      await api('ai-default-rule', 'PUT', enabled)
      const auto = await createProperty('Consent changed before automatic send')
      await api(`properties/${auto.id}/ai-rule`, 'PUT', changedRule)
      await processJobs(env)
      const d = (await api<Detail>(`properties/${auto.id}`)).data
      assert.equal(d.aiJobs.length, 1)
      assert.equal(d.aiJobs[0].state, 'failed')
      assert.match(d.aiJobs[0].error!, /rule consent changed/i)
      assert.equal(d.property.version, 1)
      assert.equal(aiCalls.length, 0)
    }
  } finally {
    globalThis.fetch = originalFetch
    await api('ai-default-rule', 'PUT', previousRule)
  }
})

test('revoked recipients cannot retrieve notification titles; persisted notifications remain for later regrants', async () => {
  const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
  const p = await createProperty('Notification grant retention')
  await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' })
  const reminder = await api<Reminder>(`properties/${p.id}/reminders`, 'POST', { title: 'Private event title', dueAt: '2020-01-01T00:00Z', timeZone: 'UTC' }, 'bob')
  assert.equal(reminder.status, 201)
  await scheduledWork(env)
  const notification = (await api<Notification[]>('notifications', 'GET', undefined, 'bob')).data.find(n => n.propertyId === p.id)!
  assert.ok(notification)
  await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
  assert.equal((await api<Notification[]>('notifications', 'GET', undefined, 'bob')).data.some(n => n.propertyId === p.id), false)
  assert.equal((await api(`notifications/${notification.id}`, 'PATCH', { read: true }, 'bob')).status, 404)
  assert.equal((await api(`properties/${p.id}`, 'GET', undefined, 'bob')).status, 404)
  assert.ok(await db.prepare('SELECT id FROM notifications WHERE id=?').bind(notification.id).first())
  await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'viewer' })
  assert.equal((await api<Notification[]>('notifications', 'GET', undefined, 'bob')).data.some(n => n.id === notification.id), true)
  await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
})

test('delivery suppresses new notifications after creator revocation and later owner title edits', async () => {
  const bob = (await api<User>('me', 'GET', undefined, 'bob')).data
  const p = await createProperty('Revoked creator before delivery')
  await api(`properties/${p.id}/members`, 'POST', { userId: bob.id, role: 'editor' })
  const created = await api<Reminder>(`properties/${p.id}/reminders`, 'POST', { title: 'Original collaborator title', dueAt: '2020-01-01T00:00Z', timeZone: 'UTC' }, 'bob')
  assert.equal(created.status, 201)
  await api(`properties/${p.id}/members/${encodeURIComponent(bob.id)}`, 'DELETE')
  const secretTitle = 'Owner-only title changed after creator revocation'
  const edited = await api<Reminder>(`properties/${p.id}/reminders/${created.data.id}`, 'PATCH', { title: secretTitle })
  assert.equal(edited.status, 200)
  assert.equal(edited.data.createdBy, bob.id)
  await Promise.all([scheduledWork(env), scheduledWork(env)])
  const notifications = await api<Notification[]>('notifications', 'GET', undefined, 'bob')
  assert.equal(notifications.status, 200)
  assert.equal(notifications.data.some(n => n.propertyId === p.id || n.title === secretTitle), false)
  assert.equal(await db.prepare('SELECT id FROM notifications WHERE reminder_id=?').bind(created.data.id).first(), null)
  assert.equal((await api(`properties/${p.id}`, 'GET', undefined, 'bob')).status, 404)
  const original = await db.prepare('SELECT created_by,owner_id FROM reminders WHERE id=?').bind(created.data.id).first<{ created_by: string; owner_id: string }>()
  assert.equal(original!.created_by, bob.id)
  assert.equal(original!.owner_id, bob.id)
})

test('AI needs explicit opt-in, creates deduplicated snapshots, never changes records, bounded retry/leases', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => upstream(new Request(input, init))) as typeof fetch
  try {
    const p = await createProperty('AI without opt in')
    assert.equal((await api<Detail>(`properties/${p.id}`)).data.aiJobs.length, 0)
    const r = { enabled: true, triggers: ['creation', 'field_change', 'reminder'], watchedFields: ['name'], fields: ['name'] }
    assert.equal((await api('ai-default-rule', 'PUT', r)).status, 200)
    const defaultHistory = await db.prepare('SELECT actor_id,actor_stamp FROM user_history WHERE owner_id=?').bind(user.id).all<{ actor_id: string; actor_stamp: string }>()
    assert.ok(defaultHistory.results.length > 0)
    assert.equal(defaultHistory.results.every(h => h.actor_id === user.id && h.actor_stamp === user.stamp), true)
    await assert.rejects(db.prepare("UPDATE user_history SET action='forged' WHERE owner_id=?").bind(user.id).run(), /append-only user history/)
    await assert.rejects(db.prepare('DELETE FROM user_history WHERE owner_id=?').bind(user.id).run(), /append-only user history/)
    const automated = await createProperty('AI opt in')
    let jobs = (await api<Detail>(`properties/${automated.id}`)).data.aiJobs
    assert.equal(jobs.length, 1); assert.equal(jobs[0].trigger, 'creation')
    aiCalls = []
    await Promise.all([processJobs(env), processJobs(env)])
    assert.equal(aiCalls.length, 1); assert.deepEqual(aiCalls[0].fields, ['name']); assert.deepEqual(aiCalls[0].record, { name: 'AI opt in' }); assert.deepEqual(aiCalls[0].tools, [])
    let d = (await api<Detail>(`properties/${automated.id}`)).data
    assert.equal(d.aiJobs[0].state, 'successful'); assert.equal(d.property.version, 1)
    assert.equal(d.history.filter(h => h.action === 'created').length, 1)
    assert.equal(d.history.filter(h => h.action === 'updated').length, 0)
    assert.equal(d.history.find(h => h.action === 'ai_job_requested')!.actorId, user.id)
    assert.equal(d.history.filter(h => h.action === 'ai_job_updated').every(h => h.actorId === 'system:ai-executor' && h.actorStamp === 'SYSTEM-AI'), true)
    const unchanged = await api<Property>(`properties/${automated.id}`, 'PATCH', { version: 1, tags: ['new'] })
    assert.equal(unchanged.status, 200)
    assert.equal((await api<Detail>(`properties/${automated.id}`)).data.aiJobs.length, 1)
    aiFailures = 1
    await api(`properties/${automated.id}`, 'PATCH', { version: 2, name: 'Changed authorized field' })
    await processJobs(env)
    jobs = (await api<Detail>(`properties/${automated.id}`)).data.aiJobs
    const retrying = jobs.find(j => j.trigger === 'field_change')!
    assert.equal(retrying.state, 'pending'); assert.equal(retrying.attempts, 1)
    await db.prepare("UPDATE ai_jobs SET next_attempt_at='2020-01-01T00:00:00.000Z' WHERE id=?").bind(retrying.id).run()
    await processJobs(env)
    jobs = (await api<Detail>(`properties/${automated.id}`)).data.aiJobs
    assert.equal(jobs.find(j => j.id === retrying.id)!.state, 'successful')
    assert.equal(jobs.find(j => j.id === retrying.id)!.attempts, 2)
    const reminder = await api<Reminder>(`properties/${automated.id}/reminders`, 'POST', { title: 'AI reminder', dueAt: '2020-01-01T00:00Z', timeZone: 'UTC' })
    assert.equal(reminder.status, 201)
    await Promise.all([scheduledWork(env), scheduledWork(env)])
    await scheduledWork(env)
    d = (await api<Detail>(`properties/${automated.id}`)).data
    assert.equal(d.aiJobs.filter(j => j.trigger === 'reminder').length, 1)
    assert.equal(d.property.version, 3)
    const m1 = await api<AIJob>(`properties/${automated.id}/ai`, 'POST', { fields: ['name'], idempotencyKey: 'manual-once' })
    const m2 = await api<AIJob>(`properties/${automated.id}/ai`, 'POST', { fields: ['name'], idempotencyKey: 'manual-once' })
    assert.equal(m1.status, 202); assert.equal(m1.data.id, m2.data.id)
    assert.equal((await api(`properties/${automated.id}/ai`, 'POST', { fields: ['attributes'], idempotencyKey: 'manual-once' })).status, 409)
    assert.equal((await api(`properties/${automated.id}/ai`, 'POST', { fields: ['creatorId'], idempotencyKey: 'unsafe' })).status, 400)
    assert.equal((await api(`properties/${automated.id}/ai`, 'POST', { fields: ['name'], idempotencyKey: 'steal' }, 'bob')).status, 404)
    await db.prepare("UPDATE ai_jobs SET state='failed',attempts=2 WHERE id=?").bind(m1.data.id).run()
    const retried = await api<AIJob>(`properties/${automated.id}/ai/${m1.data.id}/retry`, 'POST', {})
    assert.equal(retried.status, 202)
    const retryHistory = (await api<Detail>(`properties/${automated.id}`)).data.history.filter(h => h.action === 'ai_job_updated')
    assert.equal(retryHistory.some(h => h.actorId === user.id && (h.after as { id: string; state: string }).id === m1.data.id && (h.after as { state: string }).state === 'pending'), true)
    await db.prepare("UPDATE ai_jobs SET state='failed',attempts=3 WHERE id=?").bind(m1.data.id).run()
    assert.equal((await api(`properties/${automated.id}/ai/${m1.data.id}/retry`, 'POST', {})).status, 409)
    await db.prepare("UPDATE ai_jobs SET state='running',attempts=3,lease_until='2020-01-01T00:00:00.000Z' WHERE id=?").bind(m1.data.id).run()
    await processJobs(env)
    assert.equal((await db.prepare('SELECT state FROM ai_jobs WHERE id=?').bind(m1.data.id).first<{ state: string }>())!.state, 'failed')
    await api('ai-default-rule', 'PUT', { ...r, enabled: false })
  } finally { globalThis.fetch = originalFetch }
})

test('oversized AI provider streams are cancelled before full buffering or decoding', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => upstream(new Request(input, init))) as typeof fetch
  try {
    aiOversized = true; aiBodyCancelled = false; aiBodyChunks = 0
    const p = await createProperty('Oversized provider response')
    const queued = await enqueueManual(env, user.id, p, ['name'], 'oversized-response')
    await processJobs(env)
    assert.equal(aiBodyCancelled, true)
    assert.ok(aiBodyChunks < 20, 'Must stop reading before the entire provider response')
    const d = (await api<Detail>(`properties/${p.id}`)).data
    const job = d.aiJobs.find(j => j.id === queued.id)!
    assert.equal(job.state, 'pending')
    assert.equal(job.attempts, 1)
    assert.equal(job.result, null)
    assert.match(job.error!, /provider request failed/i)
    assert.equal(d.property.version, 1)
  } finally {
    aiOversized = false
    globalThis.fetch = originalFetch
  }
})

test('local development bypass is explicit and impossible on remote requests or configured Access', async () => {
  const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false })
  const localOptions = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-02', d1Databases: ['DB'], bindings: { DEV_AUTH: 'true', APP_ORIGIN: 'http://127.0.0.1:5173' } }
  const local = new Miniflare({ ...convertV4MiniflareOptions(localOptions), resourceTmpPath: `${process.cwd()}/worker/.backend-test-runtime/local` })
  try {
    const localDb = await local.getD1Database('DB')
    await applyMigrations(localDb)
    const localMe = await local.dispatchFetch('http://localhost/api/me')
    assert.equal(localMe.status, 200)
    assert.equal((await localMe.json() as User).id, 'local-developer')
    assert.equal((await local.dispatchFetch('https://remote.example/api/me')).status, 503)
    const forwarded = await local.dispatchFetch('http://127.0.0.1:8787/api/bins', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ name: 'Forwarded Vite mutation', color: '#123456' }),
    })
    assert.equal(forwarded.status, 201)
    const crossSite = await local.dispatchFetch('http://127.0.0.1:8787/api/bins', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Cross-site mutation', color: '#123456' }),
    })
    assert.equal(crossSite.status, 403)
    const unconfiguredPort = await local.dispatchFetch('http://127.0.0.1:8787/api/bins', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5174' }, body: JSON.stringify({ name: 'Unconfigured local origin', color: '#123456' }),
    })
    assert.equal(unconfiguredPort.status, 403)
    const bins = await (await local.dispatchFetch('http://localhost/api/bins')).json() as Bin[]
    const unavailable = await local.dispatchFetch('http://localhost/api/addresses/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"123 Main"}' })
    assert.equal(unavailable.status, 503); assert.match(JSON.stringify(await unavailable.json()), /unverified draft/)
    const draft = await local.dispatchFetch('http://localhost/api/properties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Provider unavailable draft', enteredAddress: 'User input', binId: bins[0].id }) })
    assert.equal(draft.status, 201)
    const draftProperty = await draft.json() as Property
    assert.equal(draftProperty.verificationStatus, 'unverified')
    const unavailableAI = await local.dispatchFetch(`http://localhost/api/properties/${draftProperty.id}/ai`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: ['name'], idempotencyKey: 'missing-provider' }) })
    assert.equal(unavailableAI.status, 503)
    await local.setOptions({ ...convertV4MiniflareOptions({ ...localOptions, bindings: { DEV_AUTH: 'true', APP_ORIGIN: 'https://evil.example' } }), resourceTmpPath: `${process.cwd()}/worker/.backend-test-runtime/local` })
    const remoteConfiguredOrigin = await local.dispatchFetch('http://127.0.0.1:8787/api/bins', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Remote configured origin', color: '#123456' }),
    })
    assert.equal(remoteConfiguredOrigin.status, 403)
    await local.setOptions({ ...convertV4MiniflareOptions({ ...localOptions, bindings: { DEV_AUTH: 'true', ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', ACCESS_AUD: 'test-audience' } }), resourceTmpPath: `${process.cwd()}/worker/.backend-test-runtime/local` })
    assert.equal((await local.dispatchFetch('http://localhost/api/me')).status, 401)
  } finally { await local.dispose() }
})
