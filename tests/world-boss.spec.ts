import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, h, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { applyWorldBoss, deferQuiet, allocate, RULES, formatBossPercent } = require(resolve(root, 'lib/world-boss.js'))
const { applyExercises } = require(resolve(root, 'lib/modules/exercises.js'))
const deps = { ...require(resolve(root, 'lib/utils.js')), ...require(resolve(root, 'lib/combat-stats.js')), ...require(resolve(root, 'lib/battle-detail.js')) }

const HOUR = 3600_000
/** 2026-10-31 12:00（上海） */
const NOON = Date.UTC(2026, 9, 31, 4, 0)
const sent: { channelId: string; content: string }[] = []

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async sendMessage(channelId: string, content: any): Promise<string[]> { sent.push({ channelId, content: String(content) }); return ['1'] }
}

async function fixture(prefix = '', rewardVersion: 1 | 2 = 1, random = () => 0.99, preserveBosses = false) {
  sent.length = 0
  const app = new App({ prefix, autoAssign: true, autoAuthorize: 1, delay: { character: 0, message: 0 } })
  const pgConfig = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pgConfig && !/^xiuxian_economy_test_/.test(pgConfig.database)) throw new Error('仅允许隔离测试数据库')
  const driver = require(pgConfig ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pgConfig || { path: ':memory:' })
  app.provide('monetary', {})
  app.plugin(TestBot)
  const clock = { now: NOON }
  const blocked = new Set<string>()
  let api: any, reload: () => Promise<void>
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    ctx.plugin(XiuxianService, { currency: 'default' })
    ctx.inject(['xiuxian' as any], scope => {
      const register = (ctx: any) => { api = applyWorldBoss(ctx.intersect((s: any) => !blocked.has(s.guildId)), ctx, deps, { now: () => clock.now, timer: false, rewardVersion, random }) }
      // 讨伐时 buildFighter 会读炼体表，与正式加载一样先注册
      applyExercises(scope, {})
      if (rewardVersion === 2) for (const table of ['xiuxian_work', 'xiuxian_bank', 'xiuxian_plot']) scope.model.extend(table as any, { userId: 'string' }, { primary: 'userId' })
      let fork = scope.plugin(register)
      reload = async () => { await fork.dispose(); fork = scope.plugin(register); await app.lifecycle.flush() }
    })
  })
  await app.start()
  const database: any = app.database, service: any = (app as any).xiuxian
  if (pgConfig) for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_back', 'xiuxian_boss', 'xiuxian_boss_participant', 'xiuxian_boss_schedule', 'xiuxian_boss_activity', 'xiuxian_boss_account', 'xiuxian_boss_reward', 'xiuxian_boss_exchange']) {
    if (preserveBosses && ['xiuxian_boss', 'xiuxian_boss_participant'].includes(table)) continue
    await database.remove(table, {})
  }
  // 中位修为 3000（admin 5000 也计入），5 人
  const players = [['admin', 5000], ['p1', 1000], ['p2', 2000], ['p3', 3000], ['p4', 100000]] as const
  for (const [i, [userId, exp]] of players.entries()) {
    await database.create('user', { id: 81 + i, name: userId, authority: userId === 'admin' ? 999 : 1 })
    await database.create('binding', { aid: 81 + i, bid: 81 + i, pid: userId, platform: 'webridge' })
    await database.create('xiuxian_player', { userId, uid: 81 + i, platform: 'webridge', userName: '道友' + userId, createTime: new Date(NOON), exp, hp: exp / 2, mp: exp, atk: 1e9 })
    await database.create('monetary', { uid: 81 + i, currency: 'default', value: 0 })
  }
  const run = async (command: string, userId = 'admin', guildId = 'boss@chatroom') => {
    const session = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: guildId }, channel: { id: guildId, type: 0 } })
    return String(await session.execute(command, true))
  }
  // 每人发一次指令，登记为本群活跃玩家
  for (const [userId] of players) await run('世界boss帮助', userId)
  return { app, database, service, clock, blocked, run, api: () => api, reload: () => reload(),
    message: async (text: string, userId = 'admin', guildId = 'boss@chatroom') => {
      const start = sent.length
      const s = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: guildId }, channel: { id: guildId, type: 0 }, message: { elements: [h.text(text)] } })
      await app.parallel('message', s)
      return sent.slice(start).map(x => x.content).join('\n')
    },
    boss: async () => (await database.get('xiuxian_boss', {}))[0],
    exp: async (userId: string) => (await service.getPlayer(userId)).exp,
    wallet: (userId: string) => service.getStoneForUser(userId, 'webridge'),
  }
}

const rewards = require(resolve(root, 'lib/boss-rewards.js'))
async function readyKill(f: any, guild = 'boss@chatroom', userId = 'p1', attacks = 1, damageRate = 0.5) {
  await f.run('创建世界boss', 'admin', guild)
  const [boss] = await f.database.get('xiuxian_boss', { channelId: guild })
  const p = await f.service.getPlayer(userId)
  await f.database.set('xiuxian_boss', { id: boss.id }, { hp: 1 })
  await f.database.create('xiuxian_boss_participant', { bossId: boss.id, userId, platform: 'webridge', character: rewards.characterKey(p), rewardLevel: p.level, effectiveAttacks: attacks, damage: Math.floor(boss.maxHp * damageRate) })
  return boss
}

test('新版击杀保底、绑定物资、功勋和稀有保底记录一次；旧Boss不切换奖励', async () => {
  const f = await fixture('', 2)
  try {
    await readyKill(f)
    assert.match(await f.run('讨伐世界boss', 'p1'), /灵石\+50000[\s\S]*功勋\+21[\s\S]*绑定/)
    const [account] = await f.database.get('xiuxian_boss_account', { userId: 'p1' })
    assert.equal(account.kills, 1); assert.equal(account.merit, 21); assert.equal(account.pity, 1)
    const backs = await f.service.getBack('p1')
    assert.equal(backs.filter((x: any) => x.goodsType === '药材').reduce((s: number, x: any) => s + x.goodsNum, 0), 8)
    assert.ok(backs.every((x: any) => x.bindNum === x.goodsNum))
    assert.equal((await f.database.get('xiuxian_boss_reward', {})).length, 1)
    assert.match(await f.run('讨伐战利', 'p1'), /灵石\+50000[\s\S]*只查询/)
    assert.match(await f.run('讨伐战利', 'p2'), /暂无/)
    assert.match(await f.run('讨伐世界boss', 'p1'), /暂无/)
    await f.reload()
    assert.match(await f.run('讨伐功勋', 'p1'), /21[\s\S]*1\/3[\s\S]*1\/5/)
    const old = await readyKill(f)
    await f.database.set('xiuxian_boss', { id: old.id }, { rewardVersion: 1 })
    assert.match(await f.run('讨伐世界boss', 'p1'), /终斩/)
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].kills, 1)
  } finally { await f.app.stop() }
})

test('第六次稀有空档记待领，进阶自选不绑定物品，仅领取一次', async () => {
  const f = await fixture('', 2)
  try {
    await f.database.set('xiuxian_player', { userId: 'p1' }, { level: '练气境初期' })
    await f.database.create('xiuxian_boss_account', { platform: 'webridge', userId: 'p1', pity: 5 })
    await readyKill(f)
    assert.match(await f.run('讨伐世界boss', 'p1'), /稀有已命中[\s\S]*待领/)
    let [a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' })
    assert.equal(a.pity, 0); assert.equal(a.pendingRare['1'], 1)
    assert.match(await f.run('领取讨伐战利品', 'p1'), /资格会保留/)
    await f.database.set('xiuxian_player', { userId: 'p1' }, { level: '练气境圆满' })
    assert.match(await f.run('领取讨伐战利品', 'p1'), /7002/)
    assert.match(await f.run('领取讨伐战利品 7002', 'p1'), /不绑定/)
    assert.equal((await f.service.getBackItem('p1', 7002)).bindNum, 0)
    assert.match(await f.run('领取讨伐战利品 7002', 'p1'), /没有对应/)
    assert.equal((await f.service.getBackItem('p1', 7002)).goodsNum, 1)
    ;[a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' }); assert.equal(a.pendingRare['1'], 0)
  } finally { await f.app.stop() }
})

test('连续六次跨日计奖触发稀有保底，不限第一名，稀有物品不绑定', async () => {
  const f = await fixture('', 2)
  try {
    for (let i = 0; i < 6; i++) {
      if (i === 3) f.clock.now += 24 * HOUR
      await f.database.set('xiuxian_player', { userId: 'p1' }, { hp: (await f.service.getPlayer('p1')).exp / 2 })
      await readyKill(f)
      const reply = await f.run('讨伐世界boss', 'p1')
      const [a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' })
      assert.equal(a.pity, i === 5 ? 0 : i + 1)
      if (i === 5) assert.match(reply, /不绑定，可交易/)
    }
    const books = (await f.service.getBack('p1')).filter((x: any) => ['功法', '神通', '法器', '防具'].includes(x.goodsType))
    assert.equal(books.reduce((n: number, x: any) => n + x.goodsNum, 0), 1)
    assert.equal(books[0].bindNum, 0)
  } finally { await f.app.stop() }
  const both = await fixture('', 2, () => 0)
  try {
    await both.database.set('xiuxian_player', { userId: ['p1', 'p2'] }, { level: '筑基境中期' })
    const b = await readyKill(both)
    await both.database.set('xiuxian_boss', { id: b.id }, { strength: 8000 })
    const p = await both.service.getPlayer('p2')
    await both.database.create('xiuxian_boss_participant', { bossId: b.id, userId: 'p2', platform: 'webridge', character: rewards.characterKey(p), rewardLevel: p.level, damage: b.maxHp * 0.1 })
    assert.match(await both.run('讨伐世界boss', 'p1'), /2位道友/)
    for (const user of ['p1', 'p2']) {
      const drops = (await both.service.getBack(user)).filter((x: any) => ['功法', '神通', '法器', '防具'].includes(x.goodsType))
      assert.equal(drops.length, 1); assert.equal(drops[0].bindNum, 0)
    }
  } finally { await both.app.stop() }
})

test('兑换发货失败或背包上限会回滚功勋和周限额，角色快照变更不领旧场奖励', async () => {
  const f = await fixture('', 2), proto = Object.getPrototypeOf(f.service), send = proto.sendBack
  try {
    await f.database.set('xiuxian_player', { userId: 'p1' }, { level: '筑基境中期' })
    await f.database.create('xiuxian_boss_account', { platform: 'webridge', userId: 'p1', merit: 180 })
    proto.sendBack = async () => { throw Error('模拟兑换发货失败') }
    await f.run('讨伐兑换 功法 9011', 'p1'); proto.sendBack = send
    let [a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' }); assert.equal(a.merit, 180); assert.equal(a.books, 0)
    await f.service.sendBack('p1', 9011, '禾山经', '功法', 2147483647)
    await f.run('讨伐兑换 功法 9011', 'p1')
    ;[a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' }); assert.equal(a.merit, 180); assert.equal(a.books, 0)
    await f.database.remove('xiuxian_back', { userId: 'p1', goodsId: 9011 })
    assert.match(await f.run('讨伐兑换 功法 9011', 'p1'), /兑换成功/)
    await readyKill(f)
    await f.database.set('xiuxian_player', { userId: 'p1' }, { createTime: new Date(f.clock.now + 1) })
    assert.match(await f.run('讨伐世界boss', 'p1'), /重入前/)
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].kills, 0)
  } finally { proto.sendBack = send; await f.app.stop() }
})

test('未达新增门槛及遁走仅给基础；两次正伤害可获得保底，奖励失败回滚全部', async () => {
  const f = await fixture('', 2), proto = Object.getPrototypeOf(f.service), send = proto.sendBack
  try {
    await readyKill(f, 'boss@chatroom', 'p1', 0, 0)
    assert.match(await f.run('讨伐世界boss', 'p1'), /未达到新增奖励条件/)
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].kills, 0)
    const boss = await readyKill(f, 'boss@chatroom', 'p1', 1, 0)
    const wallet = await f.wallet('p1'), exp = await f.exp('p1')
    proto.sendBack = async () => { throw Error('模拟奖励发货失败') }
    await f.run('讨伐世界boss', 'p1')
    proto.sendBack = send
    assert.equal((await f.boss()).id, boss.id)
    assert.equal(await f.wallet('p1'), wallet); assert.equal(await f.exp('p1'), exp)
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].kills, 0)
    assert.match(await f.run('讨伐世界boss', 'p1'), /功勋\+15/)
    await f.run('创建世界boss')
    const escaped = await f.boss()
    await f.database.set('xiuxian_boss', { id: escaped.id }, { expireAt: new Date(f.clock.now + HOUR) })
    await f.run('讨伐世界boss', 'p2')
    f.clock.now += HOUR; await f.api().tick()
    const [a] = await f.database.get('xiuxian_boss_account', { userId: 'p2' })
    assert.ok(!a || a.kills === 0)
  } finally { proto.sendBack = send; await f.app.stop() }
})

test('跨群每日3次、UTC+8跨日重置、重入保留账号记录，兑换校验与每周限购', async () => {
  const f = await fixture('', 2)
  try {
    await f.database.create('xiuxian_boss_account', { platform: 'webridge', userId: 'p1', merit: 300, day: rewards.rewardDay(f.clock.now), kills: 3, pity: 2 })
    await readyKill(f, 'other@chatroom')
    assert.match(await f.run('讨伐世界boss', 'p1', 'other@chatroom'), /3次已用完/)
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].pity, 2)
    f.clock.now = Date.UTC(2026, 9, 31, 16)
    await readyKill(f)
    assert.match(await f.run('讨伐世界boss', 'p1'), /今日新增奖励1\/3/)
    await f.service.wipeUserData('p1')
    assert.equal((await f.database.get('xiuxian_boss_account', { userId: 'p1' }))[0].kills, 1)
    await f.database.create('xiuxian_player', { userId: 'p1', platform: 'webridge', uid: 82, level: '筑基境中期', createTime: new Date(f.clock.now), exp: 8000, hp: 4000, atk: 1e9 })
    assert.match(await f.run('讨伐兑换 药材 3001 3001 3002', 'p1'), /不同的/)
    assert.match(await f.run('讨伐兑换 功法 999999', 'p1'), /未扣功勋/)
    assert.match(await f.run('讨伐兑换 功法 9011', 'p1'), /兑换成功/)
    assert.equal((await f.service.getBackItem('p1', 9011)).bindNum, 1)
    assert.match(await f.run('讨伐兑换 神通 8101', 'p1'), /本周/)
    f.clock.now = Date.UTC(2026, 10, 1, 16)
    assert.match(await f.run('讨伐兑换 神通 8101', 'p1'), /兑换成功/)
    assert.match(await f.run('讨伐兑换 药材 3001 3002 3003', 'p1'), /兑换成功/)
    assert.equal((await f.service.getBackItem('p1', 3001)).bindNum, 3)
  } finally { await f.app.stop() }
})

test('PostgreSQL 两群同时击杀共享最后一个计奖额度，重复消息兑换不重复扣费', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture('', 2)
  try {
    await f.database.create('xiuxian_boss_account', { platform: 'webridge', userId: 'p1', day: rewards.rewardDay(f.clock.now), kills: 2, merit: 90 })
    await readyKill(f); await readyKill(f, 'other@chatroom')
    const replies = await Promise.all([f.run('讨伐世界boss', 'p1'), f.run('讨伐世界boss', 'p1', 'other@chatroom')])
    assert.equal(replies.filter(x => x.includes('3次已用完')).length, 1)
    let [a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' }); assert.equal(a.kills, 3); assert.equal(a.merit, 111)
    const session = () => f.app.bots[0].session({ type: 'message', user: { id: 'p1' }, guild: { id: 'boss@chatroom' }, channel: { id: 'boss@chatroom', type: 0 }, message: { id: 'repeat-exchange' } })
    await Promise.all([session().execute('讨伐兑换 药材 3001 3002 3003', true), session().execute('讨伐兑换 药材 3001 3002 3003', true)])
    ;[a] = await f.database.get('xiuxian_boss_account', { userId: 'p1' }); assert.equal(a.merit, 81)
    assert.equal((await f.service.getBackItem('p1', 3001)).goodsNum, 3)
  } finally { await f.app.stop() }
})

test('PostgreSQL 首次并发读取战斗buff只建一行，不覆盖已有功法', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture('', 2)
  try {
    for (let i = 0; i < 3; i++) {
      await f.database.remove('xiuxian_buff', { userId: 'p1' })
      const records = await Promise.all(Array.from({ length: 12 }, () => f.service.getBuff('p1')))
      assert.ok(records.every(x => x.userId === 'p1'))
      assert.equal((await f.database.get('xiuxian_buff', { userId: 'p1' })).length, 1)
      await f.service.setMainBuff('p1', 9011)
      assert.ok((await Promise.all(Array.from({ length: 12 }, () => f.service.getBuff('p1')))).every(x => x.mainBuff === 9011))
    }
  } finally { await f.app.stop() }
})

test('PostgreSQL 从缺少新字段的旧表升级，存活Boss与伤害保留且奖励版本默认为旧版', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const old = await fixture('', 1)
  let upgraded: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    await old.run('创建世界boss'); await old.run('讨伐世界boss', 'p1')
    const boss = await old.boss(), [participation] = await old.database.get('xiuxian_boss_participant', {})
    const driver = old.database.getDriver('xiuxian_boss')
    // 仅在上方校验过名称的临时测试数据库中还原旧列结构。
    await driver.query('ALTER TABLE "xiuxian_boss" DROP COLUMN "rewardVersion"')
    await driver.query('ALTER TABLE "xiuxian_boss_participant" DROP COLUMN "character", DROP COLUMN "rewardLevel", DROP COLUMN "effectiveAttacks"')
    await old.app.stop()
    upgraded = await fixture('', 2, () => 0.99, true)
    const live = await upgraded.boss(), [record] = await upgraded.database.get('xiuxian_boss_participant', { bossId: boss.id })
    assert.equal(live.rewardVersion, 1); assert.equal(live.hp, boss.hp); assert.equal(live.maxHp, boss.maxHp)
    assert.equal(record.damage, participation.damage); assert.equal(+record.lastAttackAt, +participation.lastAttackAt)
    await upgraded.run('创建世界boss', 'admin', 'new@chatroom')
    assert.equal((await upgraded.database.get('xiuxian_boss', { channelId: 'new@chatroom' }))[0].rewardVersion, 2)
  } finally { await upgraded?.app.stop(); await old.app.stop() }
})

test('群内实际输入：空格、boos拼写、小时单位及状态入口均识别，权限和群过滤保留', async () => {
  const f = await fixture()
  try {
    assert.match(await f.message('启动世界 boss 3'), /每3小时一只[\s\S]*现世/)
    const id = (await f.boss()).id
    assert.match(await f.message('启动世界boos 3'), /每3小时[\s\S]*仍在/)
    assert.equal((await f.boss()).id, id)
    assert.match(await f.message('世界BOSs'), /世界BOSS.*编号/)
    assert.match(await f.message('世界 boss 帮助'), /世界BOSS帮助/)
    assert.match(await f.message('讨伐世界 BOOS', 'p1'), /本次伤害/)
    assert.match(await f.message('停止世界boos', 'p1'), /权限不足/)
    assert.equal((await f.database.get('xiuxian_boss_schedule', {})).length, 1)
    assert.match(await f.message('停止世界boos'), /已关闭/)
    assert.match(await f.run('启动世界boss 3小时'), /每3小时[\s\S]*仍在/)
    assert.match(await f.message('启动 世界 BOSS 3 小时'), /每3小时[\s\S]*仍在/)
    for (const value of ['3.5小时', '0小时', '73小时', '3 明天']) assert.match(await f.run('启动世界boss ' + value), /1～72/)
    f.blocked.add('boss@chatroom')
    assert.equal(await f.message('世界 boss'), '')
    assert.match(await f.message('启动世界 boos 3'), /本群未启用修仙/)
    assert.equal(await f.message('今天世界 boss 好难打'), '')
  } finally { await f.app.stop() }
})

test('世界Boss输入兼容保留指令前缀约束，不执行普通聊天或重复注册', async () => {
  const f = await fixture('!')
  try {
    assert.equal(await f.message('启动世界 boss 3'), '')
    assert.equal(await f.boss(), undefined)
    assert.match(await f.message('!启动世界 boss 3小时'), /已开启/)
    assert.match(await f.message('!世界 boss'), /世界BOSS.*编号/)
    const id = (await f.boss()).id
    await f.reload()
    assert.match(await f.message('!停止世界 boos'), /已关闭/)
    assert.equal((await f.boss()).id, id)
  } finally { await f.app.stop() }
})

test('夜间顺延和奖励分配的边界', () => {
  assert.equal(formatBossPercent(702303, 4682025), '15.0%', '达到整数伤害上限时不再误显示14.9%')
  assert.equal(formatBossPercent(0, 0), '0.0%')
  assert.equal(deferQuiet(Date.UTC(2026, 9, 31, 17, 0)), Date.UTC(2026, 10, 1, 0, 0), '01:00 顺延到当天 08:00')
  assert.equal(deferQuiet(Date.UTC(2026, 9, 31, 15, 59)), Date.UTC(2026, 9, 31, 15, 59), '23:59 不顺延')
  assert.equal(deferQuiet(Date.UTC(2026, 10, 1, 0, 0)), Date.UTC(2026, 10, 1, 0, 0), '08:00 不顺延')
  const boss = { maxHp: 1000, expReward: 1000, stone: 1000, headcount: 5 }
  const shares = allocate(boss, [{ userId: 'a', damage: 900 }, { userId: 'b', damage: 1 }, { userId: 'c', damage: 0 }, { userId: 'k', damage: 99 }], 'kill', 'k')
  const by = Object.fromEntries(shares.map((s: any) => [s.userId, s]))
  assert.equal(by.a.exp, 300, '单人封顶 30%')
  assert.equal(by.b.exp, 40, '保底人均的 20%')
  assert.equal(by.c, undefined, '零伤害不分奖')
  assert.equal(by.k.exp, 99)
  assert.equal(by.k.stone, 99 + 100, '最后一击加奖池 10% 灵石')
  const escaped = allocate(boss, [{ userId: 'a', damage: 500 }], 'escape')
  assert.equal(escaped[0].exp, 150, '逃走减半后再封顶')
  assert.equal(escaped[0].lastHit, false)
})

test('启动按本群活跃玩家中位数生成，只限管理员，重复启动只改间隔', async () => {
  const f = await fixture()
  try {
    assert.doesNotMatch(await f.run('启动世界boss', 'p1'), /已开启/)
    assert.match(await f.run('启动世界boss 0'), /1～72/)
    assert.match(await f.run('启动世界boss'), /每6小时一只[\s\S]*现世/)
    const boss = await f.boss()
    assert.equal(boss.strength, 3000)
    assert.equal(boss.headcount, 5)
    assert.equal(boss.maxHp, 3000 * 5 * 1.5)
    assert.equal(boss.atk, 300)
    assert.equal(boss.expReward, 750)
    assert.equal(boss.stone, 450)
    assert.equal(+boss.expireAt, NOON + 6 * HOUR)
    assert.match(await f.run('创建世界boss'), /已有世界BOSS存活/)
    assert.match(await f.run('启动世界boss 12'), /每12小时[\s\S]*仍在/)
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 1)
    assert.match(await f.run('停止世界boss'), /已关闭[\s\S]*仍可讨伐/)
    assert.match(await f.run('停止世界boss'), /未开启/)
  } finally { await f.app.stop() }
})

test('单次伤害封顶 15%，30 分钟冷却，打不过时不受封顶提示', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('讨伐世界boss', 'p1'), /暂无世界BOSS/)
    await f.run('创建世界boss')
    const cap = Math.floor((await f.boss()).maxHp * 0.15)
    assert.match(await f.run('讨伐世界boss', 'p1'), /负伤暂退[\s\S]*30分钟后可再次讨伐/)
    assert.equal((await f.boss()).hp, (await f.boss()).maxHp - cap)
    assert.match(await f.run('讨伐世界boss', 'p1'), /30分钟后再战/)
    f.clock.now += 29 * 60_000
    assert.match(await f.run('讨伐世界boss', 'p1'), /1分钟后再战/)
    f.clock.now += 60_000
    assert.match(await f.run('讨伐世界boss', 'p1'), /累计伤害/)
    const [row] = await f.database.get('xiuxian_boss_participant', { userId: 'p1' })
    assert.equal(row.damage, cap * 2)
    // 攻击力 1 的玩家必败，伤害远小于封顶
    await f.database.set('xiuxian_player', { userId: 'p2' }, { atk: 1 })
    assert.match(await f.run('讨伐世界boss', 'p2'), /败下阵来/)
    assert.match(await f.run('查看世界boss', 'p1'), /伤害排行[\s\S]*p1[\s\S]*道友累计伤害/)
    assert.match(await f.run(`讨伐世界boss ${(await f.boss()).id + 1}`, 'p3'), /当前为编号/)
  } finally { await f.app.stop() }
})

test('击杀按伤害分奖，伤害第一拿战利品，最后一击加灵石，结算后 Boss 删除', async () => {
  const f = await fixture()
  try {
    await f.run('创建世界boss')
    const boss = await f.boss()
    // 伤害：p2 60%、p3 0.1%；剩余气血让 p1 一击击杀
    await f.database.create('xiuxian_boss_participant', { bossId: boss.id, userId: 'p2', platform: 'webridge', damage: boss.maxHp * 0.6 })
    await f.database.create('xiuxian_boss_participant', { bossId: boss.id, userId: 'p3', platform: 'webridge', damage: boss.maxHp * 0.001 })
    await f.database.set('xiuxian_boss', { id: boss.id }, { hp: 500 })
    const before = { p1: await f.exp('p1'), p2: await f.exp('p2'), p3: await f.exp('p3') }
    const reply = await f.run('讨伐世界boss', 'p1')
    assert.match(reply, /已被讨伐！3位道友[\s\S]*1\. 道友p2[\s\S]*最后一击/)
    assert.equal(await f.exp('p2') - before.p2, Math.floor(750 * 0.3), 'p2 封顶 30%')
    assert.equal(await f.exp('p3') - before.p3, Math.floor(750 / 5 * 0.2), 'p3 拿保底')
    assert.equal(await f.exp('p1') - before.p1, Math.floor(Math.max(750 * 500 / boss.maxHp, 750 / 5 * 0.2)))
    assert.equal(await f.wallet('p1'), Math.floor(450 / 5 * 0.2) + Math.floor(450 * 0.1))
    assert.equal(await f.wallet('p2'), Math.floor(450 * 0.3))
    // 只有 p2 伤害占比 ≥5%，两件战利品都归 p2
    const loot = (await f.database.get('xiuxian_back', { userId: 'p2' })).reduce((n: number, b: any) => n + b.goodsNum, 0)
    assert.equal(loot, 2)
    assert.equal((await f.database.get('xiuxian_back', { userId: 'p3' })).length, 0)
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 0)
    assert.equal((await f.database.get('xiuxian_boss_participant', {})).length, 0)
    assert.match(await f.run('讨伐世界boss', 'p4'), /暂无世界BOSS/)
  } finally { await f.app.stop() }
})

test('到期遁走按一半发奖并推送，随后刷新下一只；遁走时间避开夜间', async () => {
  const f = await fixture()
  try {
    f.clock.now = NOON + 8 * HOUR // 20:00 启动，6 小时后是 02:00，应顺延到 08:00
    await f.run('启动世界boss')
    const first = await f.boss()
    assert.equal(+first.expireAt, NOON + 20 * HOUR)
    await f.run('讨伐世界boss', 'p1')
    const before = await f.exp('p1')
    f.clock.now = NOON + 14 * HOUR // 02:00 夜间不处理
    await f.api().tick()
    assert.equal((await f.boss()).id, first.id)
    assert.equal(sent.length, 0)
    f.clock.now = NOON + 20 * HOUR // 08:00
    await f.api().tick()
    assert.equal(sent.length, 2)
    assert.equal(sent[0].channelId, 'boss@chatroom')
    assert.match(sent[0].content, /已遁走！1位道友[\s\S]*p1/)
    assert.match(sent[1].content, /现世/)
    assert.equal(await f.exp('p1') - before, Math.floor(Math.max(750 * 0.5 * 0.15, 750 * 0.5 / 5 * 0.2)))
    const second = await f.boss()
    assert.notEqual(second.id, first.id)
    assert.equal(+second.expireAt, NOON + 26 * HOUR)
    assert.equal(+(await f.database.get('xiuxian_boss_schedule', {}))[0].nextSpawnAt, NOON + 26 * HOUR)
    await f.api().tick()
    assert.equal(sent.length, 2, '同一时刻重复检查不会重复刷新')
  } finally { await f.app.stop() }
})

test('停机错过多次刷新只补一只；无人讨伐的遁走也会推送', async () => {
  const f = await fixture()
  try {
    await f.run('启动世界boss')
    f.clock.now = NOON + 72 * HOUR
    await f.api().tick()
    assert.match(sent[0].content, /无人讨伐，已遁走/)
    assert.equal(sent.length, 2)
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 1)
    assert.equal(+(await f.database.get('xiuxian_boss_schedule', {}))[0].nextSpawnAt, NOON + 78 * HOUR)
  } finally { await f.app.stop() }
})

test('启动时删除旧版 Boss 及其参与记录，不发奖', async () => {
  const f = await fixture()
  try {
    await f.run('创建世界boss')
    const kept = await f.boss()
    const legacy = await f.database.create('xiuxian_boss', { channelId: 'boss@chatroom', name: '旧妖', level: '江湖好手', hp: 1e9, maxHp: 1e9, atk: 1, stone: 1, expReward: 1 })
    await f.database.create('xiuxian_boss_participant', { bossId: legacy.id, userId: 'p1', platform: 'webridge', damage: 1e8 })
    await f.database.create('xiuxian_boss_participant', { bossId: kept.id, userId: 'p2', platform: 'webridge', damage: 1 })
    const before = await f.exp('p1')
    await f.reload()
    assert.deepEqual((await f.database.get('xiuxian_boss', {})).map((b: any) => b.id), [kept.id])
    assert.deepEqual((await f.database.get('xiuxian_boss_participant', {})).map((p: any) => p.userId), ['p2'])
    assert.equal(await f.exp('p1'), before)
  } finally { await f.app.stop() }
})

test('PostgreSQL 并发讨伐只击杀和结算一次', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await f.run('创建世界boss')
    await f.database.set('xiuxian_boss', {}, { hp: 10 })
    const before = await f.exp('p1') + await f.exp('p2')
    const replies = await Promise.all([f.run('讨伐世界boss', 'p1'), f.run('讨伐世界boss', 'p2')])
    assert.equal(replies.filter(r => r.includes('终斩')).length, 1)
    assert.equal(replies.filter(r => r.includes('被讨伐或遁走')).length, 1)
    assert.ok(await f.exp('p1') + await f.exp('p2') - before <= 750)
  } finally { await f.app.stop() }
})

test('规则常量与确认方案一致', () => {
  assert.equal(RULES.attackCooldownMs, 30 * 60_000)
  assert.equal(RULES.defaultHours, 6)
  assert.equal(RULES.quietEndHour, 8)
})

test('大量微量伤害参与者的保底不会超发奖池', () => {
  const boss = { maxHp: 10000, expReward: 1000, stone: 1000, headcount: 3 }
  const rows = [{ userId: 'main', damage: 9900 }, ...Array.from({ length: 100 }, (_, i) => ({ userId: 'small' + i, damage: 1 }))]
  for (const outcome of ['kill', 'escape'] as const) {
    const shares = allocate(boss, rows, outcome, outcome === 'kill' ? 'main' : undefined)
    assert.ok(shares.reduce((n: number, s: any) => n + s.exp, 0) <= (outcome === 'kill' ? 1000 : 500))
    assert.ok(shares.reduce((n: number, s: any) => n + s.stone, 0) <= (outcome === 'kill' ? 1100 : 500))
  }
})

test('白名单移除后定时器停止刷新和推送，管理员也不能在禁用群启动', async () => {
  const f = await fixture()
  try {
    await f.run('启动世界boss')
    const first = await f.boss()
    f.blocked.add('boss@chatroom')
    f.clock.now += 6 * HOUR
    await f.api().tick()
    assert.equal((await f.boss()).id, first.id)
    assert.equal(sent.length, 0)
    assert.match(await f.run('启动世界boss'), /本群未启用修仙/)
    f.blocked.clear()
    await f.api().tick()
    assert.notEqual((await f.boss()).id, first.id)
    assert.equal(sent.length, 2)
  } finally { await f.app.stop() }
})

test('接近余额上限的奖励只入账可存部分，不阻塞其他人结算', async () => {
  const f = await fixture()
  try {
    await f.run('创建世界boss')
    const boss = await f.boss()
    await f.database.create('xiuxian_boss_participant', { bossId: boss.id, userId: 'p2', platform: 'webridge', damage: boss.maxHp * 0.6 })
    await f.database.set('monetary', { uid: 83 }, { value: 2147483646 })
    await f.database.set('xiuxian_boss', { id: boss.id }, { hp: 10 })
    assert.match(await f.run('讨伐世界boss', 'p1'), /余额上限/)
    assert.equal(await f.wallet('p2'), 2147483647)
    assert.ok(await f.wallet('p1') > 0)
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 0)
  } finally { await f.app.stop() }
})

test('发奖中途失败回滚气血、伤害、奖励及Boss删除，下次可重试', async () => {
  const f = await fixture()
  try {
    await f.run('创建世界boss')
    const boss = await f.boss(), before = await f.service.getPlayer('p1')
    await f.database.set('xiuxian_boss', { id: boss.id }, { hp: 10 })
    const proto = Object.getPrototypeOf(f.service), gain = proto.gainStoneForUser
    proto.gainStoneForUser = async () => { throw new Error('模拟发奖失败') }
    try { await f.run('讨伐世界boss', 'p1') } finally { proto.gainStoneForUser = gain }
    assert.equal((await f.boss()).hp, 10)
    assert.deepEqual(await f.service.getPlayer('p1'), before)
    assert.equal(await f.wallet('p1'), 0)
    assert.equal((await f.database.get('xiuxian_boss_participant', {})).length, 0)
    assert.match(await f.run('讨伐世界boss', 'p1'), /终斩/)
  } finally { await f.app.stop() }
})

test('创建Boss与保存刷新计划共用事务，计划写入失败不遗留Boss', async () => {
  const f = await fixture(), transact = f.database.transact.bind(f.database)
  try {
    f.database.transact = (cb: Function) => transact((db: any) => cb(new Proxy(db, {
      get(target, key) {
        if (key === 'upsert') return (table: string, ...args: any[]) => {
          if (table === 'xiuxian_boss_schedule') throw new Error('模拟计划写入失败')
          return target.upsert(table, ...args)
        }
        return Reflect.get(target, key, target)
      },
    })))
    await f.run('启动世界boss')
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 0)
    assert.equal((await f.database.get('xiuxian_boss_schedule', {})).length, 0)
  } finally { f.database.transact = transact; await f.app.stop() }
})

test('PostgreSQL 管理员与定时器并发刷新只生成一只，关闭后不重建计划', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await Promise.all([f.run('启动世界boss'), f.run('创建世界boss'), f.run('启动世界boss 12')])
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 1)
    await f.database.remove('xiuxian_boss', {})
    await f.database.set('xiuxian_boss_schedule', {}, { nextSpawnAt: new Date(f.clock.now - 1) })
    await Promise.all([f.api().tick(), f.run('创建世界boss')])
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 1)
    await Promise.all([f.api().tick(), f.run('停止世界boss')])
    assert.equal((await f.database.get('xiuxian_boss_schedule', {})).length, 0)
  } finally { await f.app.stop() }
})

test('PostgreSQL 两群由不同玩家同时击杀可完成，不因玩家锁顺序死锁', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    for (const guild of ['boss@chatroom', 'other@chatroom']) await f.run('创建世界boss', 'admin', guild)
    const bosses = await f.database.get('xiuxian_boss', {})
    for (const boss of bosses) {
      for (const userId of ['p1', 'p2']) await f.database.create('xiuxian_boss_participant', { bossId: boss.id, userId, platform: 'webridge', damage: 100 })
      await f.database.set('xiuxian_boss', { id: boss.id }, { hp: 10 })
    }
    const replies = await Promise.all([f.run('讨伐世界boss', 'p2'), f.run('讨伐世界boss', 'p1', 'other@chatroom')])
    assert.equal(replies.filter(r => r.includes('终斩')).length, 2)
    assert.equal((await f.database.get('xiuxian_boss', {})).length, 0)
  } finally { await f.app.stop() }
})
