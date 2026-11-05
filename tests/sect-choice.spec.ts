import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { XiuxianService } = require(resolve(root, 'lib/service.js'))
const { applyBase } = require(resolve(root, 'lib/modules/base.js'))
const { applySect } = require(resolve(root, 'lib/modules/sect.js'))

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async sendMessage(): Promise<string[]> { throw new Error('离线测试不能发送消息') }
}

async function fixture() {
  const app = new App()
  const driver = require('@koishijs/plugin-database-sqlite')
  app.plugin(driver.default ?? driver, { path: ':memory:' })
  app.provide('monetary', {})
  app.plugin(TestBot)
  app.inject(['database'], ctx => {
    ctx.plugin(XiuxianService, { currency: 'default' })
    ctx.inject(['xiuxian' as any], scope => { applyBase(scope, {}); applySect(scope, {}) })
  })
  await app.start()
  const database: any = app.database, service: any = (app as any).xiuxian
  await service.ensurePresetSects()
  for (let i = 41; i <= 55; i++) await database.create('xiuxian_sect', { sectId: i, sectName: `玩家自建宗门${i}`, sectOwner: 'founder' })
  function session(userId: string) {
    return app.bots[0].session({ type: 'message', user: { id: userId, name: '新道友' }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 } })
  }
  return { app, database, service,
    async register(answers: Array<string | undefined | (() => Promise<string>)>, userId = 'newbie') {
      if (!await database.getUser('webridge', userId, ['id'])) await database.createUser('webridge', userId, { authority: 1 })
      const s: any = { userId, platform: 'webridge', username: '新道友', event: { user: { name: '新道友' } }, getUser: async () => undefined }, sent: string[] = []
      s.send = async (message: any) => { sent.push(String(message)); return [] }
      s.prompt = (async () => { const answer = answers.shift(); return typeof answer === 'function' ? answer() : answer }) as any
      const command: any = app.$commander.get('我要修仙')
      return { result: String(await command._actions[0]({ session: s })), sent }
    },
    async run(command: string, userId = 'newbie') { return String(await session(userId).execute(command, true)) },
    async player(userId = 'newbie') { return service.getPlayer(userId) },
  }
}

test('新手真实建号流程显示全部自建宗门，按真实编号加入，不误用列表序号', async () => {
  const f = await fixture()
  try {
    const response = await f.register(['加入宗门', '41'])
    const list = response.sent.find(s => s.includes('编号41'))!
    assert.ok(list)
    for (let id = 41; id <= 55; id++) assert.ok(list.includes(`编号${id} 玩家自建宗门${id}`), list)
    assert.match(list, /青冥剑宗/)
    assert.match(response.result, /成功加入宗门【玩家自建宗门41】/)
    assert.equal((await f.player()).sectId, 41)
    assert.equal((await f.player()).sectPosition, 4)
    assert.match(response.sent.join('\n'), /查看全部宗门/)
  } finally { await f.app.stop() }
})

test('新手及普通加入指令都能按自建宗门全名加入，普通目录不截断前十', async () => {
  const f = await fixture()
  try {
    assert.match((await f.register(['加入宗门', '玩家自建宗门55'])).result, /成功加入宗门【玩家自建宗门55】/)
    const list = await f.run('宗门列表')
    for (let id = 41; id <= 55; id++) assert.ok(list.includes(`编号${id} 玩家自建宗门${id}`), list)
    assert.equal((await f.service.sectScaleTop()).length, 10, '排行榜继续只显示前十')
    await f.register(['成为散修'], 'another')
    assert.match(await f.run('加入宗门 玩家自建宗门41', 'another'), /成功加入宗门/)
    assert.equal((await f.player('another')).sectId, 41)
    assert.match(await f.run('加入宗门 42', 'another'), /已有宗门/)
  } finally { await f.app.stop() }
})

test('不存在或已删除宗门不会错误加入，重新输入编号可继续选择', async () => {
  const f = await fixture()
  try {
    const response = await f.register(['加入宗门', async () => {
      await f.database.remove('xiuxian_sect', { sectId: 41 }); return '41'
    }, '不存在的宗门', '42'])
    assert.equal((await f.player()).sectId, 42)
    assert.match(response.sent.join('\n'), /未找到宗门/)
    assert.match(response.result, /成功加入宗门【玩家自建宗门42】/)
  } finally { await f.app.stop() }
})

test('预设宗门保留描述；散修、超时与同名宗门均有明确处理', async () => {
  const f = await fixture()
  try {
    assert.match((await f.register(['加入宗门', '青冥剑宗'], 'preset')).result, /执掌山岳剑道/)
    assert.match((await f.register(['成为散修'], 'solo')).result, /选择成为散修/)
    assert.equal((await f.player('solo')).sectId, 0)
    assert.match((await f.register(['加入宗门', undefined], 'timeout')).result, /选择超时/)
    assert.equal((await f.player('timeout')).sectId, 0)
    await f.database.create('xiuxian_sect', { sectId: 60, sectName: '玩家自建宗门41', sectOwner: 'founder2' })
    const response = await f.register(['加入宗门', '玩家自建宗门41', '60'], 'duplicate')
    assert.match(response.sent.join('\n'), /存在同名宗门/)
    assert.equal((await f.player('duplicate')).sectId, 60)
  } finally { await f.app.stop() }
})
