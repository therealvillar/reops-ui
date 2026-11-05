import type { TileConfig } from '../shared/types'
import type { Env } from './index'
import { assert, HttpError } from './validation'

const defaultUrl = 'https://api.maptiler.com/maps/streets-v4/{z}/{x}/{y}.png'
const copyright = '<a href="https://www.maptiler.com/copyright/">© MapTiler</a> · <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>'

export function tileConfig(env: Env): TileConfig {
  const key = env.MAPTILER_BROWSER_KEY
  if (!key) throw new HttpError(503, 'Configure a licensed MapTiler browser key before loading map tiles')
  assert(key.length <= 256 && !/\s/.test(key), 'Invalid MapTiler browser key', 503)
  const url = env.MAP_TILE_URL ?? defaultUrl
  assert(/^https:\/\/api\.maptiler\.com\/maps\/[a-z0-9-]+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(url),
    'Map tile URL must be a MapTiler raster XYZ endpoint', 503)
  const zoom = env.MAP_TILE_MAX_ZOOM === undefined ? 19 : Number(env.MAP_TILE_MAX_ZOOM)
  assert(Number.isInteger(zoom) && zoom >= 1 && zoom <= 20, 'Invalid map maximum zoom', 503)
  const label = env.MAP_TILE_ATTRIBUTION ?? ''
  assert(label.length <= 200, 'Invalid map attribution', 503)
  const escaped = label.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
  return { url: `${url}?key=${encodeURIComponent(key)}`, maxZoom: zoom, attribution: `${copyright}${escaped ? ` · ${escaped}` : ''}` }
}
