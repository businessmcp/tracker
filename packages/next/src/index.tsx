'use client'

// @mcphosting/next — the BusinessMCP tracker for the Next.js App Router. MIT.
//
//   import { BusinessMCP } from '@mcphosting/next'
//   <BusinessMCP trackerId="trk_..." />            // in app/layout.tsx
//
// Renders ONE next/script tag (afterInteractive) for the served tracker. Client-side route
// changes need nothing: the tracker records pushState/replaceState/popstate navigations
// itself. Does not bundle the tracker, so an install never runs a stale copy.

import Script from 'next/script'

export const DEFAULT_PLATFORM_ORIGIN = 'https://businessmcp.com'

/** Mirrors lib/tracking/host.ts:trackerScriptSrc and @mcphosting/tracker's scriptSrc. */
export function scriptSrc(host: string | null | undefined, platformOrigin: string = DEFAULT_PLATFORM_ORIGIN): string {
  return host ? `https://${host}/m/s.js` : `${platformOrigin.replace(/\/+$/, '')}/track.js`
}

export type BusinessMCPProps = {
  trackerId: string
  /** Your verified tracking subdomain, e.g. `link.acme.com`. */
  host?: string | null
  platformOrigin?: string
  /** Extra tracker attributes, e.g. `{ 'data-require-consent': 'split' }`. Only `data-` keys are applied. */
  attributes?: Record<string, string>
}

export function BusinessMCP({ trackerId, host, platformOrigin, attributes }: BusinessMCPProps) {
  const data = Object.fromEntries(Object.entries(attributes ?? {}).filter(([k, v]) => /^data-[a-z][a-z0-9-]*$/.test(k) && typeof v === 'string'))
  return <Script id={`businessmcp-${trackerId}`} src={scriptSrc(host, platformOrigin)} strategy="afterInteractive" data-tracker={trackerId} {...data} />
}

export default BusinessMCP
