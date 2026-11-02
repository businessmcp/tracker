// @mcphosting/tracker — load and call the BusinessMCP tracker from code. MIT.
//
// This package does NOT bundle the tracker. It injects the one script tag the platform
// serves (track.js, edge-cached and always current), so an install never runs a stale copy
// and the bundle cost is a few hundred bytes. Calls made before the script loads are queued
// on `window.mcph.q` and replayed by the tracker, exactly like the snippet's own stub.

import type { McphApi, McphAttribution, McphMeta } from './types'

export type { McphApi, McphAttribution, McphMeta, McphTouch } from './types'

export const DEFAULT_PLATFORM_ORIGIN = 'https://businessmcp.com'

/**
 * The script URL. Mirrors lib/tracking/host.ts:trackerScriptSrc in the platform: a verified
 * first-party tracking subdomain serves the neutral alias `/m/s.js`, otherwise the platform
 * serves `/track.js`.
 */
export function scriptSrc(host: string | null | undefined, platformOrigin: string = DEFAULT_PLATFORM_ORIGIN): string {
  return host ? `https://${host}/m/s.js` : `${platformOrigin.replace(/\/+$/, '')}/track.js`
}

export type TrackerOptions = {
  /** Your tracker id (Connections → Tracking script, or the dashboard install step). */
  trackerId: string
  /** Your verified tracking subdomain, e.g. `link.acme.com`. Optional. */
  host?: string | null
  /** Override the platform origin (self-hosted gateways, tests). */
  platformOrigin?: string
  /**
   * Extra `data-*` attributes the tracker reads, e.g. `{ 'data-require-consent': 'split' }`
   * or `{ 'data-domains': 'acme.com,shop.acme.com' }`. Only `data-` keys are applied.
   */
  attributes?: Record<string, string>
}

type QueueCall = [method: string, args?: unknown[]]
// Read and written through an untyped view: a host app may declare its own global
// `Window.mcph` (the BusinessMCP repo does), and this package must not depend on its shape.
type McphWindow = { mcph?: unknown }

function ensureStub(w: McphWindow): void {
  if (!w.mcph) w.mcph = { q: [] as QueueCall[] }
}

/** `data-` attribute names only: anything else could inject behaviour into the tag. */
export function safeAttributes(attrs: Record<string, string> | undefined): [string, string][] {
  return Object.entries(attrs ?? {}).filter(([k, v]) => /^data-[a-z][a-z0-9-]*$/.test(k) && typeof v === 'string')
}

function win(): McphWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as McphWindow)
}

function call(method: keyof McphApi, args: unknown[]): unknown {
  const w = win()
  if (!w) return undefined
  const m = w.mcph as McphApi | undefined
  // Loaded: call directly. Not yet: queue on the stub the tracker replays on load.
  if (m && typeof (m as McphApi)[method] === 'function' && method !== 'q') {
    return ((m as McphApi)[method] as (...a: unknown[]) => unknown)(...args)
  }
  ensureStub(w)
  const stub = w.mcph as { q?: { push: (c: QueueCall) => void } }
  if (!stub.q) stub.q = [] as QueueCall[]
  stub.q.push([method, args])
  return undefined
}

/**
 * Inject the tracker once. Safe on the server (no-op) and idempotent in the browser: a page
 * that already carries a tag for this tracker id is left alone.
 */
export function init(opts: TrackerOptions): void {
  const w = win()
  if (!w || typeof document === 'undefined' || !opts?.trackerId) return
  ensureStub(w)
  if (document.querySelector(`script[data-tracker="${CSS.escape(opts.trackerId)}"]`)) return
  const s = document.createElement('script')
  s.defer = true
  s.src = scriptSrc(opts.host, opts.platformOrigin)
  s.setAttribute('data-tracker', opts.trackerId)
  for (const [k, v] of safeAttributes(opts.attributes)) s.setAttribute(k, v)
  document.head.appendChild(s)
}

/** Record a goal, or revenue with `meta.revenue_cents`. */
export function track(name: string, meta?: McphMeta): void {
  call('track', meta ? [name, meta] : [name])
}

/** Identify the visitor by email. */
export function identify(email: string, traits?: McphMeta): void {
  call('identify', traits ? [email, traits] : [email])
}

/** Consent for `data-require-consent` sites. */
export function consent(state: 'granted' | 'denied', persist?: boolean): void {
  call('consent', persist === undefined ? [state] : [state, persist])
}

/** The anonymous visitor id, once the tracker has loaded (pass it to your backend). */
export function getVisitorId(): string | undefined {
  return call('getVisitorId', []) as string | undefined
}

/** First and last touch, once loaded: send it with a server-side signup. */
export function getAttribution(): McphAttribution | null {
  return (call('getAttribution', []) as McphAttribution | null | undefined) ?? null
}
