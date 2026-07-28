import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5173'
const browserCandidates = [
  process.env.BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate))
if (!executablePath) throw new Error('Chrome or Edge executable was not found')

const artifactDir = path.join(os.tmpdir(), 'daylight-journal-e2e')
fs.mkdirSync(artifactDir, { recursive: true })
const storageKey = 'daylight-journal-entries-v1'
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())
const syncEndpoint = 'http://journal-host.local:8780'

function createEncryptedRemote() {
  return {
    objects: new Map(),
    changes: [],
    revisions: new Map(),
    operations: new Map(),
  }
}

function objectHeaders(record, replayed = false) {
  return {
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/octet-stream',
    'X-Ciphertext-Sha256': record.ciphertextSha256,
    'X-Ciphertext-Bytes': String(record.ciphertextBytes),
    'X-Object-Nonce': record.nonce,
    'X-Object-Aad-Hash': record.aadHash,
    'X-Key-Version': String(record.keyVersion),
    'Access-Control-Expose-Headers': 'X-Ciphertext-Sha256, X-Ciphertext-Bytes, X-Object-Nonce, X-Object-Aad-Hash, X-Key-Version, X-Object-Replayed',
    ...(replayed ? { 'X-Object-Replayed': 'true' } : {}),
  }
}

function cursorNumber(value) {
  if (value === null) return 0
  return Number.parseInt(String(value).slice(1), 36)
}

async function openSettings(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  const desktopButton = page.locator('#journal-navigation')
    .getByRole('button', { name: '设置', exact: true })
  if (await desktopButton.isVisible()) {
    await desktopButton.click()
    return
  }
  await page.locator('.mobile-nav').getByRole('button', { name: '设置', exact: true }).click()
}

async function openToday(page) {
  const desktopButton = page.locator('#journal-navigation')
    .getByRole('button', { name: '今日', exact: true })
  if (await desktopButton.isVisible()) {
    await desktopButton.click()
    return
  }
  await page.locator('.mobile-nav').getByRole('button', { name: '今日', exact: true }).click()
}

async function saveEncryptedDeviceCredential(page, deviceId) {
  const token = `dj1.${deviceId}.${'a'.repeat(32)}`
  await openSettings(page)
  await page.getByLabel('Journal 同步服务地址').fill(syncEndpoint)
  await page.getByLabel('Journal 同步设备 token').fill(token)
  await page.getByRole('button', { name: '保存 token', exact: true }).click()
  await page.getByText('设备凭据已保存到安全存储。').waitFor()
  return token
}

async function configureNewEncryptedSpace(page, deviceId) {
  const token = await saveEncryptedDeviceCredential(page, deviceId)
  await page.getByRole('button', { name: '初始化新加密空间', exact: true }).click()
  await page.getByText('新的端到端加密空间已初始化。').waitFor()
  return token
}

async function encryptedSyncQueueSnapshot(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('daylight-journal-encrypted-sync-v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const transaction = database.transaction(['outbox', 'object-payloads', 'archives'], 'readonly')
      const readAll = (store) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [outbox, objects, archives] = await Promise.all([
        readAll('outbox'),
        readAll('object-payloads'),
        readAll('archives'),
      ])
      return {
        outbox: outbox.map((item) => ({
          opId: item.opId,
          state: item.state,
          objectKeys: item.objects.map((object) => object.objectKey),
        })),
        objectKeys: objects.map((item) => item.objectKey),
        archiveCount: archives.length,
      }
    } finally {
      database.close()
    }
  })
}

function createSeedEntry(date, title, content, overrides = {}) {
  const timestamp = `${date}T12:00:00.000Z`
  return {
    date,
    title,
    content,
    mood: null,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  }
}

const browser = await chromium.launch({ executablePath, headless: true })

async function openApp({
  viewport,
  seed = null,
  failStorage = false,
  failSync = false,
  failMutationExchanges = 0,
  remote = createEncryptedRemote(),
  skipSplash = true,
  reducedMotion = 'reduce',
}) {
  const context = await browser.newContext({ viewport, reducedMotion })
  const page = await context.newPage()
  const requests = []
  const objectRequests = []
  const objectResponses = []
  const errors = []
  let remainingMutationFailures = failMutationExchanges
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', async (response) => {
    if (response.url().includes('/sync/v2/objects/')) {
      objectResponses.push({ status: response.status(), headers: await response.allHeaders() })
    }
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('ERR_FAILED')) {
      errors.push(message.text())
    }
  })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.route(/\/sync\/v2\/objects\//, async (route) => {
    const request = route.request()
    const objectKey = decodeURIComponent(new URL(request.url()).pathname.split('/sync/v2/objects/')[1] || '')
    if (request.method() === 'PUT') {
      const headers = request.headers()
      const body = request.postDataBuffer() || Buffer.alloc(0)
      const record = {
        objectKey,
        ciphertextSha256: headers['x-ciphertext-sha256'],
        ciphertextBytes: Number(headers['x-ciphertext-bytes']),
        nonce: headers['x-object-nonce'],
        aadHash: headers['x-object-aad-hash'],
        keyVersion: Number(headers['x-key-version']),
        body: Buffer.from(body),
      }
      objectRequests.push({ method: 'PUT', ...record })
      const existing = remote.objects.get(objectKey)
      if (existing) {
        const same = existing.ciphertextSha256 === record.ciphertextSha256 &&
          existing.ciphertextBytes === record.ciphertextBytes &&
          existing.nonce === record.nonce && existing.aadHash === record.aadHash &&
          existing.keyVersion === record.keyVersion && existing.body.equals(record.body)
        await route.fulfill({
          status: same ? 204 : 409,
          headers: same ? objectHeaders(existing, true) : { 'Content-Type': 'application/json' },
          ...(same ? {} : { body: JSON.stringify({ error: 'object_key_reused' }) }),
        })
        return
      }
      remote.objects.set(objectKey, record)
      await route.fulfill({ status: 201, headers: objectHeaders(record), body: '' })
      return
    }
    if (request.method() === 'GET') {
      const record = remote.objects.get(objectKey)
      objectRequests.push({ method: 'GET', objectKey })
      if (!record) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'object_not_found' }),
        })
        return
      }
      await route.fulfill({ status: 200, headers: objectHeaders(record), body: record.body })
      return
    }
    await route.fulfill({ status: 405 })
  })
  await page.route(/\/sync\/v2\/exchange$/, async (route) => {
    if (failSync) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'offline-test' }),
      })
      return
    }
    const body = JSON.parse(route.request().postData() || '{}')
    requests.push(body)
    if ((body.mutations || []).length > 0 && remainingMutationFailures > 0) {
      remainingMutationFailures -= 1
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'restart-test' }),
      })
      return
    }
    const acknowledged = []
    const conflicts = []
    for (const mutation of body.mutations || []) {
      const replay = remote.operations.get(mutation.opId)
      if (replay) {
        acknowledged.push({ ...replay, replayed: true })
        continue
      }
      const revision = remote.revisions.get(mutation.entityId) || 0
      if (mutation.baseRevision !== revision) {
        conflicts.push({
          outcome: 'conflict',
          opId: mutation.opId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          operation: mutation.operation,
          error: 'REVISION_CONFLICT',
          current: remote.changes.findLast((change) => change.entityId === mutation.entityId) || null,
          candidate: mutation,
        })
        continue
      }
      const nextRevision = revision + 1
      const acknowledgement = {
        outcome: 'acknowledged',
        opId: mutation.opId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        operation: mutation.operation,
        revision: nextRevision,
      }
      acknowledged.push(acknowledgement)
      remote.operations.set(mutation.opId, acknowledgement)
      remote.revisions.set(mutation.entityId, nextRevision)
      remote.changes.push({
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        revision: nextRevision,
        operation: mutation.operation,
        keyVersion: mutation.keyVersion,
        ciphertext: mutation.ciphertext,
        nonce: mutation.nonce,
        aadHash: mutation.aadHash,
        objects: mutation.objects,
        changedAt: new Date().toISOString(),
        originDeviceId: body.deviceId,
        operationId: mutation.opId,
      })
    }
    const start = cursorNumber(body.cursor)
    const changes = remote.changes.slice(start, start + 100)
    const nextCursor = start + changes.length
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocolVersion: 2,
        envelopeVersion: 1,
        product: 'journal',
        acknowledged,
        conflicts,
        changes,
        nextCursor: `c${nextCursor.toString(36)}`,
        hasMore: start + changes.length < remote.changes.length,
        serverTime: new Date().toISOString(),
      }),
    })
  })
  await page.addInitScript(
    ({ storageKey, seed, failStorage, skipSplash }) => {
      if (skipSplash) sessionStorage.setItem('daylight-splash-seen', '1')
      if (seed) localStorage.setItem(storageKey, JSON.stringify(seed))
      if (failStorage) {
        Storage.prototype.setItem = () => {
          throw new DOMException('full', 'QuotaExceededError')
        }
      }
    },
    { storageKey, seed, failStorage, skipSplash },
  )
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  try {
    await page.locator('.app-shell').waitFor()
  } catch (error) {
    console.error('Browser errors:', errors)
    console.error('Page content:', (await page.content()).slice(0, 2_000))
    throw error
  }
  return { context, page, requests, objectRequests, objectResponses, remote, errors }
}

try {
  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
      skipSplash: false,
      reducedMotion: 'no-preference',
    })
    const splash = page.getByLabel('跳过启动动画')
    assert.equal(await splash.isVisible(), true)
    await splash.click()
    await splash.waitFor({ state: 'detached' })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const session = await openApp({ viewport: { width: 1440, height: 900 } })
    const { context, page, requests, objectRequests, objectResponses, errors } = session
    await page.getByLabel('日记标题').fill('快速保存回归')
    await page.getByLabel('日记正文').fill('最后一段输入必须立即留在本机')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('textbox', { name: '日记正文' }).click()
    assert.equal(
      await page.getByLabel('日记正文').inputValue(),
      '最后一段输入必须立即留在本机',
    )

    await page.locator('input[type="file"]').setInputFiles({
      name: 'regression.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="100%" height="100%" fill="#6f9b7b"/></svg>',
      ),
    })
    await page.getByLabel('日记正文').fill('图片处理中继续输入也不能被覆盖')
    await page.locator('.entry-cover img').waitFor({ timeout: 10_000 })
    assert.equal(
      await page.getByLabel('日记正文').inputValue(),
      '图片处理中继续输入也不能被覆盖',
    )
    await page.waitForTimeout(700)
    await page.screenshot({
      path: path.join(artifactDir, 'desktop.png'),
      fullPage: true,
    })
    await page.locator('.topbar').getByLabel('切换到深色模式').click()
    assert.equal(
      await page.locator('html').getAttribute('data-theme'),
      'dark',
    )
    await page.screenshot({
      path: path.join(artifactDir, 'desktop-dark.png'),
      fullPage: true,
    })
    const token = await configureNewEncryptedSpace(page, 'test-device-1')
    await page.waitForFunction(() => window.localStorage.getItem('daylight-journal-api') !== null)
    await page.waitForFunction(() => document.body.textContent?.includes('密钥已就绪'))
    for (let attempt = 0; attempt < 200 &&
      !requests.some((entry) => Array.isArray(entry.mutations) && entry.mutations.length > 0);
      attempt += 1) {
      await page.waitForTimeout(50)
    }
    assert(
      requests.some((entry) => Array.isArray(entry.mutations) && entry.mutations.length > 0),
      JSON.stringify({
        requests,
        objectRequests: objectRequests.map(({ body: _body, ...entry }) => entry),
        objectResponses,
        errors,
      }),
    )
    const attachmentMutation = requests
      .flatMap((entry) => entry.mutations || [])
      .find((mutation) => mutation.objects.length > 0)
    assert(attachmentMutation, '带封面的日记没有生成加密对象 manifest')
    assert.equal(attachmentMutation.objects.length, 1)
    const uploadedObject = objectRequests.find((entry) => entry.method === 'PUT')
    assert(uploadedObject, '带封面的日记没有先上传对象密文')
    assert.equal(uploadedObject.objectKey, attachmentMutation.objects[0].objectKey)
    assert.equal(uploadedObject.body.length, attachmentMutation.objects[0].ciphertextBytes)
    assert.equal(uploadedObject.body.toString('utf8').includes('data:image/'), false)
    assert.equal(uploadedObject.body.toString('utf8').includes('图片处理中继续输入也不能被覆盖'), false)
    assert.equal(uploadedObject.body.toString('utf8').includes(token), false)
    const serializedRequests = requests.map((entry) => JSON.stringify(entry))
    assert(serializedRequests.every((entry) => !entry.includes('图片处理中继续输入也不能被覆盖')),
      '加密同步 envelope 泄露了日记正文')
    assert(serializedRequests.every((entry) => !entry.includes('data:image/')),
      '加密同步 envelope 泄露了封面 base64')
    assert(serializedRequests.every((entry) => !entry.includes(token)),
      '加密同步 envelope 泄露了设备 token')
    assert.deepEqual(
      await page.evaluate(() => ({
        url: localStorage.getItem('daylight-journal-api'),
        token: localStorage.getItem('daylight-journal-api-token'),
      })),
      {
        url: 'http://journal-host.local:8780',
        token: null,
      },
    )
    await page.waitForFunction(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('daylight-journal-encrypted-sync-v1')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = database.transaction(['outbox', 'object-payloads'], 'readonly')
      const count = (store) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const [outboxCount, objectCount] = await Promise.all([count('outbox'), count('object-payloads')])
      const result = outboxCount === 0 && objectCount === 0
      database.close()
      return result
    })
    await page.screenshot({
      path: path.join(artifactDir, 'desktop-settings.png'),
      fullPage: true,
    })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
    })
    const sidebar = page.locator('#journal-navigation')
    assert.equal(await sidebar.getAttribute('aria-hidden'), 'true')
    assert.equal(await sidebar.evaluate((element) => element.hasAttribute('inert')), true)
    await page.getByLabel('打开菜单').click()
    assert.equal(await sidebar.getAttribute('aria-hidden'), null)
    assert.equal(await sidebar.evaluate((element) => element.hasAttribute('inert')), false)
    await sidebar.getByLabel('关闭菜单').click()
    const mobileNav = page.locator('.mobile-nav')
    await page.evaluate(() => {
      window.scrollTo(0, 420)
      const stage = document.querySelector('.view-stage')
      if (stage) stage.scrollTop = 420
    })
    const readScroll = () => page.evaluate(() => ({
      documentTop: document.scrollingElement?.scrollTop ?? 0,
      stageTop: document.querySelector('.view-stage')?.scrollTop ?? 0,
    }))
    const todayScroll = await readScroll()
    assert(
      Math.max(todayScroll.documentTop, todayScroll.stageTop) > 0,
      `手机标签切换测试无法建立滚动位置：${JSON.stringify(todayScroll)}`,
    )
    await mobileNav.getByRole('button', { name: '日历', exact: true }).click()
    await page.waitForTimeout(50)
    const calendarScroll = await readScroll()
    assert.equal(Math.max(calendarScroll.documentTop, calendarScroll.stageTop), 0)
    await mobileNav.getByRole('button', { name: '今日', exact: true }).click()
    await page.waitForTimeout(50)
    const restoredTodayScroll = await readScroll()
    assert(
      Math.max(restoredTodayScroll.documentTop, restoredTodayScroll.stageTop) > 0,
      `返回今日后没有恢复滚动位置：${JSON.stringify(restoredTodayScroll)}`,
    )
    await mobileNav.getByRole('button', { name: '今日', exact: true }).click()
    await page.waitForTimeout(50)
    const resetTodayScroll = await readScroll()
    assert.equal(Math.max(resetTodayScroll.documentTop, resetTodayScroll.stageTop), 0)
    const dateActionSizes = await page.locator('.date-actions > button').evaluateAll(
      (buttons) =>
        buttons
          .map((button) => button.getBoundingClientRect())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => ({ width: rect.width, height: rect.height })),
    )
    assert(
      dateActionSizes.every(({ width, height }) => width >= 44 && height >= 44),
      `手机日期操作触控目标不足 44px：${JSON.stringify(dateActionSizes)}`,
    )
    const tagInput = page.getByLabel('快速添加标签')
    await tagInput.focus()
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.mobile-nav')).display === 'none')
    await tagInput.evaluate((element) => element.blur())
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none')
    await page.screenshot({ path: path.join(artifactDir, 'phone.png') })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 768, height: 1024 },
    })
    const sidebar = page.locator('#journal-navigation')
    assert.equal(await sidebar.getAttribute('aria-hidden'), null)
    assert.equal(await sidebar.evaluate((element) => element.hasAttribute('inert')), false)
    assert.equal(await sidebar.isVisible(), true)
    assert.equal(await page.getByLabel('打开菜单').isVisible(), false)
    const portraitContextTop = await page.locator('.mood-card').evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    assert(
      portraitContextTop < 1024,
      `平板竖屏首屏未露出上下文卡片：top=${portraitContextTop}`,
    )
    await page.screenshot({ path: path.join(artifactDir, 'tablet.png') })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 1024, height: 768 },
    })
    const layout = await page.evaluate(() => {
      const footer = document.querySelector('.editor-footer')?.getBoundingClientRect()
      const insight = document.querySelector('.insight-column')?.getBoundingClientRect()
      const mobileNav = document.querySelector('.mobile-nav')?.getBoundingClientRect()
      return {
        footerBottom: footer?.bottom ?? Infinity,
        insightTop: insight?.top ?? Infinity,
        mobileNavWidth: mobileNav?.width ?? Infinity,
      }
    })
    assert(
      layout.footerBottom <= 768,
      `平板横屏编辑器页脚超出视口：${JSON.stringify(layout)}`,
    )
    assert(
      layout.insightTop < 100,
      `平板横屏洞察栏没有贴近顶部：${JSON.stringify(layout)}`,
    )
    assert.equal(layout.mobileNavWidth, 0)
    await page.screenshot({ path: path.join(artifactDir, 'tablet-landscape.png') })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
      failStorage: true,
    })
    await page.getByLabel('日记正文').fill('内存中的草稿仍可继续编辑')
    await page.getByRole('alert').filter({ hasText: '尚未保存到本机' }).waitFor()
    assert.equal(await page.getByLabel('日记正文').inputValue(), '内存中的草稿仍可继续编辑')
    await page.screenshot({
      path: path.join(artifactDir, 'storage-error.png'),
    })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
      failSync: true,
    })
    await page.getByLabel('日记正文').fill('离线时保留在本机的虚构草稿')
    await configureNewEncryptedSpace(page, 'offline-device-1')
    await openToday(page)
    await page.getByRole('button', { name: '重试同步' }).waitFor()
    assert.equal(await page.locator('.chat-mini').textContent(), 'AI 复盘')
    assert.equal(await page.locator('.chat-mini').isDisabled(), true)
    assert(
      errors.every((message) => message.includes('503')),
      `离线回归出现了预期之外的浏览器错误：${JSON.stringify(errors)}`,
    )
    await context.close()
  }

  {
    const coverImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    const restartSeed = {
      [today]: createSeedEntry(today, '重启续传回归', '对象已上传后 exchange 暂时失败。', { coverImage }),
    }
    const session = await openApp({
      viewport: { width: 390, height: 844 },
      seed: restartSeed,
      failMutationExchanges: 1,
    })
    const { context, page, requests, objectRequests, remote, errors } = session
    await configureNewEncryptedSpace(page, 'restart-device-1')
    await openToday(page)
    await page.getByRole('button', { name: '重试同步' }).waitFor()
    const failedMutation = requests.flatMap((entry) => entry.mutations || [])[0]
    assert(failedMutation, '故障注入没有命中带 outbox 的 exchange')
    const queued = await encryptedSyncQueueSnapshot(page)
    assert.deepEqual(queued.outbox, [{
      opId: failedMutation.opId,
      state: 'retry',
      objectKeys: [failedMutation.objects[0].objectKey],
    }])
    assert.deepEqual(queued.objectKeys, [failedMutation.objects[0].objectKey])
    assert.equal(remote.objects.size, 1)
    const firstUpload = objectRequests.find((entry) => entry.method === 'PUT')
    assert(firstUpload)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.app-shell').waitFor()
    await page.waitForFunction(() => document.body.textContent?.includes('已保存并同步') ||
      document.body.textContent?.includes('同步服务可用'))
    for (let attempt = 0; attempt < 80 &&
      requests.flatMap((entry) => entry.mutations || []).filter((mutation) => mutation.opId === failedMutation.opId).length < 2;
      attempt += 1) {
      await page.waitForTimeout(50)
    }
    const replayedMutations = requests
      .flatMap((entry) => entry.mutations || [])
      .filter((mutation) => mutation.opId === failedMutation.opId)
    assert.equal(replayedMutations.length, 2, '重启后没有重放同一个稳定 opId')
    const replayedUploads = objectRequests
      .filter((entry) => entry.method === 'PUT' && entry.objectKey === firstUpload.objectKey)
    assert.equal(replayedUploads.length, 2, '重启后没有重放同一个对象上传')
    assert.equal(replayedUploads[0].body.equals(replayedUploads[1].body), true)
    assert.deepEqual(await encryptedSyncQueueSnapshot(page), {
      outbox: [],
      objectKeys: [],
      archiveCount: 0,
    })
    assert(errors.every((message) => message.includes('503')), JSON.stringify(errors))
    await context.close()
  }

  {
    const remote = createEncryptedRemote()
    const coverImage = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    const recoverySecret = 'journal-e2e-recovery-2026'
    const source = await openApp({
      viewport: { width: 1440, height: 900 },
      seed: {
        [today]: createSeedEntry(today, '跨设备封面恢复', '第二台设备必须从对象存储解密恢复。', { coverImage }),
      },
      remote,
    })
    await configureNewEncryptedSpace(source.page, 'source-device-1')
    await source.page.waitForFunction(() => document.body.textContent?.includes('已保存并同步') ||
      document.body.textContent?.includes('同步服务可用'))
    await openSettings(source.page)
    await source.page.getByLabel('Journal 恢复密钥短语').fill(recoverySecret)
    await source.page.getByRole('button', { name: '导出恢复包' }).click()
    await source.page.getByText('恢复包已生成。').waitFor()
    const recoveryPackage = await source.page.getByLabel('Journal 恢复包').inputValue()
    assert(!recoveryPackage.includes('跨设备封面恢复'))
    assert(!recoveryPackage.includes('data:image/'))
    await source.context.close()

    const target = await openApp({ viewport: { width: 1440, height: 900 }, remote })
    await saveEncryptedDeviceCredential(target.page, 'target-device-1')
    await target.page.getByLabel('Journal 恢复密钥短语').fill(recoverySecret)
    await target.page.getByLabel('Journal 恢复包').fill(recoveryPackage)
    await target.page.getByRole('button', { name: '导入恢复包' }).click()
    await target.page.getByText('恢复密钥已导入。').waitFor()
    await target.page.waitForFunction(
      ({ storageKey, title }) => JSON.parse(localStorage.getItem(storageKey) || '{}')[Object.keys(JSON.parse(localStorage.getItem(storageKey) || '{}'))[0]]?.title === title,
      { storageKey, title: '跨设备封面恢复' },
    )
    await openToday(target.page)
    assert.equal(await target.page.getByLabel('日记标题').inputValue(), '跨设备封面恢复')
    await target.page.getByRole('textbox', { name: '日记正文' }).click()
    const restoredBody = target.page.locator('textarea[aria-label="日记正文"]')
    await restoredBody.waitFor()
    assert.equal(await restoredBody.inputValue(), '第二台设备必须从对象存储解密恢复。')
    await target.page.locator('.entry-cover img').waitFor()
    assert(target.objectRequests.some((entry) => entry.method === 'GET'))
    assert.deepEqual(await encryptedSyncQueueSnapshot(target.page), {
      outbox: [],
      objectKeys: [],
      archiveCount: 0,
    })
    assert.deepEqual(target.errors, [])
    await target.context.close()
  }

  {
    const now = new Date().toISOString()
    const imageOnly = {
      [today]: {
        date: today,
        title: '',
        content: '',
        mood: null,
        tags: [],
        coverImage: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        createdAt: now,
        updatedAt: now,
      },
    }
    const { context, page, errors } = await openApp({
      viewport: { width: 1440, height: 900 },
      seed: imageOnly,
    })
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.chat-mini').isDisabled(), true)
    assert.equal(await page.locator('.ai-card > button').isDisabled(), true)
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const [year, month, day] = today.split('-')
    const memoryDate = `${Number(year) - 4}-${month}-${day}`
    const memoryTitle = '四年前的萤火虫'
    const seed = {
      [today]: createSeedEntry(today, '今天的虚构记录', '今天在窗边写下一段测试日记。'),
      [memoryDate]: createSeedEntry(
        memoryDate,
        memoryTitle,
        '那年同一天，我在河岸看见了萤火虫。',
      ),
    }
    const { context, page, errors } = await openApp({
      viewport: { width: 1440, height: 900 },
      seed,
    })
    const memoryCard = page.getByLabel('时间回声')
    await memoryCard.getByText('往年同日回看', { exact: true }).waitFor()
    await memoryCard.getByText(memoryTitle).waitFor()
    await memoryCard.getByRole('button', { name: `打开 ${memoryDate} 的日记` }).click()
    assert.equal(await page.getByLabel('日记标题').inputValue(), memoryTitle)
    await page.locator('.date-subline').getByText(`${Number(year) - 4}年`, { exact: false }).waitFor()
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const historySeed = {
      '2024-06-18': createSeedEntry(
        '2024-06-18',
        '雨停后的散步',
        '晚饭后沿着虚构的河岸慢慢散步。',
        { mood: 4, tags: ['散步'] },
      ),
      '2024-06-03': createSeedEntry(
        '2024-06-03',
        '六月的第一封信',
        '给未来的自己留下一封虚构的信。',
      ),
      '2024-05-27': createSeedEntry(
        '2024-05-27',
        '五月末的晚风',
        '窗外有一阵很轻的、虚构的晚风。',
        { mood: 3 },
      ),
    }
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
      seed: historySeed,
    })
    await page.locator('.mobile-nav').getByRole('button', { name: '历史' }).click()
    const months = page.locator('.history-month')
    await months.first().waitFor()
    assert.equal(await months.count(), 2)
    await months.nth(0).getByText('2024年 6月', { exact: true }).waitFor()
    await months.nth(0).getByText('2 篇记录', { exact: true }).waitFor()
    await months.nth(0).getByText('雨停后的散步', { exact: true }).waitFor()
    await months.nth(0).getByText('六月的第一封信', { exact: true }).waitFor()
    await months.nth(1).getByText('2024年 5月', { exact: true }).waitFor()
    await months.nth(1).getByText('五月末的晚风', { exact: true }).waitFor()

    const layout = await page.evaluate(() => ({
      bodyClientWidth: document.body.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      rootClientWidth: document.documentElement.clientWidth,
      rootScrollWidth: document.documentElement.scrollWidth,
    }))
    assert(
      layout.bodyScrollWidth <= layout.bodyClientWidth,
      `390px 历史页 body 横向溢出：${JSON.stringify(layout)}`,
    )
    assert(
      layout.rootScrollWidth <= layout.rootClientWidth,
      `390px 历史页根节点横向溢出：${JSON.stringify(layout)}`,
    )
    await page.screenshot({
      path: path.join(artifactDir, 'phone-history-timeline.png'),
    })
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
    })
    const firstBlock = page.locator('.journal-block').first()
    const textarea = firstBlock.getByLabel('日记正文')
    const initialHeight = await firstBlock.evaluate((element) => element.getBoundingClientRect().height)
    const longText = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行长文会让记录片自然增长。`).join('\n')
    await textarea.fill(longText)
    const grown = await firstBlock.evaluate((element) => {
      const input = element.querySelector('textarea')
      return {
        blockHeight: element.getBoundingClientRect().height,
        textareaClientHeight: input?.clientHeight ?? 0,
        textareaScrollHeight: input?.scrollHeight ?? Infinity,
      }
    })
    assert(
      grown.blockHeight > initialHeight + 300,
      `手机长文没有撑高记录片：before=${initialHeight}, after=${grown.blockHeight}`,
    )
    assert(
      grown.textareaScrollHeight <= grown.textareaClientHeight + 2,
      `手机正文仍有内部滚动：${JSON.stringify(grown)}`,
    )
    assert.equal(await firstBlock.locator('.record-tile-heading time').count(), 1)
    await page.getByLabel('日记标题').click()
    assert.equal(await firstBlock.locator('.inline-write-stop').count(), 1)
    assert.equal(await firstBlock.locator('.journal-block-footer time').count(), 0)
    await firstBlock.getByRole('textbox', { name: '日记正文' }).click()
    await textarea.press('End')
    await textarea.pressSequentially('\n稍后回到同一段继续写。')
    await page.getByLabel('日记标题').click()
    assert.equal(await firstBlock.locator('.inline-write-stop').count(), 2)
    await firstBlock.screenshot({
      path: path.join(artifactDir, 'phone-inline-timestamps.png'),
    })

    await page.getByRole('button', { name: '另起一段', exact: true }).click()
    assert.equal(await page.locator('.journal-block').count(), 2)
    const secondTextarea = page.getByLabel('日记正文第 2 段')
    assert.equal(await page.locator('.keyboard-format-toolbar').isVisible(), true)
    assert.equal(await page.locator('.mobile-nav').isVisible(), false)
    await secondTextarea.fill('这是独立的第二张记录片。')
    await secondTextarea.evaluate((element) => element.scrollIntoView({ block: 'center' }))
    const scrollBeforeLongInput = await page.evaluate(() => window.scrollY)
    await secondTextarea.press('End')
    await secondTextarea.pressSequentially(`\n${'继续记录这一段，光标不能跳走。'.repeat(28)}`)
    const longInputState = await secondTextarea.evaluate((element) => ({
      valueLength: element.value.length,
      selectionEnd: element.selectionEnd,
      pageTop: window.scrollY,
      rectTop: element.getBoundingClientRect().top,
      rectBottom: element.getBoundingClientRect().bottom,
      viewportHeight: window.visualViewport?.height || window.innerHeight,
    }))
    assert(longInputState.valueLength > 302, JSON.stringify(longInputState))
    assert.equal(longInputState.selectionEnd, longInputState.valueLength)
    assert(
      longInputState.pageTop >= Math.max(0, scrollBeforeLongInput - 80),
      `第二段超过 302 字后跳回顶部：${JSON.stringify(longInputState)}`,
    )
    assert(
      longInputState.rectBottom > 0 && longInputState.rectTop < longInputState.viewportHeight,
      `第二段输入区域离开可视窗口：${JSON.stringify(longInputState)}`,
    )
    await secondTextarea.evaluate((element) => element.setSelectionRange(0, 2))
    await page.getByRole('button', { name: '加粗第 2 段所选文字' }).click()
    assert.match(await secondTextarea.inputValue(), /^\*\*这是\*\*/)
    await page.getByRole('button', { name: '切换第 2 段文字颜色' }).click()
    assert.equal(
      await page.locator('.journal-block').nth(1).getAttribute('data-text-color'),
      'sage',
    )
    await page.getByRole('button', { name: '完成', exact: true }).click()
    assert.equal(await page.locator('.journal-block').nth(1).locator('.inline-write-stop').count(), 1)
    assert.equal(await page.locator('.mobile-nav').isVisible(), true)
    await page.reload({ waitUntil: 'domcontentloaded' })
    assert.equal(await page.locator('.journal-block').count(), 2)
    assert.match(
      await page.getByRole('textbox', { name: '日记正文第 2 段' }).textContent(),
      /^\*\*这是\*\*/,
    )
    assert.equal(
      await page.locator('.journal-block').nth(1).getAttribute('data-text-color'),
      'sage',
    )
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const scrollSeed = {}
    for (let index = 0; index < 12; index += 1) {
      const date = `2026-06-${String(index + 1).padStart(2, '0')}`
      scrollSeed[date] = createSeedEntry(date, `滚动记录 ${index + 1}`, `第 ${index + 1} 篇虚构记录`)
    }
    scrollSeed[today] = createSeedEntry(today, '三栏滚动测试', '用于验证中栏滚动。')
    const { context, page, errors } = await openApp({
      viewport: { width: 1024, height: 768 },
      seed: scrollSeed,
    })
    await page.getByRole('textbox', { name: '日记正文' }).click()
    await page.getByLabel('日记正文').fill('中栏长文\n'.repeat(180))
    await page.waitForFunction(() => {
      const writing = document.querySelector('.writing-column')
      return writing instanceof HTMLElement && writing.scrollHeight > writing.clientHeight
    })
    const scrollState = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar')
      const writing = document.querySelector('.writing-column')
      const insight = document.querySelector('.insight-column')
      const stage = document.querySelector('.view-stage')
      if (!(sidebar instanceof HTMLElement) || !(writing instanceof HTMLElement) ||
          !(insight instanceof HTMLElement) || !(stage instanceof HTMLElement)) {
        throw new Error('三栏滚动容器缺失')
      }
      sidebar.scrollTop = sidebar.scrollHeight
      writing.scrollTop = writing.scrollHeight
      insight.scrollTop = insight.scrollHeight
      return {
        sidebarScrollable: sidebar.scrollHeight > sidebar.clientHeight,
        sidebarTop: sidebar.scrollTop,
        writingScrollable: writing.scrollHeight > writing.clientHeight,
        writingTop: writing.scrollTop,
        insightScrollable: insight.scrollHeight > insight.clientHeight,
        insightTop: insight.scrollTop,
        stageTop: stage.scrollTop,
      }
    })
    assert(scrollState.sidebarScrollable && scrollState.sidebarTop > 0, JSON.stringify(scrollState))
    assert(scrollState.writingScrollable && scrollState.writingTop > 0, JSON.stringify(scrollState))
    assert(
      !scrollState.insightScrollable || scrollState.insightTop > 0,
      JSON.stringify(scrollState),
    )
    assert.equal(scrollState.stageTop, 0)
    const sidebar = page.locator('.sidebar')
    await sidebar.evaluate((element) => { element.scrollTop = 0 })
    await sidebar.hover()
    await page.mouse.wheel(0, 3_000)
    await page.waitForFunction(() => {
      const element = document.querySelector('.sidebar')
      return element instanceof HTMLElement && element.scrollTop > 0
    })
    const footerBottom = await sidebar.locator('.sidebar-footer').evaluate(
      (element) => element.getBoundingClientRect().bottom,
    )
    assert(
      footerBottom <= 768,
      `平板左栏滚到底后设置区域仍不可达：bottom=${footerBottom}`,
    )
    assert.deepEqual(errors, [])
    await context.close()
  }

  {
    const { context, page, errors } = await openApp({
      viewport: { width: 390, height: 844 },
    })
    await page.locator('.mobile-nav').getByRole('button', { name: '设置' }).click()
    await page.getByLabel('设置应用锁密码').fill('2468')
    await page.getByLabel('确认应用锁密码').fill('2468')
    await page.getByRole('button', { name: '开启应用锁' }).click()
    await page.getByText('应用锁已开启，下次打开需要输入密码。').waitFor()

    await page.reload({ waitUntil: 'domcontentloaded' })
    const lock = page.getByRole('dialog', { name: '应用锁' })
    await lock.waitFor()
    assert.equal(await page.locator('.app-shell').count(), 0)
    for (const digit of ['9', '9', '9', '9']) {
      await lock.getByRole('button', { name: digit, exact: true }).click()
    }
    await lock.getByText('密码不正确').waitFor()
    await page.waitForTimeout(500)
    for (const digit of ['2', '4', '6', '8']) {
      await lock.getByRole('button', { name: digit, exact: true }).click()
    }
    await page.locator('.app-shell').waitFor()

    await page.locator('.mobile-nav').getByRole('button', { name: '设置' }).click()
    await page.getByLabel('当前应用锁密码').fill('2468')
    await page.getByRole('button', { name: '关闭应用锁' }).click()
    await page.getByText('应用锁已关闭。', { exact: true }).waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.app-shell').waitFor()
    assert.equal(await page.getByRole('dialog', { name: '应用锁' }).count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
  }

  console.log(`Frontend smoke tests passed. Artifacts: ${artifactDir}`)
} finally {
  await browser.close()
}
