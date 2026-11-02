// @mcphosting/node — send events, identities and accounts to BusinessMCP from your server. MIT.
//
//   import { BusinessMCP } from '@mcphosting/node'
//   const bmcp = new BusinessMCP({ apiKey: process.env.BUSINESSMCP_API_KEY! })
//   bmcp.track({ name: 'signup', user_id: 'u_123', properties: { plan: 'pro' } })
//   bmcp.identify({ user_id: 'u_123', email: 'ada@acme.com' })
//   await bmcp.shutdown()                       // flush before a serverless function returns
//
// Zero dependencies: the platform's global fetch (Node 18+). Events are batched and sent as
// NDJSON to POST /api/v1/track (at most 500 per request, the API's limit). identify and group
// are sent at once. A failed send is reported through `onError`, never thrown into your code.

export const DEFAULT_BASE_URL = 'https://businessmcp.com'
/** The Events API's own per-request limit. */
export const MAX_BATCH = 500

/** The endpoints this client calls; packages/sdk.test.ts pins them to the platform's API. */
export const PATHS = {
  track: '/api/v1/track',
  identify: '/api/v1/identify',
  group: '/api/v1/group',
  goal: (trackerId: string) => `/api/tracker/${encodeURIComponent(trackerId)}/goal`,
} as const

export type TrackEvent = {
  name: string
  user_id?: string
  visitor_id?: string
  /** ISO 8601; at most 30 days back. Defaults to now. */
  timestamp?: string
  properties?: Record<string, unknown>
  revenue_cents?: number
}

export type IdentifyInput = { user_id?: string; email?: string; visitor_id?: string; traits?: Record<string, unknown> }
export type GroupInput = { account_id: string; name?: string; domain?: string; plan?: string; mrr_cents?: number; seats?: number; traits?: Record<string, unknown>; user_ids?: string[] }

export type ClientOptions = {
  /** An `mcph_` key (Settings → API & access). */
  apiKey: string
  baseUrl?: string
  /** Flush when this many events are queued. Default 100, at most 500. */
  flushAt?: number
  /** Flush at least this often while events are queued. Default 2000 ms; 0 disables the timer. */
  flushIntervalMs?: number
  fetch?: typeof fetch
  onError?: (err: Error) => void
}

export class BusinessMCP {
  private queue: TrackEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void>[] = []
  private readonly base: string
  private readonly flushAt: number
  private readonly interval: number
  private readonly f: typeof fetch

  constructor(private readonly opts: ClientOptions) {
    if (!opts?.apiKey) throw new Error('BusinessMCP: apiKey is required')
    this.base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.flushAt = Math.min(Math.max(1, opts.flushAt ?? 100), MAX_BATCH)
    this.interval = opts.flushIntervalMs ?? 2000
    this.f = opts.fetch ?? fetch
  }

  /** Queue one event. Sent in the next batch. */
  track(event: TrackEvent): void {
    if (!event?.name) return
    this.queue.push({ ...event, timestamp: event.timestamp ?? new Date().toISOString() })
    if (this.queue.length >= this.flushAt) this.track_flush()
    else if (this.interval > 0 && !this.timer) this.timer = setTimeout(() => this.track_flush(), this.interval)
  }

  /** Link your product's user id and/or email to the CRM contact, with traits. */
  identify(input: IdentifyInput): Promise<void> {
    return this.send(PATHS.identify, JSON.stringify(input), 'application/json')
  }

  /** Upsert an account (a company using your product) and link its users. */
  group(input: GroupInput): Promise<void> {
    return this.send(PATHS.group, JSON.stringify(input), 'application/json')
  }

  /** Send everything queued now. */
  async flush(): Promise<void> {
    this.track_flush()
    await Promise.all(this.inflight)
  }

  /** Flush and stop the timer. Call before a serverless handler returns. */
  async shutdown(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.flush()
  }

  private track_flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    while (this.queue.length) {
      const batch = this.queue.splice(0, MAX_BATCH)
      const p = this.send(PATHS.track, batch.map((e) => JSON.stringify(e)).join('\n'), 'application/x-ndjson').finally(() => {
        this.inflight = this.inflight.filter((x) => x !== p)
      })
      this.inflight.push(p)
    }
  }

  private async send(path: string, body: string, contentType: string): Promise<void> {
    try {
      const res = await this.f(`${this.base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': contentType },
        body,
      })
      if (!res.ok) throw new Error(`BusinessMCP ${path} answered ${res.status}`)
    } catch (e) {
      this.opts.onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }

  /**
   * A conversion from your backend with NO API key: the public goal endpoint keyed by tracker
   * id (a payment webhook, a job). Pass the visitor id the browser tracker gave you to stitch
   * the journey.
   */
  static async goal(
    trackerId: string,
    input: { name: string; visitorId?: string; revenueCents?: number; metadata?: Record<string, unknown> },
    opts: { baseUrl?: string; fetch?: typeof fetch } = {},
  ): Promise<boolean> {
    const f = opts.fetch ?? fetch
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    try {
      const res = await f(`${base}${PATHS.goal(trackerId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: input.name, visitorId: input.visitorId, revenue_cents: input.revenueCents, metadata: input.metadata }),
      })
      return res.ok
    } catch {
      return false
    }
  }
}

export default BusinessMCP
