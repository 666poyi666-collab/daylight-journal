# Journal SyncEnvelope v1

The production client path in `App.tsx` uses `JournalV2SyncClient` and the
AES-256-GCM device replica in `src/journal/encrypted-sync.ts`. AAD binds Journal
product, entity type/id, operation, key version and target revision. Every
payload also carries a SHA-256 ciphertext digest. Root keys are generated or
imported on an approved device and never appear in an envelope or outbox.

For PC-off ChatGPT reads, each upsert also carries `mcpEntry`: the exact date,
title, body, blocks, mood, tags and timestamps with `coverImage` removed. The
Journal Worker validates this projection and writes it only when the matching
encrypted mutation is acknowledged. Conflicts cannot overwrite it; delete
removes it in the same D1 batch. The root key is never sent.

Attachments are not cloud objects. They use the separate peer-only AES-GCM
channel and pending store. Cloud `objects` is always `[]`; `coverImage`, data
URLs, base64 attachment bytes, file paths and media URLs are rejected before
they can enter D1 or MCP.

The adapter supplied to `JournalEncryptedSync` must make `SyncSnapshot` writes
atomic. The snapshot includes entities, conflicts, tombstones, outbox, pending
legacy imports and cursor. ACK removal happens in the same commit as remote
materialization, migration completion and cursor advancement; a crash before
that commit replays the immutable `opId` safely.

`App.tsx` has no V1 fallback. A synchronization run first retries the existing
durable outbox, then decrypts and validates returned changes and persists legacy
imports before queuing new mutations. `mcpEntry` is derived from the same
attachment-free encrypted payload. `migrationIds` is `[]` for normal writes and
stays in the outbox until ACK. Whole-entry deletion is explicit and queues a
tombstone before removing the local view. Rewriting the same date after a
tombstone creates a higher revision restore mutation.

Device approval is explicit in Settings: a valid `dj1` device credential and
the shared `jk1` root key must both be saved before synchronization can run.
Remote deployment and real-device installation remain separate release steps.
PC-off completion requires a deployed Journal Worker, a non-empty acknowledged
mutation and an OAuth MCP/Resource read after the originating client is stopped.
