import path from 'node:path'
import { startPairing } from './pairing.mjs'

const dataIndex = process.argv.indexOf('--data-dir')
const dataDir = dataIndex >= 0 ? process.argv[dataIndex + 1] : process.env.JOURNAL_DATA_DIR
if (!dataDir) throw new Error('Pass --data-dir or set JOURNAL_DATA_DIR')

const result = await startPairing(path.resolve(dataDir))
const expiresAt = new Date(result.expiresAt).toLocaleTimeString('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})
process.stdout.write(`\n手机配对码：${result.code}\n${expiresAt} 前有效，成功使用一次后立即作废。\n\n`)
