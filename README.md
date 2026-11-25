# Switchboard

Switchboard is a shared inbox for human support agents. The project keeps the
assessment scaffold paths: the Express API is in `scaffold/server`, and the
React/Vite app is in `scaffold/web`. The assessment runner references the
server at that path through `switchboard.json`.

## Requirements

- Node.js 22 or newer
- Docker with Compose

## Setup

From the repository root:

```bash
npm run up
npm run scaffold:install
```

`npm run up` starts MongoDB, Redis, Pigeon, the Mock IdP, and Paybox. Elasticsearch
is optional. Copy `.env.example` to `.env` if you want to override settings.
For the alternate local assessment data services, use:

```dotenv
MONGO_URL=mongodb://localhost:27018/assessment
REDIS_URL=redis://localhost:6380
```

The server also accepts `MONGODB_URI` as a fallback alias for `MONGO_URL`.
Keep `.env` local; it is ignored by Git.

## Run the application

Open two terminals at the repository root.

Terminal 1:

```bash
npm run scaffold:server
```

The API listens on the environment's `PORT` (4000 by default), and reports
ready at `http://localhost:4000/healthz`.

Terminal 2:

```bash
npm run scaffold:web
```

Open `http://localhost:5173`. Sign in through the Mock IdP. Its test-user page
lets you choose an agent; workspace memberships come from the IdP claims.

## Main implementation

- `scaffold/server/src/index.ts` defines the HTTP API, webhook endpoint, grader
  contract, and authenticated WebSocket upgrade.
- `scaffold/server/src/auth.ts` implements OpenID Connect authorization-code
  login with PKCE and server-side Redis sessions.
- `scaffold/server/src/store.ts` handles MongoDB persistence, webhook recovery,
  reply outbox retries, encrypted private-note storage, atomic claims,
  workspace event sequencing, and inbox queries.
- `scaffold/web/src/App.tsx` provides the inbox, message history, assignment,
  close/reopen, reply, private notes, and reconnecting live-update workflows.

## Private notes

Private note text is encrypted in the browser with AES-256-GCM before it is
sent to the API. In the **Private notes** tab, generate a workspace key once
and share it with teammates through a secure channel; each teammate imports
that same key in their browser. The key stays in local browser storage and
cannot be recovered by Switchboard. The server sees note metadata but stores
only ciphertext for the note content. See [PROTOCOL.md](./PROTOCOL.md) for
what the server stores and the security limitations.

Replies are written to MongoDB before acceptance and dispatched by a leased
outbox worker. Pigeon idempotency keys protect retries when its response is
slow or a server process restarts. Redis is shared by server copies for send
rate limits, session storage, event sequence numbers, and live fan-out.

## Test

Trigger a customer message and inspect Pigeon's view:

```bash
npm run quiet
npm run inbound -- ws_acme +14155550101 "Hello from a test"
npm run report
```

The assessment check resets application data and starts its own server. Stop
the development backend before running it. For the alternate MongoDB and Redis
ports, run from the repository root:

```bash
MONGO_URL=mongodb://localhost:27018/assessment REDIS_URL=redis://localhost:6380 npm run check
MONGO_URL=mongodb://localhost:27018/assessment REDIS_URL=redis://localhost:6380 npm run check:full
```

`npm run check:full` writes `CHECK_REPORT.json`. The check turns off Pigeon's
automatic message trickle; restart it afterward with `npm run drizzle`.

For production builds and static type checks:

```bash
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
```
