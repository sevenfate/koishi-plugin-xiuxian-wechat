const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const upstream = require('../upstream.json')
async function main() {
  const cache = path.join(root, '.cache', 'upstream')
  await fs.mkdir(cache, { recursive: true })
  const archive = path.join(cache, 'upstream.tgz')
  let bytes
  try { bytes = await fs.readFile(archive) } catch {
    const response = await fetch(upstream.tarball, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error('无法下载已固定版本的上游包')
    bytes = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(archive, bytes)
  }
  if ('sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') !== upstream.integrity) throw new Error('上游包完整性不一致')
  // GNU tar 会把 Windows 的 C:/... 误判成远程主机路径，统一在缓存目录使用相对归档名。
  const listing = spawnSync('tar', ['-tf', path.basename(archive)], { cwd: cache, encoding: 'utf8', windowsHide: true })
  if (listing.status !== 0 || listing.stdout.trim().split(/\r?\n/).some(p => !p.startsWith('package/') || p.split('/').includes('..'))) throw new Error('上游包文件路径校验失败')
  const extracted = spawnSync('tar', ['-xf', path.basename(archive)], { cwd: cache, windowsHide: true })
  if (extracted.status !== 0) throw new Error('上游包解包失败')
  // 只清理本项目的生成目录，避免重建时残留旧代码或上游历史数据库。
  for (const directory of ['lib', 'data']) {
    const target = path.join(root, directory)
    if (path.dirname(target) !== root) throw new Error('生成目录越界')
    await fs.rm(target, { recursive: true, force: true })
  }
  await fs.cp(path.join(cache, 'package', 'lib'), path.join(root, 'lib'), { recursive: true })
  // 只分发游戏读取的静态资料，不复制上游附带的旧数据库和运行配置。
  const resources = [
    '境界.json', '灵根.json', '突破概率.json', '宗门玩法配置.json', '炼体境界.json',
    'work/灵材.json', 'work/暗杀.json', 'work/镇妖.json', 'work/等级奖励稿.json',
    '装备/防具.json', '装备/法器.json', '功法/主功法.json', '功法/辅修功法.json', '功法/神通.json',
    '丹药/丹药.json', '丹药/药材.json', '丹药/炼丹丹药.json', '丹药/炼丹炉.json',
    '修炼物品/聚灵旗.json', 'font/sarasa-mono-sc-regular.ttf',
  ]
  for (const resource of resources) {
    const target = path.join(root, 'data', 'xiuxian', resource)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(cache, 'package', 'data', 'xiuxian', resource), target)
  }
  await fs.copyFile(path.join(root, 'licenses', 'Sarasa-Gothic-OFL.txt'), path.join(root, 'data/xiuxian/font/OFL.txt'))
  const patches = JSON.parse(await fs.readFile(path.join(root, 'patches/wechat-profile.json'), 'utf8'))
  for (const patch of patches) {
    const file = path.resolve(root, patch.file)
    if (!file.startsWith(root + path.sep)) throw new Error('补丁路径越界')
    let source = await fs.readFile(file, 'utf8')
    const count = source.split(patch.before).length - 1
    if (count !== patch.count) throw new Error('上游代码与补丁不匹配：' + patch.file)
    source = source.split(patch.before).join(patch.after)
    await fs.writeFile(file, source)
  }
  await esbuild.build({ entryPoints: ['wechat-profile', 'wechat-mentions', 'economy', 'mix-recipe-list', 'forget-skill', 'view-techniques', 'item-order', 'work-reward', 'shop-trade', 'world-boss', 'boss-rewards', 'sign-in', 'player-services', 'alchemy', 'high-work', 'market-stock', 'market-lock', 'reply-display', 'endless-tower', 'alchemy-commands', 'mix-recipe-search', 'mix-recipe-worker', 'mix-recipe-scanner'].map(name => path.join(root, 'src', name + '.ts')), outdir: path.join(root, 'lib'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', target: 'node18' })
  console.log('已构建上游 ' + upstream.version + ' 的微信昵称适配版本')
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
