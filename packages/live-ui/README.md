# @farmlink/live-ui

The live views: the driven vehicle's gauges, the worker board with its Stop buttons, alerts, the
fleet list and the farm summary. The bridge serves them to the phone as one self-contained page;
from P2 the web app's `/live` route reuses the same components.

- `src/components/`: React components, with no knowledge of where the data comes from.
- `src/store.ts`: the page state built from the bridge's WebSocket messages, and the per-farm view.
- `src/useLive.ts`: the bridge connection: reconnects, and tells a stale link from a stopped bridge.
- `src/page/`: the phone page's entry point and styles.
- `generated/page.ts`: the built page as one HTML string, imported by the bridge. Committed so the
  bridge runs without a build step; `test/page.test.ts` fails when it is out of date.

```sh
pnpm --filter @farmlink/live-ui run build   # after changing src/
pnpm --filter @farmlink/live-ui test
```

The page bundles Preact's React compatibility layer instead of React, which keeps it under 50 KB.
Protocol: `packages/schema/src/protocol.ts`.
