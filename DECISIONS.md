# Decisions

I kept the supplied Express/TypeScript and React/Vite scaffold because
`switchboard.json` and the assessment runner invoke `scaffold/server` and
`scaffold/web`. I used the existing MongoDB driver rather than adding Mongoose.
MongoDB stores conversations, messages, webhook receipts, outbound jobs, and
replayable workspace events. Redis stores login sessions and coordinates
workspace sequence numbers, WebSocket fan-out, and a shared per-workspace
Pigeon send limiter.

Inbound webhook receipts are persisted before acknowledgement and processed
idempotently. Replies are persisted before returning `202`, then sent by a
leased outbox worker using Pigeon's idempotency key. A lease can be reclaimed
after a process dies; retrying the same key avoids sending an accepted reply a
second time. Login uses authorization code + PKCE, validates the IdP's signed
ID token, and stores the resulting session in Redis so another server copy can
read it. Private notes are encrypted in the browser with a shared workspace
key; key sharing is deliberately out of band and documented in `PROTOCOL.md`.

Elasticsearch search is not implemented; it is optional and would add an
operational dependency. The inbox API uses cursor pagination; the UI exposes a
load-more action. Message history and private-note retrieval are currently
capped at 500 records per conversation.

The public checker passed levels 1, 2, 3, and 5 (75/75). Level 4 is the hiring
team's private written-rules check and cannot be run from this repository.
The session cookie is configured for the assessment's local HTTP environment;
a production deployment must use HTTPS and set the cookie's `Secure` flag.
