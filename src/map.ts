import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Bin, Layer, LayerFeature, Property, SavedView } from '../shared/types'
import { button, el } from './dom'
import { filterLayerFeatures, isMappable, propertyLayerVisible } from './utils'

interface Point { id: string; label: string; latitude: number; longitude: number; color: string; propertyId?: string; layer: string }

export class PropertyMap {
  private map: L.Map
  private markers = L.layerGroup()
  private points: Point[] = []
  private fitted = false
  private tileStatus = el('div', 'map-status', 'Map tiles © OpenStreetMap contributors')

  constructor(container: HTMLElement, private openDetail: (id: string) => void) {
    const canvas = el('div', 'map-canvas')
    canvas.setAttribute('aria-label', 'Property map. Use plus and minus to zoom; select a marker to open details.')
    container.append(canvas, this.tileStatus)
    this.map = L.map(canvas).setView([49.21, -122.92], 11)
    const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map)
    tiles.on('tileerror', () => { this.tileStatus.textContent = 'Map tiles could not load. Your records are still available in Table and Board.' })
    this.markers.addTo(this.map)
    this.map.on('zoomend moveend', () => this.draw())
    requestAnimationFrame(() => this.map.invalidateSize())
  }

  update(properties: Property[], bins: Bin[], layers: Layer[], features: Map<string, LayerFeature[]>, view: SavedView): number {
    const propertiesVisible = propertyLayerVisible(view)
    this.points = (propertiesVisible ? properties : []).filter(isMappable).map(p => ({
      id: p.id, label: p.name, latitude: p.latitude!, longitude: p.longitude!,
      color: bins.find(b => b.id === p.binId)?.color ?? '#197e76', propertyId: p.id, layer: 'properties',
    }))
    for (const layer of layers.filter(l => view.layers.includes(l.id))) {
      if (layer.id === 'properties') continue
      for (const feature of filterLayerFeatures(layer, features.get(layer.id) ?? [], view)) {
        if (!Number.isFinite(feature.latitude) || !Number.isFinite(feature.longitude) ||
            Math.abs(feature.latitude) > 90 || Math.abs(feature.longitude) > 180) continue
        this.points.push({ ...feature, color: layer.color, layer: layer.id })
      }
    }
    if (!this.fitted && this.points.length) {
      this.map.fitBounds(L.latLngBounds(this.points.map(p => [p.latitude, p.longitude])), { padding: [48, 48], maxZoom: 14 })
      this.fitted = true
    }
    this.draw()
    return this.points.length
  }

  private draw(): void {
    this.markers.clearLayers()
    const groups = new Map<string, Point[]>()
    for (const point of this.points) {
      const projected = this.map.project([point.latitude, point.longitude], this.map.getZoom())
      // Grid groups reduce overlapping records at overview zoom without a plugin.
      const cell = this.map.getZoom() < 16 ? 56 : 20
      const key = `${point.layer}:${Math.floor(projected.x / cell)}:${Math.floor(projected.y / cell)}`
      const group = groups.get(key)
      if (group) group.push(point)
      else groups.set(key, [point])
    }
    for (const points of groups.values()) {
      const point = points[0]
      const center: [number, number] = [
        points.reduce((n, p) => n + p.latitude, 0) / points.length,
        points.reduce((n, p) => n + p.longitude, 0) / points.length,
      ]
      const symbol = el('span', points.length > 1 ? 'map-pin cluster' : 'map-pin', points.length > 1 ? String(points.length) : point.propertyId ? '⌂' : '•')
      symbol.style.setProperty('--pin-color', points.some(p => p.color !== point.color) ? '#172b36' : point.color)
      const marker = L.marker(center, {
        icon: L.divIcon({ html: symbol, className: 'safe-marker', iconSize: [34, 34], iconAnchor: [17, 17] }),
        title: points.length > 1 ? `${points.length} nearby locations — select to explore` : point.label,
        keyboard: true,
      })
      if (points.length > 1) {
        marker.bindPopup(() => {
          const popup = el('div', 'cluster-list')
          popup.append(el('strong', '', `${points.length} nearby locations`))
          popup.append(button('Zoom to group', () => this.map.fitBounds(L.latLngBounds(points.map(p => [p.latitude, p.longitude])), { maxZoom: 18, padding: [30, 30] }), 'button small'))
          for (const item of points.slice(0, 100)) {
            popup.append(item.propertyId
              ? button(item.label, () => this.openDetail(item.propertyId!), 'text-button')
              : el('p', '', item.label))
          }
          if (points.length > 100) popup.append(el('p', '', `${points.length - 100} additional locations. Zoom further or use Table to explore the full property list.`))
          return popup
        })
      } else if (point.propertyId) marker.on('click', () => this.openDetail(point.propertyId!))
      else marker.bindPopup(el('div', '', point.label))
      marker.bindTooltip(el('span', '', points.length > 1 ? `${points.length} locations` : point.label))
      marker.addTo(this.markers)
      marker.getElement()?.setAttribute('aria-label', points.length > 1 ? `${points.length} nearby locations — select to explore` : point.label)
      if (point.propertyId && points.length === 1) marker.getElement()?.setAttribute('data-property-id', point.propertyId)
    }
  }

  destroy(): void { this.map.remove() }
}
