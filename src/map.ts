import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Bin, Layer, LayerFeature, Property, SavedView, TileConfig } from '../shared/types'
import { propertyLabel } from '../shared/property'
import { button, el } from './dom'
import { filterLayerFeatures, isMappable, propertyLayerVisible } from './utils'

interface Point { id: string; label: string; latitude: number; longitude: number; color: string; propertyId?: string; layer: string }
let sessionViewport: { center: L.LatLng; zoom: number } | undefined

export class PropertyMap {
  private map: L.Map
  private references = L.layerGroup()
  private propertiesLayer = L.layerGroup()
  private selection = L.layerGroup()
  private points: Point[] = []
  private pointKey = ''
  private fitted = Boolean(sessionViewport)
  private selectedId: string | undefined
  private resize: ResizeObserver
  private tileStatus = el('div', 'map-status')

  constructor(container: HTMLElement, private openDetail: (id: string) => void, tiles: TileConfig | string) {
    const canvas = el('div', 'map-canvas')
    canvas.setAttribute('aria-label', 'Property map. Use plus and minus to zoom; select a marker to open its dossier.')
    container.append(canvas, this.tileStatus)
    this.tileStatus.setAttribute('role', 'status')
    this.map = L.map(canvas, { keyboard: true }).setView(sessionViewport?.center ?? [39.95, -75.16], sessionViewport?.zoom ?? 11)
    if (typeof tiles === 'string') {
      this.tileStatus.textContent = `Basemap unavailable: ${tiles}. Properties remain available in Table and Board.`
    } else {
      this.tileStatus.textContent = 'Basemap: MapTiler · map data © OpenStreetMap contributors'
      const base = L.tileLayer(tiles.url, {
        tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: tiles.maxZoom, attribution: tiles.attribution,
      }).addTo(this.map)
      base.once('tileerror', () => {
        this.tileStatus.textContent = 'MapTiler tiles failed to load. Check the browser network response, key restrictions, plan quota and CSP. Property points remain available; use Table or Board if tiles stay unavailable.'
      })
    }
    this.references.addTo(this.map)
    this.propertiesLayer.addTo(this.map)
    this.selection.addTo(this.map)
    this.map.on('dragstart zoomstart', () => { this.fitted = true })
    this.map.on('zoomend', () => this.draw())
    this.resize = new ResizeObserver(() => this.map.invalidateSize({ pan: false }))
    this.resize.observe(container)
    requestAnimationFrame(() => this.map.invalidateSize({ pan: false }))
  }

  update(properties: Property[], bins: Bin[], layers: Layer[], features: Map<string, LayerFeature[]>, view: SavedView): number {
    const visible = (propertyLayerVisible(view) ? properties : []).filter(isMappable)
    const points: Point[] = visible.map(p => ({
      id: p.id, label: propertyLabel(p), latitude: p.latitude!, longitude: p.longitude!,
      color: bins.find(b => b.id === p.binId)?.color ?? '#197e76', propertyId: p.id, layer: 'properties',
    }))
    for (const layer of layers.filter(l => l.id !== 'properties' && view.layers.includes(l.id))) {
      for (const feature of filterLayerFeatures(layer, features.get(layer.id) ?? [], view)) {
        if (!Number.isFinite(feature.latitude) || !Number.isFinite(feature.longitude) ||
            Math.abs(feature.latitude) > 90 || Math.abs(feature.longitude) > 180) continue
        points.push({ ...feature, color: layer.color, layer: layer.id })
      }
    }
    if (!this.fitted && points.length) {
      this.fitted = true
      const focus = visible.length ? points.filter(p => p.propertyId) : points
      if (focus.length === 1) this.map.setView([focus[0].latitude, focus[0].longitude], 15)
      else this.map.fitBounds(L.latLngBounds(focus.map(p => [p.latitude, p.longitude])), { padding: [48, 48], maxZoom: 15 })
    }
    const key = JSON.stringify(points)
    if (key !== this.pointKey) {
      this.points = points
      this.pointKey = key
      this.draw()
    }
    return points.length
  }

  private draw(): void {
    this.references.clearLayers()
    this.propertiesLayer.clearLayers()
    this.selection.clearLayers()
    const groups = new Map<string, Point[]>()
    for (const point of this.points) {
      const projected = this.map.project([point.latitude, point.longitude], this.map.getZoom())
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
      const selected = points.length === 1 && this.selectedId !== undefined && point.propertyId === this.selectedId
      const symbol = el('span', `map-pin${points.length > 1 ? ' cluster' : ''}${selected ? ' selected' : ''}`,
        points.length > 1 ? String(points.length) : point.propertyId ? '⌂' : '•')
      symbol.style.setProperty('--pin-color', points.some(p => p.color !== point.color) ? '#172b36' : point.color)
      const marker = L.marker(center, {
        icon: L.divIcon({ html: symbol, className: 'safe-marker', iconSize: [34, 34], iconAnchor: [17, 17] }),
        title: points.length > 1 ? `${points.length} nearby locations — select to explore` : point.label,
        keyboard: true, zIndexOffset: selected ? 1000 : 0,
      })
      if (points.length > 1) {
        marker.bindPopup(() => {
          const popup = el('div', 'cluster-list')
          popup.append(el('strong', '', `${points.length} nearby locations`))
          popup.append(button('Zoom to group', () => this.map.fitBounds(L.latLngBounds(points.map(p => [p.latitude, p.longitude])), { maxZoom: 18, padding: [30, 30] }), 'button small'))
          for (const item of points.slice(0, 100)) {
            popup.append(item.propertyId
              ? button(item.label, () => this.select(item.propertyId!), 'text-button')
              : el('p', '', item.label))
          }
          if (points.length > 100) popup.append(el('p', '', `${points.length - 100} additional locations. Zoom further or use Table to explore the full property list.`))
          return popup
        })
      } else if (point.propertyId) marker.on('click', () => this.select(point.propertyId!))
      else marker.bindPopup(el('div', '', point.label))
      marker.bindTooltip(el('span', '', points.length > 1 ? `${points.length} locations` : point.label))
      marker.addTo(selected ? this.selection : point.propertyId ? this.propertiesLayer : this.references)
      marker.getElement()?.setAttribute('aria-label', points.length > 1 ? `${points.length} nearby locations — select to explore` : point.label)
      if (point.propertyId && points.length === 1) marker.getElement()?.setAttribute('data-property-id', point.propertyId)
    }
  }

  private select(id: string): void {
    this.selectedId = id
    this.draw()
    this.openDetail(id)
  }

  destroy(): void {
    sessionViewport = { center: this.map.getCenter(), zoom: this.map.getZoom() }
    this.resize.disconnect()
    this.map.remove()
  }
}
