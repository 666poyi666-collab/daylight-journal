# Journal encrypted SyncEnvelope v1

The production client path in `App.tsx` uses `JournalV2SyncClient` and the
AES-256-GCM data plane in `src/journal/encrypted-sync.ts`. AAD binds Journal
product, entity type/id, operation, key version and target revision. Every
payload also carries a SHA-256 ciphertext digest. Root keys are generated or
imported on an approved device and never appear in an envelope, attachment
manifest, outbox or cloud object.

Attachments are encrypted before upload. The cloud object manifest contains
only object key, ciphertext SHA-256, ciphertext size, nonce, AAD hash and key
version. Upload completion is persisted separately so an interrupted upload is
resumed before its mutation is exchanged. A downloaded object is digest- and
AAD-verified before decryption.

The adapter supplied to `JournalEncryptedSync` must make `SyncSnapshot` writes
atomic. The snapshot includes entities, conflicts, tombstones, outbox,
attachment upload state and cursor. ACK removal happens in the same commit as
remote materialization and cursor advancement; a crash before that commit
replays the immutable `opId` safely.

`App.tsx` has no V1 fallback. Local edits are encrypted into the durable outbox
before a network exchange, attachments upload before their mutation, and a
first pull decrypts and validates all returned payloads before advancing the
cursor. Whole-entry deletion is explicit and queues a tombstone before removing
the local view. Rewriting the same date after a tombstone creates a higher
revision restore mutation.

Device approval is explicit in Settings: a valid `dj1` device credential and
the shared `jk1` root key must both be saved before synchronization can run.
Remote deployment, key-recovery packaging, real-device and PC-off validation
remain outside this local client change.
