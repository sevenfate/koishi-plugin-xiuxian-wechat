import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename), root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const load = (name: string) => require(resolve(root, 'lib', name + '.js'))
const { applyEndlessTower, towerEnemy, towerRewards, TOWER } = load('endless-tower')
const { XiuxianService } = load('service'), { applyExercises } = load('modules/exercises')
const realDeps = { ...load('utils'), ...load('combat-stats'), ...load('skills') }
class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  deviceAccountId = 'tower-bot'
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async getGuildMember(_guild: string, id: string) { return { user: { id }, nick: '道友' + id } }
  async sendMessage(): Promise<string[]> { throw Error('测试不可发送群消息') }
}

async function fixture() {
  const app = new App(), pg = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pg && !/^xiuxian_economy_test_/.test(pg.database)) throw Error('仅允许隔离测试库')
  const driver = require(pg ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pg || { path: ':memory:' }); app.provide('monetary', {}); app.plugin(TestBot)
  const state = { time: Date.UTC(2026, 10, 1, 14), calls: 0, advanceMs: 0, mode: 'win', failFloor: 0, blocked: false, pause: undefined as undefined | (() => Promise<void>), frames: [] as any[] }
  const deps = { ...realDeps, playerFight(fighter: any, enemy: any, data: any) {
    state.calls++; state.time += state.advanceMs; state.frames.push({ fighter: { ...fighter }, enemy: { ...enemy } })
    if (state.mode === 'real') return realDeps.playerFight(fighter, enemy, data)
    const win = state.mode !== 'timeout' && Number(enemy.userId.split('-')[1]) !== state.failFloor
    return [['模拟战斗', '道友胜'], '道友', { [fighter.userId]: fighter.hp, [enemy.userId]: win ? 0 : enemy.hp }, fighter.userId]
  }, async buildFighter(srv: any, id: string) {
    if (state.pause) await state.pause()
    return realDeps.buildFighter(srv, id)
  } }
  let reload: () => Promise<void>, api: any
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    // 重入会清理其他玩法表，这里只需注册其删除条件用到的列。
    for (const table of ['xiuxian_work','xiuxian_boss_participant','xiuxian_bank','xiuxian_plot']) ctx.model.extend(table as any, { userId: 'string' }, { primary: 'userId' })
    ctx.plugin(XiuxianService, { currency: 'default', remakeCost: 10 })
    ctx.inject(['xiuxian' as any], scope => {
      applyExercises(scope, {})
      const register = (ctx: any) => { api = applyEndlessTower(ctx.intersect((s: any) => !state.blocked && s.guildId !== 'blocked'), deps, { now: () => state.time }) }
      let fork = scope.plugin(register)
      reload = async () => { await fork.dispose(); fork = scope.plugin(register); await app.lifecycle.flush() }
    })
  })
  await app.start()
  const db: any = app.database, srv: any = (app as any).xiuxian
  if (pg) for (const table of ['binding','user','monetary','xiuxian_player','xiuxian_back','xiuxian_buff','xiuxian_skill','xiuxian_exercises','xiuxian_sign','xiuxian_tower','xiuxian_tower_reward','xiuxian_tower_request','xiuxian_tower_member']) await db.remove(table, {})
  for (const [i, id] of ['one','two'].entries()) {
    await db.create('user', { id: 151 + i, authority: 1, name: id })
    await db.create('binding', { aid: 151 + i, bid: 151 + i, pid: id, platform: 'webridge' })
    await db.create('xiuxian_player', { userId: id, uid: 151 + i, platform: 'webridge', userName: '道友' + id, exp: 10000, atk: 1000, hp: 0, mp: 0 })
    await db.create('monetary', { uid: 151 + i, currency: 'default', value: 1000 })
  }
  let seq = 0
  return { app, db, srv, state, api: () => api, reload: () => reload(), async run(command: string, user = 'one', guild = 'tower@chatroom', messageId?: string) {
    const session = app.bots[0].session({ type: 'message', timestamp: state.time, user: { id: user }, guild: { id: guild }, channel: { id: guild, type: 0 }, message: { id: messageId || String(++seq) } })
    return String(await session.execute(command, true))
  }, async progress(id = 'one') { return (await db.get('xiuxian_tower', { userId: id }))[0]?.floor || 0 },
  async next(command = '连闯无尽塔 10', id = 'one', guild = 'tower@chatroom') { state.time += 6000; return this.run(command, id, guild) },
  }
}

test('全1000层守卫强度有界且固定，全部200个奖励节点配置有效、确定且不含虚构物品', () => {
  const data = new (load('data').GameData)()
  let previous = 0, materials = 0, pills = 0, books = 0
  for (let f = 1; f <= TOWER.floors; f++) {
    const enemy = towerEnemy(data, f)
    assert.deepEqual(enemy, towerEnemy(data, f))
    assert.ok(enemy.hp > 0 && enemy.atk > 0 && enemy.hp <= TOWER.maxStat)
    // 三类守卫侧重不同，比较每60层同类型的境界锚点。
    if (f % 60 === 1) { assert.ok(enemy.hp > previous); previous = enemy.hp }
    const items = towerRewards(data, f)
    if (f % 5) assert.equal(items.length, 0)
    else {
      assert.deepEqual(items, towerRewards(data, f)); assert.ok(items.length >= 3)
      for (const x of items) {
        assert.ok(data.getItem(x.id)); assert.ok(x.count >= 1 && x.count <= 2)
        if (x.type === '药材') materials += x.count
        else if (x.type === '丹药') pills += x.count
        else books += x.count
      }
    }
  }
  assert.equal(materials, 1200); assert.equal(pills, 100); assert.equal(books, 20)
  assert.throws(() => towerEnemy(data, Infinity)); assert.throws(() => towerEnemy(data, 0))
})

test('真实服务快照满状态连闯、奖励绑定，查询与重复消息不发奖，冷却和上限生效', async () => {
  const f = await fixture()
  try {
    const player = await f.srv.getPlayer('one'), money = await f.db.get('monetary', {})
    assert.match(await f.run('无尽塔'), /最高通关：0层/)
    assert.match(await f.run('无尽塔奖励 10'), /未解锁/)
    assert.match(await f.run('连闯无尽塔 10', 'one', 'tower@chatroom', 'unique'), /共10层[\s\S]*第5层首通[\s\S]*第10层首通/)
    assert.equal(await f.progress(), 10); assert.equal(f.state.calls, 10)
    assert.ok(f.state.frames.every(x => x.fighter.hp === 5000 && x.fighter.mp === 10000))
    const backs = await f.db.get('xiuxian_back', { userId: 'one' })
    assert.equal(backs.reduce((sum: number, x: any) => sum + x.goodsNum, 0), 13)
    assert.ok(backs.every((x: any) => x.bindNum === x.goodsNum))
    assert.deepEqual(await f.srv.getPlayer('one'), player)
    assert.deepEqual(await f.db.get('monetary', {}), money)
    const reply = await f.run('连闯无尽塔 10', 'one', 'tower@chatroom', 'unique')
    assert.match(reply, /共10层/); assert.equal(f.state.calls, 10)
    assert.match(await f.run('挑战无尽塔'), /5秒后再试/)
    assert.match(await f.run('无尽塔奖励 10'), /已到账/)
    assert.match(await f.run('无尽塔奖励 7'), /5的倍数/)
    assert.match(await f.run('连闯无尽塔 11'), /1～10/)
    assert.equal(await f.progress(), 10)
    assert.deepEqual(await f.db.get('xiuxian_back', { userId: 'one' }), backs)
    await f.reload(); assert.match(await f.run('无尽塔'), /最高通关：10层/)
    assert.match(await f.run('无尽塔战报'), /第10层/)
  } finally { await f.app.stop() }
})

test('战败保留本次之前已通过层；超时按血量判胜也不能过关；跨群、跨账号战报隔离', async () => {
  const f = await fixture()
  try {
    f.state.failFloor = 7
    assert.match(await f.run('连闯无尽塔 10'), /共6层[\s\S]*第7层挑战失败/)
    assert.equal(await f.progress(), 6)
    assert.equal((await f.db.get('xiuxian_tower_reward', {})).length, 1)
    f.state.mode = 'timeout'
    assert.match(await f.next('挑战无尽塔'), /第7层挑战失败/)
    assert.equal(await f.progress(), 6)
    assert.match(await f.run('无尽塔', 'one', 'another@chatroom'), /最高通关：6层/)
    assert.match(await f.run('无尽塔战报', 'one', 'another@chatroom'), /暂无本人/)
    assert.match(await f.run('无尽塔战报', 'two'), /暂无本人/)
    ;(f.app.bots[0] as TestBot).deviceAccountId = 'other-bot'
    assert.match(await f.run('无尽塔战报'), /暂无本人/)
  } finally { await f.app.stop() }
})

test('结算中发奖失败回滚整次连闯、奖励流水和背包，重试只发一次', async () => {
  const f = await fixture()
  try {
    const proto = Object.getPrototypeOf(f.srv), original = proto.sendBack
    let calls = 0
    proto.sendBack = async function (...args: any[]) { if (++calls === 2) throw Error('测试物品入库故障'); return original.apply(this, args) }
    try { assert.match(await f.run('连闯无尽塔 10'), /本次进度与奖励均未保存/) }
    finally { proto.sendBack = original }
    assert.equal(await f.progress(), 0)
    for (const table of ['xiuxian_tower_reward','xiuxian_tower_request','xiuxian_back']) assert.equal((await f.db.get(table, {})).length, 0)
    assert.match(await f.run('连闯无尽塔 10'), /共10层/)
    assert.equal((await f.db.get('xiuxian_tower_reward', {})).length, 2)
  } finally { await f.app.stop() }
})

test('重入与角色删除保留账号塔进度和奖励，不可通过重建或换群再次领取', async () => {
  const f = await fixture()
  try {
    await f.run('连闯无尽塔 10')
    assert.match(await f.srv.wipeAndRemake('one','webridge'), /逆天改命/)
    assert.match(await f.run('挑战无尽塔'), /没有道友/)
    await f.db.create('xiuxian_player', { userId: 'one', platform: 'webridge', userName: '新道号', exp: 10000, atk: 1000 })
    assert.match(await f.run('无尽塔'), /最高通关：10层/)
    assert.match(await f.run('无尽塔奖励 10'), /已到账/)
    await f.next('挑战无尽塔','one','another@chatroom')
    assert.equal(await f.progress(), 11)
    assert.equal((await f.db.get('xiuxian_back', { userId: 'one' })).length, 0)
    assert.equal((await f.db.get('xiuxian_tower_reward', { userId: 'one' })).length, 2)
  } finally { await f.app.stop() }
})

test('排行只列本群和当前机器人参与者；群过滤禁用与私人消息不执行挑战', async () => {
  const f = await fixture()
  try {
    await f.run('连闯无尽塔 10','one','group-a')
    await f.run('挑战无尽塔','two','group-b')
    const a = await f.run('无尽塔排行榜','one','group-a')
    assert.match(a, /道友one：10层/); assert.doesNotMatch(a, /道友two/)
    assert.match(await f.run('无尽塔排行榜','one','group-b'), /道友two：1层/)
    ;(f.app.bots[0] as TestBot).deviceAccountId = 'other-bot'
    assert.match(await f.run('无尽塔排行榜','one','group-a'), /暂无无尽塔挑战记录/)
    assert.equal(await f.run('挑战无尽塔','one','blocked'), '')
    assert.match(await f.run('挑战无尽塔','one',''), /群内使用/)
    assert.equal(await f.progress(), 10)
  } finally { await f.app.stop() }
})

test('等待期间停用群时不推进或发奖', async () => {
  const f = await fixture()
  try {
    f.state.pause = async () => { f.state.blocked = true }
    assert.match(await f.run('连闯无尽塔 10'), /均未保存/)
    assert.equal(await f.progress(), 0)
    assert.equal((await f.db.get('xiuxian_back', {})).length, 0)
  } finally { await f.app.stop() }
})

test('真实战斗的养成进步能跨越卡层，功法与装备加成进入快照且不改变现实状态', async () => {
  const f = await fixture(), random = Math.random
  try {
    Math.random = () => 0.5
    f.state.mode = 'real'
    await f.db.set('xiuxian_player', { userId: 'one' }, { exp: 100, atk: 10, hp: 0, mp: 0 })
    for (let i = 0; i < 5; i++) {
      const before = await f.progress(); await f.next()
      if (await f.progress() === before) break
    }
    const low = await f.progress()
    assert.ok(low > 0 && low < 50)
    await f.srv.learnSkill('one', 9001, '功法')
    const weapon = Object.entries(f.srv.data.getItemsByType(['法器'])).find(([, x]: any) => x.atk_buff > 0) as any
    await f.srv.sendBack('one', Number(weapon[0]), weapon[1].name, '法器', 1)
    await f.db.set('xiuxian_back', { userId: 'one', goodsId: Number(weapon[0]) }, { state: 1 })
    await f.db.set('xiuxian_player', { userId: 'one' }, { exp: 10000, atk: 1000 })
    const player = await f.srv.getPlayer('one')
    assert.match(await f.next(), /共10层/)
    assert.equal(await f.progress(), low + 10)
    const frame = f.state.frames.at(-1).fighter
    assert.equal(frame.hp, 5150); assert.equal(frame.mp, 10200)
    assert.ok(frame.atk > 1030, '装备和功法同时生效')
    assert.deepEqual(await f.srv.getPlayer('one'), player)
  } finally { Math.random = random; await f.app.stop() }
})

test('PostgreSQL 两个独立插件作用域同时跨群挑战只推进一次；与重入共用账号锁', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    const ctx: any = f.app, service = f.srv
    const makeSession = (id: string) => f.app.bots[0].session({ type: 'message', timestamp: f.state.time, user: { id: 'one' }, guild: { id }, channel: { id, type: 0 }, message: { id: 'same-flight' } })
    // 两套处理器各有独立 running 集合，仅由数据库账号行锁和冷却保护。
    let second: any
    const fork = ctx.inject(['database', 'xiuxian'], (ctx: any) => { second = applyEndlessTower(ctx, realDeps, { now: () => f.state.time }) })
    await f.app.lifecycle.flush()
    const first = f.api()
    const answers = await Promise.all([first.challenge(makeSession('a'), 10), second.challenge(makeSession('b'), 10)])
    assert.equal(answers.filter((x: string) => /共10层/.test(x)).length, 1)
    assert.equal(await f.progress(), 10)
    assert.equal((await f.db.get('xiuxian_tower_reward', {})).length, 2)
    f.state.time += 6000
    await Promise.all([first.challenge(makeSession('a'), 10), service.wipeAndRemake('one','webridge')])
    assert.equal(await service.getPlayer('one'), undefined)
    assert.ok([10,20].includes(await f.progress()))
    await fork.dispose()
  } finally { await f.app.stop() }
})

test('连闯结束明确区分批次数、战败与回合耗尽，战报不能显示虚假的胜利', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('连闯无尽塔 10'), /本次挑战已结束.*已完成本次10层/)
    assert.match(await f.run('无尽塔状态'), /当前没有正在执行的挑战.*上次结束原因：已完成本次10层/)
    assert.match(await f.next('连续推进 2'), /共2层/)
    f.state.mode = 'timeout'
    assert.match(await f.next('连闯无尽塔 10'), /第13层回合耗尽，连闯已结束.*守卫剩余气血/)
    const battle = await f.run('无尽塔战报')
    assert.match(battle, /已达战斗回合上限/); assert.doesNotMatch(battle, /道友胜/)
    assert.equal(await f.progress(), 12)
  } finally { await f.app.stop() }
})

test('正在处理时可查看阶段，重复连闯不启动第二份任务，完成后释放状态', async () => {
  const f = await fixture()
  let release!: () => void, started!: () => void
  const pendingGate = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  let pending: Promise<string> | undefined
  try {
    f.state.pause = async () => { started(); await pendingGate }
    pending = f.run('连闯无尽塔 10')
    await entered
    assert.match(await f.run('无尽塔状态'), /正在准备战斗.*无需重复发送/)
    assert.match(await f.run('连闯无尽塔 10'), /正在准备战斗/)
    assert.equal(f.state.calls, 0)
    release(); await pending
    assert.match(await f.run('无尽塔状态'), /当前没有正在执行的挑战/)
    assert.equal(await f.progress(), 10)
  } finally { release(); await pending; await f.app.stop() }
})

test('连闯时间预算结束保留已通层，整次处理过慢则回滚且不在后台继续发奖', async () => {
  const f = await fixture()
  try {
    f.state.advanceMs = 1000
    assert.match(await f.run('连闯无尽塔 10'), /共9层[\s\S]*达到本次连闯时间上限/)
    assert.equal(await f.progress(), 9)
    const inventory = await f.db.get('xiuxian_back', {})
    f.state.advanceMs = 0
    f.state.pause = async () => { f.state.time += TOWER.attemptMs + 1 }
    assert.match(await f.next(), /等待超时，已取消并回滚/)
    assert.equal(await f.progress(), 9)
    assert.deepEqual(await f.db.get('xiuxian_back', {}), inventory)
    assert.match(await f.run('无尽塔状态'), /当前没有正在执行的挑战/)
    f.state.pause = undefined
    assert.match(await f.next('挑战无尽塔'), /共1层/)
    assert.equal(await f.progress(), 10)
  } finally { await f.app.stop() }
})

test('PostgreSQL 账号行或角色行被锁时有界取消，不残留后台任务、进度或奖励，超时设置仅本事务有效', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture(), pg = JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG!)
  const sql = require('postgres')({ ...pg, max: 1 })
  try {
    await f.db.upsert('xiuxian_sign', [{ userId: 'one' }])
    for (const table of ['xiuxian_sign','xiuxian_player']) {
      let release!: () => void, signal!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const held = new Promise<void>(resolve => { signal = resolve })
      const block = sql.begin(async (tx: any) => {
        await tx.unsafe(table === 'xiuxian_sign' ? "UPDATE xiuxian_sign SET token=token WHERE \"userId\"='one'" : "UPDATE xiuxian_player SET exp=exp WHERE \"userId\"='one'")
        signal(); await gate
      })
      await held
      let pending: Promise<string> | undefined, timer: NodeJS.Timeout | undefined
      try {
        const started = Date.now()
        pending = f.run('连闯无尽塔 10')
        const reply = await Promise.race([pending, new Promise<string>((_, reject) => { timer = setTimeout(() => reject(Error('锁等待未按时取消')), 6000) })])
        assert.match(reply, /等待超时，已取消并回滚/)
        assert.ok(Date.now() - started < 6000)
        assert.equal(await f.progress(), 0)
        assert.equal((await f.db.get('xiuxian_tower_reward', {})).length, 0)
        assert.equal((await f.db.get('xiuxian_back', {})).length, 0)
        assert.match(await f.run('无尽塔状态'), /当前没有正在执行的挑战/)
      } finally { clearTimeout(timer); release(); await block; await pending }
    }
    await f.db.transact(async (db: any) => {
      await db.get('xiuxian_sign', { userId: 'one' })
      const [setting] = await db.getDriver('xiuxian_sign').query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")
      assert.equal(setting.lock, '0'); assert.equal(setting.statement, '0')
    })
    assert.match(await f.run('连闯无尽塔 10'), /共10层/)
    assert.equal(await f.progress(), 10)
    assert.equal((await f.db.get('xiuxian_tower_reward', {})).length, 2)
  } finally { await sql.end(); await f.app.stop() }
})
