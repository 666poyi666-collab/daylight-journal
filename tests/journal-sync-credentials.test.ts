import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isJournalDeviceToken,
  normalizeJournalSyncEndpoint,
} from '../src/journal/syncCredentials.ts'

test('Journal V2 credential accepts only dj1 device tokens', () => {
  assert.equal(isJournalDeviceToken(`dj1.device-1.${'a'.repeat(32)}`), true)
  assert.equal(isJournalDeviceToken(`legacy.${'a'.repeat(64)}`), false)
  assert.equal(isJournalDeviceToken(`dj1.x.${'a'.repeat(32)}`), false)
  assert.equal(isJournalDeviceToken(`dj1.device-1.${'a'.repeat(31)}`), false)
})

test('Journal sync endpoints require HTTPS or a fixed local plaintext port', () => {
  assert.equal(normalizeJournalSyncEndpoint('https://sync.example.test/'), 'https://sync.example.test')
  assert.equal(normalizeJournalSyncEndpoint('http://127.0.0.1:8780/'), 'http://127.0.0.1:8780')
  assert.equal(normalizeJournalSyncEndpoint('http://192.168.1.20:8781'), 'http://192.168.1.20:8781')
  assert.equal(normalizeJournalSyncEndpoint('http://journal-host.local:8780'), 'http://journal-host.local:8780')
  assert.equal(normalizeJournalSyncEndpoint('http://sync.example.test:8780'), null)
  assert.equal(normalizeJournalSyncEndpoint('http://192.168.1.20:8080'), null)
  assert.equal(normalizeJournalSyncEndpoint('https://user:secret@sync.example.test'), null)
  assert.equal(normalizeJournalSyncEndpoint('https://sync.example.test?token=secret'), null)
})
