# BusinessMCP tracker

The open-source browser tracker, heatmap and session-replay recorder, and SDKs behind
[BusinessMCP](https://businessmcp.com): first-party analytics, multi-touch attribution,
recordings and heatmaps. Generated from the BusinessMCP repository; do not edit here.

| Path | What |
|---|---|
| `tracker/track.js` | The browser tracker (pageviews, goals, identify, attribution, consent modes) |
| `tracker/hm.js` | Heatmaps and session replay, lazy-loaded by track.js |
| `vendor/rrweb-record.min.js` | The rrweb recorder (MIT, rrweb-io/rrweb) |
| `packages/tracker` | `@mcphosting/tracker`: load and call the tracker from code |
| `packages/next` | `@mcphosting/next`: one component for the Next.js App Router |
| `packages/node` | `@mcphosting/node`: server-side events, identify and accounts |

MIT licensed. The hosted analytics, the AI team and the data services are not part of this repository.
