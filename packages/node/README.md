# @mcphosting/node

Send events, identities and accounts to [BusinessMCP](https://businessmcp.com) from your
server, so signups and revenue are attributed even when the browser tracker is blocked.

```sh
npm install @mcphosting/node
```

```ts
import { BusinessMCP } from '@mcphosting/node'

const bmcp = new BusinessMCP({ apiKey: process.env.BUSINESSMCP_API_KEY! })
bmcp.track({ name: 'signup', user_id: 'u_123', properties: { plan: 'pro' } })
await bmcp.identify({ user_id: 'u_123', email: 'ada@acme.com' })
await bmcp.group({ account_id: 'acme', name: 'Acme', domain: 'acme.com', plan: 'pro' })
await bmcp.shutdown() // flush before a serverless function returns
```

No API key at hand (a payment webhook)? Record a goal against your tracker id:

```ts
await BusinessMCP.goal('YOUR_TRACKER_ID', { name: 'purchase', visitorId, revenueCents: 4900 })
```

Zero dependencies, Node 18+. Events are batched as NDJSON, at most 500 per request.

MIT licensed.
