# @mcphosting/next

The [BusinessMCP](https://businessmcp.com) tracker for the Next.js App Router: analytics,
attribution, session replay and heatmaps from one component.

```sh
npm install @mcphosting/next
```

```tsx
// app/layout.tsx
import { BusinessMCP } from '@mcphosting/next'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <BusinessMCP trackerId="YOUR_TRACKER_ID" />
      </body>
    </html>
  )
}
```

Client-side route changes are recorded by the tracker itself. Use `@mcphosting/tracker` for
`track()` and `identify()` calls from client components.

MIT licensed.
