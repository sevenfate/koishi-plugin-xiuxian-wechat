import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, h, type Context } from 'koishi'

const require = createRequire(__filename), root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const plugin = (file: string) => require(resolve(root, 'lib', file + '.js'))
const { XiuxianService } = plugin('service'), { applyPlayerServices, FURNACE_PRICE } = plugin('player-services')
const { applyWork } = plugin('modules/work'), { craftBatch } = plugin('alchemy')
const { buildFighter } = plugin('combat-stats'), { playerFight } = plugin('utils')

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  deviceAccountId = 'fake'
  sent: string[] = []
  async getGuildMember(_guild: string, id: string) { return { user: { id }, nick: '接收道友' } }
  async sendMessage(_channel: string, content: any): Promise<string[]> { this.sent.push(h.normalize(content).join('')); return ['offline'] }
}

async function fixture() {
  const app = new App(), pg = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pg && !/^xiuxian_economy_test_/.test(pg.database)) throw new Error('仅允许隔离测试数据库')
  const driver = require(pg ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pg || { path: ':memory:' }); app.provide('monetary', {}); app.plugin(TestBot)
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    ctx.plugin(XiuxianService, { currency: 'default' })
    ctx.inject(['xiuxian' as any], scope => {
      applyWork(scope, {}); plugin('modules/exercises').applyExercises(scope, {})
      plugin('modules/mixelixir').applyMixElixir(scope, {})
      plugin('modules/back').applyBack(scope, {})
      applyPlayerServices(scope, {}, plugin('helpers').getAtId, plugin('daily-utils').todayStr)
      plugin('wechat-mentions').applyMentionCompat(scope)
    })
  })
  await app.start()
  const db: any = app.database, srv: any = (app as any).xiuxian
  if (pg) for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_back', 'xiuxian_cd', 'xiuxian_buff', 'xiuxian_skill', 'xiuxian_sign', 'xiuxian_work', 'xiuxian_work_pending', 'xiuxian_exercises']) await db.remove(table, {})
  for (const [i, userId] of ['giver', 'receiver'].entries()) {
    await db.create('user', { id: 101 + i, authority: 1, name: userId })
    await db.create('binding', { aid: 101 + i, bid: 101 + i, pid: userId, platform: 'webridge' })
    await db.create('xiuxian_player', { userId, uid: 101 + i, platform: 'webridge', userName: userId, hp: 5000, mp: 10000, exp: 10000, level: '筑基境初期' })
    await db.create('monetary', { uid: 101 + i, currency: 'default', value: 1000000 })
  }
  return { app, db, srv, async run(command: string, userId = 'giver', target?: string) {
    const s = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 },
      message: { elements: [h.text(command), ...(target ? [h('at', { id: target })] : [])] } })
    return String(await s.execute(command, true))
  }, count: async (userId: string, id: number) => (await srv.getBackItem(userId, id))?.goodsNum || 0,
  wallet: () => srv.getStoneForUser('giver', 'webridge'), async message(text: string) {
    const bot = app.bots[0] as TestBot, start = bot.sent.length
    const { buildSession } = require('./fixtures/message-session.ts')
    const s = buildSession.call(bot, { event_name: 'message', body: {
      message_id: String(Date.now()), sender_id: 'giver', chat_id: 'test@chatroom', room_id: 'test@chatroom', is_group: true,
      at_user_list: ['receiver'], create_time: Date.now() / 1000,
    } }, text, [])
    await app.parallel('message', s)
    return bot.sent.slice(start).join('\n')
  } }
}

test('真实命令经工作线程扫描并炼制，消耗与产出写入同一事务', async () => {
  const f = await fixture()
  try {
    const util = plugin('mix-elixir-util'), data = f.srv.data
    const herbs = Object.entries(data.getItemsByType(['药材'])).map(([id, info]) => ({ id: +id, info, num: 5 }))
    const first = util.findMixRecipes(herbs, data.getItemsByType(['合成丹药']))[0]
    assert.ok(first)
    const ids = [...new Set([first.mainId, first.yaoyinId, first.fuyaoId])]
    await f.srv.sendBack('giver', 4003, '陨铁炉', '炼丹炉', 1)
    for (const id of ids) await f.srv.sendBack('giver', id, data.getItem(id).name, '药材', 5)
    const expected = util.findMixRecipes(herbs.filter((x: any) => ids.includes(x.id)), data.getItemsByType(['合成丹药']))[0]
    const listing = await f.run('炼丹')
    assert.ok(listing.includes(expected.elixirName))
    assert.equal(await f.count('giver', expected.elixirId), 0, '只扫描不产出丹药')
    assert.match(await f.run('炼制 1'), /丹成/)
    assert.equal(await f.count('giver', expected.elixirId), 1)
    const materials = plugin('mix-recipe-list').recipeMaterials(expected)
    for (const [id, material] of materials) assert.equal(await f.count('giver', id), 5 - material.num)
  } finally { await f.app.stop() }
})

test('微信群离线消息解析：仅艾特群友、显示名紧贴指令及别名都能赠送', async () => {
  const f = await fixture()
  try {
    await f.srv.sendBack('giver', 1101, '回血丹', '丹药', 10)
    assert.match(await f.message('赠送物品@接收道友\u2005 1101 2'), /赠送.*2个/)
    assert.match(await f.message('送物品 1101 3 @接收道友\u2005'), /赠送.*3个/)
    assert.equal(await f.count('receiver', 1101), 5)
    assert.equal(await f.count('giver', 1101), 5)
  } finally { await f.app.stop() }
})

test('赠送书籍/丹药只转移未绑定库存，禁止自赠和未建号目标', async () => {
  const f = await fixture()
  try {
    const id = Number(Object.keys(f.srv.data.getItemsByType(['功法']))[0]), info = f.srv.data.getItem(id)
    await f.srv.sendBack('giver', id, info.name, '功法', 5)
    await f.db.set('xiuxian_back', { userId: 'giver', goodsId: id }, { bindNum: 2 })
    assert.match(await f.run(`赠送物品 ${id} 4`, 'giver', 'receiver'), /可赠送数量不足/)
    assert.match(await f.run(`赠送物品 ${id} 3`, 'giver', 'receiver'), /赠送.*3个/)
    assert.equal(await f.count('giver', id), 2); assert.equal(await f.count('receiver', id), 3)
    assert.equal((await f.srv.getBackItem('giver', id)).bindNum, 2)
    assert.match(await f.run('我的背包'), /绑定2，可交易0/)
    assert.match(await f.run(`赠送物品 ${id}`, 'giver', 'giver'), /自己/)
    assert.match(await f.run(`赠送物品 ${id}`, 'giver', 'missing'), /尚未加入/)
    assert.match(await f.run(`赠送物品 ${id}`), /请艾特/)
    assert.match(await f.run(`赠送物品 ${id} -1`, 'giver', 'receiver'), /1～1000/)
  } finally { await f.app.stop() }
})

test('常驻商店购买丹炉扣费发货一次；导引与今日状态不发奖、不消耗次数', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('修仙商店'), /陨铁炉/)
    assert.match(await f.run('修仙购买 炼丹炉'), /购得【陨铁炉】/)
    assert.equal(await f.wallet(), 1000000 - FURNACE_PRICE)
    assert.match(await f.run('修仙购买 4003'), /已有可用炼丹炉/)
    assert.equal(await f.count('giver', 4003), 1)
    assert.match(await f.run('修仙指引 炼丹'), /炼制 1 10/)
    assert.match(await f.run('今日修仙'), /签到.*修仙签到/)
    await f.db.upsert('xiuxian_cd', [{ userId: 'giver', type: 1 }])
    const daily = await f.run('今日修仙')
    assert.match(daily, /悬赏：当前闭关或秘境中/)
    assert.match(daily, /无需等待悬赏结算/)
    assert.match(await f.run('修仙指引 炼丹'), /炼十炉/)
    assert.equal(await f.wallet(), 1000000 - FURNACE_PRICE)
    assert.equal((await f.srv.getPlayer('giver')).workRefreshCount, 0)
  } finally { await f.app.stop() }
})

test('所有境界均能生成悬赏；高阶重复查看不刷新，结算后只能领取一次', async () => {
  const f = await fixture()
  try {
    for (const level of Object.keys(f.srv.data.levels)) {
      await f.db.set('xiuxian_player', { userId: 'giver' }, { level, exp: Math.max(100, f.srv.data.getLevelPower(level)) })
      await f.db.remove('xiuxian_work_pending', { userId: 'giver' })
      const first = await f.run('悬赏令')
      assert.match(first, /个人悬赏令/, level)
      assert.equal(await f.run('悬赏令'), first)
    }
    assert.match(await f.run('悬赏令接取 1'), /接取任务/)
    await f.db.set('xiuxian_work', { userId: 'giver' }, { startTime: new Date(0) })
    assert.match(await f.run('悬赏令结算 灵石'), /获得报酬/)
    const wallet = await f.wallet()
    assert.match(await f.run('悬赏令结算 灵石'), /没有查到/)
    assert.equal(await f.wallet(), wallet)
  } finally { await f.app.stop() }
})

const recipe = { elixirId: 1101, elixirName: '测试丹', mainId: 3101, mainName: '主药', mainNum: 1,
  yaoyinId: 3102, yaoyinName: '药引', yaoyinNum: 1, fuyaoId: 3101, fuyaoName: '主药', fuyaoNum: 1, formulaShort: '主药2药引1' }

test('批量炼制合并同种药材，绑定材料保留绑定属性；数量不足不消耗', async () => {
  const f = await fixture()
  try {
    await f.srv.sendBack('giver', 4003, '陨铁炉', '炼丹炉', 1)
    await f.srv.sendBack('giver', 3101, '主药', '药材', 10, 1)
    await f.srv.sendBack('giver', 3102, '药引', '药材', 10)
    assert.match(await craftBatch(f.app, f.srv, 'giver', recipe, 6, () => false), /药材不足/)
    assert.equal(await f.count('giver', 3101), 10)
    assert.match(await craftBatch(f.app, f.srv, 'giver', recipe, 3, () => false), /3枚.*绑定/)
    assert.equal(await f.count('giver', 3101), 4); assert.equal(await f.count('giver', 3102), 7)
    assert.equal(await f.count('giver', 1101), 3); assert.equal((await f.srv.getBackItem('giver', 1101)).bindNum, 3)
    assert.match(await craftBatch(f.app, f.srv, 'giver', recipe, 101, () => false), /1～100/)
    await f.srv.sendBack('giver', 4001, '寒铁铸心炉', '炼丹炉', 1)
    await f.srv.sendBack('giver', 4002, '雕花紫铜炉', '炼丹炉', 1)
    assert.match(await craftBatch(f.app, f.srv, 'giver', recipe, 2, () => false), /6枚.*不叠加/)
    assert.equal(await f.count('giver', 1101), 9)
  } finally { await f.app.stop() }
})

test('不绑定方案批量炼制不会自动用绑定库存，成功产物可赠送且保留原绑定药材', async () => {
  const f = await fixture()
  try {
    await f.srv.sendBack('giver', 4003, '陨铁炉', '炼丹炉', 1)
    await f.srv.sendBack('giver', 3101, '主药', '药材', 8, 1)
    await f.srv.sendBack('giver', 3101, '主药', '药材', 2)
    await f.srv.sendBack('giver', 3102, '药引', '药材', 10)
    const safe = { ...recipe, materialPolicy: 'unbound' }
    assert.match(await craftBatch(f.app, f.srv, 'giver', safe, 2, () => false), /未绑定药材不足：[\s\S]*需要4个，现有10个（绑定8、未绑定2）[\s\S]*最多可炼1炉/)
    assert.equal(await f.count('giver', 3101), 10)
    assert.match(await craftBatch(f.app, f.srv, 'giver', safe, 1, () => false), /丹成/)
    assert.equal((await f.srv.getBackItem('giver', 3101)).bindNum, 8)
    assert.equal((await f.srv.getBackItem('giver', 1101)).bindNum, 0)
    assert.match(await f.run('赠送物品 1101 1', 'giver', 'receiver'), /赠送/)
    assert.equal(await f.count('receiver', 1101), 1)
    assert.match(await craftBatch(f.app, f.srv, 'giver', safe, 1, () => false), /未绑定药材不足/)
    assert.equal(await f.count('giver', 3101), 8)
    assert.match(await craftBatch(f.app, f.srv, 'giver', { ...recipe, materialPolicy: 'any' }, 1, () => false), /本批丹药绑定/)
    assert.equal((await f.srv.getBackItem('giver', 1101)).bindNum, 1)
  } finally { await f.app.stop() }
})

test('背包按分类、名称和编号直接查数量，丹药含两种类别，查询不改背包和绑定数', async () => {
  const f = await fixture()
  try {
    await f.srv.sendBack('giver', 3101, f.srv.data.getItem(3101).name, '药材', 8, 1)
    await f.srv.sendBack('giver', 3101, f.srv.data.getItem(3101).name, '药材', 2)
    await f.srv.sendBack('giver', 3102, f.srv.data.getItem(3102).name, '药材', 3, 1)
    await f.srv.sendBack('giver', 1101, f.srv.data.getItem(1101).name, '丹药', 2)
    await f.srv.sendBack('giver', 1401, f.srv.data.getItem(1401).name, '合成丹药', 3)
    const before = await f.srv.getBack('giver')
    const name = f.srv.data.getItem(3101).name
    for (const cmd of [`我的背包 ${name}`, '我的背包 3101', `我的药材 ${name}`, '我的物品 药材 3101']) {
      const text = await f.run(cmd)
      assert.match(text, /共1种/); assert.match(text, /x10（绑定8，可交易2）/)
      assert.doesNotMatch(text, /编号3102|编号1101/)
    }
    assert.match(await f.run('我的背包 不绑定 药材'), /共1种/)
    assert.match(await f.run('我的药材'), /共2种/)
    const pills = await f.run('我的丹药')
    assert.match(pills, /共2种/); assert.match(pills, /编号1101/); assert.match(pills, /编号1401/)
    assert.doesNotMatch(pills, /编号3101/)
    assert.match(await f.run('我的背包 不存在的物品'), /没有符合条件/)
    assert.deepEqual(await f.srv.getBack('giver'), before)
  } finally { await f.app.stop() }
})

test('赠送和炼制的发货失败都回滚库存与绑定数', async () => {
  const f = await fixture(), proto = Object.getPrototypeOf(f.srv), send = proto.sendBack
  try {
    await f.srv.sendBack('giver', 4003, '陨铁炉', '炼丹炉', 1)
    await f.srv.sendBack('giver', 3101, '主药', '药材', 6, 1); await f.srv.sendBack('giver', 3102, '药引', '药材', 6)
    await f.srv.sendBack('giver', 1101, '回血丹', '丹药', 3)
    proto.sendBack = async () => { throw new Error('模拟发货失败') }
    await f.run('赠送物品 1101 2', 'giver', 'receiver')
    await assert.rejects(craftBatch(f.app, f.srv, 'giver', recipe, 2, () => false), /模拟发货失败/)
    assert.equal(await f.count('giver', 1101), 3); assert.equal(await f.count('receiver', 1101), 0)
    assert.equal(await f.count('giver', 3101), 6); assert.equal((await f.srv.getBackItem('giver', 3101)).bindNum, 6)
  } finally { proto.sendBack = send; await f.app.stop() }
})

test('功法气血加成用于实际战斗，剩余气血换算回基础存储，不会虚增或满血损失', async () => {
  const f = await fixture()
  try {
    const id = Number(Object.keys(f.srv.data.getItemsByType(['功法'])).find(id => f.srv.data.getItem(Number(id)).hpbuff > 0))
    assert.ok(id)
    await f.srv.learnSkill('giver', id, '功法')
    const real = await f.srv.getRealPlayer('giver'), fighter = await buildFighter(f.srv, 'giver')
    assert.equal(fighter.hp, real.hp)
    assert.ok(fighter.hp > 5000)
    await f.srv.applyBattleHp('giver', fighter.hp)
    assert.equal((await f.srv.getPlayer('giver')).hp, 5000)
    await f.srv.applyBattleHp('giver', Math.floor(fighter.hp / 2))
    assert.ok(Math.abs((await f.srv.getRealPlayer('giver')).hp - Math.floor(fighter.hp / 2)) <= fighter.hpScale)
    await f.srv.applyBattleHp('giver', 0)
    assert.equal((await f.srv.getPlayer('giver')).hp, 0)
  } finally { await f.app.stop() }
})

test('防御神通提高施法者的减伤，不增强对手', () => {
  const a = { userId: 'a', name: '甲', hp: 100, atk: 10, mp: 100, crit: 0, critDamage: 1.5, defense: 0, secSkillIds: [1] }
  const b = { userId: 'b', name: '乙', hp: 100, atk: 10, mp: 100, crit: 0, critDamage: 1.5, defense: 0 }
  const data = { getItem: () => ({ name: '护体', rate: 100, skill_type: 3, bufftype: 2, buffvalue: 0.1 }) }
  playerFight(a, b, data)
  assert.ok(a.defense > 0); assert.equal(b.defense, 0)
})

test('PostgreSQL 并发赠送不超送、并发结算不重复领奖', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await f.srv.sendBack('giver', 1101, '回血丹', '丹药', 5)
    const replies = await Promise.all([f.run('赠送物品 1101 4', 'giver', 'receiver'), f.run('赠送物品 1101 4', 'giver', 'receiver')])
    assert.equal(replies.filter(r => r.includes('已向')).length, 1)
    assert.equal(await f.count('giver', 1101), 1); assert.equal(await f.count('receiver', 1101), 4)
    await f.run('悬赏令'); await f.run('悬赏令接取 1')
    await f.db.set('xiuxian_work', { userId: 'giver' }, { startTime: new Date(0), rate: 100, award: 100, itemId: 0 })
    const before = await f.wallet()
    const settled = await Promise.all([f.run('悬赏令结算 灵石'), f.run('悬赏令结算 灵石')])
    assert.equal(settled.filter(r => r.includes('获得报酬')).length, 1)
    assert.equal(await f.wallet(), before + 200)
  } finally { await f.app.stop() }
})
