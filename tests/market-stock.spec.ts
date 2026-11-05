import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App } from 'koishi'

const require = createRequire(__filename), root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const moduleOf = (name: string) => require(resolve(root, 'lib', name + '.js'))
const { XiuxianService } = moduleOf('service'), { createMarketStock, selectMarketGoods, marketPrice, RESTOCK_MS } = moduleOf('market-stock')
const { buyGoods, listGoods } = moduleOf('shop-trade')

async function fixture() {
  const app = new App(), pg = process.env.XIUXIAN_TEST_POSTGRES_CONFIG && JSON.parse(process.env.XIUXIAN_TEST_POSTGRES_CONFIG)
  if (pg && !/^xiuxian_economy_test_/.test(pg.database)) throw new Error('仅允许隔离测试数据库')
  const driver = require(pg ? '@koishijs/plugin-database-postgres' : '@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, pg || { path: ':memory:' }); app.provide('monetary', {})
  const clock = { now: Date.now() }, config = { currency: 'default', shopCapacity: 6, shopRestockThreshold: 5, shopExpireHours: 72, shopServiceCharge: 0.1, adminQQ: [], groupWhitelistEnabled: false, groupWhitelist: ['a@chatroom'] }
  let api: any
  app.inject(['database'], ctx => {
    ctx.model.extend('monetary' as any, { uid: 'unsigned', currency: 'string', value: 'integer' }, { primary: ['uid', 'currency'] })
    ctx.plugin(XiuxianService, config)
    ctx.inject(['xiuxian' as any], scope => {
      // 使用正式模块注册表和命令，但关闭其真实时钟，用手动时钟验证补货。
      moduleOf('modules/shop').applyShop(scope, { ...config, shopRestockThreshold: 0 })
      api = createMarketStock(scope, (scope as any).xiuxian, config, moduleOf('helpers').normalizePlatformId, { now: () => clock.now, timer: false, random: () => 0 })
    })
  })
  await app.start()
  const db: any = app.database, srv: any = (app as any).xiuxian
  if (pg) for (const table of ['binding', 'user', 'monetary', 'xiuxian_player', 'xiuxian_back', 'xiuxian_market', 'xiuxian_shop']) await db.remove(table, {})
  for (const [i, userId] of ['seller', 'buyer'].entries()) {
    await db.create('user', { id: 111 + i, authority: 1, name: userId })
    await db.create('binding', { aid: 111 + i, bid: 111 + i, pid: userId, platform: 'webridge' })
    await db.create('xiuxian_player', { userId, uid: 111 + i, platform: 'webridge', userName: userId })
    await db.create('monetary', { uid: 111 + i, currency: 'default', value: 100000000 })
  }
  return { app, db, srv, api, clock, config, items: (gid = 'a@chatroom') => db.get('xiuxian_shop', { guildId: gid }),
    session: (userId = 'seller') => ({ userId, platform: 'webridge', guildId: 'a@chatroom' }),
    wallet: () => srv.getStoneForUser('buyer', 'webridge') }
}

test('神秘人从全部六类物品抽取，单价为正整数，消耗品有批量库存', async () => {
  const f = await fixture()
  try {
    const goods = selectMarketGoods(f.srv.data, 6, () => 0)
    assert.equal(goods.length, 6)
    assert.equal(new Set(goods.map((x: any) => x.goodsId)).size, 6)
    assert.ok(goods.some((x: any) => x.goodsType === '功法' || x.goodsType === '辅修功法'))
    assert.ok(goods.some((x: any) => x.goodsType === '神通'))
    assert.ok(goods.some((x: any) => x.goodsType === '药材' && x.goodsNum === 3))
    assert.ok(goods.every((x: any) => x.price > 0 && Number.isInteger(x.price)))
    assert.ok(marketPrice({ rank: 1, item_type: '功法' }) > marketPrice({ rank: 50, item_type: '功法' }))
  } finally { await f.app.stop() }
})

test('首次查看补货，重复查看和重新建控制器不换批；卖空后仍按时间补货', async () => {
  const f = await fixture()
  try {
    const state = await f.api.visit('a@chatroom'), first = await f.items()
    assert.equal(first.length, 5)
    assert.equal(+state.nextRestockAt, f.clock.now + RESTOCK_MS)
    await f.api.visit('a@chatroom'); assert.deepEqual(await f.items(), first)
    const reloaded = createMarketStock(f.app, f.srv, f.config, moduleOf('helpers').normalizePlatformId, { now: () => f.clock.now, timer: false })
    await reloaded.visit('a@chatroom'); assert.deepEqual(await f.items(), first)
    await f.db.remove('xiuxian_shop', {})
    await f.api.tick(); assert.equal((await f.items()).length, 0)
    f.clock.now += RESTOCK_MS
    await f.api.tick(); assert.equal((await f.items()).length, 5)
    assert.notEqual((await f.items())[0].id, first[0].id)
  } finally { await f.app.stop() }
})

test('换批保留玩家和管理员物品，尊重总容量与群隔离', async () => {
  const f = await fixture()
  try {
    const fields = { guildId: 'a@chatroom', goodsId: 1101, goodsName: '丹药', goodsType: '丹药', goodsNum: 2, price: 100, createTime: new Date(f.clock.now) }
    const player = await f.db.create('xiuxian_shop', { ...fields, sellerId: 'seller', sellerName: 'seller' })
    const admin = await f.db.create('xiuxian_shop', { ...fields, sellerId: '0', sellerName: '系统' })
    await f.api.visit('a@chatroom')
    assert.equal((await f.items()).length, 6)
    f.clock.now += RESTOCK_MS; await f.api.tick()
    assert.equal((await f.items()).length, 6)
    assert.ok((await f.items()).some((x: any) => x.id === player.id))
    assert.ok((await f.items()).some((x: any) => x.id === admin.id))
    await f.api.visit('b@chatroom'); assert.equal((await f.items('b@chatroom')).length, 5)
  } finally { await f.app.stop() }
})

test('补货失败保留旧货和原时间，重试可成功；白名单移除后不换货', async () => {
  const f = await fixture(), transact = f.db.transact.bind(f.db)
  try {
    await f.api.visit('a@chatroom'); const first = await f.items()
    f.clock.now += RESTOCK_MS
    let calls = 0
    f.db.transact = (cb: Function) => transact((db: any) => cb(new Proxy(db, { get(target, key) {
      if (key === 'create') return (table: string, ...args: any[]) => {
        if (table === 'xiuxian_shop' && ++calls === 2) throw new Error('模拟补货失败')
        return target.create(table, ...args)
      }
      return Reflect.get(target, key, target)
    } })))
    await assert.rejects(f.api.visit('a@chatroom'), /模拟补货失败/)
    assert.deepEqual(await f.items(), first)
    f.db.transact = transact
    f.config.groupWhitelistEnabled = true; f.config.groupWhitelist = []
    await f.api.tick(); assert.deepEqual(await f.items(), first)
    f.config.groupWhitelist = ['webridge:a@chatroom']
    await f.api.tick(); assert.notEqual((await f.items())[0].id, first[0].id)
  } finally { f.db.transact = transact; await f.app.stop() }
})

test('定时过期回收继续退回玩家剩余库存', async () => {
  const f = await fixture()
  try {
    await f.db.create('xiuxian_shop', { guildId: 'a@chatroom', sellerId: 'seller', sellerName: 'seller', goodsId: 1101, goodsName: '丹药', goodsType: '丹药', goodsNum: 4, price: 100, createTime: new Date(0) })
    await f.api.tick()
    assert.equal((await f.srv.getBackItem('seller', 1101)).goodsNum, 4)
    await f.api.tick(); assert.equal((await f.srv.getBackItem('seller', 1101)).goodsNum, 4)
  } finally { await f.app.stop() }
})

test('关闭神秘人补货时仍会回收过期的玩家商品', async () => {
  const f = await fixture()
  try {
    const disabled = createMarketStock(f.app, f.srv, { ...f.config, shopRestockThreshold: 0 }, moduleOf('helpers').normalizePlatformId, { timer: false })
    await f.db.create('xiuxian_shop', { guildId: 'a@chatroom', sellerId: 'seller', sellerName: 'seller', goodsId: 1101, goodsName: '丹药', goodsType: '丹药', goodsNum: 2, price: 100, createTime: new Date(0) })
    await disabled.tick()
    assert.equal((await f.srv.getBackItem('seller', 1101)).goodsNum, 2)
    assert.equal((await f.items()).length, 0)
  } finally { await f.app.stop() }
})

test('PostgreSQL 并发查看只换一次，并发上架不突破容量，换批与购买不重复扣款', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    await Promise.all([f.api.visit('a@chatroom'), f.api.visit('a@chatroom')])
    assert.equal((await f.items()).length, 5)
    for (const id of ['seller', 'buyer']) await f.srv.sendBack(id, 1101, '回血丹', '丹药', 1)
    const replies = await Promise.all(['seller', 'buyer'].map(id => listGoods(f.app, f.srv, f.config, f.session(id), '回血丹', 100, 1)))
    assert.equal(replies.filter((x: string) => x.includes('已上架')).length, 1)
    assert.equal((await f.items()).length, 6)
    const item = (await f.items()).find((x: any) => x.sellerName === '神秘人')
    const before = await f.wallet()
    f.clock.now += RESTOCK_MS
    const [bought] = await Promise.all([buyGoods(f.app, f.srv, f.config, f.session('buyer'), item.id, 1), f.api.visit('a@chatroom')])
    assert.equal(await f.wallet(), before - (bought.includes('购得') ? item.price : 0))
    assert.ok((await f.items()).length <= 6)
  } finally { await f.app.stop() }
})
