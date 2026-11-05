import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { signOnce } = require(resolve(root, 'lib/sign-in.js'))
const { todayStr } = require(resolve(root, 'lib/daily-utils.js'))

async function fixture() {
  const app = new App()
  const pg = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pg && !/^xiuxian_economy_test_/.test(pg.database)) throw new Error('仅允许隔离测试数据库')
  const driver = require(pg ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pg || { path: ':memory:' })
  app.provide('monetary', {})
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    // wipeUserData 还会清理其他玩法表，隔离测试只需注册被清理的列。
    for (const table of ['xiuxian_work', 'xiuxian_boss_participant', 'xiuxian_exercises', 'xiuxian_bank', 'xiuxian_plot']) {
      ctx.model.extend(table as any, { userId: 'string' }, { primary: 'userId' })
    }
    ctx.plugin(XiuxianService, { currency: 'default', remakeCost: 10, signInLingShiLowerLimit: 100, signInLingShiUpperLimit: 100 })
  })
  await app.start()
  const db: any = app.database, srv: any = (app as any).xiuxian
  if (pg) for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_sign', 'xiuxian_sect', 'xiuxian_cd', 'xiuxian_buff', 'xiuxian_back']) await db.remove(table, {})
  await db.create('user', { id: 91, name: 'sign-test', authority: 1 })
  await db.create('binding', { aid: 91, bid: 91, pid: 'sign-test', platform: 'webridge' })
  await db.create('monetary', { uid: 91, currency: 'default', value: 1000 })
  const create = () => srv.createPlayer({ userId: 'sign-test', platform: 'webridge' }, '金', '真灵根', 100, '道友')
  await create()
  return { app, db, srv, create, sign: () => srv.sign('sign-test', 'webridge'), remake: () => srv.wipeAndRemake('sign-test', 'webridge'),
    wallet: () => srv.getStoneForUser('sign-test', 'webridge'), player: () => srv.getPlayer('sign-test'),
    record: async () => (await db.get('xiuxian_sign', { userId: 'sign-test' }))[0] }
}

test('签到后反复重入和重新建号，当天只领一次，奖励记录不随删档消失', async () => {
  const f = await fixture()
  try {
    assert.match(await f.sign(), /签到成功/)
    for (let i = 0; i < 3; i++) {
      assert.match(await f.remake(), /前尘尽散/)
      assert.equal(await f.player(), undefined)
      assert.equal((await f.record()).lastSignDate, todayStr())
      await f.create()
      assert.match(await f.sign(), /今日已签到/)
    }
    assert.equal(await f.wallet(), 1070)
  } finally { await f.app.stop() }
})

test('升级前的签到状态在首次重入前迁入独立记录，宗主拒绝重入时不扣费', async () => {
  const f = await fixture()
  try {
    await f.db.set('xiuxian_player', { userId: 'sign-test' }, { isSign: 1, lastSignDate: todayStr() })
    await f.remake(); await f.create()
    assert.match(await f.sign(), /今日已签到/)
    assert.equal(await f.wallet(), 990)
    await f.db.create('xiuxian_sect', { sectOwner: 'sign-test', sectName: '测试宗门' })
    assert.match(await f.remake(), /一宗之主/)
    assert.equal(await f.wallet(), 990)
  } finally { await f.app.stop() }
})

test('每日重置不清独立签到记录，换日后可以再领一次', async () => {
  const f = await fixture()
  let date = '2040-01-01'
  try {
    const sign = () => signOnce(f.srv, 'sign-test', 'webridge', () => date)
    assert.match(await sign(), /签到成功/)
    await f.srv.resetDailyFlags()
    assert.match(await sign(), /今日已签到/)
    date = '2040-01-02'
    assert.match(await sign(), /签到成功/)
    assert.match(await sign(), /今日已签到/)
    assert.equal(await f.wallet(), 1200)
  } finally { await f.app.stop() }
})

test('签到入账失败可重试，余额上限不消耗签到资格；删档失败一起回滚', async () => {
  const f = await fixture(), proto = Object.getPrototypeOf(f.srv)
  try {
    const gain = proto.gainStoneForUser
    proto.gainStoneForUser = async () => { throw new Error('模拟入账失败') }
    try { await assert.rejects(f.sign(), /模拟入账失败/) } finally { proto.gainStoneForUser = gain }
    assert.equal((await f.record()).lastSignDate, '')
    assert.equal(await f.wallet(), 1000)
    await f.db.set('monetary', { uid: 91 }, { value: 2147483647 })
    assert.match(await f.sign(), /本次未签到/)
    await f.db.set('monetary', { uid: 91 }, { value: 1000 })
    assert.match(await f.sign(), /签到成功/)
    const wipe = proto.wipeUserData
    proto.wipeUserData = async function(this: any, userId: string) { await wipe.call(this, userId); throw new Error('模拟删档失败') }
    try { await assert.rejects(f.remake(), /模拟删档失败/) } finally { proto.wipeUserData = wipe }
    assert.ok(await f.player())
    assert.equal(await f.wallet(), 1100)
    assert.match(await f.sign(), /今日已签到/)
  } finally { await f.app.stop() }
})

test('PostgreSQL 并发签到只发一次；签到与重入并发不刷新资格，并发重入只扣一次', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.sign()))
    assert.equal(replies.filter(r => r.includes('签到成功')).length, 1)
    assert.equal(await f.wallet(), 1100)
    await Promise.all([f.sign(), f.remake(), f.remake()])
    await f.create()
    assert.match(await f.sign(), /今日已签到/)
    assert.equal(await f.wallet(), 1090)
  } finally { await f.app.stop() }
})
