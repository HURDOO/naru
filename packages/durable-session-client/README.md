# DurableSession TypeScript client

This package is the transport-neutral public protocol v0 client. Its root export contains the
typed operation client, protocol/client errors, terminal sequence tracking, and the in-memory
attachment handle. Node-only private UDS helpers live at `@naru/durable-session-client/node`.

The client validates every outgoing request, caller context, and incoming response against
`@naru/contracts/durable-session/v0`. It does not retry terminal input or resize operations. An
attachment handle keeps its resume token in a private field, rotates it on resume, and exposes only
a token-free view through `view` and `toJSON()`.

```ts
import { DurableSessionClient } from "@naru/durable-session-client";
import {
  readPrivateCredentialFile,
  UdsHttpDurableSessionTransport,
} from "@naru/durable-session-client/node";

const transport = new UdsHttpDurableSessionTransport({
  socketPath: "/absolute/private/runtime/host.sock",
  appId: "local-session-cli",
  credential: readPrivateCredentialFile("/absolute/private/credentials/local-session-cli"),
});

const client = new DurableSessionClient({
  transport,
  callerContext: (request) => authorizedCallerContextFor(request),
});

const sessions = await client.request({ operation: "listSessions", limit: 100 });
```

The Node subpath also exports `UdsWebSocketDurableSessionTransport.connect(...)` for the public v0
stream contract. It validates the private socket before authentication, fixes one caller identity
at hello, multiplexes correlated operations and attachment events, sends attachment heartbeats, and
fails closed on invalid or overflowing frames. Consumers keep terminal rendering outside JSON and
feed each attachment-scoped event to its `DurableSessionAttachmentHandle`.

`authorizedCallerContextFor` is intentionally application-owned. A Gateway assertion is not a Host
capability, and consumers must delegate the minimum registered app capability and scope required by
each operation.
