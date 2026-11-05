import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { applyForgetSkill } = require(resolve(root, 'lib/forget-skill.js'))
const { applyBack } = require(resolve(root, 'lib/modules/back.js'))

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
  app.inject(['database'], ctx => {
    ctx.plugin(XiuxianService, { currency: 'default' })
    ctx.inject(['xiuxian' as any], scope => { applyForgetSkill(scope); applyBack(scope, {}) })
  })
  await app.start()
  const database: any = app.database, service: any = (app as any).xiuxian
  if (pgConfig) for (const table of ['xiuxian_skill', 'xiuxian_buff', 'xiuxian_player', 'xiuxian_back', 'xiuxian_meta']) await database.remove(table, {})
  for (const userId of ['forget-test', 'another-player']) await database.create('xiuxian_player', { userId, userName: userId })
  const ids = Object.keys(service.data.getItemsByType(['神通'])).map(Number).slice(0, 2)
  const mainId = Number(Object.keys(service.data.getItemsByType(['功法']))[0])
  assert.equal(ids.length, 2)
  for (const id of ids) await service.learnSkill('forget-test', id, '神通')
  await service.learnSkill('forget-test', mainId, '功法')
  await service.learnSkill('another-player', ids[0], '神通')
  return { app, database, service, ids, mainId, name: (id: number) => service.data.getItem(id).name,
    async run(command: string, userId = 'forget-test') {
      const session = app.bots[0].session({ type: 'message', user: { id: userId }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 } })
      return String(await session.execute(command, true))
    },
  }
}

test('查询和名称预览不删除，拒绝模糊名称、未学神通和功法', async () => {
  const f = await fixture()
  try {
    assert.match(await f.run('我的神通'), /已学神通/)
    assert.ok((await f.run('我的神通')).includes(`${f.ids[0]}、${f.name(f.ids[0])}`))
    assert.ok((await f.run(`遗忘神通 ${f.name(f.ids[0])}`)).includes(`确认遗忘神通 ${f.ids[0]}`))
    assert.match(await f.run('遗忘神通 不存在的神通'), /未学会/)
    assert.match(await f.run(`确认遗忘神通 ${f.mainId}`), /未学会/)
    assert.equal((await f.service.getSecSkillIds('forget-test')).length, 2)
    assert.match(await f.run('我的神通', 'missing-player'), /我要修仙/)
    assert.match(await f.run(`确认遗忘神通 ${f.ids[0]}`, 'missing-player'), /我要修仙/)
  } finally { await f.app.stop() }
})

test('确认只删除自己的指定神通，保留其他神通、功法、背包及旧引用', async () => {
  const f = await fixture()
  try {
    const before = await f.service.getPlayer('forget-test')
    await f.service.sendBack('forget-test', f.ids[1], f.name(f.ids[1]), '神通', 2)
    assert.match(await f.run(`确认遗忘神通 ${f.ids[1]}`), /已遗忘神通/)
    assert.deepEqual(await f.service.getSecSkillIds('forget-test'), [f.ids[0]])
    assert.equal((await f.service.getBuff('forget-test')).secBuff, f.ids[0])
    assert.equal(await f.service.hasSkill('forget-test', f.mainId), true)
    assert.equal((await f.service.getBackItem('forget-test', f.ids[1])).goodsNum, 2)
    assert.deepEqual(await f.service.getPlayer('forget-test'), before)
    assert.deepEqual(await f.service.getSecSkillIds('another-player'), [f.ids[0]])
    assert.match(await f.run(`确认遗忘神通 ${f.ids[1]}`), /已经遗忘/)
    assert.match(await f.run(`确认遗忘神通 ${f.ids[0]}`), /已遗忘神通/)
    assert.equal((await f.service.getBuff('forget-test')).secBuff, 0)
    await f.service.migrateSkillsFromBuff()
    assert.deepEqual(await f.service.getSecSkillIds('forget-test'), [])
    assert.match(await f.run('我的神通'), /尚未学会任何神通/)
  } finally { await f.app.stop() }
})

test('同名神通必须用编号，支持编号遗忘后重新消耗秘籍学习', async () => {
  const f = await fixture()
  try {
    const duplicate = f.name(f.ids[0])
    f.service.data.items[f.ids[1]].name = duplicate
    assert.match(await f.run(`遗忘神通 ${duplicate}`), /同名神通/)
    assert.match(await f.run(`确认遗忘神通 ${duplicate}`), /同名神通/)
    assert.equal((await f.service.getSecSkillIds('forget-test')).length, 2)
    assert.match(await f.run(`确认遗忘神通 ${f.ids[0]}`), /已遗忘/)
    await f.service.sendBack('forget-test', f.ids[0], duplicate, '神通', 1)
    assert.match(await f.run(`使用 ${duplicate}`), /学会神通/)
    assert.equal(await f.service.hasSkill('forget-test', f.ids[0]), true)
    assert.equal((await f.service.getBuff('forget-test')).secBuff, f.ids[0])
    assert.equal((await f.service.getBackItem('forget-test', f.ids[0])).goodsNum, 0)
  } finally { await f.app.stop() }
})

test('引用更新失败时事务回滚，已经删除的神通恢复', async () => {
  const f = await fixture()
  const transact = f.database.transact.bind(f.database)
  try {
    f.database.transact = (callback: Function) => transact((database: any) => callback(new Proxy(database, {
      get(target, key) {
        if (key === 'set') return (table: string, ...args: any[]) => {
          if (table === 'xiuxian_buff') throw new Error('模拟神通引用写入失败')
          return target.set(table, ...args)
        }
        return Reflect.get(target, key, target)
      },
    })))
    assert.match(await f.run(`确认遗忘神通 ${f.ids[0]}`), /修改已回滚/)
    assert.equal(await f.service.hasSkill('forget-test', f.ids[0]), true)
    assert.equal((await f.service.getBuff('forget-test')).secBuff, f.ids[0])
  } finally { f.database.transact = transact; await f.app.stop() }
})

test('PostgreSQL 并发确认同一神通只遗忘一次', { skip: !process.env.XIUXIAN_TEST_POSTGRES_CONFIG }, async () => {
  const f = await fixture()
  try {
    const results = await Promise.all([f.run(`确认遗忘神通 ${f.ids[0]}`), f.run(`确认遗忘神通 ${f.ids[0]}`)])
    assert.equal(results.filter(result => result.includes('已遗忘神通')).length, 1)
    assert.equal(results.filter(result => result.includes('已经遗忘')).length, 1)
    assert.deepEqual(await f.service.getSecSkillIds('forget-test'), [f.ids[1]])
    assert.equal((await f.service.getBuff('forget-test')).secBuff, 0)
  } finally { await f.app.stop() }
})
