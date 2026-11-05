import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, h, MessageEncoder, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { applyReplyDisplay, splitReply, replyCard } = require(resolve(root, 'lib/reply-display.js'))
const long = Array.from({ length: 32 }, (_, i) => `物品${i + 1}：药材、功法与丹药🌿`).join('\n')
class Encoder extends MessageEncoder {
  parts: h[] = []
  async visit(el: h) { this.parts.push(el) }
  async flush() {
    ;(this.bot as any).sent.push(this.parts.map(String).join(''))
    this.results.push({ id: 'test', content: this.parts.map(String).join('') } as any)
  }
}
class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  static MessageEncoder = Encoder
  sent: string[] = []
  deviceAccountId = 'bot-account'
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
}

async function fixture(prefix = '') {
  const app = new App({ prefix, autoAssign: true, autoAuthorize: 1, delay: { character: 0, message: 0 } })
  const sqlite = require('@koishijs/plugin-database-sqlite')
  const pg = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pg && !/^xiuxian_economy_test_/.test(pg.database)) throw Error('仅允许隔离测试数据库')
  const driver = pg ? require('@koishijs/plugin-database-postgres') : sqlite
  app.plugin(driver.default ?? driver, pg || { path: ':memory:' })
  app.plugin(TestBot)
  const state = { renders: 0, uploads: 0, actions: 0, fail: false, badUrl: false, now: 100000, html: '', recipes: [] as any[] }
  app.provide('wechatRender' as any, { async render(html: string) {
    state.renders++; state.html = html
    if (state.fail) throw Error('renderer offline')
    return Buffer.from('fake-png')
  } })
  app.provide('assets', { async upload(uri: string) {
    assert.match(uri, /^data:image\/png;base64,/)
    return state.badUrl ? 'data:image/png;base64,invalid' : `https://assets.example.test/${++state.uploads}.png`
  } } as any)
  let display: any
  app.inject(['database'], ctx => {
    const scope = ctx.exclude(ctx.guild('blocked'))
    scope.command('xiuxian')
    scope.command('xiuxian/长查询').action(() => { state.actions++; return long })
    scope.command('xiuxian/短查询').action(() => '收到')
    scope.command('xiuxian/已有图片').action(() => h.image('https://example.test/a.png'))
    scope.command('xiuxian/引用查询').action(() => [h.quote('original'), h.text(long)])
    scope.command('xiuxian/炼丹 [page:integer]').action((_, page = 1) => state.recipes.length
      ? require(resolve(root, 'lib/mix-recipe-list')).renderMixRecipePage(state.recipes, page) : `配方页${page}`)
    ctx.command('其他长文').action(() => long)
    display = applyReplyDisplay(scope, { longTextToImage: true, longTextLineThreshold: 20 }, { now: () => state.now })
  })
  await app.start()
  if (pg) for (const table of ['binding', 'user', 'channel', 'xiuxian_display']) await app.database.remove(table as any, {})
  const bot = app.bots[0] as TestBot
  return { app, bot, state, get display() { return display },
    async run(content: string, guild = 'group', user = 'reader') {
      bot.sent.length = 0
      const s = bot.session({ type: 'message', user: { id: user }, guild: { id: guild }, channel: { id: guild, type: 0 }, message: { elements: [h.text(content)] } })
      await app.parallel('message', s)
      return bot.sent.join('\n')
    },
  }
}

test('分页保留中文和 emoji 全文、限制页长，卡片转义不可信文本', () => {
  for (const input of [long, '🌿'.repeat(1550), '甲\n'.repeat(100), '', '<script>&"']) {
    const pages = splitReply(input)
    assert.equal(pages.join(''), input)
    assert.ok(pages.every((p: string) => Array.from(p).length <= 500 && !/[\uD800-\uDBFF]$/.test(p)))
  }
  assert.match(replyCard('<script>&"'), /&lt;script&gt;&amp;&quot;/)
  assert.ok(replyCard(long).length < 3000)
})

test('36种炼丹配方经真实发送链全部可达，图片、文字和失败回退均保留炼丹导航', async () => {
  const f = await fixture()
  try {
    f.state.recipes = Array.from({ length: 36 }, (_, i) => ({ elixirId: i + 1, elixirName: `丹药${i + 1}`,
      formulaShort: '主药热药1药引寒药1辅药中药1', desc: '恢复气血和修为。'.repeat(4), materialPolicy: 'unbound', maxBatches: 10 }))
    const seen = new Set<number>()
    for (let page = 1; page <= 8; page++) {
      assert.match(await f.run(`炼丹 ${page}`), /<img /)
      assert.match(f.state.html, new RegExp(`第 ${page}/8 页`))
      assert.doesNotMatch(f.state.html, /炼丹 · 第1\/|下一页：修仙翻页/)
      for (const hit of f.state.html.matchAll(/\d+、丹药(\d+)/g)) seen.add(+hit[1])
      if (page < 8) assert.ok(f.state.html.includes(`下一页：炼丹 ${page + 1}`))
    }
    assert.equal(seen.size, 36)
    assert.match(await f.run('修仙翻页 2'), /炼丹列表请/)
    await f.run('修仙显示 文字')
    assert.match(await f.run('炼丹 8'), /36、丹药36/)
    await f.run('修仙显示 图片'); f.state.fail = true
    assert.match(await f.run('炼丹 5'), /图片暂不可用[\s\S]*21、丹药21[\s\S]*下一页：炼丹 6/)
  } finally { await f.app.stop() }
})

test('真实发送链自动转图并托管 HTTP URL；翻页复用缓存且不重新执行原指令', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('长查询'), /<img src="https:\/\/assets.example.test\/1.png"/)
    assert.match(f.state.html, /第1\/4页/)
    assert.match(await f.run('修仙翻页2'), /assets.example.test\/2.png/)
    assert.match(f.state.html, /第2\/4页/)
    assert.match(await f.run('修仙翻页 1'), /assets.example.test\/1.png/)
    assert.equal(f.state.actions, 1)
    assert.equal(f.state.renders, 2)
    assert.match(await f.run('修仙翻页 99'), /页码无效/)
    assert.equal(await f.run('短查询'), '收到')
    assert.equal(await f.run('其他长文'), String(h.text(long)))
    assert.match(await f.run('已有图片'), /example.test\/a.png/)
    assert.match(await f.run('引用查询'), /<quote id="original"\/><img/)
  } finally { await f.app.stop() }
})

test('个人偏好持久保存，文字分页保留末页，跨群跨账号不可读缓存，过期有提示', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('修仙显示 文字'), /已设置/)
    assert.equal((await f.app.database.get('xiuxian_display' as any, {}))[0].mode, '文字')
    assert.match(await f.run('长查询'), /第1\/4页/)
    assert.match(await f.run('修仙翻页 4'), /物品32/)
    assert.equal(f.state.renders, 0)
    assert.match(await f.run('修仙翻页 1', 'other'), /没有可翻页/)
    assert.match(await f.run('修仙翻页 1', 'group', 'other-user'), /没有可翻页/)
    f.bot.deviceAccountId = 'another-account'
    assert.match(await f.run('修仙翻页 1'), /没有可翻页/)
    f.bot.deviceAccountId = 'bot-account'
    f.state.now += 600001
    assert.match(await f.run('修仙翻页 1'), /已过期/)
    assert.match(await f.run('修仙显示 乱填'), /模式支持/)
    assert.match(await f.run('修仙显示'), /当前显示：文字/)
    assert.match(await f.run('修仙显示 自动'), /已设置/)
    assert.match(await f.run('长查询'), /<img /)
  } finally { await f.app.stop() }
})

test('渲染失败回退完整分页文字，不丢内容、不影响其他插件和群过滤', async () => {
  const f = await fixture()
  try {
    f.state.fail = true
    assert.match(await f.run('长查询'), /图片暂不可用[\s\S]*物品1/)
    assert.match(await f.run('修仙翻页 4'), /物品32/)
    assert.equal(f.state.actions, 1)
    f.state.fail = false; f.state.badUrl = true
    assert.match(await f.run('长查询'), /图片暂不可用/)
    assert.equal(await f.run('长查询', 'blocked'), '')
    assert.equal(await f.run('炼丹2', 'blocked'), '')
  } finally { await f.app.stop() }
})

test('无空格炼丹页码保留前缀约束，不误改普通聊天', async () => {
  const f = await fixture('!')
  try {
    assert.equal(await f.run('!炼丹2'), '配方页2')
    assert.equal(await f.run('炼丹2'), '')
    assert.equal(await f.run('!炼丹2今天'), '')
    assert.equal(await f.run('!炼丹 3'), '配方页3')
  } finally { await f.app.stop() }
})
