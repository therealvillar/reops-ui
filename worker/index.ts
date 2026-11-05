import type { AIRule, Bin, Detail, Layer, LayerFeature, Note, Property, Reminder, User } from '../shared/types'
import { authenticate, protectOrigin } from './auth'
import { addressSelection, searchAddress } from './address'
import { propertyArea } from './area'
import { enqueueManual, jobModel, processJobs, requireAI, scheduledWork, type JobRow } from './ai'
import { aiFields, assert, attributes, color, DEFAULT_VIEW, dueAt, HttpError, keys, object, rule, savedView, strings, text, timeZone } from './validation'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  APP_ORIGIN?: string
  DEV_AUTH?: string
  ADDRESS_TOKEN_SECRET?: string
  BUCKS_PARCELS_ENABLED?: string
  DELAWARE_ZONING_ENABLED?: string
  AI_ENDPOINT?: string
  AI_API_KEY?: string
}
interface PropertyRow { id: string; owner_id: string; version: number; data: string }
interface ReminderRow {
  id: string; property_id: string; title: string; due_at: string; time_zone: string
  state: Reminder['state']; error: string | null; created_by: string
}
const propertyModel = (row: PropertyRow) => JSON.parse(row.data) as Property
const reminderModel = (r: ReminderRow): Reminder => ({ id: r.id, propertyId: r.property_id, title: r.title, dueAt: r.due_at, timeZone: r.time_zone, state: r.state, error: r.error, createdBy: r.created_by })
const propertyLayer: Layer = { id: 'properties', name: 'Properties', color: '#2563eb', source: 'properties', latitudeField: 'latitude', longitudeField: 'longitude', labelField: 'name', filterableAttributes: ['binId', 'tags', 'verificationStatus'] }
const response = (body: unknown, status = 200) => Response.json(body, { status })
async function body(request: Request) {
  assert(Number(request.headers.get('Content-Length') ?? 0) <= 100000, 'Request body too large', 413)
  const reader = request.body?.getReader()
  assert(reader, 'JSON request body required')
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > 100000) { await reader.cancel(); throw new HttpError(413, 'Request body too large') }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return object(JSON.parse(new TextDecoder().decode(bytes))) } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Invalid JSON')
  }
}
async function accessibleProperty(env: Env, user: User, id: string, edit = false) {
  const row = await env.DB.prepare("SELECT p.id,p.owner_id,p.version,p.data,m.role FROM properties p LEFT JOIN property_members m ON m.property_id=p.id AND m.user_id=? WHERE p.id=? AND (p.owner_id=? OR m.user_id IS NOT NULL)")
    .bind(user.id, id, user.id).first<PropertyRow & { role: 'viewer' | 'editor' | null }>()
  assert(row, 'Property not found', 404)
  assert(!edit || row.owner_id === user.id || row.role === 'editor', 'This property is read-only for your account', 403)
  return propertyModel(row)
}
async function ownedBin(env: Env, user: User, id: unknown, ownerId = user.id) {
  const binId = text(id, 'binId', 300)
  assert(await env.DB.prepare('SELECT id FROM bins WHERE id=? AND owner_id=?').bind(binId, ownerId).first(), 'Bin not found', 404)
  return binId
}
async function listLayers(env: Env, user: User): Promise<Layer[]> {
  const rows = await env.DB.prepare('SELECT id,name,color,source,latitude_field AS latitudeField,longitude_field AS longitudeField,label_field AS labelField,filterable_attributes AS attrs FROM layers WHERE owner_id=? ORDER BY name').bind(user.id).all<Layer & { attrs: string }>()
  return [propertyLayer, ...rows.results.map(({ attrs, ...l }) => ({ ...l, filterableAttributes: JSON.parse(attrs) }))]
}
async function detail(env: Env, user: User, property: Property): Promise<Detail> {
  const id = property.id
  const [notes, history, reminders, jobs, aiRule] = await Promise.all([
    env.DB.prepare('SELECT id,body,actor_id AS actorId,actor_name AS actorName,actor_stamp AS actorStamp,created_at AS createdAt FROM notes WHERE property_id=? ORDER BY created_at,id').bind(id).all<Note>(),
    env.DB.prepare('SELECT id,actor_id AS actorId,actor_name AS actorName,actor_stamp AS actorStamp,action,created_at AS createdAt,before_data,after_data FROM property_history WHERE property_id=? ORDER BY created_at,id').bind(id).all<{ id: string; actorId: string; actorName: string; actorStamp: string; action: string; createdAt: string; before_data: string | null; after_data: string }>(),
    env.DB.prepare('SELECT * FROM reminders WHERE property_id=? ORDER BY due_at').bind(id).all<ReminderRow>(),
    env.DB.prepare('SELECT * FROM ai_jobs WHERE property_id=? ORDER BY created_at DESC').bind(id).all<JobRow>(),
    env.DB.prepare('SELECT rule_json FROM ai_rules WHERE property_id=?').bind(id).first<{ rule_json: string }>(),
  ])
  return { property, notes: notes.results, history: history.results.map(({ before_data, after_data, ...h }) => ({ ...h, before: before_data ? JSON.parse(before_data) : null, after: JSON.parse(after_data) })),
    reminders: reminders.results.map(reminderModel), aiJobs: jobs.results.map(jobModel), aiRule: aiRule ? JSON.parse(aiRule.rule_json) : null }
}
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) {
    // The SPA and all API data use the same fail-closed identity gate.
    await authenticate(request, env)
    return env.ASSETS.fetch(request)
  }
  protectOrigin(request, env)
  const user = await authenticate(request, env)
  const parts = url.pathname.slice(5).split('/').map(p => decodeURIComponent(p))
  const [resource, id, sub, subId, action] = parts
  const method = request.method
  if (resource === 'me' && parts.length === 1 && method === 'GET') return response(user)
  if (resource === 'bins' && !sub) {
    if (!id && method === 'GET') return response((await env.DB.prepare('SELECT id,name,color,position FROM bins WHERE owner_id=? ORDER BY position,id').bind(user.id).all<Bin>()).results)
    if (!id && method === 'POST') {
      const b = await body(request); keys(b, ['name', 'color'])
      const bin: Bin = { id: crypto.randomUUID(), name: text(b.name, 'bin name'), color: color(b.color), position: 0 }
      const max = await env.DB.prepare('SELECT COALESCE(MAX(position),-1)+1 AS position FROM bins WHERE owner_id=?').bind(user.id).first<{ position: number }>()
      bin.position = max!.position
      await env.DB.prepare('INSERT INTO bins(id,owner_id,name,color,position) VALUES(?,?,?,?,?)').bind(bin.id, user.id, bin.name, bin.color, bin.position).run()
      return response(bin, 201)
    }
    if (id && method === 'PATCH') {
      const old = await env.DB.prepare('SELECT id,name,color,position FROM bins WHERE id=? AND owner_id=?').bind(id, user.id).first<Bin>()
      assert(old, 'Bin not found', 404)
      const b = await body(request); keys(b, ['name', 'color', 'position'])
      if (b.name !== undefined) old.name = text(b.name, 'bin name')
      if (b.color !== undefined) old.color = color(b.color)
      if (b.position !== undefined) { assert(Number.isInteger(b.position) && Number(b.position) >= 0 && Number(b.position) <= 100000, 'Invalid position'); old.position = b.position as number }
      await env.DB.prepare('UPDATE bins SET name=?,color=?,position=? WHERE id=? AND owner_id=?').bind(old.name, old.color, old.position, id, user.id).run()
      return response(old)
    }
  }
  if (resource === 'properties') {
    if (!id && method === 'GET') return response((await env.DB.prepare('SELECT p.id,p.owner_id,p.version,p.data FROM properties p WHERE p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=?) ORDER BY p.created_at DESC,p.id').bind(user.id, user.id).all<PropertyRow>()).results.map(propertyModel))
    if (!id && method === 'POST') {
      const b = await body(request); keys(b, ['name', 'enteredAddress', 'binId', 'tags', 'attributes', 'addressToken'])
      const enteredAddress = text(b.enteredAddress, 'enteredAddress', 1000, true)
      const selected = await addressSelection(env, user, enteredAddress, b.addressToken)
      const now = new Date().toISOString()
      const p: Property = { id: crypto.randomUUID(), name: text(b.name, 'name'), enteredAddress, ...selected, binId: await ownedBin(env, user, b.binId),
        tags: strings(b.tags ?? [], 'tags'), attributes: attributes(b.attributes ?? {}), creatorId: user.id, creatorStamp: user.stamp, creatorName: user.name,
        createdAt: now, updatedBy: user.id, updatedAt: now, version: 1 }
      await env.DB.prepare('INSERT INTO properties(id,owner_id,bin_id,creator_id,created_at,updated_by,updated_at,version,data) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(p.id, user.id, p.binId, user.id, now, user.id, now, 1, JSON.stringify(p)).run()
      return response(p, 201)
    }
    if (id) {
      const p = await accessibleProperty(env, user, id, !['GET', 'HEAD'].includes(method))
      if (sub === 'area' && parts.length === 3 && method === 'GET') return response(await propertyArea(p, url.searchParams.get('county'), env))
      if (sub === 'bins' && !subId && method === 'GET') return response((await env.DB.prepare('SELECT id,name,color,position FROM bins WHERE owner_id=? ORDER BY position,id').bind(p.creatorId).all<Bin>()).results)
      if (sub === 'members' && !action) {
        assert(p.creatorId === user.id, 'Only the property owner can manage access', 403)
        if (!subId && method === 'GET') return response((await env.DB.prepare('SELECT m.user_id AS userId,u.name,u.stamp,m.role FROM property_members m JOIN users u ON u.id=m.user_id WHERE m.property_id=? ORDER BY u.name,m.user_id').bind(id).all()).results)
        if (!subId && method === 'POST') {
          const b = await body(request); keys(b, ['userId', 'role'])
          const memberId = text(b.userId, 'userId', 500)
          assert(memberId !== user.id, 'The owner already has full access')
          assert(!memberId.startsWith('system:'), 'System actors cannot receive login grants')
          assert(b.role === 'viewer' || b.role === 'editor', 'Role must be viewer or editor')
          assert(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(memberId).first(), 'User not found. Ask them to sign in and copy their stable user ID first.', 404)
          await env.DB.prepare('INSERT INTO property_members(property_id,user_id,role) VALUES(?,?,?) ON CONFLICT(property_id,user_id) DO UPDATE SET role=excluded.role').bind(id, memberId, b.role).run()
          return response(await env.DB.prepare('SELECT m.user_id AS userId,u.name,u.stamp,m.role FROM property_members m JOIN users u ON u.id=m.user_id WHERE m.property_id=? AND m.user_id=?').bind(id, memberId).first(), 201)
        }
        if (subId && method === 'DELETE') {
          if (request.body) { const b = await body(request); keys(b, []) }
          const removed = await env.DB.prepare('DELETE FROM property_members WHERE property_id=? AND user_id=? RETURNING user_id').bind(id, subId).first()
          assert(removed, 'Membership not found', 404)
          return response({ removed: true })
        }
      }
      if (!sub && method === 'GET') return response(await detail(env, user, p))
      if (!sub && method === 'PATCH') {
        const b = await body(request); keys(b, ['version', 'name', 'enteredAddress', 'binId', 'tags', 'attributes', 'addressToken'])
        assert(Object.keys(b).some(key => key !== 'version'), 'Include at least one changed field')
        assert(Number.isSafeInteger(b.version) && Number(b.version) > 0 && Number(b.version) < Number.MAX_SAFE_INTEGER, 'A safe positive version with room to increment is required')
        assert(p.version === b.version, 'Property changed. Reload before saving.', 409)
        const next = { ...p }
        if (b.name !== undefined) next.name = text(b.name, 'name')
        if (b.enteredAddress !== undefined) next.enteredAddress = text(b.enteredAddress, 'enteredAddress', 1000, true)
        if (b.binId !== undefined) next.binId = await ownedBin(env, user, b.binId, p.creatorId)
        if (b.tags !== undefined) next.tags = strings(b.tags, 'tags')
        if (b.attributes !== undefined) next.attributes = attributes(b.attributes)
        if (next.enteredAddress !== p.enteredAddress || b.addressToken !== undefined) Object.assign(next, await addressSelection(env, user, next.enteredAddress, b.addressToken))
        next.version++; next.updatedBy = user.id; next.updatedAt = new Date().toISOString()
        const updated = await env.DB.prepare("UPDATE properties SET bin_id=?,updated_by=?,updated_at=?,version=?,data=? WHERE id=? AND owner_id=? AND version=? AND (owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=properties.id AND m.user_id=? AND m.role='editor')) RETURNING id,owner_id,version,data")
          .bind(next.binId, user.id, next.updatedAt, next.version, JSON.stringify(next), id, p.creatorId, b.version, user.id, user.id).first<PropertyRow>()
        assert(updated, 'Property changed. Reload before saving.', 409)
        return response(propertyModel(updated))
      }
      if (sub === 'notes' && !subId && method === 'POST') {
        const b = await body(request); keys(b, ['body'])
        const noteId = crypto.randomUUID()
        const note = await env.DB.prepare("INSERT INTO notes(id,property_id,body,actor_id,actor_name,actor_stamp) SELECT ?,p.id,?,?,?,? FROM properties p WHERE p.id=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor')) RETURNING id,body,actor_id AS actorId,actor_name AS actorName,actor_stamp AS actorStamp,created_at AS createdAt")
          .bind(noteId, text(b.body, 'note body', 10000), user.id, user.name, user.stamp, id, user.id, user.id).first()
        assert(note, 'Property access changed; reload', 403)
        return response(note, 201)
      }
      if (sub === 'reminders' && !action) {
        if (!subId && method === 'POST') {
          const b = await body(request); keys(b, ['title', 'dueAt', 'timeZone'])
          const reminderId = crypto.randomUUID()
          const reminder = await env.DB.prepare("INSERT INTO reminders(id,property_id,owner_id,title,due_at,time_zone,created_by,updated_by) SELECT ?,p.id,?,?,?,?,?,? FROM properties p WHERE p.id=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor')) RETURNING *")
            .bind(reminderId, user.id, text(b.title, 'reminder title', 500), dueAt(b.dueAt), timeZone(b.timeZone), user.id, user.id, id, user.id, user.id).first<ReminderRow>()
          assert(reminder, 'Property access changed; reload', 403)
          return response(reminderModel(reminder), 201)
        }
        if (subId && method === 'PATCH') {
          const old = await env.DB.prepare('SELECT * FROM reminders WHERE id=? AND property_id=?').bind(subId, id).first<ReminderRow>()
          assert(old, 'Reminder not found', 404)
          const b = await body(request); keys(b, ['title', 'dueAt', 'timeZone', 'state'])
          assert(Object.keys(b).length > 0, 'Include at least one reminder field')
          const assignments: string[] = []
          const values: unknown[] = []
          if (b.title !== undefined) { assignments.push('title=?'); values.push(text(b.title, 'reminder title', 500)) }
          if (b.dueAt !== undefined) { assignments.push('due_at=?'); values.push(dueAt(b.dueAt)) }
          if (b.timeZone !== undefined) { assignments.push('time_zone=?'); values.push(timeZone(b.timeZone)) }
          if (b.state !== undefined) {
            assert(['completed', 'cancelled', 'scheduled'].includes(b.state as string), 'Only scheduled, completed, or cancelled can be selected; delivery is server-controlled')
            assert(!(old.state === 'delivered' && b.state === 'scheduled'), 'Create a new reminder to schedule another delivery', 409)
            const delivered = await env.DB.prepare('SELECT id FROM notifications WHERE reminder_id=?').bind(subId).first()
            assert(!(delivered && b.state === 'scheduled'), 'Create a new reminder to schedule another delivery', 409)
            assignments.push('state=?', 'error=NULL')
            values.push(b.state)
          }
          assignments.push('updated_by=?')
          values.push(user.id, subId, id, user.id, user.id)
          const stateGuard = b.state === undefined ? '' : ' AND state=?'
          if (b.state !== undefined) values.push(old.state)
          const updated = await env.DB.prepare(`UPDATE reminders SET ${assignments.join(',')} WHERE id=? AND property_id=? AND EXISTS(SELECT 1 FROM properties p WHERE p.id=reminders.property_id AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor')))${stateGuard} RETURNING *`)
            .bind(...values).first<ReminderRow>()
          assert(updated, b.state === undefined ? 'Property access changed; reload' : 'Reminder state changed. Reload before saving.', b.state === undefined ? 403 : 409)
          return response(reminderModel(updated))
        }
      }
      if (sub === 'ai-rule' && !subId && method === 'PUT') {
        const r = rule(await body(request))
        const saved = await env.DB.prepare("INSERT INTO ai_rules(property_id,owner_id,rule_json,updated_by) SELECT p.id,p.owner_id,?,? FROM properties p WHERE p.id=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor')) ON CONFLICT(property_id) DO UPDATE SET rule_json=excluded.rule_json,updated_by=excluded.updated_by RETURNING property_id")
          .bind(JSON.stringify(r), user.id, id, user.id, user.id).first()
        assert(saved, 'Property access changed; reload', 403)
        return response(r)
      }
      if (sub === 'ai' && !subId && method === 'POST') {
        const b = await body(request); keys(b, ['fields', 'idempotencyKey'])
        const job = await enqueueManual(env, user.id, p, aiFields(b.fields), text(b.idempotencyKey, 'idempotencyKey', 100))
        ctx.waitUntil(processJobs(env))
        return response(job, 202)
      }
      if (sub === 'ai' && subId && action === 'retry' && parts.length === 5 && method === 'POST') {
        const b = await body(request); keys(b, [])
        requireAI(env)
        const old = await env.DB.prepare('SELECT * FROM ai_jobs WHERE id=? AND property_id=?').bind(subId, id).first<JobRow>()
        assert(old, 'AI job not found', 404)
        assert(old.state === 'failed' && old.attempts < 3, 'Only failed jobs with remaining attempts can be retried', 409)
        const updated = await env.DB.prepare("UPDATE ai_jobs SET state='pending',error=NULL,next_attempt_at=NULL,updated_by=? WHERE id=? AND property_id=? AND state='failed' AND attempts<3 AND EXISTS(SELECT 1 FROM properties p WHERE p.id=ai_jobs.property_id AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=? AND m.role='editor'))) RETURNING *").bind(user.id, subId, id, user.id, user.id).first<JobRow>()
        assert(updated, 'Job changed; reload', 409)
        ctx.waitUntil(processJobs(env))
        return response(jobModel(updated), 202)
      }
    }
  }
  if (resource === 'addresses' && id === 'search' && parts.length === 2 && method === 'POST') {
    const b = await body(request); keys(b, ['query'])
    return response(await searchAddress(env, user, text(b.query, 'address query', 1000)))
  }
  if (resource === 'view' && parts.length === 1) {
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT view_json FROM preferences WHERE owner_id=?').bind(user.id).first<{ view_json: string | null }>()
      return response(row?.view_json ? JSON.parse(row.view_json) : DEFAULT_VIEW)
    }
    if (method === 'PUT') {
      const v = savedView(await body(request)), available = await listLayers(env, user)
      assert(v.layers.every(id => available.some(l => l.id === id)), 'Unknown view layer')
      if (v.filters.binId) {
        const visible = await env.DB.prepare('SELECT b.id FROM bins b WHERE b.id=? AND (b.owner_id=? OR EXISTS(SELECT 1 FROM properties p JOIN property_members m ON m.property_id=p.id WHERE p.owner_id=b.owner_id AND m.user_id=?))')
          .bind(v.filters.binId, user.id, user.id).first()
        assert(visible, 'Bin not found', 404)
      }
      await env.DB.prepare('INSERT INTO preferences(owner_id,view_json) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET view_json=excluded.view_json').bind(user.id, JSON.stringify(v)).run()
      return response(v)
    }
  }
  if (resource === 'ai-default-rule' && parts.length === 1) {
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT default_ai_rule FROM preferences WHERE owner_id=?').bind(user.id).first<{ default_ai_rule: string | null }>()
      return response(row?.default_ai_rule ? JSON.parse(row.default_ai_rule) : { enabled: false, triggers: ['creation'], watchedFields: [], fields: ['name', 'enteredAddress'] } satisfies AIRule)
    }
    if (method === 'PUT') {
      const r = rule(await body(request))
      await env.DB.prepare('INSERT INTO preferences(owner_id,default_ai_rule) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET default_ai_rule=excluded.default_ai_rule').bind(user.id, JSON.stringify(r)).run()
      return response(r)
    }
  }
  if (resource === 'layers') {
    if (!id && method === 'GET') return response(await listLayers(env, user))
    if (!id && method === 'POST') {
      const b = await body(request); keys(b, ['name', 'color', 'source', 'latitudeField', 'longitudeField', 'labelField', 'filterableAttributes', 'features'])
      assert(b.source === 'layer_points' && b.latitudeField === 'latitude' && b.longitudeField === 'longitude' && b.labelField === 'label', 'Only the owner-scoped layer_points source and whitelisted latitude/longitude/label columns are supported')
      const filterable = strings(b.filterableAttributes ?? ['category', 'status'], 'filterable attributes', 2)
      assert(filterable.every(f => ['category', 'status'].includes(f)), 'Unsupported layer attribute')
      const layer: Layer = { id: crypto.randomUUID(), name: text(b.name, 'layer name'), color: color(b.color), source: 'layer_points', latitudeField: 'latitude', longitudeField: 'longitude', labelField: 'label', filterableAttributes: filterable }
      assert(b.features === undefined || (Array.isArray(b.features) && b.features.length <= 200), 'At most 200 layer features')
      const inserts = [env.DB.prepare('INSERT INTO layers(id,owner_id,name,color,source,latitude_field,longitude_field,label_field,filterable_attributes) VALUES(?,?,?,?,?,?,?,?,?)').bind(layer.id, user.id, layer.name, layer.color, layer.source, layer.latitudeField, layer.longitudeField, layer.labelField, JSON.stringify(filterable))]
      for (const feature of (b.features ?? []) as unknown[]) {
        const f = object(feature); keys(f, ['label', 'latitude', 'longitude', 'attributes'])
        assert(typeof f.latitude === 'number' && Number.isFinite(f.latitude) && Math.abs(f.latitude) <= 90 && typeof f.longitude === 'number' && Number.isFinite(f.longitude) && Math.abs(f.longitude) <= 180, 'Invalid feature coordinates')
        const a = object(f.attributes ?? {}); keys(a, ['category', 'status'])
        const category = a.category === undefined || a.category === null ? null : text(a.category, 'category', 200)
        const status = a.status === undefined || a.status === null ? null : text(a.status, 'status', 200)
        inserts.push(env.DB.prepare('INSERT INTO layer_points(id,layer_id,owner_id,latitude,longitude,label,category,status) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), layer.id, user.id, f.latitude, f.longitude, text(f.label, 'feature label'), category, status))
      }
      await env.DB.batch(inserts)
      return response(layer, 201)
    }
    if (id && sub === 'features' && parts.length === 3 && method === 'GET') {
      if (id === 'properties') {
        const props = (await env.DB.prepare('SELECT p.id,p.owner_id,p.version,p.data FROM properties p WHERE p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=?)').bind(user.id, user.id).all<PropertyRow>()).results.map(propertyModel)
        return response(props.filter(p => p.verificationStatus === 'verified' && p.latitude !== null && p.longitude !== null).map(p => ({
          id: p.id, propertyId: p.id, label: p.name, latitude: p.latitude!, longitude: p.longitude!,
          attributes: { ...p.attributes, binId: p.binId, tags: p.tags.join(', '), verificationStatus: p.verificationStatus },
        } satisfies LayerFeature)))
      }
      const layer = await env.DB.prepare('SELECT id FROM layers WHERE id=? AND owner_id=?').bind(id, user.id).first()
      assert(layer, 'Layer not found', 404)
      const features = await env.DB.prepare('SELECT id,label,latitude,longitude,category,status FROM layer_points WHERE layer_id=? AND owner_id=? ORDER BY id').bind(id, user.id).all<{ id: string; label: string; latitude: number; longitude: number; category: string | null; status: string | null }>()
      return response(features.results.map(({ category, status, ...f }) => ({ ...f, attributes: { category, status } })))
    }
  }
  if (resource === 'notifications' && !sub) {
    if (!id && method === 'GET') return response((await env.DB.prepare('SELECT n.id,n.property_id AS propertyId,n.title,n.created_at AS createdAt,n.read_at AS readAt FROM notifications n WHERE n.owner_id=? AND EXISTS(SELECT 1 FROM properties p WHERE p.id=n.property_id AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=?))) ORDER BY n.created_at DESC,n.id').bind(user.id, user.id, user.id).all()).results)
    if (id && method === 'PATCH') {
      const b = await body(request); keys(b, ['read']); assert(b.read === true, 'read must be true')
      const notification = await env.DB.prepare("UPDATE notifications SET read_at=COALESCE(read_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM properties p WHERE p.id=notifications.property_id AND (p.owner_id=? OR EXISTS(SELECT 1 FROM property_members m WHERE m.property_id=p.id AND m.user_id=?))) RETURNING id,property_id AS propertyId,title,created_at AS createdAt,read_at AS readAt").bind(id, user.id, user.id, user.id).first()
      assert(notification, 'Notification not found', 404)
      return response(notification)
    }
  }
  throw new HttpError(404, 'API route not found')
}
function secureHeaders(res: Response): Response {
  const result = new Response(res.body, res)
  result.headers.set('X-Content-Type-Options', 'nosniff')
  result.headers.set('Referrer-Policy', 'same-origin')
  result.headers.set('X-Frame-Options', 'DENY')
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
  result.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  result.headers.set('Cache-Control', 'no-store')
  return result
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try { return secureHeaders(await route(request, env, ctx)) } catch (error) {
      if (error instanceof HttpError) return secureHeaders(response({ error: error.message }, error.status))
      if (error instanceof URIError) return secureHeaders(response({ error: 'Malformed path' }, 400))
      if (error instanceof Error && /UNIQUE constraint failed: bins/.test(error.message)) return secureHeaders(response({ error: 'A bin with this name already exists' }, 409))
      // Never include database/provider errors or credentials in responses or logs.
      return secureHeaders(response({ error: 'Internal service error' }, 500))
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(scheduledWork(env)) },
}
