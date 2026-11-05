import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type { Context, Session } from 'koishi'
import { createNameResolver as createStandardNameResolver, readableName } from '../src/wechat-profile'

const require = createRequire(__filename)
const directory = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const plugin = (file: string) => require(resolve(directory, 'lib', file))
const profile = plugin('wechat-profile.js')
const { GameData } = plugin('data.js')
const gameData = new GameData()

function session(group = '甲群', account = '账号一', userId = 'wxid_alice') {
  return { platform: 'webridge', userId, guildId: group, channelId: group, selfId: account,
    event: { user: { id: userId, name: '消息昵称' }, member: { nick: '消息群昵称' } },
    username: '会话昵称', bot: { deviceAccountId: account }, elements: [{ type: 'at', attrs: { id: 'wxid_bob' }, children: [] }],
  } as unknown as Session
}
function context(member?: (s: Session, id: string) => Promise<any>) {
  return { lookup: member } as unknown as Pick<Context, 'get'>
}

function bindBot(ctx: any, s: Session) {
  ;(s.bot as any).getGuildMember = async (guild: string, id: string) => {
    assert.equal(guild, s.guildId)
    const row = await ctx.lookup?.(s, id)
    return row && { nick: row.roomNickname, user: { id, nick: row.nickname } }
  }
  return s
}
function createNameResolver(timeout: number) {
  const resolve = createStandardNameResolver(timeout)
  return (ctx: Pick<Context, 'get'>, s: Session, id: string, fallback?: string) => resolve(ctx, bindBot(ctx, s), id, fallback)
}

test('按当前账号和当前群查询；同一消息合并查询，下一条消息刷新昵称', async () => {
  const resolveName = createNameResolver(50), calls: Session[] = []
  let suffix = '旧'
  const ctx = context(async (s, id) => { calls.push(s); return { roomNickname: `${s.selfId}/${s.guildId}/${id}/${suffix}`, nickname: '微信昵称' } })
  const a = session(), b = session('乙群'), c = session('甲群', '账号二')
  const names = await Promise.all([resolveName(ctx, a, a.userId!), resolveName(ctx, a, a.userId!), resolveName(ctx, b, b.userId!), resolveName(ctx, c, c.userId!)])
  assert.equal(calls.length, 3)
  assert.equal(calls[0], a)
  assert.equal(new Set(names).size, 3)
  suffix = '新'
  assert.match(await resolveName(ctx, session(), a.userId!), /新$/)
})

test('群昵称、微信昵称、消息昵称、原道号的回退；不借用发言人昵称冒充目标', async () => {
  const resolveName = createNameResolver(20)
  assert.equal(await resolveName(context(async () => ({ roomNickname: '群名片', nickname: '微信昵称' })), session(), 'wxid_alice', '道号'), '群名片')
  assert.equal(await resolveName(context(async () => ({ roomNickname: ' ', nickname: '微信昵称' })), session(), 'wxid_alice', '道号'), '微信昵称')
  assert.equal(await resolveName(context(), session(), 'wxid_alice', '道号'), '消息群昵称')
  assert.equal(await resolveName(context(), session(), 'wxid_bob', '乙道号'), '乙道号')
  assert.equal(await resolveName(context(), session(), 'wxid_bob', 'wxid_bob'), '无名道友')
  assert.equal(await resolveName(context(async () => { throw Error('离线') }), session(), 'wxid_bob', '乙道号'), '乙道号')
  assert.equal(await resolveName(context(() => new Promise(() => {})), session(), 'wxid_bob', '乙道号'), '乙道号')
})

test('昵称只作文字；其他平台不查询微信成员资料', async () => {
  assert.equal(readableName(' \n<at id="all"/>\u0000 '), '＜at id="all"/＞')
  assert.equal(readableName('wxid_unknown'), undefined)
  let called = false
  const s = session(); Object.defineProperty(s, 'platform', { value: 'onebot' })
  assert.equal(await profile.displayName(context(async () => { called = true }), s, '12345', '原道号'), '原道号')
  assert.equal(called, false)
})

function fixture() {
  const actions = new Map<string, (...args: any[]) => Promise<string>>()
  const players = [
    { userId: 'wxid_alice', platform: 'webridge', userName: '自定义道号甲', rootType: '天灵根', root: '金', level: '江湖好手', exp: 1000, power: 100, hp: 500, mp: 1000, atk: 100, atkPractice: 0, levelUpRate: 0, sectId: 1, sectPosition: 0, sectContribution: 50 },
    { userId: 'wxid_bob', platform: 'webridge', userName: 'wxid_bob', rootType: '天灵根', root: '水', level: '江湖好手', exp: 800, power: 80, hp: 400, mp: 800, atk: 80, atkPractice: 0, levelUpRate: 0, sectId: 1, sectPosition: 4, sectContribution: 10 },
  ]
  let suffix = ''
  const lookups: { group: string; id: string; account: string }[] = []
  const ctx: any = {
    async lookup(s: Session, id: string) {
      lookups.push({ group: s.guildId!, id, account: s.selfId })
      return { roomNickname: `${s.guildId}-${id === 'wxid_alice' ? '群昵称甲' : '群昵称乙'}${suffix}`, nickname: '微信昵称' }
    },
    command(name: string) { const command: any = { alias() { return command }, action(action: any) { actions.set(name.split(' ')[0], action); return command } }; return command },
    model: { extend() {} }, setInterval() {},
    database: { async get(table: string) { if (table === 'xiuxian_shop') return [
      { id: 1, goodsName: '回血丹', goodsType: '丹药', price: 100, sellerId: 'wxid_bob', sellerName: '过期卖家名字' },
      { id: 2, goodsName: '凝气丹', goodsType: '丹药', price: 50, sellerId: '0', sellerName: '神秘人' },
    ]; return players } },
  }
  const srv: any = ctx.xiuxian = {
    ctx, data: gameData,
    async getPlayer(id: string) { return players.find(p => p.userId === id) },
    async getRealPlayer(id: string) { return players.find(p => p.userId === id) },
    async getBuff() { return { faqiBuff: 0, armorBuff: 0, mainBuff: 0, secBuff: 0 } },
    async getLearnedSkills() { return [] }, async getSecSkillIds() { return [] }, async getExercises() { return undefined }, async syncEquipBuffs() {},
    async getStoneForUser() { return 1000 }, async costStoneForUser() { return true }, async gainStoneForUser() {},
    async realmTop() { return players }, async powerTop() { return players }, async stoneTop() { return players.map(p => ({ ...p, stone: 1000 })) },
    async getSectMembers() { return players.slice() },
    async getSectById() { return { sectName: '测试宗门' } },
    async getBack() { return [{ goodsId: 999999, goodsName: '测试丹药', goodsType: '丹药', goodsNum: 1, state: 0 }] },
  }
  plugin('modules/base.js').applyBase(ctx, { giveStoneTax: 0.1 })
  plugin('modules/info.js').applyInfo(ctx, {})
  plugin('modules/back.js').applyBack(ctx, {})
  plugin('modules/sect.js').applySect(ctx, {})
  plugin('modules/shop.js').applyShop(ctx, {})
  return { ctx, srv, players, lookups, actions, rename() { suffix = '已更新' }, run(name: string, s = session(), ...args: any[]) { assert.ok(actions.has('xiuxian/' + name), name); return actions.get('xiuxian/' + name)!({ session: bindBot(ctx, s) }, ...args) } }
}

test('真实面板与三类排行榜按当前群显示，旧角色无需改库；道号保留', async () => {
  const f = fixture(), before = structuredClone(f.players)
  const info = await f.run('我的修仙信息')
  assert.match(info, /^甲群-群昵称甲 道友的信息/)
  assert.match(info, /道号：自定义道号甲/)
  assert.match(await f.run('我的状态'), /^甲群-群昵称甲 道友的状态/)
  assert.match(await f.run('我的背包'), /^甲群-群昵称甲 道友的背包/)
  for (const type of ['境界', '灵石', '战力']) {
    const rank = await f.run('排行榜', session('乙群'), type)
    assert.match(rank, /乙群-群昵称甲/); assert.match(rank, /乙群-群昵称乙/)
    assert.doesNotMatch(rank, /wxid_|甲群-/)
  }
  f.rename()
  assert.match(await f.run('我的状态'), /^甲群-群昵称甲已更新/)
  assert.deepEqual(f.players, before)
  assert.ok(f.lookups.every(q => q.account === '账号一'))
})

test('建号取群昵称；宗门、赠送灵石和坊市使用目标成员昵称', async () => {
  const f = fixture()
  let savedName = ''
  f.srv.createPlayer = async (_s: Session, _root: string, _type: string, _power: number, name: string) => { savedName = name; return '您已迈入修仙世界' }
  await f.run('我要修仙')
  assert.equal(savedName, '甲群-群昵称甲')
  assert.match(await f.run('宗门成员查看'), /甲群-群昵称乙/)
  assert.match(await f.run('送灵石', session(), 100), /给甲群-群昵称乙道友/)
  const shop = await f.run('坊市查看')
  assert.match(shop, /卖家：甲群-群昵称乙/)
  assert.match(shop, /卖家：神秘人/)
  assert.doesNotMatch(shop, /过期卖家名字/)
})

test('灵石榜保留玩家 ID 供查名，战斗群昵称与结算身份分离', async () => {
  const f = fixture()
  const { XiuxianService } = plugin('service.js')
  const rank = await XiuxianService.prototype.stoneTop.call({ ctx: f.ctx, getStoneForUser: async () => 1000 })
  assert.equal(rank[0].userId, 'wxid_alice')
  const { buildFighter } = plugin('combat-stats.js')
  const fighter = await buildFighter(f.srv, 'wxid_alice', bindBot(f.ctx, session()))
  assert.equal(fighter.name, '自定义道号甲')
  assert.equal(fighter.displayName, '甲群-群昵称甲')
  const { playerFight } = plugin('utils.js')
  // 补齐暴击倍率，避免随机命中零暴击率边界时产生 NaN。
  const [log, victor, hp, victorId] = playerFight(
    { userId: '甲', name: '原道号甲', displayName: '同名群昵称', hp: 1, atk: 1, mp: 0, crit: 0, critDamage: 1.5, defense: 0 },
    { userId: '乙', name: '原道号乙', displayName: '同名群昵称', hp: 1000, atk: 1000, mp: 0, crit: 0, critDamage: 1.5, defense: 0 },
  )
  assert.equal(victor, '原道号乙')
  assert.equal(victorId, '乙')
  assert.equal(hp.甲 <= 0, true)
  assert.ok(log.every((line: string) => !line.includes('原道号')))
  assert.match(log.at(-1), /同名群昵称胜/)
  const duplicate = playerFight(
    { userId: '甲', name: '相同道号', displayName: '甲群昵称', hp: 1, atk: 1, mp: 0, crit: 0, critDamage: 1.5, defense: 0 },
    { userId: '乙', name: '相同道号', displayName: '乙群昵称', hp: 1000, atk: 1000, mp: 0, crit: 0, critDamage: 1.5, defense: 0 },
  )
  assert.equal(duplicate[3], '乙')
  assert.equal(duplicate[0].at(-1), '乙群昵称胜')
})
