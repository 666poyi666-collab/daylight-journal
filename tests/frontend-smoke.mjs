import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'
import {
  decryptMutation,
  parseRootKey,
} from '../src/journal/encrypted-sync.ts'

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
const screenshotsEnabled = process.env.NO_SCREENSHOTS !== '1'
const storageKey = 'daylight-journal-entries-v1'
const syncToken = `dj1.e2e-device.${'a'.repeat(43)}`
const rootKey = `jk1.1.${'A'.repeat(43)}`
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date())

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
  skipSplash = true,
  reducedMotion = 'reduce',
}) {
  const context = await browser.newContext({ viewport, reducedMotion })
  const page = await context.newPage()
  if (!screenshotsEnabled) page.screenshot = async () => Buffer.alloc(0)
  const requests = []
  const objectRequests = []
  const mutationWaiters = []
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('ERR_FAILED')) {
      errors.push(message.text())
    }
  })
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
  await page.route(/\/sync\/v2\/objects\//, async (route) => {
    objectRequests.push({
      method: route.request().method(),
      url: route.request().url(),
    })
    await route.fulfill({
      status: 410,
      contentType: 'application/json',
      body: '{"error":"object_sync_disabled"}',
    })
  })
  await page.route(/\/sync\/v2\/exchange$/, async (route) => {
    const request = route.request()
    if (failSync) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'offline-test' }),
      })
      return
    }
    const envelope = JSON.parse(request.postData() || '{}')
    requests.push(envelope)
    if (envelope.mutations.length > 0) {
      for (const resolve of mutationWaiters.splice(0)) resolve(envelope)
    }
    const changedAt = new Date().toISOString()
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocolVersion: 2,
        envelopeVersion: 1,
        product: 'journal',
        acknowledged: envelope.mutations.map((mutation) => ({
          outcome: 'acknowledged',
          opId: mutation.opId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          operation: mutation.operation,
          revision: mutation.baseRevision + 1,
        })),
        conflicts: [],
        changes: envelope.mutations.map((mutation) => ({
          ...mutation,
          revision: mutation.baseRevision + 1,
          changedAt,
          originDeviceId: envelope.deviceId,
          operationId: mutation.opId,
        })),
        nextCursor: 'c1',
        hasMore: false,
        serverTime: changedAt,
      }),
    })
  })
  await page.addInitScript(
    ({ storageKey, seed, failStorage, skipSplash, syncToken, rootKey }) => {
      if (skipSplash) sessionStorage.setItem('daylight-splash-seen', '1')
      if (seed) localStorage.setItem(storageKey, JSON.stringify(seed))
      localStorage.setItem('daylight-journal-api', 'https://journal-sync.e2e.invalid')
      localStorage.setItem('daylight-journal-api-token', syncToken)
      localStorage.setItem('daylight-journal-sync-root-v1', rootKey)
      if (failStorage) {
        Storage.prototype.setItem = () => {
          throw new DOMException('full', 'QuotaExceededError')
        }
      }
    },
    { storageKey, seed, failStorage, skipSplash, syncToken, rootKey },
  )
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  try {
    await page.locator('.app-shell').waitFor()
  } catch (error) {
    console.error('Browser errors:', errors)
    console.error('Page content:', (await page.content()).slice(0, 2_000))
    throw error
  }
  const waitForMutationExchange = (timeoutMs = 10_000) => {
    const captured = requests.find((request) => request.mutations.length > 0)
    if (captured) return Promise.resolve(captured)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for a V2 mutation exchange: ${errors.join(' | ')}`)), timeoutMs)
      mutationWaiters.push((envelope) => {
        clearTimeout(timer)
        resolve(envelope)
      })
    })
  }
  return { context, page, requests, objectRequests, errors, waitForMutationExchange }
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
    const {
      context,
      page,
      requests,
      objectRequests,
      errors,
      waitForMutationExchange,
    } = session
    await page.getByLabel('日记标题').fill('快速保存回归')
    await page.getByLabel('日记正文').fill('最后一段输入必须立即留在本机')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('textbox', { name: '日记正文' }).click()
    assert.equal(
      await page.getByLabel('日记正文').inputValue(),
      '最后一段输入必须立即留在本机',
    )
    await page.waitForTimeout(700)
    requests.length = 0

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
    const mutationExchange = await waitForMutationExchange()
    assert(requests.some((request) => request.mutations.length > 0))
    assert.equal(objectRequests.length, 0)
    const rootBundle = parseRootKey(rootKey)
    assert(rootBundle)
    for (const mutation of mutationExchange.mutations) {
      assert.deepEqual(mutation.objects, [])
      const payload = await decryptMutation(rootBundle, mutation)
      const payloadKeys = []
      JSON.stringify(payload, (key, value) => {
        if (key) payloadKeys.push(key)
        return value
      })
      assert.equal(payloadKeys.some((key) => /cover|base64|path|url/i.test(key)), false)
    }
    assert(requests.every((request) => !JSON.stringify(request).includes('图片处理中继续输入也不能被覆盖')))
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
    await page.locator('#journal-navigation')
      .getByRole('button', { name: '设置', exact: true })
      .click()
    await page.getByLabel('Journal 同步服务地址').fill('http://journal-host.local:8780')
    await page.getByLabel('Journal 同步服务配对令牌')
      .fill(syncToken)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    assert.deepEqual(
      await page.evaluate(() => ({
        url: localStorage.getItem('daylight-journal-api'),
        token: localStorage.getItem('daylight-journal-api-token'),
      })),
      {
        url: 'http://journal-host.local:8780',
        token: syncToken,
      },
    )
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
    const offlineCover = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
    const { context, page, objectRequests, errors } = await openApp({
      viewport: { width: 390, height: 844 },
      seed: {
        [today]: createSeedEntry(
          today,
          '离线封面回归',
          '带本机封面的文字仍需进入持久队列',
          { coverImage: offlineCover },
        ),
      },
      failSync: true,
    })
    await page.getByRole('button', { name: '重试同步' }).waitFor()
    const outbox = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith('daylight-journal-sync-v2:'),
      )
      return key ? JSON.parse(localStorage.getItem(key) || '{}').outbox : []
    })
    assert(outbox.length > 0)
    assert(outbox.every((mutation) => mutation.objects.length === 0))
    assert.equal(objectRequests.length, 0)
    assert.equal(await page.locator('.chat-mini').textContent(), 'AI 复盘')
    assert.equal(await page.locator('.chat-mini').isDisabled(), true)
    assert(
      errors.every((message) => message.includes('503')),
      `离线回归出现了预期之外的浏览器错误：${JSON.stringify(errors)}`,
    )
    await context.close()
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
    if (screenshotsEnabled) {
      await firstBlock.screenshot({
        path: path.join(artifactDir, 'phone-inline-timestamps.png'),
      })
    }

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

  console.log(`Frontend smoke tests passed. Artifacts: ${artifactDir}`)
} finally {
  await browser.close()
}
