import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { GameData } = require(resolve(root, 'lib/data.js'))
const { applyViewTechniques } = require(resolve(root, 'lib/view-techniques.js'))
const { applyBack } = require(resolve(root, 'lib/modules/back.js'))

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async sendMessage(): Promise<string[]> { throw new Error('查询测试不能发消息') }
}

async function fixture() {
  const app = new App(), data = new GameData()
  const techniques = Object.keys(data.getItemsByType(['功法'])).map(Number)
  const low = techniques.find((id: number) => data.getItem(id).level === '人阶下品')!
  const high = techniques.find((id: number) => data.getItem(id).level === '仙阶下品')!
  const skillId = Number(Object.keys(data.getItemsByType(['神通']))[0])
  const learned = [
    { skillId: low, skillType: '功法' },
    { skillId: high, skillType: '功法' },
    { skillId, skillType: '神通' },
  ]
  app.provide('xiuxian', { data, getPlayer: async (id: string) => id === 'missing' ? undefined : { userId: id },
    getLearnedSkills: async (id: string) => id === 'test' ? learned : [] })
  app.plugin(TestBot)
  applyViewTechniques(app)
  applyBack(app, {})
  await app.start()
  return { app, data, techniques, learned, low, high, skillId, async run(command: string, userId = 'test') {
    const session = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 } })
    return String(await session.execute(command, true))
  } }
}

test('类型查询优先：功法返回完整图鉴，不再匹配单本吐纳功法，包含第51本及以后', async () => {
  const f = await fixture()
  try {
    const reply = await f.run('查看修仙界物品 功法')
    assert.match(reply, /^【功法】物品图鉴/)
    assert.ok(f.techniques.length > 50)
    for (const id of f.techniques) assert.ok(reply.includes(`\n${id} `), `图鉴遗漏 ${id}`)
    assert.match(reply, /查看修仙界物品 编号/)
    assert.doesNotMatch(reply, /<编号>/)
  } finally { await f.app.stop() }
})

test('物品编号和完整名称仍返回单件详情，其他类型正常', async () => {
  const f = await fixture()
  try {
    const id = String(f.low), name = f.data.getItem(f.low).name
    const byId = await f.run(`查看修仙界物品 ${id}`)
    assert.match(byId, /^编号：/)
    assert.equal(await f.run(`查看修仙界物品 ${name}`), byId)
    assert.match(await f.run('查看修仙界物品 神通'), /^【神通】物品图鉴/)
  } finally { await f.app.stop() }
})

test('我的功法与查看功法展示本人已学功法的品阶、效果和编号，高品阶在前', async () => {
  const f = await fixture()
  try {
    const before = JSON.stringify(f.learned), reply = await f.run('我的功法')
    assert.equal(await f.run('查看功法'), reply)
    assert.match(reply, /已学功法（2本）/)
    assert.ok(reply.indexOf('【仙阶下品】') < reply.indexOf('【人阶下品】'))
    assert.ok(reply.includes(`${f.high}、`))
    assert.match(reply, /效果：.*气血/)
    assert.match(reply, /合并功法增益：/)
    assert.match(reply, /同属性增益取最高，不叠加/)
    assert.ok(!reply.includes(f.data.getItem(f.skillId).name))
    assert.equal(JSON.stringify(f.learned), before)
    assert.match(await f.run('我的功法', 'another-player'), /尚未学会任何功法/)
    assert.match(await f.run('我的功法', 'missing'), /我要修仙/)
  } finally { await f.app.stop() }
})

test('辅修功法纳入列表，静态物品资料缺失时保留记录并说明', async () => {
  const f = await fixture()
  try {
    f.learned.push({ skillId: 999999, skillType: '辅修功法' })
    const reply = await f.run('我的功法')
    assert.match(reply, /已学功法（3本）/)
    assert.match(reply, /999999、【品阶未标注】未知功法（辅修功法）/)
    assert.match(reply, /物品资料缺失，学习记录已保留/)
    assert.equal(f.learned.length, 4)
  } finally { await f.app.stop() }
})
