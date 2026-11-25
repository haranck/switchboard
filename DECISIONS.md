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
read it.

I did not implement private notes or Elasticsearch search in this pass.
Encrypted notes require a client key-sharing protocol and a threat model; a
server-readable shortcut would violate the brief. Search is optional and
Elasticsearch is intentionally not required. The inbox API uses cursor
pagination; the UI exposes a load-more action. The message history endpoint is
currently capped at 500 messages per conversation.

The public checker passed levels 1, 2, 3, and 5 (75/75). Level 4 is the hiring
team's private written-rules check and cannot be run from this repository.
The session cookie is configured for the assessment's local HTTP environment;
a production deployment must use HTTPS and set the cookie's `Secure` flag.
