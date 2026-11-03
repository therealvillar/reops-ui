import type { AIRule, SavedView } from '../shared/types'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function assert(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new HttpError(status, message)
}
export function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object')
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  assert(Object.keys(value).every(key => allowed.includes(key)), 'Unsupported field')
}
export function text(value: unknown, label: string, max = 200, allowEmpty = false): string {
  assert(typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0), `Invalid ${label}`)
  return value
}
export function color(value: unknown): string {
  const result = text(value, 'color', 7)
  assert(/^#[0-9a-f]{6}$/i.test(result), 'Color must be #RRGGBB')
  return result
}
export function strings(value: unknown, label: string, max = 50): string[] {
  assert(Array.isArray(value) && value.length <= max, `Invalid ${label}`)
  const result = value.map(v => text(v, label, 100))
  assert(new Set(result).size === result.length, `Duplicate ${label}`)
  return result
}
export function attributes(value: unknown) {
  const result = object(value)
  assert(Object.keys(result).length <= 50, 'Too many attributes')
  for (const [key, v] of Object.entries(result)) {
    assert(/^[a-zA-Z][\w -]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key), 'Invalid attribute key')
    assert(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 2000), 'Invalid attribute value')
  }
  return result as Record<string, string | number | boolean | null>
}
export const PROPERTY_FIELDS = ['name', 'enteredAddress', 'normalizedAddress', 'verificationStatus', 'binId', 'tags', 'attributes', 'latitude', 'longitude'] as const
export function aiFields(value: unknown): string[] {
  const fields = strings(value, 'AI fields', 10)
  assert(fields.length > 0 && fields.every(f => PROPERTY_FIELDS.includes(f as typeof PROPERTY_FIELDS[number])), 'Choose supported AI fields')
  return fields
}
export function rule(value: unknown): AIRule {
  const r = object(value)
  keys(r, ['enabled', 'triggers', 'watchedFields', 'fields'])
  assert(typeof r.enabled === 'boolean', 'Invalid rule enabled')
  const triggers = strings(r.triggers, 'triggers', 3)
  assert(triggers.every(t => ['creation', 'field_change', 'reminder'].includes(t)), 'Invalid trigger')
  const watchedFields = strings(r.watchedFields, 'watched fields', 10)
  assert(watchedFields.every(f => PROPERTY_FIELDS.includes(f as typeof PROPERTY_FIELDS[number])), 'Invalid watched field')
  assert(!r.enabled || triggers.length > 0, 'Enabled rules need a trigger')
  assert(!triggers.includes('field_change') || watchedFields.length > 0, 'Field-change rules need watched fields')
  return { enabled: r.enabled, triggers: triggers as AIRule['triggers'], watchedFields, fields: aiFields(r.fields) }
}
export function dueAt(value: unknown): string {
  const raw = text(value, 'dueAt', 40)
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?(Z|[+-](\d\d):(\d\d))$/.exec(raw)
  assert(match, 'dueAt must be an ISO instant with a timezone')
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  assert(month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1], 'Invalid calendar date')
  assert(Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6] ?? 0) <= 59, 'Invalid time components')
  assert(match[8] === 'Z' || (Number(match[9]) <= 14 && Number(match[10]) <= 59 && (Number(match[9]) !== 14 || Number(match[10]) === 0)), 'UTC offset must be within ±14:00')
  assert(Number.isFinite(Date.parse(raw)), 'Invalid dueAt instant')
  return new Date(raw).toISOString()
}
export function timeZone(value: unknown): string {
  const zone = text(value, 'timeZone', 100)
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format() } catch { throw new HttpError(400, 'Invalid IANA timeZone') }
  return zone
}
export const DEFAULT_VIEW: SavedView = {
  columns: ['name', 'enteredAddress', 'binId', 'tags', 'verificationStatus'],
  sorts: [{ field: 'name', direction: 'asc' }],
  filters: { search: '', binId: '', tag: '', attribute: '', value: '' }, layers: ['properties'],
}
export function savedView(value: unknown): SavedView {
  const v = object(value)
  keys(v, ['columns', 'sorts', 'filters', 'layers'])
  const validField = (f: string) => [...PROPERTY_FIELDS, 'createdAt', 'updatedAt', 'creatorStamp', 'creatorName', 'version'].includes(f as never) || /^attributes\.[a-zA-Z][\w -]{0,63}$/.test(f)
  const columns = strings(v.columns, 'columns', 30)
  assert(columns.every(validField), 'Invalid column')
  assert(Array.isArray(v.sorts) && v.sorts.length <= 5, 'Invalid sorts')
  const sorts = v.sorts.map(s => {
    const sort = object(s); keys(sort, ['field', 'direction'])
    const field = text(sort.field, 'sort field', 100)
    assert(validField(field) && (sort.direction === 'asc' || sort.direction === 'desc'), 'Invalid sort')
    return { field, direction: sort.direction as 'asc' | 'desc' }
  })
  const f = object(v.filters); keys(f, ['search', 'binId', 'tag', 'attribute', 'value'])
  return { columns, sorts, filters: {
    search: text(f.search, 'search', 500, true), binId: text(f.binId, 'binId', 300, true),
    tag: text(f.tag, 'tag', 100, true), attribute: text(f.attribute, 'attribute', 100, true),
    value: text(f.value, 'value', 2000, true),
  }, layers: strings(v.layers, 'layers', 50) }
}
