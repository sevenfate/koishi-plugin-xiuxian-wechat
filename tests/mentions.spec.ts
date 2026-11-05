import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, h, type Context, type Session } from '@koishijs/core'

const require = createRequire(__filename)
const { buildSession: buildMessageSession } = require('./fixtures/message-session.ts')
const directory = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const { getAtId } = require(resolve(directory, 'lib/helpers.js'))
const { applyBase } = require(resolve(directory, 'lib/modules/base.js'))

function session(elements: h[], selfId = 'webridge', deviceAccountId = 'wxid_robot') {
  return { selfId, bot: { selfId, deviceAccountId }, elements } as unknown as Session
}

test('目标解析跳过 Koishi 机器人标识和真实微信账号，保留首个成员', () => {
  const elements = [h.at('webridge'), h.at('wxid_robot'), h.at('wxid_target'), h.at('wxid_other')]
  assert.equal(getAtId(session(elements)), 'wxid_target')
  assert.equal(getAtId(session([h.at('wxid_target'), h.at('webridge')])), 'wxid_target')
  assert.equal(getAtId(session([h.at('custom-bot'), h.at('wxid_target')], 'custom-bot')), 'wxid_target')
  assert.deepEqual(elements.map(element => element.attrs.id), ['webridge', 'wxid_robot', 'wxid_target', 'wxid_other'])
})

test('群体提及、空提及和只提及机器人时不生成成员目标', () => {
  const ignored = [h.at('webridge'), h.at('wxid_robot'), h.at('all'), h.at('here'), h.at('notify@all'),
    h('at', { type: 'all', id: 'some-id' }), h('at', { type: 'here' }), h('at', {})]
  assert.equal(getAtId(session(ignored)), undefined)
  assert.equal(getAtId(session([...ignored, h.at('wxid_target')], 'webridge')), 'wxid_target')
  assert.equal(getAtId(session([])), undefined)
})

test('其他平台仍按首个非机器人个人提及选择，允许保留调用者自身', () => {
  assert.equal(getAtId({ selfId: '10000', bot: { selfId: '10000' }, elements: [h.at('10000'), h.at('20000')] }), '20000')
  assert.equal(getAtId({ selfId: '10000', userId: '20000', elements: [h.at('20000')] }), '20000')
})

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  static reusable = true
  deviceAccountId = 'wxid_robot'
  constructor(ctx: Context, config: {}) {
    super(ctx, config, 'webridge')
    this.user = { id: 'webridge' }
  }
}

test('离线 Koishi 会话进入指令：同时 @机器人和成员时向成员赠送，仅 @机器人时不扣款', async () => {
  const app = new App(), calls: Array<{ action: string; userId: string; amount: number }> = []
  const players = new Map([
    ['wxid_sender', { userId: 'wxid_sender', userName: '发起者' }],
    ['wxid_target', { userId: 'wxid_target', userName: '目标成员' }],
  ])
  app.plugin(TestBot, {})
  app.plugin((ctx: Context) => {
    ctx.set('xiuxian' as any, {
      async getPlayer(id: string) { return players.get(id) },
      async getStoneForUser() { return 1000 },
      async costStoneForUser(userId: string, amount: number) { calls.push({ action: 'cost', userId, amount }); return true },
      async gainStoneForUser(userId: string, amount: number) { calls.push({ action: 'gain', userId, amount }) },
    } as any)
    ctx.inject(['xiuxian' as any], ctx => { applyBase(ctx, { giveStoneTax: 0.1 }) })
  })
  await app.start()
  try {
    const bot = app.bots[0] as TestBot
    const buildSession = (mentions: string[]) => buildMessageSession.call(bot, {
      event_name: 'message', body: { message_id: 'mention-regression', sender_id: 'wxid_sender',
        chat_id: 'audit@chatroom', room_id: 'audit@chatroom', is_group: true, at_user_list: mentions,
        create_time: Date.now() / 1000 },
    }, '送灵石 100', []) as Session
    const target = buildSession(['wxid_robot', 'wxid_target'])
    assert.equal(target.stripped.atSelf, true)
    assert.equal(getAtId(target), 'wxid_target')
    const reply = (await target.execute(target.stripped.content, true)).join('')
    assert.match(reply, /给目标成员道友/)
    assert.deepEqual(calls, [
      { action: 'cost', userId: 'wxid_sender', amount: 100 },
      { action: 'gain', userId: 'wxid_target', amount: 90 },
    ])
    const alone = buildSession(['wxid_robot'])
    assert.match((await alone.execute(alone.stripped.content, true)).join(''), /请 @ 要赠送的道友/)
    assert.equal(calls.length, 2)
  } finally { await app.stop() }
})
