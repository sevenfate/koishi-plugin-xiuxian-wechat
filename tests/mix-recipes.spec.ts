import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { recipeMaterials, renderMixRecipePage, selectMixRecipes } from '../src/mix-recipe-list'
import type { MixRecipe } from '../lib/mix-elixir-util'

const require = createRequire(__filename)
const root = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const { findMixRecipes } = require(resolve(root, 'lib/mix-elixir-util.js'))
const { applyAlchemy } = require(resolve(root, 'lib/alchemy-commands.js'))
const recipe = (id: number, extra = {}): MixRecipe => ({
  elixirId: id, elixirName: `丹药${id}`, desc: `效果${id}`,
  mainId: 1, mainName: '主药', mainNum: 1, mainLevel: '',
  yaoyinId: 2, yaoyinName: '药引', yaoyinNum: 1, yaoyinLevel: '',
  fuyaoId: 3, fuyaoName: '辅药', fuyaoNum: 1, fuyaoLevel: '',
  formulaShort: '主药1药引1辅药1', elixirConfig: {}, ...extra,
})
const herbs = [1, 2, 3, 4].map(id => ({ id, num: 5, info: { name: `药材${id}` } }))

test('千条重复配方按成丹去重，优先最少消耗且不依赖背包或候选顺序', () => {
  const candidates = Array.from({ length: 1200 }, (_, i) => recipe(i % 45 + 1, { mainNum: i < 45 ? 1 : 2 }))
  const result = selectMixRecipes(candidates, herbs)
  assert.equal(result.length, 45)
  assert.ok(result.every(r => r.mainNum === 1))
  assert.deepEqual(selectMixRecipes(candidates.reverse(), [...herbs].reverse()), result)
  const tie = [recipe(1, { fuyaoId: 4 }), recipe(1)]
  assert.equal(selectMixRecipes(tie, herbs)[0].fuyaoId, 3)
})

test('兼任主药和辅药时合计消耗，不推荐实际库存不足的配方', () => {
  const shared = recipe(1, { fuyaoId: 1, fuyaoNum: 5 })
  assert.equal(recipeMaterials(shared).get(1)?.num, 6)
  assert.deepEqual(selectMixRecipes([shared], herbs), [])
  assert.equal(selectMixRecipes([shared, recipe(1)], herbs)[0].fuyaoId, 3)
})

test('全部页可达，序号连续，最后一页及错误页码提示正确', () => {
  const recipes = Array.from({ length: 45 }, (_, i) => recipe(i + 1))
  const first = renderMixRecipePage(recipes, 1), second = renderMixRecipePage(recipes, 5), last = renderMixRecipePage(recipes, 9)
  assert.match(first, /1、丹药1：/)
  assert.match(first, /5、丹药5：/)
  assert.doesNotMatch(first, /21、丹药21：/)
  assert.match(second, /21、丹药21：/)
  assert.match(second, /25、丹药25：/)
  assert.match(second, /上一页：炼丹 4/)
  assert.match(second, /下一页：炼丹 6/)
  assert.match(last, /45、丹药45：/)
  assert.doesNotMatch(last, /下一页/)
  for (const page of [0, -1, 1.5, NaN, 10]) assert.match(renderMixRecipePage(recipes, page), /页码无效/)
})

test('生成器自身完成去重，并校验重复角色的总库存', () => {
  const main = { name: '热药', 主药: { type: 2, power: 10, h_a_c: { type: 1, power: 1 } }, 辅药: { type: 3, power: 10 } }
  const cold = { name: '寒药', 药引: { h_a_c: { type: -1, power: 1 } }, 辅药: { type: 3, power: 10 } }
  const result = findMixRecipes([{ id: 1, info: main, num: 5 }, { id: 2, info: cold, num: 5 }], {
    100: { name: '测试丹', elixir_config: { 2: 10, 3: 10 } },
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].mainNum + result[0].yaoyinNum + result[0].fuyaoNum, 3)
  assert.deepEqual(findMixRecipes([{ id: 1, info: main, num: 1 }, { id: 2, info: cold, num: 1 }], {
    100: { name: '测试丹', elixir_config: { 2: 10, 3: 10 } },
  }), [])
})

test('指令翻页复用同一列表，炼制使用全局序号并重新合计校验库存', async () => {
  const actions = new Map<string, Function>(), reduced: unknown[][] = [], sent: unknown[][] = []
  let scans = 0, stock = 5, furnace = true
  const session = { userId: 'alchemy-test-user' }
  const ctx: any = {
    xiuxian: {
      getPlayer: async () => ({}), getBack: async () => furnace ? [
        { goodsId: 999, goodsType: '炼丹炉', goodsNum: 1 }, { goodsId: 1, goodsNum: stock },
      ] : [],
      data: { getItem: (id: number) => id === 999 ? { item_type: '炼丹炉' } : { item_type: '药材', name: `丹药${id}` }, getItemsByType: () => ({}) },
      getBackItem: async () => ({ goodsNum: stock }),
      reduceBack: async (...args: unknown[]) => reduced.push(args), sendBack: async (...args: unknown[]) => sent.push(args),
    },
    command: (name: string) => ({ action: (callback: Function) => actions.set(name, callback) }),
  }
  ctx.database = { transact: async (cb: Function) => cb({ set: async () => undefined }) }
  const methods: any = {}
  for (const [key, value] of Object.entries(ctx.xiuxian)) if (typeof value === 'function') { methods[key] = value; delete ctx.xiuxian[key] }
  Object.setPrototypeOf(ctx.xiuxian, methods)
  ctx.xiuxian.ctx = ctx; ctx.xiuxian.config = {}
  applyAlchemy(ctx, {}, { scan: async () => { scans++; return Array.from({ length: 45 }, (_, i) => recipe(i + 100, { fuyaoId: 1 })) } })
  const list = actions.get('xiuxian/炼丹 [query:text]')!, craft = actions.get('xiuxian/炼制 <num:integer> [quantity:integer]')!
  assert.match(await list({ session }), /第 1\/9 页/)
  assert.match(await list({ session }, 5), /21、丹药120：/)
  assert.equal(scans, 1)
  stock = 1
  assert.match(await craft({ session }, 21), /药材不足/)
  assert.equal(reduced.length, 0)
  stock = 5
  assert.match(await craft({ session }, 21), /丹成/)
  assert.deepEqual(reduced, [[session.userId, 1, 2, 0], [session.userId, 2, 1, 0]])
  assert.equal(sent[0][1], 120)
  assert.match(await list({ session }, 99), /页码无效/)
  furnace = false
  assert.match(await list({ session }), /没有炼丹炉/)
  assert.match(await craft({ session }, 21), /请先发送/)
})
