import assert from 'node:assert/strict'
import test from 'node:test'
import { journalSyncCrypto } from '../src/journal/encryptedSync.ts'

test('Journal AES-GCM ciphertext is opaque, randomized, and bound to mutation metadata', async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const entry = {
    date: '2026-07-28',
    title: '虚构标题',
    content: '只用于密码学负测的虚构正文',
    coverImage: 'data:image/png;base64,ZmFrZQ==',
  }
  const aad = journalSyncCrypto.aad({
    entityId: entry.date,
    operation: 'upsert',
    keyVersion: 1,
    revision: 1,
  })
  const first = await journalSyncCrypto.encryptJson(key, entry, aad)
  const second = await journalSyncCrypto.encryptJson(key, entry, aad)

  assert.notEqual(first.nonce, second.nonce)
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert(!first.ciphertext.includes(entry.title))
  assert(!first.ciphertext.includes(entry.content))
  assert(!first.ciphertext.includes(entry.coverImage))
  assert.deepEqual(
    await journalSyncCrypto.decryptJson(key, first.ciphertext, first.nonce, aad),
    entry,
  )

  const tamperedAad = journalSyncCrypto.aad({
    entityId: entry.date,
    operation: 'delete',
    keyVersion: 1,
    revision: 1,
  })
  await assert.rejects(
    journalSyncCrypto.decryptJson(key, first.ciphertext, first.nonce, tamperedAad),
  )
})

test('Journal cover ciphertext is detached, integrity-addressed, and bound to its object key', async () => {
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const cover = 'data:image/png;base64,ZmFrZS1jb3Zlcg=='
  const objectKey = 'journal_entry/2026-07-28/00000000-0000-4000-8000-000000000001/cover'
  const aad = journalSyncCrypto.objectAad({
    entityId: '2026-07-28',
    operation: 'upsert',
    keyVersion: 1,
    revision: 1,
    objectKey,
  })
  const first = await journalSyncCrypto.encryptBytes(key, new TextEncoder().encode(cover), aad)
  const second = await journalSyncCrypto.encryptBytes(key, new TextEncoder().encode(cover), aad)
  const firstBytes = new Uint8Array(first.ciphertext)

  assert.notEqual(first.nonce, second.nonce)
  assert.notDeepEqual(new Uint8Array(first.ciphertext), new Uint8Array(second.ciphertext))
  assert.equal(new TextDecoder().decode(firstBytes).includes('data:image/'), false)
  assert.match(await journalSyncCrypto.sha256Bytes(firstBytes), /^[0-9a-f]{64}$/)
  assert.equal(
    new TextDecoder().decode(await journalSyncCrypto.decryptBytes(key, first.ciphertext, first.nonce, aad)),
    cover,
  )

  const wrongObjectAad = journalSyncCrypto.objectAad({
    entityId: '2026-07-28',
    operation: 'upsert',
    keyVersion: 1,
    revision: 1,
    objectKey: `${objectKey}-replaced`,
  })
  await assert.rejects(
    journalSyncCrypto.decryptBytes(key, first.ciphertext, first.nonce, wrongObjectAad),
  )
})
