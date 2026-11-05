import type { AIRule, Bin, Layer, LayerFeature, Property, SavedView } from '../shared/types'
import { propertyLabel } from '../shared/property'

export const defaultView: SavedView = {
  columns: ['displayAddress', 'binId', 'tags', 'verificationStatus', 'updatedAt'],
  sorts: [{ field: 'displayAddress', direction: 'asc' }],
  filters: { search: '', binId: '', tag: '', attribute: '', value: '' },
  layers: ['properties'],
}

export const attributeNamePattern = '[A-Za-z][\\w \\-]{0,63}'

export function newPropertyAIRule(rule: AIRule | null): AIRule {
  return rule ? structuredClone(rule) : {
    enabled: false, triggers: ['creation'], watchedFields: [], fields: ['enteredAddress'],
  }
}

export const fieldLabels: Record<string, string> = {
  name: 'Address (legacy column)', displayAddress: 'Address', enteredAddress: 'Entered address', normalizedAddress: 'Geocoded address',
  binId: 'Bin', tags: 'Tags', verificationStatus: 'Address status', creatorStamp: 'Creator stamp',
  creatorName: 'Created by', createdAt: 'Created', updatedAt: 'Updated', version: 'Version',
  latitude: 'Latitude', longitude: 'Longitude',
}

export function fieldValue(property: Property, field: string): unknown {
  if (field === 'name' || field === 'displayAddress') return propertyLabel(property)
  return field.startsWith('attributes.') ? property.attributes[field.slice(11)] : property[field as keyof Property]
}

export function restoreSavedView(value: unknown): SavedView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Saved view is invalid. The default view is shown; save it to replace the old preference.')
  const saved = value as Partial<SavedView>
  if (!Array.isArray(saved.layers) || !saved.layers.every(id => typeof id === 'string') ||
      !Array.isArray(saved.columns) || !Array.isArray(saved.sorts) ||
      !saved.filters || typeof saved.filters !== 'object') {
    throw new Error('Saved view is invalid. The default view is shown; save it to replace the old preference.')
  }
  return { ...structuredClone(defaultView), ...saved, filters: { ...defaultView.filters, ...saved.filters } }
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export function verificationStatusLabel(status: Property['verificationStatus']): string {
  return status === 'verified' ? 'Geocoded' : status
}

// Comparisons keep numeric attributes numeric; explicit operators enable range filters.
export function matchesAttribute(attributes: Property['attributes'], key: string, query: string): boolean {
  if (!key) return true
  const value = attributes[key]
  if (value === undefined || value === null) return false
  const match = query.trim().match(/^(>=|<=|>|<|=|!=)\s*(.*)$/)
  if (!match) return String(value).toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const [, operator, expected] = match
  let left: number | string = String(value).toLocaleLowerCase()
  let right: number | string = expected.toLocaleLowerCase()
  if (typeof value === 'number') {
    if (!expected.trim() || !Number.isFinite(Number(expected))) return false
    left = value
    right = Number(expected)
  } else if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(String(value)) && /^\d{4}-\d{2}-\d{2}(T|$)/.test(expected)) {
    const a = Date.parse(String(value)); const b = Date.parse(expected)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    left = a; right = b
  }
  switch (operator) {
    case '>': return left > right
    case '>=': return left >= right
    case '<': return left < right
    case '<=': return left <= right
    case '!=': return left !== right
    default: return left === right
  }
}

export function compareValues(a: unknown, b: unknown, field: string): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1
  if (b === null || b === undefined) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  if (field === 'createdAt' || field === 'updatedAt') return Date.parse(String(a)) - Date.parse(String(b))
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(a) && /^\d{4}-\d{2}-\d{2}(T|$)/.test(b)) {
    const left = Date.parse(a); const right = Date.parse(b)
    if (Number.isFinite(left) && Number.isFinite(right)) return left - right
  }
  return displayValue(a).localeCompare(displayValue(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function filterProperties(properties: Property[], view: SavedView): Property[] {
  const { search, binId, tag, attribute, value } = view.filters
  const needle = search.trim().toLocaleLowerCase()
  return properties.filter(p =>
    (!needle || [propertyLabel(p), p.name, p.enteredAddress, p.normalizedAddress, ...p.tags, ...Object.values(p.attributes)]
      .some(v => String(v ?? '').toLocaleLowerCase().includes(needle))) &&
    (!binId || p.binId === binId) &&
    (!tag || p.tags.some(t => t.toLocaleLowerCase() === tag.toLocaleLowerCase())) &&
    matchesAttribute({ binId: p.binId, verificationStatus: p.verificationStatus, tags: p.tags.join(', '), ...p.attributes }, attribute, value),
  ).sort((a, b) => {
    for (const sort of view.sorts) {
      const result = compareValues(fieldValue(a, sort.field), fieldValue(b, sort.field), sort.field)
      if (result) return sort.direction === 'asc' ? result : -result
    }
    return a.id.localeCompare(b.id)
  })
}

export function layerFilterExclusion(layer: Layer, filters: SavedView['filters']): string | null {
  if (filters.binId && !layer.filterableAttributes.includes('binId')) return 'This layer does not expose bins and is hidden while a bin filter is active.'
  if (filters.tag && !layer.filterableAttributes.includes('tags')) return 'This layer does not expose tags and is hidden while a tag filter is active.'
  if (filters.attribute && !layer.filterableAttributes.includes(filters.attribute)) return `This layer does not expose “${filters.attribute}” and is hidden while that attribute filter is active.`
  return null
}

export function filterLayerFeatures(layer: Layer, features: LayerFeature[], view: SavedView): LayerFeature[] {
  if (layerFilterExclusion(layer, view.filters)) return []
  const { search, binId, tag, attribute, value } = view.filters
  const needle = search.trim().toLocaleLowerCase()
  return features.filter(feature =>
    (!needle || [feature.label, ...Object.values(feature.attributes)]
      .some(v => String(v ?? '').toLocaleLowerCase().includes(needle))) &&
    (!binId || String(feature.attributes.binId ?? '') === binId) &&
    (!tag || String(feature.attributes.tags ?? '').split(',').some(t => t.trim().toLocaleLowerCase() === tag.toLocaleLowerCase())) &&
    matchesAttribute(feature.attributes, attribute, value),
  )
}

export function moveProperty(properties: Property[], id: string, binId: string): Property[] {
  return properties.map(p => p.id === id ? { ...p, binId } : p)
}

export function propertyBinChoices(property: Property, userId: string, ownBins: Bin[], ownerBins: Bin[] = []): Bin[] {
  return property.creatorId === userId ? ownBins : ownerBins
}

export function propertyLayerVisible(view: Pick<SavedView, 'layers'>): boolean {
  return view.layers.includes('properties')
}

export function isMappable(property: Property): boolean {
  return property.latitude !== null && property.longitude !== null &&
    Number.isFinite(property.latitude) && Number.isFinite(property.longitude) &&
    Math.abs(property.latitude) <= 90 && Math.abs(property.longitude) <= 180
}

export function parseAttributes(raw: string): Property['attributes'] {
  const parsed: unknown = JSON.parse(raw || '{}')
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Attributes must be a JSON object.')
  if (Object.keys(parsed).length > 50) throw new Error('Use at most 50 custom attributes.')
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[a-zA-Z][\w -]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) ||
      !['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
      throw new Error('Use named attributes with text, number, true/false, or null values.')
    }
  }
  return parsed as Property['attributes']
}

export function validateReminderInstant(iso: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(iso.trim())) {
    throw new Error('Include an explicit UTC offset, for example 2026-11-05T09:00-08:00 in America/Los_Angeles. This avoids daylight-saving ambiguity.')
  }
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) throw new Error('Enter a valid reminder date and time.')
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(date) }
  catch { throw new Error('Enter an IANA timezone, such as America/Vancouver or Europe/London.') }
  // Validate the entered wall-clock time against the chosen timezone, including its DST offset.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (name: string) => parts.find(p => p.type === name)?.value
  const wall = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
  if (wall !== iso.slice(0, 16)) throw new Error('The UTC offset does not match this timezone at that date, or the local time does not exist during a daylight-saving change.')
  return date.toISOString()
}
