# @mcphosting/tracker

Load and call the [BusinessMCP](https://businessmcp.com) tracker from code: first-party web
analytics, multi-touch attribution, session replay and heatmaps from one deferred script.
Cookieless by default, GDPR-friendly consent modes, free to start.

```sh
npm install @mcphosting/tracker
```

```ts
import { init, track, identify } from '@mcphosting/tracker'

init({ trackerId: 'YOUR_TRACKER_ID' })   // once, in the browser
track('signup', { plan: 'pro' })          // a goal
track('purchase', { revenue_cents: 4900 }) // revenue
identify('ada@acme.com', { name: 'Ada' })
```

The package does not bundle the tracker: it adds the one script tag the platform serves, so
you always run the current version. Calls made before it loads are queued and replayed.

Options: `host` (your verified tracking subdomain, e.g. `link.acme.com`), `attributes`
(any `data-*` attribute the tracker reads, such as `data-require-consent`).

MIT licensed.
