import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Layer, LayerFeature, Property, SavedView } from '../shared/types'
import { attributeNamePattern, compareValues, defaultView, fieldLabels, fieldValue, filterLayerFeatures, filterProperties, isMappable, layerFilterExclusion, matchesAttribute, moveProperty, newPropertyAIRule, parseAttributes, propertyBinChoices, propertyLayerVisible, validateReminderInstant, verificationStatusLabel } from '../src/utils'

const property = (overrides: Partial<Property> = {}): Property => ({
  id: 'p1', name: 'Alpha', enteredAddress: '123 Main Street', normalizedAddress: null,
  verificationStatus: 'unverified', verificationMessage: null, latitude: null, longitude: null,
  binId: 'new', tags: ['Garden'], attributes: { area: 900, inspected: '2026-10-01', active: true },
  creatorId: 'u1', creatorStamp: 'AJ', creatorName: 'Alex', createdAt: '2026-10-01T08:00:00Z',
  updatedBy: 'u1', updatedAt: '2026-10-01T08:00:00Z', version: 4, ...overrides,
})
const withFilters = (filters: Partial<SavedView['filters']>): SavedView => ({
  ...structuredClone(defaultView), filters: { ...defaultView.filters, ...filters },
})

test('fallback view matches canonical server defaults and property map toggle is respected', () => {
  assert.deepEqual(defaultView.columns, ['name', 'enteredAddress', 'binId', 'tags', 'verificationStatus'])
  assert.deepEqual(defaultView.sorts, [{ field: 'name', direction: 'asc' }])
  assert.deepEqual(defaultView.layers, ['properties'])
  assert.equal(fieldValue(property(), 'attributes.area'), 900)
  assert.equal(propertyLayerVisible(defaultView), true)
  assert.equal(propertyLayerVisible({ layers: [] }), false)
  assert.equal(propertyLayerVisible({ layers: ['context'] }), false)
})

test('verified address status is presented as geocoded without changing other statuses', () => {
  assert.equal(verificationStatusLabel('verified'), 'Geocoded')
  assert.equal(verificationStatusLabel('unverified'), 'unverified')
  assert.equal(verificationStatusLabel('ambiguous'), 'ambiguous')
  assert.equal(fieldLabels.normalizedAddress, 'Geocoded address')
})

test('nullable new-property AI defaults remain disabled until explicit precreation opt-in', () => {
  const fallback = newPropertyAIRule(null)
  assert.equal(fallback.enabled, false)
  assert.deepEqual(fallback.triggers, ['creation'])
  assert.deepEqual(fallback.fields, ['name', 'enteredAddress'])
  const configured = { ...fallback, enabled: true }
  const copied = newPropertyAIRule(configured)
  assert.deepEqual(copied, configured)
  copied.fields.push('tags')
  assert.deepEqual(configured.fields, ['name', 'enteredAddress'])
})

test('all views share search, bin, tag, and attribute filters without mutating records', () => {
  const records = [property(), property({ id: 'p2', binId: 'contacted', tags: ['Patio'], attributes: { area: 1200 } })]
  assert.equal(filterProperties(records, withFilters({ search: 'MAIN', binId: 'new', tag: 'garden', attribute: 'area', value: '>= 800' }))[0].id, 'p1')
  assert.equal(filterProperties(records, withFilters({ tag: 'missing' })).length, 0)
  assert.equal(filterProperties(records, withFilters({ search: '1200' }))[0].id, 'p2')
  assert.equal(records[0].version, 4)
  assert.equal(filterProperties(records, withFilters({ attribute: 'verificationStatus', value: '= unverified' })).length, 2)
})

test('numeric, date, boolean, text and missing attributes filter predictably', () => {
  assert.equal(matchesAttribute({ area: 10 }, 'area', '> 9'), true)
  assert.equal(matchesAttribute({ area: 10 }, 'area', '< 2'), false)
  assert.equal(matchesAttribute({ area: 10 }, 'area', '>= nope'), false)
  assert.equal(matchesAttribute({ area: 10 }, 'area', '='), false)
  assert.equal(matchesAttribute({ inspected: '2026-10-01' }, 'inspected', '>= 2026-09-30'), true)
  assert.equal(matchesAttribute({ active: true }, 'active', '= true'), true)
  assert.equal(matchesAttribute({ active: true }, 'active', '!= false'), true)
  assert.equal(matchesAttribute({ category: 'Residential' }, 'category', 'dent'), true)
  assert.equal(matchesAttribute({}, 'area', ''), false)
  assert.equal(matchesAttribute({ area: null }, 'area', ''), false)
})

const referenceLayer: Layer = { id: 'context', name: 'Context', color: '#197e76', source: 'layer_points', latitudeField: 'latitude', longitudeField: 'longitude', labelField: 'label', filterableAttributes: ['category', 'status'] }
const referenceFeature: LayerFeature = { id: 'f1', label: 'Community place', latitude: 49, longitude: -123, attributes: { category: 'Civic', status: 'Open' } }

test('reference layers are excluded with an explicit reason when common bins or tags are unsupported', () => {
  assert.deepEqual(filterLayerFeatures(referenceLayer, [referenceFeature], withFilters({ binId: 'new' })), [])
  assert.match(layerFilterExclusion(referenceLayer, withFilters({ binId: 'new' }).filters)!, /does not expose bins/)
  assert.deepEqual(filterLayerFeatures(referenceLayer, [referenceFeature], withFilters({ tag: 'Garden' })), [])
  assert.match(layerFilterExclusion(referenceLayer, withFilters({ tag: 'Garden' }).filters)!, /does not expose tags/)
  assert.deepEqual(filterLayerFeatures(referenceLayer, [referenceFeature], withFilters({ attribute: 'area', value: '> 10' })), [])
  assert.match(layerFilterExclusion(referenceLayer, withFilters({ attribute: 'area' }).filters)!, /does not expose “area”/)
})

test('supported reference attributes share search and filter semantics with property records', () => {
  assert.equal(filterLayerFeatures(referenceLayer, [referenceFeature], withFilters({ search: 'COMMUNITY', attribute: 'category', value: '= civic' })).length, 1)
  assert.equal(filterLayerFeatures(referenceLayer, [referenceFeature], withFilters({ attribute: 'status', value: '= closed' })).length, 0)
  assert.equal(layerFilterExclusion(referenceLayer, withFilters({ attribute: 'category' }).filters), null)
  const layer = { ...referenceLayer, filterableAttributes: ['binId', 'tags', 'area'] }
  const feature = { ...referenceFeature, attributes: { binId: 'new', tags: 'Garden, Viewing', area: 1200 } }
  assert.equal(filterLayerFeatures(layer, [feature], withFilters({ binId: 'new', tag: 'garden', attribute: 'area', value: '>= 1000' })).length, 1)
  assert.equal(filterLayerFeatures(layer, [feature], withFilters({ binId: 'other' })).length, 0)
})

test('multi-sort honors numeric attributes, date order and stable ID tie-breaks', () => {
  const records = [
    property({ id: 'c', name: 'Gamma', attributes: { area: 100 }, updatedAt: '2026-10-01T10:00:00+02:00' }),
    property({ id: 'b', name: 'Beta', attributes: { area: 10 }, updatedAt: '2026-10-01T09:00:00Z' }),
    property({ id: 'a', name: 'Alpha', attributes: { area: 10 }, updatedAt: '2026-10-01T09:00:00Z' }),
  ]
  const view = structuredClone(defaultView)
  view.sorts = [{ field: 'attributes.area', direction: 'asc' }, { field: 'name', direction: 'desc' }]
  assert.deepEqual(filterProperties(records, view).map(p => p.id), ['b', 'a', 'c'])
  view.sorts = [{ field: 'updatedAt', direction: 'desc' }]
  assert.deepEqual(filterProperties(records, view).map(p => p.id), ['a', 'b', 'c'])
  assert.deepEqual(records.map(p => p.id), ['c', 'b', 'a'])
  assert.equal(compareValues(2, 10, 'attributes.area') < 0, true)
  assert.equal(compareValues('2026-10-01T10:00:00+02:00', '2026-10-01T09:00:00Z', 'attributes.inspected') < 0, true)
})

test('custom timestamp attributes sort by instant rather than offset spelling', () => {
  const records = [
    property({ id: 'later', attributes: { inspected: '2026-10-01T09:00:00Z' } }),
    property({ id: 'earlier', attributes: { inspected: '2026-10-01T10:00:00+02:00' } }),
  ]
  const view = structuredClone(defaultView)
  view.sorts = [{ field: 'attributes.inspected', direction: 'asc' }]
  assert.deepEqual(filterProperties(records, view).map(p => p.id), ['earlier', 'later'])
  view.sorts[0].direction = 'desc'
  assert.deepEqual(filterProperties(records, view).map(p => p.id), ['later', 'earlier'])
})

test('optimistic bin moves preserve the complete record and version', () => {
  const original = property()
  const other = property({ id: 'p2' })
  const moved = moveProperty([original, other], 'p1', 'qualified')
  assert.deepEqual(moved[0], { ...original, binId: 'qualified' })
  assert.equal(original.binId, 'new')
  assert.equal(moved[1], other)
  assert.equal(moved[0].attributes, original.attributes)
  assert.equal(moved[0].version, 4)
})

test('shared property bin choices never include an editor’s private bins', () => {
  const original = property({ creatorId: 'alice', creatorName: 'Alice', creatorStamp: 'ALICE123', updatedBy: 'bob' })
  const privateBins = [{ id: 'bob-private', name: 'Bob private', color: '#123456', position: 0 }]
  const ownerBins = [{ id: 'alice-work', name: 'Owner stage', color: '#197e76', position: 0 }]
  assert.equal(propertyBinChoices(original, 'alice', ownerBins, privateBins), ownerBins)
  assert.equal(propertyBinChoices(original, 'bob', privateBins, ownerBins), ownerBins)
  assert.deepEqual(propertyBinChoices(original, 'bob', privateBins), [])
  const moved = moveProperty([original], original.id, ownerBins[0].id)[0]
  assert.equal(moved.creatorId, 'alice')
  assert.equal(moved.creatorName, 'Alice')
  assert.equal(moved.creatorStamp, 'ALICE123')
  assert.equal(moved.updatedBy, 'bob')
})

test('unlocated or invalid drafts stay out of the map; zero is a valid coordinate', () => {
  assert.equal(isMappable(property()), false)
  assert.equal(isMappable(property({ latitude: 0, longitude: 0 })), true)
  assert.equal(isMappable(property({ latitude: NaN, longitude: 1 })), false)
  assert.equal(isMappable(property({ latitude: 91, longitude: 181 })), false)
})

test('custom attribute values accept primitives only', () => {
  assert.deepEqual(parseAttributes('{"area":100,"active":true,"date":"2026-10-01","empty":null}'), { area: 100, active: true, date: '2026-10-01', empty: null })
  assert.throws(() => parseAttributes('[]'))
  assert.throws(() => parseAttributes('{"nested":{}}'))
  assert.throws(() => parseAttributes('{"":1}'))
  assert.throws(() => parseAttributes('{"__proto__":null}'))
})

test('attribute name HTML pattern compiles with Unicode sets and rejects invalid names', () => {
  const pattern = new RegExp(`^(?:${attributeNamePattern})$`, 'v')
  assert.equal(pattern.test('Floor area'), true)
  assert.equal(pattern.test('Inspection-date_1'), true)
  assert.equal(pattern.test('1area'), false)
  assert.equal(pattern.test('area!'), false)
})

test('reminders require explicit offset and real IANA timezone, rejecting nonexistent DST times', () => {
  assert.equal(validateReminderInstant('2026-11-05T09:00-08:00', 'America/Los_Angeles'), '2026-11-05T17:00:00.000Z')
  assert.equal(validateReminderInstant('2026-06-05T09:00-07:00', 'America/Los_Angeles'), '2026-06-05T16:00:00.000Z')
  assert.throws(() => validateReminderInstant('2026-06-05T09:00-08:00', 'America/Los_Angeles'), /offset/)
  assert.throws(() => validateReminderInstant('2026-03-08T02:30-08:00', 'America/Los_Angeles'), /does not exist/)
  assert.throws(() => validateReminderInstant('2026-11-05T09:00', 'America/Los_Angeles'), /offset/)
  assert.throws(() => validateReminderInstant('2026-11-05T09:00Z', 'Not/AZone'), /IANA/)
})

test('ambiguous DST hour is resolved by the explicit offset, not silently guessed', () => {
  assert.equal(validateReminderInstant('2026-11-01T01:30-07:00', 'America/Los_Angeles'), '2026-11-01T08:30:00.000Z')
  assert.equal(validateReminderInstant('2026-11-01T01:30-08:00', 'America/Los_Angeles'), '2026-11-01T09:30:00.000Z')
})
