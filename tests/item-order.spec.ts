import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { App, Bot, type Context } from 'koishi'

const require = createRequire(__filename)
const root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { sortByItemGrade } = require(resolve(root, 'lib/item-order.js'))
const { GameData } = require(resolve(root, 'lib/data.js'))
const { applyBack } = require(resolve(root, 'lib/modules/back.js'))
const { applyInfo } = require(resolve(root, 'lib/modules/info.js'))
const { applyForgetSkill } = require(resolve(root, 'lib/forget-skill.js'))
const { applyViewTechniques } = require(resolve(root, 'lib/view-techniques.js'))

test('品阶从高到低：仙阶上品、药材品数、装备档次及同阶编号均可比较，排序不修改输入', () => {
  for (const { levels, expected } of [
    { levels: ['人阶下品', '仙阶下品', '仙阶上品', '天阶上品'], expected: [3, 2, 4, 1] },
    { levels: ['一品药材', '九品药材', '三品药材', '八品药材'], expected: [2, 4, 3, 1] },
    { levels: ['下品符器', '上品仙器', '下品仙器', '上品通天法器'], expected: [2, 3, 4, 1] },
  ]) {
    const infos = new Map(levels.map((level, id) => [id + 1, { level }]))
    const input = [4, 1, 3, 2], before = [...input]
    assert.deepEqual(sortByItemGrade(input, { getItem: (id: number) => infos.get(id) }, (id: number) => id), expected)
    assert.deepEqual(input, before)
  }
  const same = { getItem: (id: number) => id === 99 ? undefined : { level: '仙阶上品' } }
  assert.deepEqual(sortByItemGrade([99, 9, 2], same, (id: number) => id), [2, 9, 99])
})

test('没有品阶时 rank 越小等级越高，字符串数字有效，空值不被视为最高等级', () => {
  const ranks = [50, '18', 30, null, '', NaN, 0]
  const data = { getItem: (id: number) => ({ rank: ranks[id - 1] }) }
  assert.deepEqual(sortByItemGrade([7, 4, 1, 3, 2, 6, 5], data, (id: number) => id), [2, 3, 1, 4, 5, 6, 7])
})

class TestBot extends Bot<any> {
  static inject = ['satori', 'koishi']
  constructor(ctx: Context) { super(ctx, {}, 'webridge'); this.user = { id: 'fake' } }
  async sendMessage(): Promise<string[]> { throw new Error('排序测试不能发消息') }
}

async function fixture() {
  const app = new App(), data = new GameData()
  const choose = (type: string, level: string) => {
    const pair = Object.entries(data.getItemsByType([type])).find(([, info]: any) => info.level === level)
    assert.ok(pair, `${type} ${level}`)
    return Number(pair[0])
  }
  const pairs = {
    功法: [choose('功法', '人阶下品'), choose('功法', '仙阶下品')],
    神通: [choose('神通', '人阶下品'), choose('神通', '仙阶上品')],
    辅修功法: [choose('辅修功法', '人阶下品'), choose('辅修功法', '天阶上品')],
    装备: [choose('法器', '下品符器'), choose('防具', '上品仙器')],
    药材: [choose('药材', '一品药材'), choose('药材', '九品药材')],
    丹药: Object.keys(data.getItemsByType(['丹药'])).map(Number).sort((a, b) => Number(data.getItem(b).rank) - Number(data.getItem(a).rank)).filter((_, index, arr) => index === 0 || index === arr.length - 1),
  }
  const learned = ['功法', '神通', '辅修功法'].flatMap(type => (pairs as any)[type].map((skillId: number) => ({ skillId, skillType: type })))
  const backs = Object.entries(pairs).flatMap(([type, ids]) => ids.map((goodsId, index) => ({ goodsId, goodsType: type, goodsName: data.getItem(goodsId).name, goodsNum: index + 3, state: type === '装备' && index === 1 ? 1 : 0 })))
  backs.splice(1, 0, { goodsId: 999999, goodsType: '功法', goodsName: '缺失资料的功法', goodsNum: 7, state: 0 })
  const player = { userId: 'test', userName: '测试玩家', root: '火灵根', rootType: '真灵根', level: '筑基境中期', exp: 100, hp: 50, mp: 100, atk: 10, atkPractice: 0, levelUpRate: 0, sectId: 0 }
  app.provide('xiuxian', { data, getPlayer: async () => player, getRealPlayer: async () => player,
    getLearnedSkills: async () => learned, getBack: async () => backs, getBuff: async () => ({ faqiBuff: 0, armorBuff: 0 }), getStoneForUser: async () => 1 })
  app.plugin(TestBot)
  applyBack(app, {}); applyInfo(app, {}); applyForgetSkill(app); applyViewTechniques(app)
  await app.start()
  return { app, data, pairs, learned, backs, before: structuredClone({ player, learned, backs }), player,
    async run(command: string) {
      const session = app.bots[0].session({ type: 'message', user: { id: 'test' }, guild: { id: 'test@chatroom' }, channel: { id: 'test@chatroom', type: 0 } })
      return String(await session.execute(command, true))
    },
  }
}

function assertOrdered(text: string, high: string, low: string) {
  assert.ok(text.includes(high) && text.includes(low), '列表条目不能遗漏')
  assert.ok(text.indexOf(high) < text.indexOf(low), `${high} 应排在 ${low} 前面`)
}

test('背包保留分类、数量、装备标记与缺失资料物品，每类按等级降序', async () => {
  const f = await fixture()
  try {
    const reply = await f.run('我的背包')
    for (const [type, [low, high]] of Object.entries(f.pairs)) {
      assert.match(reply, new RegExp(`☆------${type}------☆`))
      assertOrdered(reply, f.data.getItem(high).name, f.data.getItem(low).name)
    }
    assert.match(reply, /缺失资料的功法 x7/)
    assert.ok(reply.includes(`${f.data.getItem(f.pairs.装备[1]).name} x4（已装备）`))
    assertOrdered(reply.split('☆------功法------☆')[1].split('☆------')[0], f.data.getItem(f.pairs.功法[0]).name, '缺失资料的功法')
    assert.equal(await f.run('我的物品'), reply)
    assert.deepEqual({ player: f.player, learned: f.learned, backs: f.backs }, f.before)
  } finally { await f.app.stop() }
})

test('已学功法、辅修功法与神通按品阶降序，神通仍显示原物品编号', async () => {
  const f = await fixture()
  try {
    const techniques = await f.run('我的功法'), skills = await f.run('我的神通')
    for (const type of ['功法', '辅修功法'] as const) assertOrdered(techniques, f.data.getItem(f.pairs[type][1]).name, f.data.getItem(f.pairs[type][0]).name)
    assertOrdered(skills, f.data.getItem(f.pairs.神通[1]).name, f.data.getItem(f.pairs.神通[0]).name)
    assert.match(skills, /仙阶上品/)
    assert.ok(skills.includes(`${f.pairs.神通[1]}、`))
    assert.deepEqual({ player: f.player, learned: f.learned, backs: f.backs }, f.before)
  } finally { await f.app.stop() }
})

test('角色面板中的三类已学技能也保持同一排序和品阶显示', async () => {
  const f = await fixture()
  try {
    const reply = await f.run('我的修仙信息')
    for (const type of ['功法', '辅修功法', '神通'] as const) assertOrdered(reply, f.data.getItem(f.pairs[type][1]).name, f.data.getItem(f.pairs[type][0]).name)
    assert.match(reply, /【仙阶上品】/)
    assert.match(reply, /【仙阶下品】/)
    assert.deepEqual({ player: f.player, learned: f.learned, backs: f.backs }, f.before)
  } finally { await f.app.stop() }
})
