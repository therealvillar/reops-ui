import type { Property } from './types'

export function propertyLabel(property: Pick<Property, 'id' | 'enteredAddress' | 'normalizedAddress'>): string {
  return property.normalizedAddress?.trim() || property.enteredAddress?.trim() || `Property ${property.id.slice(0, 8)}`
}
