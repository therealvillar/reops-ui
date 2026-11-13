export type VerificationStatus = 'unverified' | 'verified' | 'ambiguous' | 'failed'
export type AddressParts = Partial<Record<'houseNumber' | 'predirectional' | 'street' | 'streetSuffix' |
  'postdirectional' | 'unit' | 'city' | 'state' | 'zip', string>>
export interface User {
  id: string
  name: string
  stamp: string
}
export interface Property {
  id: string
  name?: string
  enteredAddress: string
  normalizedAddress: string | null
  addressComponents?: AddressParts | null
  verificationStatus: VerificationStatus
  verificationMessage: string | null
  latitude: number | null
  longitude: number | null
  binId: string
  tags: string[]
  attributes: Record<string, string | number | boolean | null>
  creatorId: string
  creatorStamp: string
  creatorName: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  version: number
}
export interface Bin { id: string; name: string; color: string; position: number }
export interface Note { id: string; body: string; actorId: string; actorName: string; actorStamp: string; createdAt: string }
export interface Activity {
  id: string; actorId: string; actorName: string; actorStamp: string
  action: string; createdAt: string; before: unknown; after: unknown
}
export interface Reminder {
  id: string; propertyId: string; title: string; dueAt: string; timeZone: string
  state: 'scheduled' | 'delivered' | 'completed' | 'cancelled' | 'failed'
  error: string | null; createdBy: string
}
export interface AIJob {
  id: string; propertyId: string; state: 'pending' | 'running' | 'successful' | 'failed'
  fields: string[]; attempts: number; result: string | null; error: string | null
  createdAt: string; trigger: string
}
export interface AIRule {
  enabled: boolean
  triggers: ('creation' | 'field_change' | 'reminder')[]
  watchedFields: string[]
  fields: string[]
}
export interface Detail {
  property: Property; notes: Note[]; history: Activity[]; reminders: Reminder[]
  aiJobs: AIJob[]; aiRule: AIRule | null
  enrichmentSources: EnrichmentSource[]
  enrichment: EnrichmentJob[]
  sourceRecords: SourceRecord[]
  sourceAttributes: SourceAttribute[]
}
export interface EnrichmentSource {
  id: string; name: string; dataset: string; url: string; coverage: string
  enabled: boolean; message: string; refreshDays: number
  sourceType: 'carto_sql' | 'arcgis'
  baseUrl: string; identifierFields: string[]; addressFields: string[]; parcelFields: string[]
  spatialReference: string; retrievalMethod: string; license: string
  requestLimit: number; timeoutMs: number; mappingRules: string; provenance: string
}
export interface EnrichmentJob {
  id: string; sourceId: string; status: 'pending' | 'running' | 'complete' | 'manual_review' | 'unavailable' | 'failed'
  attempts: number; lastError: string | null; createdAt: string; completedAt: string | null
}
export interface SourceRecord {
  id: string; sourceId: string; sourceRecordId: string; matchMethod: 'parcel_id' | 'exact_address'
  matchConfidence: 'exact_parcel' | 'strong_address'; data: Record<string, string | number | boolean | null>
  fetchedAt: string; sourceUpdatedAt: string | null
}
export interface SourceAttribute {
  key: string; value: string | number | null; sourceId: string; observedAt: string
}
export interface TileConfig { url: string; attribution: string; maxZoom: number }
export interface AddressCandidate {
  token: string; label: string; latitude: number | null; longitude: number | null
  verified: boolean; message: string
}
export type AreaCounty = 'philadelphia' | 'montgomery' | 'bucks' | 'delaware'
export interface AreaSource {
  name: string
  url: string
  status: 'ok' | 'unavailable' | 'reference'
  message: string
  records: Record<string, string | number | boolean | null>[]
  limited: boolean
  dateField?: string
  dateMeaning?: string
}
export interface PropertyArea {
  county: AreaCounty
  radiusMeters: number
  fetchedAt: string
  cutoff: string | null
  sources: AreaSource[]
}
export interface Layer {
  id: string; name: string; color: string; source: string
  latitudeField: string; longitudeField: string; labelField: string
  filterableAttributes: string[]
}
export interface LayerFeature {
  id: string; label: string; latitude: number; longitude: number
  attributes: Record<string, string | number | boolean | null>
  propertyId?: string
}
export interface SavedView {
  columns: string[]; sorts: { field: string; direction: 'asc' | 'desc' }[]
  filters: { search: string; binId: string; tag: string; attribute: string; value: string }
  layers: string[]
}
export interface Notification {
  id: string; propertyId: string; title: string; createdAt: string; readAt: string | null
}
