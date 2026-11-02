export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className = '', text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function button(text: string, action: () => unknown, className = 'button'): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  let busy = false
  node.addEventListener('click', async () => {
    if (node.disabled || busy) return
    const result = action()
    if (result instanceof Promise) {
      busy = true
      node.setAttribute('aria-disabled', 'true')
      node.setAttribute('aria-busy', 'true')
      try { await result }
      finally { busy = false; node.removeAttribute('aria-disabled'); node.removeAttribute('aria-busy') }
    }
  })
  return node
}

export function input(name: string, value = '', type = 'text'): HTMLInputElement {
  const node = el('input')
  node.name = name
  node.type = type
  node.value = value
  return node
}

export function select(name: string, items: { value: string; label: string }[], value = ''): HTMLSelectElement {
  const node = el('select')
  node.name = name
  for (const item of items) {
    const option = el('option', '', item.label)
    option.value = item.value
    node.append(option)
  }
  node.value = value
  return node
}

let nextId = 0
export function label(text: string, control: HTMLElement, hint?: string): HTMLDivElement {
  const wrapper = el('div', 'field')
  const id = `field-${++nextId}`
  control.id = id
  const caption = el('label', '', text)
  caption.htmlFor = id
  wrapper.append(caption, control)
  if (hint) {
    const help = el('small', 'muted', hint)
    help.id = `${id}-help`
    control.setAttribute('aria-describedby', help.id)
    wrapper.append(help)
  }
  return wrapper
}

export function announce(text: string): void {
  const node = document.getElementById('announcer')
  if (node) node.textContent = text
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: unknown
  try { data = await response.json() } catch { data = null }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `Request failed (${response.status}).`
    throw new ApiError(response.status === 401
      ? 'Sign in through Cloudflare Access to open your private workspace. Reload after signing in.'
      : message, response.status)
  }
  return data as T
}

export function dialog(title: string, subtitle?: string): { node: HTMLDialogElement; body: HTMLDivElement; close: () => void } {
  const previous = document.activeElement as HTMLElement | null
  const propertyId = previous?.dataset.propertyId
  const node = el('dialog', 'dialog')
  const heading = el('header', 'dialog-header')
  const titleBlock = el('div')
  const h = el('h2', '', title)
  h.id = `dialog-${++nextId}`
  node.setAttribute('aria-labelledby', h.id)
  titleBlock.append(h)
  if (subtitle) titleBlock.append(el('p', 'muted', subtitle))
  const close = () => node.close()
  const closeButton = button('×', close, 'icon-button')
  closeButton.setAttribute('aria-label', 'Close dialog')
  heading.append(titleBlock, closeButton)
  const body = el('div', 'dialog-body')
  node.append(heading, body)
  document.body.append(node)
  node.addEventListener('click', event => { if (event.target === node) close() })
  node.addEventListener('close', () => {
    node.remove()
    if (previous?.isConnected) previous.focus()
    else if (document.querySelector('dialog[open]')) document.querySelector<HTMLElement>('dialog[open] input, dialog[open] button')?.focus()
    else if (propertyId) (document.querySelector<HTMLElement>(`[data-property-id="${CSS.escape(propertyId)}"]`) ?? document.querySelector<HTMLElement>('[data-add-property]'))?.focus()
    else document.querySelector<HTMLElement>('[data-add-property]')?.focus()
  })
  node.showModal()
  return { node, body, close }
}

export function submitForm(form: HTMLFormElement, text: string, action: () => Promise<void>): void {
  const feedback = el('p', 'form-feedback')
  feedback.setAttribute('role', 'alert')
  const submit = el('button', 'button primary', text)
  submit.type = 'submit'
  form.append(feedback, submit)
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!form.reportValidity() || submit.disabled) return
    const hadFocus = document.activeElement === submit
    const ownerDialog = form.closest('dialog')
    submit.disabled = true
    submit.textContent = 'Saving…'
    form.setAttribute('aria-busy', 'true')
    feedback.textContent = ''
    try { await action() }
    catch (error) {
      feedback.textContent = errorMessage(error)
      announce(feedback.textContent)
      if (error instanceof ApiError && error.status === 401) {
        const link = el('a', 'sign-in-link', 'Open Access sign-in')
        link.href = `/cdn-cgi/access/login?redirect_url=${encodeURIComponent(window.location.href)}`
        feedback.append(document.createTextNode(' '), link)
      }
    }
    finally {
      submit.disabled = false; submit.textContent = text; form.removeAttribute('aria-busy')
      if (hadFocus && document.activeElement === document.body) {
        const target = submit.isConnected ? submit : ownerDialog?.open
          ? [...ownerDialog.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find(control => control.textContent === text) : undefined
        target?.focus()
      }
    }
  })
}
