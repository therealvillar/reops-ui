import type { AddressCandidate, AIRule, Bin, Detail, Property, Reminder } from '../shared/types'
import { announce, api, button, dialog, el, errorMessage, input, label, select, submitForm } from './dom'
import { attributeNamePattern, newPropertyAIRule, validateReminderInstant } from './utils'

interface DetailContext {
  bins: () => Bin[]
  userId: () => string
  propertyBins: (property: Property) => Promise<Bin[]>
  saved: (property: Property) => void
  changed: () => void
}

const dateText = (iso: string, zone?: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short', ...(zone ? { timeZone: zone } : {}),
}).format(new Date(iso))

function stamp(name: string, text: string): HTMLElement {
  const node = el('span', 'stamp', text)
  node.title = `Creator: ${name}`
  node.setAttribute('aria-label', `Creator stamp: ${name}, ${text}`)
  return node
}

function attributeEditor(attributes: Property['attributes']): { node: HTMLElement; value: () => Property['attributes'] } {
  const node = el('fieldset', 'attributes-editor')
  node.append(el('legend', '', 'Custom attributes'))
  const rows = el('div')
  const add = (key = '', value: string | number | boolean | null = '') => {
    const row = el('div', 'attribute-row')
    const keyInput = input('attribute-key', key)
    keyInput.maxLength = 64
    keyInput.pattern = attributeNamePattern
    keyInput.placeholder = 'e.g. Floor area'
    keyInput.setAttribute('aria-label', 'Attribute name')
    const kind = select('attribute-type', ['text', 'number', 'boolean', 'date', 'null'].map(v => ({ value: v, label: v })), value === null ? 'null' : typeof value === 'string' ? 'text' : typeof value)
    kind.setAttribute('aria-label', 'Attribute type')
    const valueInput = input('attribute-value', value === null ? '' : String(value))
    valueInput.setAttribute('aria-label', 'Attribute value')
    const configure = () => {
      valueInput.type = kind.value === 'number' ? 'number' : kind.value === 'date' ? 'date' : 'text'
      valueInput.step = 'any'
      valueInput.disabled = kind.value === 'null'
      valueInput.placeholder = kind.value === 'boolean' ? 'true or false' : 'Value'
    }
    kind.addEventListener('change', configure)
    configure()
    const remove = button('×', () => row.remove(), 'icon-button')
    remove.setAttribute('aria-label', 'Remove attribute')
    row.append(keyInput, kind, valueInput, remove)
    rows.append(row)
  }
  Object.entries(attributes).forEach(([key, value]) => add(key, value))
  node.append(rows, button('+ Add attribute', () => add(), 'text-button'))
  return { node, value: () => {
    const result: Property['attributes'] = Object.create(null)
    for (const row of rows.children) {
      const controls = row.querySelectorAll('input, select')
      const key = (controls[0] as HTMLInputElement).value.trim()
      const kind = (controls[1] as HTMLSelectElement).value
      const value = (controls[2] as HTMLInputElement).value
      if (!key) throw new Error('Give each attribute a name, or remove the empty row.')
      if (!/^[a-zA-Z][\w -]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('Attribute names must start with a letter and use up to 64 letters, numbers, spaces, underscores, or hyphens.')
      if (Object.hasOwn(result, key)) throw new Error(`Attribute “${key}” is listed twice.`)
      if (kind === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error(`Enter a number for ${key}.`)
      if (kind === 'boolean' && !['true', 'false'].includes(value.toLowerCase())) throw new Error(`Use true or false for ${key}.`)
      result[key] = kind === 'null' ? null : kind === 'number' ? Number(value) : kind === 'boolean' ? value.toLowerCase() === 'true' : value
    }
    return result
  } }
}

function propertyForm(property: Property | undefined, bins: Bin[], save: (body: Record<string, unknown>) => Promise<void>): HTMLFormElement {
  const form = el('form', 'stack')
  const name = input('name', property?.name)
  name.required = true; name.maxLength = 200
  const address = input('address', property?.enteredAddress)
  address.required = true; address.maxLength = 500
  address.autocomplete = 'off'
  address.setAttribute('role', 'combobox')
  address.setAttribute('aria-autocomplete', 'list')
  address.setAttribute('aria-expanded', 'false')
  const candidates = el('div', 'address-candidates')
  candidates.id = `candidates-${crypto.randomUUID()}`
  candidates.setAttribute('role', 'listbox')
  address.setAttribute('aria-controls', candidates.id)
  const status = el('p', 'muted address-status', property?.verificationMessage ?? 'Confirm an address suggestion when available. Drafts can be saved without verification.')
  status.setAttribute('role', 'status')
  let token: string | undefined
  let selectedAddress: string | undefined
  let sequence = 0
  let timer: ReturnType<typeof setTimeout>
  const choose = (candidate: AddressCandidate) => {
    address.value = candidate.label
    selectedAddress = candidate.label
    token = candidate.token
    candidates.replaceChildren()
    address.setAttribute('aria-expanded', 'false')
    status.textContent = candidate.message
    address.focus()
  }
  address.addEventListener('input', () => {
    token = undefined; selectedAddress = undefined
    candidates.replaceChildren()
    address.setAttribute('aria-expanded', 'false')
    clearTimeout(timer)
    const current = ++sequence
    if (address.value.trim().length < 3) { status.textContent = 'Type at least 3 characters to search addresses.'; return }
    status.textContent = 'Searching addresses…'
    timer = setTimeout(async () => {
      try {
        const result = await api<{ candidates: AddressCandidate[]; message: string }>('/addresses/search', 'POST', { query: address.value })
        if (current !== sequence || !address.isConnected) return
        status.textContent = result.message
        for (const candidate of result.candidates) {
          const option = button(candidate.label, () => choose(candidate), 'address-option')
          option.setAttribute('role', 'option')
          option.setAttribute('aria-selected', 'false')
          option.addEventListener('keydown', event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); (option.nextElementSibling as HTMLElement | null)?.focus() }
            if (event.key === 'ArrowUp') { event.preventDefault(); const previous = option.previousElementSibling as HTMLElement | null; (previous ?? address).focus() }
            if (event.key === 'Escape') { candidates.replaceChildren(); address.setAttribute('aria-expanded', 'false'); address.focus() }
          })
          candidates.append(option)
        }
        address.setAttribute('aria-expanded', String(result.candidates.length > 0))
      } catch (error) { if (current === sequence) status.textContent = `${errorMessage(error)} You can still save an unverified draft.` }
    }, 350)
  })
  address.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && candidates.firstElementChild) { event.preventDefault(); (candidates.firstElementChild as HTMLElement).focus() }
    if (event.key === 'Escape') { candidates.replaceChildren(); address.setAttribute('aria-expanded', 'false'); event.stopPropagation() }
  })
  const bin = select('binId', bins.map(b => ({ value: b.id, label: b.name })), property?.binId ?? bins[0]?.id)
  bin.required = true
  const tags = input('tags', property?.tags.join(', '))
  const attrs = attributeEditor(property?.attributes ?? {})
  form.append(label('Property name', name), label('Street address', address), candidates, status,
    label('Pipeline bin', bin), label('Tags', tags, 'Separate tags with commas.'), attrs.node)
  submitForm(form, property ? 'Save property' : 'Create property', async () => {
    const body: Record<string, unknown> = {
      name: name.value.trim(), enteredAddress: address.value.trim(), binId: bin.value,
      tags: [...new Set(tags.value.split(',').map(t => t.trim()).filter(Boolean))], attributes: attrs.value(),
    }
    if (property) body.version = property.version
    if (token && selectedAddress === address.value) body.addressToken = token
    await save(body)
  })
  return form
}

export function createProperty(context: DetailContext, open: (id: string) => void): void {
  const modal = dialog('A new place to start', 'Add a property to your pipeline. Every useful detail moves it forward.')
  if (!context.bins().length) {
    modal.body.append(el('p', '', 'Create your first pipeline bin before adding a property. Use “Manage bins” in the workspace toolbar.'))
    return
  }
  const automation = el('section', 'progress-card stack')
  automation.append(el('strong', '', 'Optional analysis for new properties'))
  const automationStatus = el('p', 'muted', 'Loading your new-property opt-in…')
  automationStatus.setAttribute('role', 'status')
  const renderDefault = (rule: AIRule | null) => {
    automationStatus.textContent = rule?.enabled
      ? `Enabled for future records. Shared fields: ${rule.fields.join(', ')}. Triggers: ${rule.triggers.join(', ')}.`
      : 'Disabled. No automatic AI sharing for new records.'
  }
  automation.append(automationStatus, button('Configure new-property AI opt-in', async () => {
    const settings = dialog('New-property analysis opt-in', 'These defaults are inherited by future properties only. Configure creation analysis before adding a record; existing records keep their own rules.')
    settings.body.append(el('p', 'loading', 'Loading your opt-in settings…'))
    try {
      const rule = await api<AIRule | null>('/ai-default-rule')
      if (!settings.node.isConnected) return
      settings.body.replaceChildren(ruleEditor(newPropertyAIRule(rule), async next => {
        const saved = await api<AIRule>('/ai-default-rule', 'PUT', next)
        renderDefault(saved); announce('New-property AI opt-in saved.'); settings.close()
      }, true))
    } catch (error) { settings.body.replaceChildren(el('p', 'error-text', errorMessage(error))) }
  }, 'button small'))
  modal.body.append(automation)
  void api<AIRule | null>('/ai-default-rule').then(renderDefault).catch(error => {
    automationStatus.textContent = `Opt-in settings unavailable: ${errorMessage(error)}`
  })
  modal.body.append(propertyForm(undefined, context.bins(), async body => {
    const property = await api<Property>('/properties', 'POST', body)
    context.saved(property)
    announce('Property created.')
    modal.close()
    open(property.id)
  }))
}

export async function openProperty(id: string, context: DetailContext): Promise<void> {
  const modal = dialog('Property dossier', 'One record. Every detail, decision, and next step.')
  modal.node.classList.add('detail-dialog')
  const body = modal.body
  let detail: Detail
  let propertyBins: Bin[] = []
  let binsError = ''
  const refresh = async () => {
    detail = await api<Detail>(`/properties/${encodeURIComponent(id)}`)
    try { propertyBins = await context.propertyBins(detail.property); binsError = '' }
    catch (error) {
      binsError = `Owner’s bins could not load: ${errorMessage(error)}. The current bin will be preserved.`
      propertyBins = [{ id: detail.property.binId, name: 'Current owner bin', color: '#64748b', position: 0 }]
    }
    if (!modal.node.isConnected) return
    context.saved(detail.property)
    render()
  }
  const section = (title: string, description?: string) => {
    const block = el('section', 'detail-section')
    block.append(el('h3', '', title))
    if (description) block.append(el('p', 'muted', description))
    return block
  }
  const render = () => {
    const active = document.activeElement as HTMLElement | null
    body.replaceChildren()
    const p = detail.property
    const summary = el('div', 'dossier-summary')
    const title = el('div')
    title.append(el('p', 'eyebrow', 'PROPERTY DOSSIER'), el('h2', '', p.name), el('p', 'muted', p.enteredAddress))
    title.append(button('Reload latest record', async () => {
      try { await refresh(); announce('Latest record loaded. Unsaved form edits were replaced.') }
      catch (error) { showInlineError(body, error) }
    }, 'text-button'))
    summary.append(title, stamp(p.creatorName, p.creatorStamp))
    const verify = el('div', `verification ${p.verificationStatus}`)
    verify.append(el('strong', '', `Address ${p.verificationStatus}`), el('p', '', p.verificationMessage ?? 'No address verification result available.'))
    if (p.normalizedAddress) verify.append(el('p', '', p.normalizedAddress))
    const progress = el('div', 'progress-card')
    const milestones = [Boolean(p.name && p.enteredAddress), p.verificationStatus === 'verified', detail.notes.length > 0, detail.reminders.some(r => ['scheduled', 'delivered', 'completed'].includes(r.state))]
    progress.append(el('strong', '', `${milestones.filter(Boolean).length}/4 thoughtful steps`), el('p', 'muted', 'A record started · address verified · insight noted · next step planned'))
    const bar = el('progress'); bar.max = 4; bar.value = milestones.filter(Boolean).length; bar.setAttribute('aria-label', 'Useful property completion')
    progress.append(bar)
    const edit = section('Property details', 'Your creator stamp stays with this record, wherever it goes.')
    if (binsError) edit.append(el('p', 'error-text', binsError))
    if (p.creatorId !== context.userId()) edit.append(el('p', 'muted', 'Shared property. Bin choices belong to its original owner. Your account’s private bins are not valid destinations. Changes are signed with your identity; the original creator stamp stays unchanged.'))
    edit.append(propertyForm(p, propertyBins, async changes => {
      const updated = await api<Property>(`/properties/${encodeURIComponent(id)}`, 'PATCH', changes)
      context.saved(updated); announce('Property saved.'); await refresh()
    }))
    const notes = section('Field notes', 'Leave a little context for your future self.')
    const noteForm = el('form', 'stack')
    const noteBody = el('textarea'); noteBody.name = 'note'; noteBody.required = true; noteBody.rows = 3; noteBody.maxLength = 10000
    noteForm.append(label('New note', noteBody))
    submitForm(noteForm, 'Add note', async () => {
      await api(`/properties/${encodeURIComponent(id)}/notes`, 'POST', { body: noteBody.value.trim() })
      announce('Note added.'); await refresh()
    })
    notes.append(noteForm)
    if (!detail.notes.length) notes.append(el('p', 'empty-inline', 'No notes yet. A good observation is a good beginning.'))
    for (const note of detail.notes) {
      const card = el('article', 'note')
      const meta = el('div', 'note-meta')
      meta.append(stamp(note.actorName, note.actorStamp), el('span', 'muted', `${note.actorName} · ${dateText(note.createdAt)}`))
      card.append(meta, el('p', 'preserve-lines', note.body)); notes.append(card)
    }
    const reminders = section('Next steps', 'Reminders are delivered by the server, even when this workspace is closed.')
    reminders.append(el('p', 'muted', 'Notifications go to the original reminder creator, not the property’s creator or a later editor. Editing a shared reminder does not change its recipient. Delivery and opening its property require current access.'))
    reminders.append(button('+ Plan a reminder', () => editReminder(id, undefined, refresh), 'button small'))
    if (!detail.reminders.length) reminders.append(el('p', 'empty-inline', 'No reminders planned.'))
    for (const reminder of detail.reminders) {
      const card = el('article', 'reminder')
      card.append(el('strong', '', reminder.title), el('p', 'muted', `${dateText(reminder.dueAt, reminder.timeZone)} · ${reminder.timeZone}`), el('span', `badge ${reminder.state}`, reminder.state))
      card.append(el('p', 'muted preserve-lines', reminder.createdBy === context.userId() ? 'Notification recipient: your account' : `Notification recipient: ${reminder.createdBy}`))
      if (reminder.error) card.append(el('p', 'error-text', reminder.error))
      const actions = el('div', 'button-row')
      actions.append(button('Edit', () => editReminder(id, reminder, refresh), 'text-button'))
      for (const state of ['completed', 'cancelled'] as const) {
        if (reminder.state !== 'completed' && reminder.state !== 'cancelled') {
          actions.append(button(state === 'completed' ? 'Mark complete' : 'Cancel', async () => {
            try {
              await api(`/properties/${encodeURIComponent(id)}/reminders/${encodeURIComponent(reminder.id)}`, 'PATCH', { state })
              announce(`Reminder ${state}.`); await refresh()
            } catch (error) { showInlineError(card, error) }
          }, 'text-button'))
        }
      }
      card.append(actions); reminders.append(card)
    }
    const analysis = aiSection(id, detail, refresh, section)
    const history = section('Record trail', 'A transparent timeline, signed by the person who made the change.')
    if (!detail.history.length) history.append(el('p', 'empty-inline', 'No recorded activity yet.'))
    for (const activity of detail.history) {
      const item = el('details', 'history-item')
      const summary = el('summary', '', `${activity.actorStamp} ${activity.actorName} · ${activity.action} · ${dateText(activity.createdAt)}`)
      item.append(summary, el('pre', 'history-values', JSON.stringify({ before: activity.before, after: activity.after }, null, 2)))
      history.append(item)
    }
    const collaboration = p.creatorId === context.userId()
      ? sharingSection(id, refresh)
      : section('Shared access', 'Access was granted to your stable user ID. Only the property owner can manage collaborators. Viewer accounts can read; editor accounts can save changes. The server checks every action.')
    body.append(summary, verify, progress, edit, collaboration, notes, reminders, analysis, history)
    if (active && !active.isConnected) body.querySelector<HTMLElement>('input,button')?.focus()
  }
  body.append(el('p', 'loading', 'Opening the dossier…'))
  try { await refresh() }
  catch (error) {
    body.replaceChildren(el('p', 'error-text', errorMessage(error)), button('Try again', async () => {
      try { await refresh() } catch (retryError) { showInlineError(body, retryError) }
    }))
  }
}

function showInlineError(container: HTMLElement, error: unknown): void {
  container.querySelector('.inline-error')?.remove()
  const node = el('p', 'error-text inline-error', errorMessage(error))
  node.setAttribute('role', 'alert'); container.append(node); announce(node.textContent!)
}

interface Member { userId: string; name: string; stamp: string; role: 'viewer' | 'editor' }

function sharingSection(id: string, refresh: () => Promise<void>): HTMLElement {
  const section = el('section', 'detail-section')
  section.append(el('h3', '', 'Share this property'), el('p', 'muted', 'Grant access to a known registered user by their exact stable ID. Ask them to sign in, open their profile, and copy their ID. Your creator stamp is permanent.'))
  const list = el('div', 'stack')
  list.append(el('p', 'loading', 'Loading record grants…'))
  const load = async () => {
    const members = await api<Member[]>(`/properties/${encodeURIComponent(id)}/members`)
    if (!section.isConnected) return
    list.replaceChildren()
    if (!members.length) list.append(el('p', 'empty-inline', 'Private to you. No individual access grants yet.'))
    for (const member of members) {
      const card = el('article', 'notification')
      card.append(el('strong', '', member.name), el('p', 'preserve-lines', member.userId), stamp(member.name, member.stamp))
      const form = el('form', 'stack')
      const role = select('role', [{ value: 'viewer', label: 'Viewer — read only' }, { value: 'editor', label: 'Editor — can update this record' }], member.role)
      form.append(label(`Access for ${member.name}`, role))
      submitForm(form, 'Save role', async () => {
        await api(`/properties/${encodeURIComponent(id)}/members`, 'POST', { userId: member.userId, role: role.value })
        announce('Record access updated.'); await refresh()
      })
      card.append(form, button('Remove access', async () => {
        try { await api(`/properties/${encodeURIComponent(id)}/members/${encodeURIComponent(member.userId)}`, 'DELETE'); announce('Access grant removed.'); await refresh() }
        catch (error) { showInlineError(card, error) }
      }, 'text-button'))
      list.append(card)
    }
  }
  const form = el('form', 'stack')
  const userId = input('memberUserId'); userId.required = true; userId.maxLength = 500
  const role = select('memberRole', [{ value: 'viewer', label: 'Viewer — read only' }, { value: 'editor', label: 'Editor — can update this record' }], 'viewer')
  form.append(label('Exact stable user ID', userId), label('Access role', role))
  submitForm(form, 'Grant record access', async () => {
    await api(`/properties/${encodeURIComponent(id)}/members`, 'POST', { userId: userId.value.trim(), role: role.value })
    announce('Property access granted.'); await refresh()
  })
  section.append(list, form)
  void load().catch(error => {
    list.replaceChildren(el('p', 'error-text', errorMessage(error)), button('Retry grants', async () => {
      try { await load() } catch (retryError) { showInlineError(list, retryError) }
    }, 'button small'))
  })
  return section
}

function offsetTimestamp(instant: string, timeZone: string): string {
  const date = new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(date)
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? ''
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00'
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}${offset}`
}

function editReminder(id: string, reminder: Reminder | undefined, refresh: () => Promise<void>): void {
  const modal = dialog(reminder ? 'Edit next step' : 'Plan a next step', 'Choose an explicit time and timezone. No guessing at daylight-saving boundaries.')
  const form = el('form', 'stack')
  const zoneValue = reminder?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const title = input('title', reminder?.title); title.required = true; title.maxLength = 300
  const due = input('dueAt', reminder ? offsetTimestamp(reminder.dueAt, reminder.timeZone) : '')
  due.required = true; due.placeholder = offsetTimestamp(new Date(Date.now() + 86400000).toISOString(), zoneValue)
  const zone = input('timeZone', zoneValue); zone.required = true
  form.append(label('What needs to happen?', title),
    label('Date and time with UTC offset', due, 'Format: YYYY-MM-DDTHH:MM±HH:MM. Example: 2026-11-05T09:00-08:00 in America/Los_Angeles. The offset must match the timezone below.'),
    label('IANA timezone', zone, 'For example America/Vancouver, America/New_York, Europe/London, or UTC.'))
  const preview = el('p', 'muted')
  const updatePreview = () => {
    try { preview.textContent = `Scheduled for ${dateText(validateReminderInstant(due.value, zone.value), zone.value)} in ${zone.value}.` }
    catch (error) { preview.textContent = errorMessage(error) }
  }
  due.addEventListener('input', updatePreview); zone.addEventListener('input', updatePreview)
  form.append(preview)
  if (reminder) {
    const state = select('state', [
      { value: '', label: `Keep current status (${reminder.state})` },
      ...['scheduled', 'completed', 'cancelled'].filter(s => reminder.state !== 'delivered' || s !== 'scheduled')
        .map(s => ({ value: s, label: s })),
    ])
    form.append(label('Reminder status', state))
    if (reminder.state === 'delivered') form.append(el('p', 'muted', 'This reminder has already been delivered. Create a new reminder if you need another notification.'))
  }
  submitForm(form, 'Save reminder', async () => {
    const dueAt = validateReminderInstant(due.value.trim(), zone.value.trim())
    const state = form.querySelector<HTMLSelectElement>('[name="state"]')?.value
    await api(`/properties/${encodeURIComponent(id)}/reminders${reminder ? `/${encodeURIComponent(reminder.id)}` : ''}`, reminder ? 'PATCH' : 'POST',
      { title: title.value.trim(), dueAt, timeZone: zone.value.trim(), ...(state ? { state } : {}) })
    announce('Reminder saved.'); modal.close(); await refresh()
  })
  modal.body.append(form)
}

const aiFields = ['name', 'enteredAddress', 'normalizedAddress', 'verificationStatus', 'binId', 'tags', 'attributes', 'latitude', 'longitude']

function fieldChecks(title: string, selected: string[]): { node: HTMLElement; value: () => string[] } {
  const node = el('fieldset', 'check-list')
  node.append(el('legend', '', title))
  const controls: HTMLInputElement[] = []
  for (const field of aiFields) {
    const check = input('ai-field', field, 'checkbox'); check.checked = selected.includes(field)
    controls.push(check); node.append(label(field, check))
  }
  return { node, value: () => controls.filter(c => c.checked).map(c => c.value) }
}

function ruleEditor(rule: AIRule | null, save: (rule: AIRule) => Promise<void>, defaults = false): HTMLFormElement {
  const form = el('form', 'stack')
  const enabled = input('enabled', '', 'checkbox'); enabled.checked = rule?.enabled ?? false
  form.append(label(defaults ? 'Enable automatic analysis for future properties' : 'Enable automatic analysis for this record', enabled))
  const triggers = el('fieldset', 'check-list'); triggers.append(el('legend', '', 'Run when'))
  const checks: HTMLInputElement[] = []
  for (const trigger of ['creation', 'field_change', 'reminder']) {
    const check = input('trigger', trigger, 'checkbox'); check.checked = rule?.triggers.includes(trigger as AIRule['triggers'][number]) ?? false
    checks.push(check); triggers.append(label(trigger.replace('_', ' '), check))
  }
  const watched = fieldChecks('Watched fields for field-change triggers', rule?.watchedFields ?? [])
  const shared = fieldChecks('Fields shared on every automatic run', rule?.fields ?? ['name', 'enteredAddress'])
  const autoConsent = input('automatic-consent', '', 'checkbox')
  form.append(triggers, watched.node, shared.node, label(defaults
    ? 'I consent to sharing these fields from all future properties with the analysis provider when the selected triggers occur.'
    : 'I consent to automatic sharing of these fields when the selected triggers occur.', autoConsent),
    el('p', 'muted', defaults
      ? 'AI is read-only. Defaults apply only to future records and can be disabled at any time. Each created record retains its own inherited rule until you change it in its dossier.'
      : 'Creation triggers apply only at creation; enabling a rule afterward does not backfill a creation event. Set new-property opt-in from Add property before creating a record.'))
  submitForm(form, defaults ? 'Save new-property opt-in' : 'Save analysis rule', async () => {
    if (enabled.checked && !autoConsent.checked) throw new Error('Confirm consent before enabling automatic analysis.')
    if (enabled.checked && (!shared.value().length || !checks.some(c => c.checked))) throw new Error('Choose fields to share and at least one trigger.')
    if (!shared.value().length) throw new Error('Choose at least one field to share in the rule configuration.')
    if (checks.some(c => c.checked && c.value === 'field_change') && !watched.value().length) throw new Error('Choose fields to watch for field-change analysis.')
    await save({
      enabled: enabled.checked, triggers: checks.filter(c => c.checked).map(c => c.value as AIRule['triggers'][number]),
      watchedFields: watched.value(), fields: shared.value(),
    })
  })
  return form
}

function aiSection(id: string, detail: Detail, refresh: () => Promise<void>, section: (title: string, description?: string) => HTMLElement): HTMLElement {
  const block = section('A second perspective', 'AI is an optional, read-only analysis. It cannot edit your property, move a bin, or schedule a reminder. Only selected fields are shared with the authorized analysis provider.')
  const manual = el('form', 'stack')
  const fields = fieldChecks('Fields to share for this analysis', ['name', 'enteredAddress'])
  const consent = input('consent', '', 'checkbox'); consent.required = true
  manual.append(fields.node, label('I consent to sharing the selected fields with the analysis provider.', consent))
  let key = crypto.randomUUID()
  submitForm(manual, 'Request analysis', async () => {
    if (!fields.value().length) throw new Error('Select at least one field to analyze.')
    await api(`/properties/${encodeURIComponent(id)}/ai`, 'POST', { fields: fields.value(), idempotencyKey: key })
    key = crypto.randomUUID(); announce('Analysis requested.'); await refresh()
  })
  block.append(manual)
  const rules = el('details', 'rule-editor')
  rules.append(el('summary', '', 'Automatic analysis rules'))
  rules.append(ruleEditor(detail.aiRule, async rule => {
    await api(`/properties/${encodeURIComponent(id)}/ai-rule`, 'PUT', rule)
    announce('Analysis rule saved.'); await refresh()
  }))
  block.append(rules)
  const jobs = el('div', 'ai-jobs')
  if (!detail.aiJobs.length) jobs.append(el('p', 'empty-inline', 'No analysis yet. Your judgment stays in charge.'))
  for (const job of detail.aiJobs) {
    const item = el('article', 'ai-job')
    item.append(el('span', `badge ${job.state}`, job.state), el('p', 'muted', `${job.trigger} · ${dateText(job.createdAt)} · ${job.attempts} attempt(s)`), el('p', 'muted', `Shared fields: ${job.fields.join(', ')}`))
    if (job.result) item.append(el('p', 'preserve-lines ai-result', job.result))
    if (job.error) item.append(el('p', 'error-text', job.error))
    if (job.state === 'failed' && job.attempts >= 3) item.append(el('p', 'muted', 'The three-attempt retry limit has been reached. You can request a new analysis with fresh consent.'))
    if (job.state === 'failed' && job.attempts < 3) item.append(button('Retry analysis', async () => {
      try { await api(`/properties/${encodeURIComponent(id)}/ai/${encodeURIComponent(job.id)}/retry`, 'POST', {}); announce('Retry requested.'); await refresh() }
      catch (error) { showInlineError(item, error) }
    }, 'button small'))
    jobs.append(item)
  }
  if (detail.aiJobs.some(j => j.state === 'pending' || j.state === 'running')) {
    jobs.append(button('Refresh analysis status', async () => {
      try { await refresh() } catch (error) { showInlineError(jobs, error) }
    }, 'button small'))
  }
  block.append(jobs)
  return block
}
