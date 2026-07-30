import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const requiredFiles = [
  'AGENTS.md',
  'docs/README.md',
  'docs/REQUIREMENTS.md',
  'docs/BUGS.md',
  'docs/ITERATION-LOG.md',
  'docs/CHANGELOG.md',
]

const errors = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`缺少治理文件：${path}`)
    return ''
  }
}

function collectTableIds(content, prefix) {
  const pattern = new RegExp(`^\\| (${prefix}-\\d{3}) \\|`, 'gm')
  return [...content.matchAll(pattern)].map((match) => match[1])
}

function checkUnique(ids, label) {
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  if (duplicates.length > 0) {
    errors.push(`${label}编号重复：${duplicates.join(', ')}`)
  }
}

const contents = Object.fromEntries(requiredFiles.map((path) => [path, read(path)]))
const requirements = contents['docs/REQUIREMENTS.md']
const bugs = contents['docs/BUGS.md']
const iterations = contents['docs/ITERATION-LOG.md']

const functionalIds = collectTableIds(requirements, 'FR')
const nonFunctionalIds = collectTableIds(requirements, 'NFR')
const bugIds = collectTableIds(bugs, 'BUG')
const riskIds = collectTableIds(bugs, 'KR')

checkUnique(functionalIds, '功能需求')
checkUnique(nonFunctionalIds, '非功能需求')
checkUnique(bugIds, 'Bug')
checkUnique(riskIds, '风险')

if (!requirements.includes('## 需求统计与分析')) {
  errors.push('REQUIREMENTS.md 缺少“需求统计与分析”章节')
}

if (!contents['docs/README.md'].includes('[ITERATION-LOG](ITERATION-LOG.md)')) {
  errors.push('docs/README.md 缺少迭代日志入口')
}

const iterationMatches = [...iterations.matchAll(/^## (ITER-\d{8}-\d{2})：/gm)]
const iterationIds = iterationMatches.map((match) => match[1])
checkUnique(iterationIds, '迭代')

if (iterationMatches.length === 0) {
  errors.push('ITERATION-LOG.md 至少需要一条迭代记录')
}

const requiredIterationFields = [
  '- 关联需求：',
  '- 根因：',
  '- 影响范围：',
  '- 验收方式：',
  '### 操作日志',
  '#### 新增',
  '#### 修改',
  '#### 删除',
  '### Bug 记录',
  '### 用户需求统计与分析',
  '### 验证结果',
  '### 遗留项',
]

for (let index = 0; index < iterationMatches.length; index += 1) {
  const match = iterationMatches[index]
  const start = match.index ?? 0
  const end = iterationMatches[index + 1]?.index ?? iterations.indexOf('\n## 新迭代填写规则')
  const entry = iterations.slice(start, end === -1 ? undefined : end)
  for (const field of requiredIterationFields) {
    if (!entry.includes(field)) {
      errors.push(`${match[1]} 缺少栏目：${field}`)
    }
  }
}

if (errors.length > 0) {
  console.error('治理校验失败：')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `治理校验通过：${functionalIds.length} 项功能需求，` +
    `${nonFunctionalIds.length} 项非功能需求，${bugIds.length} 个 Bug，` +
    `${riskIds.length} 个风险，${iterationIds.length} 次迭代`,
)
