import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { applyEndgame } = require(resolve(root, 'lib/modules/endgame.js'))
const { applySect } = require(resolve(root, 'lib/modules/sect.js'))
const { applyCultivate } = require(resolve(root, 'lib/modules/cultivate.js'))

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async sendMessage(): Promise<string[]> { throw new Error('离线测试不能发送消息') }
}

async function fixture() {
  const app = new App()
  const pgConfig = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pgConfig && !/^xiuxian_economy_test_/.test(pgConfig.database)) throw new Error('仅允许隔离测试数据库')
  const driver = require(pgConfig ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pgConfig || { path: ':memory:' })
  app.provide('monetary', {})
  app.plugin(TestBot)
  const config = { currency: 'default', closingExpUpperLimit: 1.5, closingExp: 30 }
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    ctx.plugin(XiuxianService, config)
    ctx.inject(['xiuxian' as any], scope => {
      applyEndgame(scope, config); applySect(scope, config); applyCultivate(scope, config)
    })
  })
  await app.start()
  const database: any = app.database, service: any = (app as any).xiuxian
  if (pgConfig) {
    for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_sect', 'xiuxian_cd', 'xiuxian_back', 'xiuxian_buff']) await database.remove(table, {})
  }
  await database.create('user', { id: 57, name: 'test', authority: 1 })
  await database.create('binding', { aid: 57, bid: 57, pid: 'test', platform: 'webridge' })
  await database.create('xiuxian_player', { userId: 'test', uid: 57, platform: 'webridge', userName: 'test', rootType: '真灵根', level: '筑基境中期', exp: 100, hp: 50, mp: 100, atk: 10, sectId: 1 })
  await database.create('xiuxian_sect', { sectId: 1, sectName: 'test', sectOwner: 'test' })
  await database.create('monetary', { uid: 57, currency: 'default', value: 1000 })
  return { app, database, service, async run(command: string) {
    const session = app.bots[0].session({ type: 'message', user: { id: 'test' }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 } })
    return String(await session.execute(command, true))
  }, async player() { return service.getPlayer('test') }, async wallet() { return service.getStoneForUser('test', 'webridge') } }
}

test('捐献再兑换不会增发灵石，默认数量和别名仍可使用', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('宗门捐献 100'), /捐献了100/)
    assert.equal(await f.wallet(), 900)
    assert.equal((await f.player()).sectContribution, 100)
    assert.match(await f.run('贡献兑换 灵石'), /获得灵石 10 枚/)
    assert.equal(await f.wallet(), 910)
    assert.equal((await f.player()).sectContribution, 0)
  } finally { await f.app.stop() }
})

test('修为兑换按十比一并按境界上限扣实际贡献，异常历史修为不再增长', async () => {
  const f = await fixture()
  try {
    const cap = f.service.data.closingMaxExp('筑基境中期', 1.5)
    await f.database.set('xiuxian_player', { userId: 'test' }, { exp: cap - 5, sectContribution: 1000 })
    assert.match(await f.run('宗门贡献兑换 修为 1000'), /消耗 50 贡献，获得修为 5/)
    assert.equal((await f.player()).exp, cap)
    assert.equal((await f.player()).sectContribution, 950)
    await f.database.set('xiuxian_player', { userId: 'test' }, { exp: 1156144770 })
    assert.match(await f.run('宗门贡献兑换 修为'), /已达当前境界修炼上限/)
    assert.equal((await f.player()).exp, 1156144770)
    assert.equal((await f.player()).sectContribution, 950)
  } finally { await f.app.stop() }
})

test('真实高修为战力可保存，出关恢复气血；失败结算回滚修为、状态和贡献', async () => {
  const f = await fixture()
  try {
    await f.database.set('xiuxian_player', { userId: 'test' }, { exp: 1156144770, hp: 0 })
    assert.match(await f.run('闭关'), /进入闭关/)
    assert.match(await f.run('出关'), /重伤已愈/)
    const player = await f.player()
    assert.equal(player.power, 2543518494)
    assert.equal(player.hp, 578072385)
    await f.database.set('xiuxian_player', { userId: 'test' }, { exp: 100, hp: 0, sectContribution: 100 })
    await f.run('闭关')
    await f.database.set('xiuxian_cd', { userId: 'test' }, { createTime: new Date(Date.now() - 600000) })
    const prototype = Object.getPrototypeOf(f.service)
    const updatePower = prototype.updatePower
    prototype.updatePower = async () => { throw new Error('模拟数据库写入失败') }
    try {
      assert.match(await f.run('出关'), /未知错误/)
      assert.equal((await f.player()).exp, 100)
      assert.equal((await f.service.getCd('test')).type, 1)
      assert.match(await f.run('宗门贡献兑换 修为 100'), /未知错误/)
      assert.equal((await f.player()).sectContribution, 100)
      assert.equal((await f.player()).exp, 100)
    } finally { prototype.updatePower = updatePower }
  } finally { await f.app.stop() }
})

test('钱包溢出、非法数量和超量丹药请求均不扣贡献', async () => {
  const f = await fixture()
  try {
    await f.database.set('xiuxian_player', { userId: 'test' }, { sectContribution: 1000000 })
    await f.database.set('monetary', { uid: 57, currency: 'default' }, { value: 2147483640 })
    assert.match(await f.run('宗门贡献兑换 灵石 100'), /钱包上限/)
    assert.match(await f.run('宗门贡献兑换 修为 -1'), /正整数/)
    assert.match(await f.run('宗门贡献兑换 丹药 101'), /最多兑换 100/)
    assert.equal((await f.player()).sectContribution, 1000000)
    assert.equal(await f.wallet(), 2147483640)
  } finally { await f.app.stop() }
})

test('捐献后续写入失败和丹药部分生成失败均回滚全部资源', async () => {
  const f = await fixture()
  try {
    await f.database.remove('xiuxian_sect', { sectId: 1 })
    assert.match(await f.run('宗门捐献 100'), /未知错误/)
    assert.equal(await f.wallet(), 1000)
    assert.equal((await f.player()).sectContribution, 0)
    await f.database.set('xiuxian_player', { userId: 'test' }, { sectContribution: 2000 })
    const data = f.service.data, original = data.randomItemIdByRank
    const [itemId] = data.findItemsByName('黄龙丹')[0]
    let calls = 0
    data.randomItemIdByRank = () => ++calls === 1 ? Number(itemId) : 0
    try { assert.match(await f.run('宗门贡献兑换 丹药 2'), /未知错误/) }
    finally { data.randomItemIdByRank = original }
    assert.equal((await f.player()).sectContribution, 2000)
    assert.deepEqual(await f.database.get('xiuxian_back', { userId: 'test' }), [])
  } finally { await f.app.stop() }
})

test('PostgreSQL 同时兑换和出关各只结算一次', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await f.database.set('xiuxian_player', { userId: 'test' }, { sectContribution: 100 })
    const exchanges = await Promise.all([f.run('宗门贡献兑换 灵石 80'), f.run('宗门贡献兑换 灵石 80')])
    assert.equal(exchanges.filter(reply => reply.includes('兑换成功')).length, 1)
    assert.equal((await f.player()).sectContribution, 20)
    assert.equal(await f.wallet(), 1008)
    await f.run('闭关')
    await f.database.set('xiuxian_cd', { userId: 'test' }, { createTime: new Date(Date.now() - 600000) })
    const closings = await Promise.all([f.run('出关'), f.run('出关')])
    assert.equal(closings.filter(reply => reply.includes('闭关结束')).length, 1)
    assert.equal((await f.player()).exp, 760)
  } finally { await f.app.stop() }
})
