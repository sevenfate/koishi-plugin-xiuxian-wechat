import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { applyWork } = require(resolve(root, 'lib/modules/work.js'))
const { applyShop } = require(resolve(root, 'lib/modules/shop.js'))
const { removeGoods } = require(resolve(root, 'lib/shop-trade.js'))

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
  const config = { currency: 'default', shopCapacity: 100, shopExpireHours: 24, shopServiceCharge: 0.1, adminQQ: [] }
  let reloadWork: () => Promise<void>
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    ctx.plugin(XiuxianService, config)
    ctx.inject(['xiuxian' as any], scope => {
      const registerWork = (ctx: any) => applyWork(ctx, config)
      let fork = scope.plugin(registerWork)
      reloadWork = async () => { await fork.dispose(); fork = scope.plugin(registerWork); await app.lifecycle.flush() }
      applyShop(scope, config)
    })
  })
  await app.start()
  const database: any = app.database, service: any = (app as any).xiuxian
  if (pgConfig) for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_work', 'xiuxian_work_pending', 'xiuxian_cd', 'xiuxian_back', 'xiuxian_shop']) await database.remove(table, {})
  for (const [id, userId] of [[71, 'seller'], [72, 'buyer'], [73, 'buyer2']] as const) {
    await database.create('user', { id, name: userId, authority: userId === 'seller' ? 999 : 1 })
    await database.create('binding', { aid: id, bid: id, pid: userId, platform: 'webridge' })
    await database.create('xiuxian_player', { userId, uid: id, platform: 'webridge', userName: userId, level: '筑基境中期', exp: 10000 })
    await database.create('monetary', { uid: id, currency: 'default', value: 2000000 })
  }
  await service.sendBack('seller', 1101, service.data.getItem(1101).name, '丹药', 20)
  return { app, database, service, config, name: service.data.getItem(1101).name, reloadWork: () => reloadWork(),
    async run(command: string, userId = 'seller', guildId = 'test@chatroom') {
      const session = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: guildId }, channel: { id: guildId, type: 0 } })
      return String(await session.execute(command, true))
    },
    stock: () => database.get('xiuxian_shop', {}),
    wallet: (userId: string) => service.getStoneForUser(userId, 'webridge'),
    count: async (userId: string) => (await service.getBackItem(userId, 1101))?.goodsNum || 0,
  }
}

test('悬赏令重复查看和重载保留原列表，不消耗刷新次数；仅刷新重抽并按次数收费', async () => {
  const f = await fixture()
  try {
    const first = await f.run('悬赏令')
    assert.match(first, /个人悬赏令/)
    assert.equal(await f.run('悬赏令'), first)
    assert.equal((await f.service.getPlayer('seller')).workRefreshCount, 0)
    await f.reloadWork()
    assert.equal(await f.run('悬赏令'), first)
    for (let i = 0; i < 3; i++) assert.match(await f.run('悬赏令刷新'), /个人悬赏令/)
    assert.equal(await f.wallet('seller'), 2000000)
    assert.match(await f.run('悬赏令刷新'), /消耗灵石500000/)
    assert.equal(await f.wallet('seller'), 1500000)
    assert.equal((await f.service.getPlayer('seller')).workRefreshCount, 4)
    const before = await f.database.get('xiuxian_work_pending', { userId: 'seller' })
    await f.database.set('monetary', { uid: 71 }, { value: 0 })
    assert.match(await f.run('悬赏令刷新'), /灵石不足/)
    assert.deepEqual(await f.database.get('xiuxian_work_pending', { userId: 'seller' }), before)
    assert.equal((await f.service.getPlayer('seller')).workRefreshCount, 4)
    const selected = before[0].list[0]
    assert.match(await f.run('悬赏令接取 1'), /接取任务/)
    assert.equal((await f.database.get('xiuxian_work', { userId: 'seller' }))[0].workName, selected.name)
    assert.deepEqual(await f.database.get('xiuxian_work_pending', { userId: 'seller' }), [])
    assert.match(await f.run('悬赏令刷新'), /进行中的悬赏令/)
  } finally { await f.app.stop() }
})

test('批量上架、分批购买按单价结算，默认买一个，下架只返还剩余库存', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run(`坊市上架 ${f.name} 100 10`), /数量10个，单价100/)
    const [item] = await f.stock()
    assert.equal(await f.count('seller'), 10)
    assert.match(await f.run('坊市查看'), /单价100灵石，库存10个/)
    assert.match(await f.run(`坊市购买 ${item.id} 3`, 'buyer'), /3个，花费灵石300/)
    assert.equal(await f.count('buyer'), 3)
    assert.equal(await f.wallet('buyer'), 1999700)
    assert.equal(await f.wallet('seller'), 2000270)
    assert.equal((await f.stock())[0].goodsNum, 7)
    assert.match(await f.run(`坊市购买 ${item.id}`, 'buyer'), /1个，花费灵石100/)
    assert.match(await f.run(`坊市下架 ${item.id}`), /6个/)
    assert.equal(await f.count('seller'), 16)
    assert.equal((await f.stock()).length, 0)
    assert.match(await f.run(`坊市上架 ${f.name} 100`), /数量1个/)
    const [single] = await f.stock()
    assert.match(await f.run(`坊市购买 ${single.id}`, 'buyer'), /购得/)
    assert.equal((await f.stock()).length, 0)
    assert.match(await f.run(`系统坊市上架 ${f.name} 200 6`), /数量6个/)
    const [system] = await f.stock()
    assert.match(await f.run(`坊市购买 ${system.id} 6`, 'buyer'), /6个，花费灵石1200/)
    assert.equal((await f.stock()).length, 0)
  } finally { await f.app.stop() }
})

test('非法数量、库存不足、跨群购买、余额不足和绑定丹药均不改变资产', async () => {
  const f = await fixture()
  try {
    for (const n of ['0', '-1', '1.5', '2147483648', '999999999999999999999']) {
      await f.run(`坊市上架 ${f.name} 100 ${n}`)
      assert.equal((await f.stock()).length, 0)
      assert.equal(await f.count('seller'), 20)
    }
    await f.database.set('xiuxian_back', { userId: 'seller', goodsId: 1101 }, { bindNum: 19 })
    assert.match(await f.run(`坊市上架 ${f.name} 100 2`), /数量不足/)
    await f.run(`坊市上架 ${f.name} 100`)
    const [item] = await f.stock()
    for (const n of ['0', '-1', '1.5', '2', '2147483648']) await f.run(`坊市购买 ${item.id} ${n}`, 'buyer')
    assert.match(await f.run(`坊市购买 ${item.id}`, 'buyer', 'other@chatroom'), /正确的坊市编号/)
    assert.match(await f.run(`坊市购买 ${item.id}`), /自己上架/)
    await f.database.set('monetary', { uid: 72 }, { value: 0 })
    assert.match(await f.run(`坊市购买 ${item.id}`, 'buyer'), /灵石不足/)
    assert.equal(await f.count('buyer'), 0)
    assert.equal((await f.stock())[0].goodsNum, 1)
    assert.equal(await f.wallet('seller'), 2000000)
  } finally { await f.app.stop() }
})

test('过期只归还剩余数量；购买中途失败会回滚钱包、背包和库存', async () => {
  const f = await fixture()
  try {
    await f.run(`坊市上架 ${f.name} 100 10`)
    const [item] = await f.stock()
    const prototype = Object.getPrototypeOf(f.service), gain = prototype.gainStoneForUser
    prototype.gainStoneForUser = async () => { throw new Error('模拟卖家入账失败') }
    try { await f.run(`坊市购买 ${item.id} 3`, 'buyer') } finally { prototype.gainStoneForUser = gain }
    assert.equal(await f.wallet('buyer'), 2000000)
    assert.equal(await f.count('buyer'), 0)
    assert.equal((await f.stock())[0].goodsNum, 10)
    await f.run(`坊市购买 ${item.id} 3`, 'buyer')
    await f.database.set('xiuxian_shop', { id: item.id }, { createTime: new Date(Date.now() - 25 * 3600000) })
    await removeGoods(f.app, f.service, f.config, null, item.id, true)
    await removeGoods(f.app, f.service, f.config, null, item.id, true)
    assert.equal(await f.count('seller'), 17)
    assert.equal((await f.stock()).length, 0)
  } finally { await f.app.stop() }
})

test('PostgreSQL 并发购买不超卖，并发付费刷新不漏扣', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await f.run(`坊市上架 ${f.name} 100 5`)
    const [item] = await f.stock()
    const results = await Promise.all([f.run(`坊市购买 ${item.id} 4`, 'buyer'), f.run(`坊市购买 ${item.id} 4`, 'buyer2')])
    assert.equal(results.filter(r => r.includes('购得')).length, 1)
    assert.equal((await f.stock())[0].goodsNum, 1)
    await f.database.set('xiuxian_player', { userId: 'buyer' }, { workRefreshCount: 3 })
    const before = await f.wallet('buyer')
    await Promise.all([f.run('悬赏令刷新', 'buyer'), f.run('悬赏令刷新', 'buyer')])
    assert.equal((await f.service.getPlayer('buyer')).workRefreshCount, 5)
    assert.equal(await f.wallet('buyer'), before - 1000000)
  } finally { await f.app.stop() }
})
