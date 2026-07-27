import { Capacitor, CapacitorHttp } from '@capacitor/core'

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  return parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
}

/** 原生明文请求只允许 Journal 的私网地址和固定端口。 */
export function isAllowedNativeJournalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:' || !['8780', '8781'].includes(url.port)) return false
    return url.hostname === 'localhost' || url.hostname.endsWith('.local') || isPrivateIpv4(url.hostname)
  } catch {
    return false
  }
}

/** 在 Android 使用受限原生 HTTP，避免为整个 WebView 开放 mixed-content。 */
export async function journalFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!Capacitor.isNativePlatform()) return fetch(url, init)
  if (!isAllowedNativeJournalUrl(url)) {
    throw new Error('Journal service URL is not allowed on this device')
  }

  const headers = Object.fromEntries(new Headers(init.headers).entries())
  let data: unknown
  if (typeof init.body === 'string') {
    data = headers['content-type']?.includes('application/json')
      ? JSON.parse(init.body)
      : init.body
  } else if (init.body != null) {
    throw new Error('Journal native requests only support text or JSON bodies')
  }

  const native = await CapacitorHttp.request({
    url,
    method: init.method || 'GET',
    headers,
    data,
    connectTimeout: 8_000,
    readTimeout: 15_000,
    responseType: 'json',
  })
  const noBody = native.status === 204 || native.status === 205
  const body = noBody
    ? null
    : typeof native.data === 'string'
      ? native.data
      : JSON.stringify(native.data)
  return new Response(body, {
    status: native.status,
    headers: native.headers,
  })
}
