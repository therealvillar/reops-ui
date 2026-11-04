import type { Bin, Layer, LayerFeature, Notification, Property, SavedView, User } from '../shared/types'
import { announce, api, ApiError, button, dialog, el, errorMessage, input, label, select, submitForm } from './dom'
import { createProperty, openProperty } from './detail'
import { PropertyMap } from './map'
import { defaultView, displayValue, fieldLabels, fieldValue, filterLayerFeatures, filterProperties, isMappable, layerFilterExclusion, moveProperty, propertyBinChoices, propertyLayerVisible, verificationStatusLabel } from './utils'
import './style.css'

type Mode = 'map' | 'table' | 'board'
let user: User
let properties: Property[] = []
let bins: Bin[] = []
let layers: Layer[] = []
let notifications: Notification[] = []
let view: SavedView = structuredClone(defaultView)
let mode: Mode = 'map'
let map: PropertyMap | undefined
const features = new Map<string, LayerFeature[]>()
const layerErrors = new Map<string, string>()
const layerLoading = new Set<string>()
const moving = new Set<string>()
const ownerBins = new Map<string, Bin[]>()
const ownerBinsLoading = new Map<string, Promise<Bin[]>>()
let notificationPoll: ReturnType<typeof setInterval> | undefined
let notificationError = ''
const app = document.getElementById('app')!
const content = el('section', 'view-content')
const status = el('div', 'workspace-status')
status.setAttribute('role', 'status')
const notice = el('div', 'global-notice')
notice.setAttribute('role', 'alert')
let notificationButton: HTMLButtonElement
let resultLabel: HTMLElement
let metrics: HTMLElement
let filterAttribute: HTMLSelectElement
let filterTag: HTMLSelectElement
let filterBin: HTMLSelectElement
let mapLegend: HTMLElement
let viewTabs: HTMLDivElement
let welcome: HTMLElement

function showError(error: unknown): void {
  notice.replaceChildren(el('span', '', errorMessage(error)), button('Dismiss', () => notice.replaceChildren(), 'text-button'))
  if (error instanceof ApiError && error.status === 401) notice.append(button('Open Access sign-in', () => {
    window.location.assign(`/cdn-cgi/access/login?redirect_url=${encodeURIComponent(window.location.href)}`)
  }, 'button small'))
  announce(errorMessage(error))
}

function openProfile(): void {
  const modal = dialog('Your workspace identity', 'Share your stable ID only with a property owner you want to collaborate with.')
  const identity = input('userId', user.id); identity.readOnly = true
  modal.body.append(el('h3', '', user.name), label('Stable user ID', identity, 'This exact, case-sensitive ID is registered when you sign in. Owners can grant viewer or editor access to individual properties.'),
    button('Copy user ID', async () => {
      try { await navigator.clipboard.writeText(user.id); announce('Stable user ID copied.'); feedback.textContent = 'Copied to clipboard.' }
      catch { identity.focus(); identity.select(); feedback.textContent = 'Clipboard unavailable. The ID is selected; press Ctrl+C or Command+C to copy.' }
    }, 'button primary'))
  const feedback = el('p', 'muted'); feedback.setAttribute('role', 'status'); modal.body.append(feedback)
}

function updateProperty(property: Property): void {
  const existing = properties.findIndex(p => p.id === property.id)
  if (existing === -1) properties.push(property)
  else properties[existing] = property
  refreshOptions()
  renderContent()
}

const context = { bins: () => bins, userId: () => user.id, propertyBins: loadPropertyBins, saved: updateProperty, changed: () => renderContent() }
const open = (id: string) => openProperty(id, context)
const add = () => createProperty(context, id => { void open(id) })
const catalogBins = (): Bin[] => {
  const catalog = new Map([...bins, ...[...ownerBins.values()].flat()].map(bin => [bin.id, bin]))
  for (const property of properties) if (!catalog.has(property.binId)) catalog.set(property.binId, {
    id: property.binId, name: 'Shared bin — details unavailable', color: '#64748b', position: Number.MAX_SAFE_INTEGER,
  })
  return [...catalog.values()].sort((a, b) => a.position - b.position)
}
const binName = (bin: Bin) => bins.some(b => b.id === bin.id) ? bin.name : `${bin.name} · shared`
const binOptions = () => catalogBins().map(b => ({ value: b.id, label: binName(b) }))
const recordBins = (property: Property): Bin[] => {
  const choices = propertyBinChoices(property, user.id, bins, ownerBins.get(property.creatorId))
  return choices.length ? choices : catalogBins().filter(b => b.id === property.binId)
}
const attributeNames = () => [...new Set([...properties.flatMap(p => Object.keys(p.attributes)), ...layers.flatMap(l => l.filterableAttributes)])].sort()
const availableFields = () => [...Object.keys(fieldLabels), ...attributeNames().map(a => `attributes.${a}`)]
const fieldName = (field: string) => field.startsWith('attributes.') ? field.slice(11) : fieldLabels[field] ?? field

async function loadPropertyBins(property: Property): Promise<Bin[]> {
  if (property.creatorId === user.id) return bins
  if (ownerBins.has(property.creatorId)) return ownerBins.get(property.creatorId)!
  const pending = ownerBinsLoading.get(property.creatorId)
  if (pending) return pending
  const request = api<Bin[]>(`/properties/${encodeURIComponent(property.id)}/bins`).then(result => {
    ownerBins.set(property.creatorId, result)
    refreshOptions(); renderContent()
    return result
  }).finally(() => ownerBinsLoading.delete(property.creatorId))
  ownerBinsLoading.set(property.creatorId, request)
  return request
}

function loadSharedBins(): void {
  const owners = new Map(properties.filter(p => p.creatorId !== user.id).map(p => [p.creatorId, p]))
  for (const property of owners.values()) void loadPropertyBins(property).catch(error => showError(error))
}

async function initialize(): Promise<void> {
  app.replaceChildren(el('div', 'boot-screen', 'Opening your property workspace…'))
  try {
    const result = await Promise.all([
      api<User>('/me'), api<Property[]>('/properties'), api<Bin[]>('/bins'), api<Layer[]>('/layers'),
    ])
    ;[user, properties, bins, layers] = result
    bins.sort((a, b) => a.position - b.position)
    let savedError: unknown
    try {
      const saved = await api<SavedView>('/view')
      if (saved) view = { ...structuredClone(defaultView), ...saved, filters: { ...defaultView.filters, ...saved.filters } }
    } catch (error) { savedError = error }
    buildShell()
    renderContent()
    loadSharedBins()
    if (savedError) showError(savedError)
    for (const id of view.layers) void loadLayer(id)
    await pollNotifications()
    if (notificationPoll) clearInterval(notificationPoll)
    notificationPoll = setInterval(() => { if (!document.hidden) void pollNotifications() }, 30000)
  } catch (error) {
    const screen = el('main', 'boot-screen')
    screen.append(el('span', 'brand-mark', 'R'), el('h1', '', 'Your workspace is private.'), el('p', 'error-text', errorMessage(error)),
      el('p', 'muted', 'Reops needs a working API and a Cloudflare Access session. No demo records or local substitutes are shown.'),
      button('Retry connection', initialize, 'button primary'),
      button('Open Access sign-in', () => { window.location.assign(`/cdn-cgi/access/login?redirect_url=${encodeURIComponent(window.location.href)}`) }, 'button'))
    app.replaceChildren(screen)
  }
}

function buildShell(): void {
  app.replaceChildren()
  const sidebar = el('aside', 'sidebar')
  const brand = el('a', 'brand'); brand.href = '/'
  brand.append(el('span', 'brand-mark', 'R'), el('span', '', 'reops'))
  const sideLabel = el('p', 'side-label', 'YOUR WORKSPACE')
  const nav = el('nav', 'side-nav'); nav.setAttribute('aria-label', 'Workspace')
  nav.append(button('◈  Properties', () => document.getElementById('workspace')?.focus(), 'nav-link active'),
    button('◷  Notifications', openNotifications, 'nav-link'),
    button('☷  Pipeline bins', manageBins, 'nav-link'),
    button('◉  Map layers', manageLayers, 'nav-link'))
  const sideFooter = el('div', 'side-footer')
  sideFooter.append(el('span', 'tiny-stamp', user.stamp), el('strong', '', 'Small steps. Real progress.'), el('p', '', 'A little more context. A clearer next move.'))
  sidebar.append(brand, sideLabel, nav, sideFooter)

  const main = el('main', 'main')
  const topbar = el('header', 'topbar')
  const breadcrumb = el('p', 'breadcrumb', 'Workspace  /  Properties')
  const controls = el('div', 'account-controls')
  notificationButton = button('Notifications', openNotifications, 'button quiet')
  notificationButton.setAttribute('aria-label', 'Notifications')
  const account = button('', openProfile, 'account profile-button')
  account.setAttribute('aria-label', `Open profile for ${user.name}`)
  account.append(el('span', 'avatar', user.stamp), el('span', '', user.name))
  controls.append(notificationButton, account)
  topbar.append(breadcrumb, controls)
  const page = el('div', 'page')
  const pageHeader = el('div', 'page-header')
  const heading = el('div')
  heading.append(el('p', 'eyebrow', 'GOOD PLACES. CLEARER POSSIBILITIES.'), el('h1', '', 'Your property workspace'), el('p', 'page-subtitle', 'Keep the big picture. Move the little things forward.'))
  const addButton = button('+ Add property', add, 'button primary')
  addButton.dataset.addProperty = ''
  pageHeader.append(heading, addButton)
  welcome = el('section', 'welcome-card')
  metrics = el('section', 'metrics'); metrics.setAttribute('aria-label', 'Workspace overview')
  const workspace = el('section', 'workspace')
  workspace.id = 'workspace'; workspace.tabIndex = -1
  const toolbar = el('div', 'workspace-toolbar')
  viewTabs = el('div', 'view-tabs'); viewTabs.setAttribute('role', 'group'); viewTabs.setAttribute('aria-label', 'Property view')
  for (const [key, text] of [['map', '◉ Map'], ['table', '☷ Table'], ['board', '▥ Board']] as const) {
    const tab = button(text, () => { mode = key; renderContent() }, 'view-tab')
    tab.dataset.mode = key; tab.setAttribute('aria-pressed', String(mode === key)); viewTabs.append(tab)
  }
  const tools = el('div', 'button-row')
  tools.append(button('Columns & sorting', configureView, 'button small'), button('Manage bins', manageBins, 'button small'),
    button('Save view', async () => {
      const saveButton = tools.querySelector<HTMLButtonElement>('[data-save-view]')!
      saveButton.disabled = true; saveButton.textContent = 'Saving…'
      try { await api<SavedView>('/view', 'PUT', view); announce('View saved to your account.'); status.textContent = 'View saved to your account.' }
      catch (error) { showError(error) }
      finally { saveButton.disabled = false; saveButton.textContent = 'Save view' }
    }, 'button small'))
  tools.lastElementChild!.setAttribute('data-save-view', '')
  toolbar.append(viewTabs, tools)
  const filters = el('div', 'filters')
  const search = input('search', view.filters.search, 'search'); search.placeholder = 'Search properties, addresses, tags…'
  search.setAttribute('aria-label', 'Search properties')
  let debounce: ReturnType<typeof setTimeout>
  search.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => { view.filters.search = search.value; renderContent() }, 160)
  })
  filterBin = select('filterBin', [{ value: '', label: 'All bins' }, ...binOptions()], view.filters.binId)
  filterBin.setAttribute('aria-label', 'Filter by bin')
  filterTag = select('filterTag', [], view.filters.tag); filterTag.setAttribute('aria-label', 'Filter by tag')
  filterAttribute = select('filterAttribute', [], view.filters.attribute); filterAttribute.setAttribute('aria-label', 'Filter by attribute')
  const attrValue = input('attributeValue', view.filters.value); attrValue.placeholder = 'Value, e.g. >= 1000'; attrValue.setAttribute('aria-label', 'Attribute value or comparison')
  for (const [control, key] of [[filterBin, 'binId'], [filterTag, 'tag'], [filterAttribute, 'attribute']] as const) {
    control.addEventListener('change', () => { view.filters[key] = control.value; renderContent() })
  }
  attrValue.addEventListener('input', () => { view.filters.value = attrValue.value; renderContent() })
  filters.append(search, filterBin, filterTag, filterAttribute, attrValue, button('Reset', () => {
    clearTimeout(debounce); view.filters = structuredClone(defaultView.filters)
    search.value = ''; attrValue.value = ''; refreshOptions(); renderContent()
  }, 'text-button'))
  const results = el('div', 'results-bar')
  resultLabel = el('p', 'muted')
  results.append(resultLabel, button('↻ Refresh', async () => {
    status.textContent = 'Refreshing properties…'
    try {
      const [nextProperties, nextBins, nextLayers] = await Promise.all([api<Property[]>('/properties'), api<Bin[]>('/bins'), api<Layer[]>('/layers')])
      properties = nextProperties; bins = nextBins.sort((a, b) => a.position - b.position); layers = nextLayers
      ownerBins.clear()
      features.clear(); refreshOptions(); renderContent()
      for (const id of view.layers) void loadLayer(id)
      loadSharedBins()
      status.textContent = 'Workspace refreshed.'; announce('Workspace refreshed.')
    } catch (error) { showError(error); status.textContent = 'Refresh failed. Showing the last loaded records.' }
  }, 'text-button'))
  mapLegend = el('div', 'map-legend')
  workspace.append(toolbar, filters, results, mapLegend, content, status)
  page.append(pageHeader, notice, welcome, metrics, workspace)
  const footer = el('footer', 'page-footer', 'Made for the work between the milestones.  ·  Your data, your next move.')
  main.append(topbar, page, footer)
  app.append(sidebar, main)
  refreshOptions()
}

function refreshOptions(): void {
  if (!filterTag) return
  const replaceOptions = (control: HTMLSelectElement, options: { value: string; label: string }[], current: string) => {
    control.replaceChildren(...options.map(item => { const option = el('option', '', item.label); option.value = item.value; return option }))
    // Keep saved filters visible even if the last matching record changed.
    if (current && !options.some(o => o.value === current)) { const option = el('option', '', current); option.value = current; control.append(option) }
    control.value = current
  }
  replaceOptions(filterBin, [{ value: '', label: 'All bins' }, ...binOptions()], view.filters.binId)
  replaceOptions(filterTag, [{ value: '', label: 'All tags' }, ...[...new Set(properties.flatMap(p => p.tags))].sort().map(t => ({ value: t, label: t }))], view.filters.tag)
  replaceOptions(filterAttribute, [{ value: '', label: 'Any attribute' }, ...attributeNames().map(a => ({ value: a, label: a }))], view.filters.attribute)
}

function renderContent(): void {
  if (!metrics) return
  const filtered = filterProperties(properties, view)
  const verified = properties.filter(p => p.verificationStatus === 'verified').length
  const ungeocoded = properties.filter(p => !isMappable(p)).length
  const nextMilestone = properties.length === 0 ? 'Add your first property' : verified === 0 ? 'Select an address location' : 'Keep the next step in sight'
  welcome.replaceChildren()
  const welcomeText = el('div')
  welcomeText.append(el('p', 'eyebrow', 'YOUR FIELD GUIDE'), el('h2', '', properties.length ? 'A little progress, a little perspective.' : `Welcome, ${user.name.split(' ')[0]}. Let’s make room for progress.`),
    el('p', '', properties.length ? 'A geocoded address and a useful note beat a hundred busy edits. Open a dossier to capture both.' : 'Start with one property. Select its address location, leave a field note, and plan what comes next.'))
  const welcomeSteps = el('div', 'welcome-steps')
  welcomeSteps.append(el('span', `step ${properties.length ? 'done' : ''}`, `${properties.length ? '✓' : '1'} Record started`),
    el('span', `step ${verified ? 'done' : ''}`, `${verified ? '✓' : '2'} Location selected`),
    button(nextMilestone + ' ↗', properties.length ? () => { void open(properties.find(p => p.verificationStatus !== 'verified')?.id ?? properties[0].id) } : add, 'text-button'))
  welcome.append(welcomeText, welcomeSteps)
  metrics.replaceChildren()
  for (const [name, value, hint] of [
    ['Properties', properties.length, 'Places in your workspace'],
    ['Geocoded addresses', verified, 'Ready for the map'],
    ['Unlocated drafts', ungeocoded, 'Excluded from the map'],
    ['Pipeline bins', bins.length, 'Your stages, your way'],
  ]) {
    const metric = el('div', 'metric'); metric.append(el('p', 'muted', String(name)), el('strong', '', String(value)), el('small', 'muted', String(hint))); metrics.append(metric)
  }
  resultLabel.textContent = `${filtered.length} of ${properties.length} properties${mode === 'map' ? ` · ${filtered.filter(p => !isMappable(p)).length} unlocated drafts hidden from map` : ''}`
  for (const tab of viewTabs.querySelectorAll<HTMLButtonElement>('button')) {
    tab.classList.toggle('selected', tab.dataset.mode === mode); tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode))
  }
  mapLegend.hidden = mode !== 'map'
  if (mode === 'map') {
    renderLegend()
    if (!map) { content.replaceChildren(); content.className = 'view-content map-view'; map = new PropertyMap(content, id => { void open(id) }) }
    const pointCount = map.update(filtered, catalogBins(), layers, features, view)
    content.querySelector('.map-empty')?.remove()
    if (!pointCount) {
      const empty = el('div', 'map-empty')
      const hasReferenceLocations = view.layers.some(id => id !== 'properties' && (features.get(id)?.length ?? 0) > 0)
      const hiddenProperties = !propertyLayerVisible(view) && filtered.some(isMappable)
      empty.append(el('strong', '', hiddenProperties ? 'Property layer is hidden' : hasReferenceLocations ? 'No locations match this view' : 'No locations to plot yet'), el('p', '', hiddenProperties
        ? 'Enable Properties in the map legend to show these locations, or choose a reference layer.'
        : hasReferenceLocations
        ? 'Reference locations are hidden by the active filters. Clear filters or enable a compatible layer. Unlocated drafts remain available in Table and Board.'
        : filtered.length ? 'Your unlocated drafts are safe in Table and Board. Select an address location in the dossier to add a map location.' : 'Add a property or clear filters to start exploring.'), button('Open table', () => { mode = 'table'; renderContent() }, 'button small'))
      content.append(empty)
    }
  } else {
    map?.destroy(); map = undefined
    content.replaceChildren(); content.className = `view-content ${mode}-view`
    if (mode === 'board') renderBoard(filtered)
    else renderTable(filtered)
    if (!filtered.length) {
      const empty = el('div', 'empty-state')
      empty.append(el('span', 'empty-symbol', '⌂'), el('h3', '', properties.length ? 'No properties match this view' : 'Your next chapter starts here'),
        el('p', 'muted', properties.length ? 'Try another bin, tag, or attribute. Your records are still here.' : 'Add your first property and give it a place in your pipeline.'), button('+ Add property', add, 'button primary'))
      content.append(empty)
    }
  }
}

function renderTable(records: Property[]): void {
  const scroller = el('div', 'table-scroll')
  const table = el('table', 'property-table')
  const caption = el('caption', 'sr-only', 'Properties. Select a property name to open its dossier. Column header buttons sort; Shift-click adds another sort.')
  const head = el('thead'); const row = el('tr')
  const columns = view.columns.length ? view.columns : ['name']
  for (const field of columns) {
    const th = el('th'); th.scope = 'col'
    const sortIndex = view.sorts.findIndex(s => s.field === field)
    const sort = view.sorts[sortIndex]
    th.setAttribute('aria-sort', sort ? view.sorts.length === 1 ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'other' : 'none')
    const sortButton = button(`${fieldName(field)}${sort ? ` ${sort.direction === 'asc' ? '↑' : '↓'}${view.sorts.length > 1 ? sortIndex + 1 : ''}` : ''}`, () => {}, 'sort-button')
    sortButton.title = 'Click to sort. Shift-click to add a secondary sort.'
    sortButton.addEventListener('click', event => {
      const next = { field, direction: (sort?.direction === 'asc' ? 'desc' : 'asc') as 'asc' | 'desc' }
      view.sorts = event.shiftKey ? [...view.sorts.filter(s => s.field !== field), next] : [next]
      renderContent(); announce(`Sorted by ${view.sorts.map(s => `${fieldName(s.field)} ${s.direction}`).join(', ')}.`)
    })
    th.append(sortButton); row.append(th)
  }
  const openHead = el('th', '', 'Dossier'); openHead.scope = 'col'; row.append(openHead)
  head.append(row)
  const body = el('tbody')
  for (const property of records) {
    const tr = el('tr'); tr.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('button,a,input,select')) void open(property.id) })
    for (const field of columns) {
      const td = el('td')
      const matchingBin = catalogBins().find(b => b.id === property.binId)
      const value = field === 'binId' ? matchingBin ? binName(matchingBin) : property.binId : fieldValue(property, field)
      if (field === 'name') {
        const openName = button(property.name, () => open(property.id), 'property-name'); openName.dataset.propertyId = property.id; td.append(openName)
      }
      else if (field === 'verificationStatus') td.append(el('span', `badge ${property.verificationStatus}`, verificationStatusLabel(property.verificationStatus)))
      else if (field === 'binId') {
        const chip = el('span', 'bin-chip', displayValue(value)); chip.style.setProperty('--bin-color', matchingBin?.color ?? '#197e76'); td.append(chip)
      } else if (field === 'tags') for (const tag of property.tags) td.append(el('span', 'tag', tag))
      else if (field === 'creatorStamp') { const stamp = el('span', 'stamp small-stamp', property.creatorStamp); stamp.title = property.creatorName; td.append(stamp) }
      else if (field === 'createdAt' || field === 'updatedAt') td.textContent = new Date(String(value)).toLocaleString()
      else td.textContent = displayValue(value)
      tr.append(td)
    }
    const openCell = el('td')
    const openButton = button('↗', () => open(property.id), 'icon-button'); openButton.setAttribute('aria-label', `Open ${property.name} dossier`)
    openButton.dataset.propertyId = property.id
    openCell.append(openButton); tr.append(openCell); body.append(tr)
  }
  table.append(caption, head, body); scroller.append(table); content.append(scroller)
}

function renderBoard(records: Property[]): void {
  const board = el('div', 'board')
  for (const bin of catalogBins()) {
    const column = el('section', 'board-column'); column.style.setProperty('--bin-color', bin.color)
    const heading = el('header', 'board-heading')
    const inBin = records.filter(p => p.binId === bin.id)
    heading.append(el('h3', '', binName(bin)), el('span', 'count', String(inBin.length)))
    column.append(heading)
    column.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('application/x-reops-property')) { event.preventDefault(); column.classList.add('drag-over'); event.dataTransfer.dropEffect = 'move' } })
    column.addEventListener('dragleave', event => { if (!column.contains(event.relatedTarget as Node | null)) column.classList.remove('drag-over') })
    column.addEventListener('drop', event => {
      event.preventDefault(); column.classList.remove('drag-over')
      const id = event.dataTransfer?.getData('application/x-reops-property')
      if (id) void changeBin(id, bin.id)
    })
    if (!inBin.length) column.append(el('p', 'board-empty', 'Room for a next possibility. Drop a property here or choose this bin in its card.'))
    for (const property of inBin) {
      const card = el('article', 'board-card'); card.draggable = !moving.has(property.id)
      card.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-reops-property', property.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' })
      card.addEventListener('dragend', () => board.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over')))
      const cardHeader = el('div', 'card-top')
      cardHeader.append(el('span', 'eyebrow', 'PROPERTY'), el('span', 'drag-handle', '⠿'))
      const openName = button(property.name, () => open(property.id), 'property-name'); openName.dataset.propertyId = property.id
      card.append(cardHeader, openName, el('p', 'muted card-address', property.enteredAddress))
      const tags = el('div', 'tags'); property.tags.forEach(tag => tags.append(el('span', 'tag', tag)))
      const foot = el('div', 'card-foot')
      const stamp = el('span', 'stamp small-stamp', property.creatorStamp); stamp.title = property.creatorName
      foot.append(stamp, el('span', `badge ${property.verificationStatus}`, verificationStatusLabel(property.verificationStatus)))
      const move = select('moveBin', recordBins(property).map(b => ({ value: b.id, label: b.name })), property.binId); move.disabled = moving.has(property.id)
      move.dataset.propertyId = property.id
      move.setAttribute('aria-label', `Move ${property.name} to bin`)
      move.addEventListener('change', () => { void changeBin(property.id, move.value) })
      card.append(tags, foot, label(moving.has(property.id) ? 'Moving…' : 'Move to bin', move))
      column.append(card)
    }
    board.append(column)
  }
  content.append(board)
}

async function changeBin(id: string, binId: string): Promise<void> {
  const original = properties.find(p => p.id === id)
  if (!original || original.binId === binId || moving.has(id)) return
  const keyboardMove = document.activeElement instanceof HTMLSelectElement && document.activeElement.dataset.propertyId === id
  if (!recordBins(original).some(b => b.id === binId)) {
    showError(new Error('Choose a bin belonging to this property’s owner. Shared records cannot move into your private bins.'))
    return
  }
  moving.add(id); properties = moveProperty(properties, id, binId); renderContent()
  announce(`Moving ${original.name} to ${recordBins(original).find(b => b.id === binId)!.name}.`)
  try {
    const updated = await api<Property>(`/properties/${encodeURIComponent(id)}`, 'PATCH', { version: original.version, binId })
    const index = properties.findIndex(p => p.id === id); if (index >= 0) properties[index] = updated
    announce(`${original.name} moved. All other record details preserved.`)
  } catch (error) {
    const index = properties.findIndex(p => p.id === id); if (index >= 0) properties[index] = original
    showError(error)
    // A conflict needs the latest version before the next move can safely succeed.
    try {
      const detail = await api<{ property: Property }>(`/properties/${encodeURIComponent(id)}`)
      const index = properties.findIndex(p => p.id === id); if (index >= 0) properties[index] = detail.property
    } catch { /* Keep the known record intact if the connection is unavailable. */ }
  } finally {
    moving.delete(id); renderContent()
    if (keyboardMove && document.activeElement === document.body) {
      (document.querySelector<HTMLSelectElement>(`select[name="moveBin"][data-property-id="${CSS.escape(id)}"]`)
        ?? document.querySelector<HTMLElement>('[aria-label="Filter by bin"]'))?.focus()
    }
  }
}

function configureView(): void {
  const modal = dialog('Make the table yours', 'Choose columns, their order, and a priority-ordered multi-sort. Use “Save view” to persist it to your account.')
  let columns = [...view.columns]
  let sorts = view.sorts.map(s => ({ ...s }))
  const choices = el('div', 'column-choices')
  const order = el('div', 'column-order')
  const sortRows = el('div', 'sort-rows')
  const feedback = el('p', 'error-text'); feedback.setAttribute('role', 'alert')
  const renderOrder = () => {
    order.replaceChildren()
    columns.forEach((field, index) => {
      const row = el('div', 'config-row')
      row.append(el('span', '', fieldName(field)))
      const up = button('↑', () => { [columns[index - 1], columns[index]] = [columns[index], columns[index - 1]]; renderOrder() }, 'icon-button')
      up.disabled = index === 0; up.setAttribute('aria-label', `Move ${fieldName(field)} column earlier`)
      const down = button('↓', () => { [columns[index + 1], columns[index]] = [columns[index], columns[index + 1]]; renderOrder() }, 'icon-button')
      down.disabled = index === columns.length - 1; down.setAttribute('aria-label', `Move ${fieldName(field)} column later`)
      row.append(up, down); order.append(row)
    })
  }
  for (const field of availableFields()) {
    const check = input('column', field, 'checkbox'); check.checked = columns.includes(field)
    check.addEventListener('change', () => { columns = check.checked ? [...columns, field] : columns.filter(c => c !== field); renderOrder() })
    choices.append(label(fieldName(field), check))
  }
  const renderSorts = () => {
    sortRows.replaceChildren()
    sorts.forEach((sort, index) => {
      const row = el('div', 'sort-row')
      const field = select('sortField', availableFields().map(f => ({ value: f, label: fieldName(f) })), sort.field)
      field.setAttribute('aria-label', `Sort priority ${index + 1} field`)
      const direction = select('sortDirection', [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], sort.direction)
      direction.setAttribute('aria-label', `Sort priority ${index + 1} direction`)
      field.addEventListener('change', () => { sort.field = field.value })
      direction.addEventListener('change', () => { sort.direction = direction.value as 'asc' | 'desc' })
      row.append(el('span', 'count', String(index + 1)), field, direction, button('×', () => { sorts.splice(index, 1); renderSorts() }, 'icon-button'))
      row.lastElementChild!.setAttribute('aria-label', `Remove sort priority ${index + 1}`)
      sortRows.append(row)
    })
  }
  renderOrder(); renderSorts()
  modal.body.append(el('h3', '', 'Visible columns'), choices, el('h3', '', 'Column order'), order, el('h3', '', 'Sort priorities'), sortRows,
    button('+ Add sort', () => {
      if (sorts.length >= 5) { feedback.textContent = 'Use up to five sort priorities.'; return }
      const field = availableFields().find(f => !sorts.some(s => s.field === f)); if (field) { sorts.push({ field, direction: 'asc' }); renderSorts() }
    }, 'text-button'),
    feedback, button('Apply view', () => {
      if (!columns.length) { feedback.textContent = 'Select at least one table column.'; announce(feedback.textContent); return }
      if (columns.length > 30) { feedback.textContent = 'Select up to 30 table columns.'; announce(feedback.textContent); return }
      if (new Set(sorts.map(s => s.field)).size !== sorts.length) { feedback.textContent = 'Use each field only once in sort priorities.'; announce(feedback.textContent); return }
      view.columns = columns; view.sorts = sorts; mode = 'table'; modal.close(); renderContent()
    }, 'button primary'))
}

function manageBins(): void {
  const modal = dialog('Your pipeline, your pace', 'Create meaningful stages. Names and colors carry through the map, table, and board.')
  const list = el('div', 'stack')
  const render = () => {
    list.replaceChildren()
    for (const bin of bins) {
      const form = el('form', 'bin-form')
      const name = input('name', bin.name); name.required = true; name.maxLength = 100
      const color = input('color', bin.color, 'color')
      const position = input('position', String(bin.position), 'number'); position.min = '0'; position.step = '1'; position.required = true
      form.append(label('Bin name', name), label('Color', color), label('Order', position))
      submitForm(form, 'Save bin', async () => {
        await api<Bin>(`/bins/${encodeURIComponent(bin.id)}`, 'PATCH', { name: name.value.trim(), color: color.value, position: Number(position.value) })
        bins = (await api<Bin[]>('/bins')).sort((a, b) => a.position - b.position)
        refreshOptions(); renderContent(); render(); announce('Bin saved.')
      })
      list.append(form)
    }
  }
  render()
  const create = el('form', 'stack')
  const name = input('name'); name.required = true; name.placeholder = 'e.g. Exploring'; name.maxLength = 100
  const color = input('color', '#197e76', 'color')
  create.append(el('h3', '', 'Add a stage'), label('New bin name', name), label('Bin color', color))
  submitForm(create, 'Create bin', async () => {
    const bin = await api<Bin>('/bins', 'POST', { name: name.value.trim(), color: color.value })
    bins.push(bin); bins.sort((a, b) => a.position - b.position); refreshOptions(); renderContent(); render()
    name.value = ''; announce('Pipeline bin created.')
  })
  modal.body.append(list, create)
}

function renderLegend(): void {
  mapLegend.replaceChildren()
  const propertyLegend = el('div', 'legend-bins')
  propertyLegend.append(el('strong', '', 'Property bins'))
  for (const bin of catalogBins()) {
    const item = el('span', 'legend-item'); const dot = el('span', 'legend-dot'); dot.style.backgroundColor = bin.color
    item.append(dot, el('span', '', binName(bin))); propertyLegend.append(item)
  }
  mapLegend.append(propertyLegend)
  const layersRow = el('div', 'legend-layers')
  layersRow.append(el('strong', '', 'D1 overlays'))
  if (!layers.length) layersRow.append(el('span', 'muted', 'No layers configured'))
  for (const layer of layers) {
    const check = input('layer', layer.id, 'checkbox'); check.checked = view.layers.includes(layer.id)
    check.addEventListener('change', () => {
      view.layers = check.checked ? [...new Set([...view.layers, layer.id])] : view.layers.filter(id => id !== layer.id)
      if (check.checked) void loadLayer(layer.id)
      renderContent()
    })
    const item = label(layer.name, check); item.classList.add('legend-check'); item.style.setProperty('--bin-color', layer.color)
    layersRow.append(item)
    if (view.layers.includes(layer.id)) {
      if (layer.id === 'properties') {
        const count = filterProperties(properties, view).filter(isMappable).length
        layersRow.append(el('span', 'muted', `${count} location${count === 1 ? '' : 's'}${count ? '' : ' · no located properties'}`))
      } else if (layerFilterExclusion(layer, view.filters)) {
        layersRow.append(el('span', 'muted layer-exclusion', `${layer.name}: ${layerFilterExclusion(layer, view.filters)}`))
      } else if (layerLoading.has(layer.id)) layersRow.append(el('span', 'muted', 'Loading…'))
      else if (layerErrors.has(layer.id)) layersRow.append(button(`Retry ${layer.name}: ${layerErrors.get(layer.id)}`, () => loadLayer(layer.id), 'text-button error-text'))
      else if (features.has(layer.id)) {
        const total = features.get(layer.id)!.length
        const count = filterLayerFeatures(layer, features.get(layer.id)!, view).length
        layersRow.append(el('span', 'muted', `${count} of ${total} locations${total ? count ? '' : ' · no filter matches' : ' · layer is empty'}`))
      }
    }
  }
  layersRow.append(button('+ Configure layer', manageLayers, 'text-button'))
  mapLegend.append(layersRow)
  if (view.filters.attribute || view.filters.binId || view.filters.tag) mapLegend.append(el('p', 'muted', 'Filters apply across the map. Reference layers without the active bin, tag, or attribute fields are hidden, never silently left unfiltered.'))
}

async function loadLayer(id: string): Promise<void> {
  if (id === 'properties' || !layers.some(l => l.id === id)) return
  if (layerLoading.has(id) || features.has(id) && !layerErrors.has(id)) return
  layerLoading.add(id); layerErrors.delete(id); if (mode === 'map') renderContent()
  try { features.set(id, await api<LayerFeature[]>(`/layers/${encodeURIComponent(id)}/features`)) }
  catch (error) { layerErrors.set(id, errorMessage(error)); announce(`Layer failed: ${errorMessage(error)}`) }
  finally { layerLoading.delete(id); if (mode === 'map') renderContent() }
}

function manageLayers(): void {
  const modal = dialog('Add context to the map', 'Layers read existing approved D1 source tables. They never create dummy locations or copy your records into browser storage.')
  for (const layer of layers) {
    const item = el('article', 'layer-config')
    item.append(el('h3', '', layer.name), el('p', 'muted', `Source: ${layer.source} · Coordinates: ${layer.latitudeField}, ${layer.longitudeField} · Label: ${layer.labelField}`), el('p', 'muted', `Filterable attributes: ${layer.filterableAttributes.join(', ') || 'None'}`))
    modal.body.append(item)
  }
  const form = el('form', 'stack')
  const name = input('name'); name.required = true
  const color = input('color', '#cc814c', 'color')
  const source = select('source', [{ value: 'layer_points', label: 'layer_points — owner-scoped locations' }], 'layer_points')
  const lat = select('latitudeField', [{ value: 'latitude', label: 'latitude' }], 'latitude')
  const lng = select('longitudeField', [{ value: 'longitude', label: 'longitude' }], 'longitude')
  const featureLabel = select('labelField', [{ value: 'label', label: 'label' }], 'label')
  const attributes = el('fieldset', 'check-list')
  attributes.append(el('legend', '', 'Filterable attribute columns'))
  const attributeChecks = ['category', 'status'].map(name => {
    const check = input('layerAttribute', name, 'checkbox'); check.checked = true; attributes.append(label(name, check)); return check
  })
  const imported = el('textarea'); imported.name = 'features'; imported.rows = 5
  imported.placeholder = 'Paste a JSON array of your location records, or leave blank.'
  form.append(el('h3', '', 'Configure a new layer'), label('Layer name', name), label('Marker color', color),
    label('Approved source table', source, 'This deployment supports the owner-scoped layer_points table. Locations are stored in D1, not in your browser.'),
    label('Latitude column', lat), label('Longitude column', lng), label('Label column', featureLabel),
    attributes, label('Optional location import (JSON)', imported, 'Up to 200 records. Each needs label (text), latitude (number), longitude (number), and optional attributes with category/status text. Leave blank to create an empty layer for a later authorized import.'))
  submitForm(form, 'Create map layer', async () => {
    let importedFeatures: unknown[] | undefined
    if (imported.value.trim()) {
      const parsed: unknown = JSON.parse(imported.value)
      if (!Array.isArray(parsed) || parsed.length > 200) throw new Error('Location import must be a JSON array with at most 200 records.')
      importedFeatures = parsed
    }
    const layer = await api<Layer>('/layers', 'POST', {
      name: name.value.trim(), color: color.value, source: source.value.trim(), latitudeField: lat.value.trim(),
      longitudeField: lng.value.trim(), labelField: featureLabel.value.trim(),
      filterableAttributes: attributeChecks.filter(c => c.checked).map(c => c.value),
      ...(importedFeatures ? { features: importedFeatures } : {}),
    })
    layers.push(layer); view.layers.push(layer.id); refreshOptions(); renderContent(); announce('Map layer configured.')
    modal.close(); void loadLayer(layer.id)
  })
  modal.body.append(form)
}

async function pollNotifications(): Promise<void> {
  try {
    const previousUnread = notifications.filter(n => !n.readAt).length
    notifications = await api<Notification[]>('/notifications')
    const unread = notifications.filter(n => !n.readAt).length
    notificationError = ''
    if (unread > previousUnread) announce(`${unread} unread server notifications.`)
    notificationButton.textContent = unread ? `Notifications · ${unread}` : 'Notifications'
    notificationButton.setAttribute('aria-label', `${unread} unread notifications`)
    notificationButton.title = 'Server-delivered reminders. Checked every 30 seconds.'
    document.querySelector('.notification-error')?.remove()
  } catch (error) {
    notificationError = errorMessage(error)
    notificationButton.title = `Notifications unavailable: ${errorMessage(error)}`
    if (!document.querySelector('.notification-error')) {
      const warning = el('p', 'error-text notification-error', `Notifications unavailable: ${errorMessage(error)}`)
      notice.append(warning)
    }
  }
}

function openNotifications(): void {
  const modal = dialog('Your next moves', 'Reminders delivered by the server. Checked every 30 seconds while this workspace is visible.')
  modal.body.append(el('p', 'muted', 'These notifications belong to reminders originally created by your account. Editing a collaborator’s reminder does not transfer its notifications. The server checks your current property access before opening any dossier.'))
  const list = el('div', 'stack')
  const render = () => {
    list.replaceChildren()
    if (notificationError) list.append(el('p', 'error-text', `Notifications could not load: ${notificationError}. Showing previously loaded notifications, if any.`))
    if (!notifications.length) list.append(el('div', 'empty-inline', 'No notifications yet. Plan a reminder from any property dossier.'))
    for (const notification of notifications) {
      const item = el('article', `notification ${notification.readAt ? 'read' : 'unread'}`)
      item.append(el('strong', '', notification.title), el('p', 'muted', new Date(notification.createdAt).toLocaleString()))
      const actions = el('div', 'button-row')
      actions.append(button('Open property', async () => {
        try {
          await api(`/notifications/${encodeURIComponent(notification.id)}`, 'PATCH', { read: true })
          modal.close(); await pollNotifications(); announce('Notification marked read.'); await open(notification.propertyId)
        } catch (error) { const errorNode = el('p', 'error-text', errorMessage(error)); errorNode.setAttribute('role', 'alert'); item.append(errorNode) }
      }, 'button small'))
      if (!notification.readAt) actions.append(button('Mark read', async () => {
        try {
          await api(`/notifications/${encodeURIComponent(notification.id)}`, 'PATCH', { read: true })
          await pollNotifications(); render(); announce('Notification marked read.')
        } catch (error) { item.append(el('p', 'error-text', errorMessage(error))) }
      }, 'text-button'))
      item.append(actions); list.append(item)
    }
  }
  render()
  modal.body.append(button('Refresh notifications', async () => { await pollNotifications(); render() }, 'button small'), list)
}

void initialize()
