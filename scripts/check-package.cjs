const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
// 使用 npm 的 JS 入口，兼容 Windows 的 npm.cmd 和 POSIX 系统。
const npm = process.env.npm_execpath
assert(npm, '请通过 npm run check:package 执行')
const result = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr)
const [pack] = JSON.parse(result.stdout)
const files = new Set(pack.files.map(file => file.path))
for (const file of ['lib/index.js', 'lib/index.d.ts', 'lib/mix-recipe-worker.js', 'data/xiuxian/境界.json', 'data/xiuxian/font/OFL.txt', 'LICENSE', 'NOTICE.md']) {
  assert(files.has(file), `安装包缺少 ${file}`)
}
for (const file of files) {
  assert(!/(^|\/)(node_modules|\.cache|\.env[^/]*|\.git|tests)(\/|$)|\.(db|sqlite|log|tgz)$/i.test(file), `安装包包含不应分发的文件 ${file}`)
}
for (const file of ['data/xiuxian/config.yaml', 'data/xiuxian/config.json', 'data/xiuxian/goods.json']) {
  assert(!files.has(file), `安装包包含上游旧运行配置 ${file}`)
}
const plugin = require(path.join(root, 'lib'))
assert.equal(typeof plugin.apply, 'function')
assert(plugin.inject.required.includes('database'))
assert(plugin.inject.required.includes('monetary'))
const { GameData } = require(path.join(root, 'lib/data'))
const data = new GameData()
assert(Object.keys(data.items).length > 0, '游戏静态资料未加载')
assert(fs.existsSync(path.join(root, 'data/xiuxian/font/sarasa-mono-sc-regular.ttf')))
console.log(`安装包检查通过：${files.size} 个文件，${Object.keys(data.items).length} 件静态物品；未包含数据库或运行配置。`)
