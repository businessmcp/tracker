// The public browser tracker API (`window.mcph`, served by the platform as track.js).
// Mirrors types/mcph.d.ts in the BusinessMCP repo; packages/sdk.test.ts fails when a method
// exists there and not here.

export type McphMeta = Record<string, unknown>

/** One touch as the tracker keeps it (utm_* shortened, click ids, external referrer, landing path). */
export interface McphTouch {
  ts?: number
  lp?: string
  src?: string
  med?: string
  cmp?: string
  ref?: string
  ids?: Record<string, string>
}

export interface McphAttribution {
  ft?: McphTouch
  lt?: McphTouch
}

export interface McphApi {
  track: (name: string, meta?: McphMeta) => string | null
  identify: (email: string, traits?: McphMeta) => void
  getVisitorId: () => string | undefined
  getAttribution: () => McphAttribution | null
  /** @deprecated Split testing was removed: always the control. */
  variant: (key: string, opts?: { variants?: { id: string; weight: number }[]; control?: string }) => string
  /** @deprecated Always null. */
  getVariant: (key: string) => string | null
  consent: (state: 'granted' | 'denied', persist?: boolean) => void
  q: { push: (...calls: [method: keyof McphApi, args?: unknown[]][]) => void }
}
