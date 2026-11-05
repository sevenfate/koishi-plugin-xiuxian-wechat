import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, h, type Context, type Session } from '@koishijs/core'

const require = createRequire(__filename)
const { buildSession } = require('./fixtures/message-session.ts')
const directory = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const { applyMentionCompat } = require(resolve(directory, 'lib/wechat-mentions.js'))
const { applyBase } = require(resolve(directory, 'lib/modules/base.js'))
const { applyGamble } = require(resolve(directory, 'lib/modules/gamble.js'))
const { applyCultivate } = require(resolve(directory, 'lib/modules/cultivate.js'))
let sequence = 0

class RoutingBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  deviceAccountId = 'wxid_robot'
  sent: string[] = []
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'webridge' } }
  async getGuildMember(_guild: string, id: string) { return { user: { id }, nick: id === 'wxid_target' ? '目标 群友' : '机器人' } }
  async sendMessage(_channel: string, content: h.Fragment) { this.sent.push(h.normalize(content).join('')); return ['local-test'] }
}

async function fixture(prefix = '') {
  const app = new App({ prefix: [prefix] })
  const changes: { kind: string; id: string; amount: number }[] = [], lookups: string[] = []
  app.plugin(RoutingBot, {})
  app.plugin(ctx => {
    ctx.set('xiuxian' as any, {
      async getPlayer(id: string) { lookups.push(id); return ['wxid_sender', 'wxid_target'].includes(id) ? { userId: id, platform: 'webridge', userName: '原道号', exp: 1000, level: '江湖好手', levelUpRate: 0 } : undefined },
      async getStoneForUser() { return 1000 },
      async costStoneForUser(id: string, amount: number) { changes.push({ kind: 'cost', id, amount }); return true },
      async gainStoneForUser(id: string, amount: number) { changes.push({ kind: 'gain', id, amount }) },
      data: { closingMaxExp() { return 10000 } },
      async addExp(id: string, amount: number) { changes.push({ kind: 'exp', id, amount }) },
      async updatePower() {}, async setLevelRate() {},
    } as any)
    ctx.inject(['xiuxian' as any], ctx => {
      const play = ctx.guild().intersect(s => s.guildId !== 'blocked@chatroom')
      applyBase(play, { giveStoneTax: 0.1 })
      applyGamble(play, { enableVoidDuel: true, voidDuelDailyLimit: 100, voidDuelAcceptTimeout: 60 })
      applyCultivate(play, { closingExpUpperLimit: 1.5 })
      applyMentionCompat(ctx)
    })
  })
  app.command('echo [value:text]').action((_, value) => value)
  await app.start()
  const bot = app.bots[0] as RoutingBot
  return { app, changes, lookups, bot, async message(text: string, ids = ['wxid_target'], group = `test-${++sequence}@chatroom`, options: { platform?: string; authority?: number } = {}) {
    const session = buildSession.call(bot, { event_name: 'message', body: {
      message_id: String(++sequence), sender_id: 'wxid_sender', chat_id: group, room_id: group, is_group: true,
      at_user_list: ids, create_time: Date.now() / 1000,
    } }, text, []) as Session
    if (options.platform) Object.defineProperty(session, 'platform', { value: options.platform })
    if (options.authority !== undefined) Object.defineProperty(session, 'user', { value: { id: 1, authority: options.authority, permissions: [], $update: async () => {} } })
    const original = h.select(session.elements ?? [], 'at').map(el => el.attrs.id)
    const start = bot.sent.length
    await app.parallel('message', session)
    assert.deepEqual(h.select(session.elements ?? [], 'at').map(el => el.attrs.id), original, '原始目标元素不能被改写')
    return { session, replies: bot.sent.slice(start).join('\n') }
  } }
}

test('完整消息流程：只艾特群友的赠送指令可以解析，艾特前后位置与无空格均兼容', async () => {
  const f = await fixture()
  try {
    for (const text of ['送灵石 100', '送灵石@目标 群友\u2005 100', '送灵石 100 @目标 群友\u2005', '/送灵石 @目标 群友 100']) {
      const { session, replies } = await f.message(text)
      assert.match(replies, /给目标 群友道友/)
      assert.equal(session.stripped.atSelf, false, '不能伪造机器人被艾特')
      assert.equal(f.changes.at(-1)?.id, 'wxid_target')
      assert.equal(f.changes.at(-1)?.amount, 90)
    }
    const both = await f.message('送灵石@目标 群友\u2005 100', ['wxid_robot', 'wxid_target'])
    assert.match(both.replies, /给目标 群友道友/)
    assert.equal(both.session.stripped.atSelf, true)
  } finally { await f.app.stop() }
})

test('虚神界对决进入真实发起流程；没有金额时给出提示，不会扣除灵石', async () => {
  const f = await fixture()
  try {
    const duel = await f.message('虚神界对决@目标 群友\u2005 100')
    assert.match(duel.replies, /向 目标 群友 道友发起对决/)
    assert.match(duel.replies, /押注 100 灵石/)
    assert.equal(f.changes.length, 0, '发起时不得提前扣除双方灵石')
    const missing = await f.message('虚神界对决@目标 群友\u2005')
    assert.ok(missing.replies.length > 0, '缺少金额应有可见提示')
    assert.equal(f.changes.length, 0)
    assert.match((await f.message('虚神界对决 100', [])).replies, /请 @ 要发起对决/)
    const forged = await f.message('虚神界对决@目标 群友\u2005 100', [])
    assert.equal(forged.replies, '', '不能从正文伪造艾特目标')
    assert.ok(!f.lookups.includes('webridge') && !f.lookups.includes('wxid_robot'))
  } finally { await f.app.stop() }
})

test('双修同样能解析目标；非修仙聊天、群过滤、指令前缀和其他平台保持原规则', async () => {
  const f = await fixture()
  try {
    assert.match((await f.message('双修@目标 群友\u2005')).replies, /一起修炼/)
    assert.ok(f.changes.some(c => c.kind === 'exp' && c.id === 'wxid_target'))
    const before = f.changes.length
    const blocked = await f.message('送灵石 100', ['wxid_target'], 'blocked@chatroom')
    assert.equal(blocked.replies, '')
    assert.equal(blocked.session.stripped.hasAt, true)
    for (const text of ['echo 你好', '你好@目标 群友', '虚神界对决攻略@目标 群友']) {
      const result = await f.message(text)
      assert.equal(result.replies, '')
      assert.equal(result.session.stripped.hasAt, true)
    }
    assert.equal(f.changes.length, before)
    const otherPlatform = await f.message('送灵石 100', ['wxid_target'], undefined, { platform: 'onebot' })
    assert.equal(otherPlatform.replies, '')
    assert.equal(otherPlatform.session.stripped.hasAt, true)
    const denied = await f.message('神秘力量@目标 群友\u2005 100', ['wxid_target'], undefined, { authority: 0 })
    assert.match(denied.replies, /权限|permission|authority/i)
    assert.equal(f.changes.length, before, '管理指令不能绕过权限')
  } finally { await f.app.stop() }
  const prefixed = await fixture('!')
  try {
    assert.equal((await prefixed.message('送灵石 100')).replies, '')
    assert.match((await prefixed.message('!送灵石@目标 群友\u2005 100')).replies, /给目标 群友道友/)
  } finally { await prefixed.app.stop() }
})
