# Journal encrypted SyncEnvelope v1

The client-side data plane in `src/journal/encrypted-sync.ts` uses AES-256-GCM.
AAD binds Journal product, entity type/id, operation, key version and target
revision. Root keys are generated explicitly on an authorized device and never
appear in an envelope, attachment manifest, outbox or cloud object.

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

This is local/staging preparation only. Device approval, recovery-pack key
wrapping and remote exchange require the OAuth/device authority integration and
are not claimed as deployed or PC-off verified by this document.
