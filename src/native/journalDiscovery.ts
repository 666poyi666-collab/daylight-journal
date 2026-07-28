import { Capacitor, registerPlugin } from '@capacitor/core'

interface DiscoveredJournalService {
  name: string
  url: string
}

interface JournalDiscoveryPlugin {
  discover(): Promise<DiscoveredJournalService>
}

const journalDiscovery = registerPlugin<JournalDiscoveryPlugin>('JournalDiscovery')

export function canDiscoverJournalService(): boolean {
  return Capacitor.isNativePlatform()
}

/** 在 Android 局域网中查找 Journal 服务；未发现或系统拒绝时 Promise 失败。 */
export async function discoverJournalService(): Promise<DiscoveredJournalService> {
  return journalDiscovery.discover()
}
