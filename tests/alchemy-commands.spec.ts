import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(__filename)
const root = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const { applyAlchemy } = require(resolve(root, 'lib/alchemy-commands'))
function fixture(recipes: any[] = [], items: Record<string, any> = {}) {
  const actions = new Map<string, Function>(), disposers: Function[] = []
  let release: Function, calls = 0, stock = 5, bound = 0, character = 1, allowed = true, fail = false
  const ctx = {
    on: (_: string, f: Function) => disposers.push(f), filter: () => allowed,
    command: (name: string) => ({ action: (f: Function) => actions.set(name, f) }),
    xiuxian: {
      getPlayer: async () => ({ createTime: character }),
      getBack: async () => [{ goodsId: 99, goodsType: '炼丹炉', goodsNum: 1 }, { goodsId: 1, goodsNum: stock, bindNum: bound }],
      data: { getItem: (id: number) => items[id] || ({ item_type: '药材' }), getItemsByType: () => ({}),
        findItemsByName: (query: string) => Object.entries(items).filter(([, info]) => info.name === query) },
    },
  }
  applyAlchemy(ctx, {}, { scan: async () => { calls++; await new Promise(r => { release = r }); if (fail) throw Error('扫描失败'); return recipes } })
  const session = { userId: 'fixture', platform: 'fixture' }
  return {
    list: (input: string | number = '') => actions.get('xiuxian/炼丹 [query:text]')!({ session }, input),
    craft: () => actions.get('xiuxian/炼制 <num:integer> [quantity:integer]')!({ session }, 1),
    release: () => release!(), calls: () => calls, stock: () => stock++, bound: () => bound++, character: () => character++,
    setStock: (value: number) => { stock = value },
    materials: (num = 1) => actions.get('xiuxian/炼丹材料 <num:integer>')!({ session }, num),
    deny: () => { allowed = false }, fail: () => { fail = true }, dispose: () => disposers.forEach(f => f()),
  }
}
const tick = () => new Promise(r => setImmediate(r))
test('相同库存合并扫描，空结果可缓存，库存变化触发新扫描，失败后可重试', async () => {
  const f = fixture(), first = f.list(), second = f.list()
  await tick(); assert.equal(f.calls(), 1); f.release()
  assert.match(await first, /未检测到/); await second
  assert.match(await f.list(), /未检测到/); assert.equal(f.calls(), 1)
  f.stock(); const changed = f.list(); await tick(); assert.equal(f.calls(), 2)
  f.stock(); assert.match(await f.list(), /仍在扫描/)
  f.fail(); f.release(); assert.match(await changed, /扫描失败/)
  const retry = f.list(); await tick(); assert.equal(f.calls(), 3); f.release(); await retry
})

test('翻页和材料明细读取实时库存，合并同种材料用量且保留原序号，不重新扫描或消耗', async () => {
  const recipes = Array.from({ length: 10 }, (_, i) => ({ elixirId: i + 100, elixirName: `测试丹${i + 1}`, desc: '药效',
    mainId: 1, mainName: '测试药', mainNum: 1, yaoyinId: 1, yaoyinName: '测试药', yaoyinNum: 1,
    fuyaoId: 1, fuyaoName: '测试药', fuyaoNum: 1, materialPolicy: 'unbound', formulaShort: '测试药3份' }))
  const f = fixture(recipes), first = f.list(); await tick(); f.release()
  assert.match(await first, /最多1炉/)
  assert.match(await f.materials(), /单炉3，库存5，绑定0，未绑定5/)
  f.setStock(2)
  const page = await f.list(2)
  assert.match(page, /6、测试丹6【不绑定，最多0炉/)
  assert.equal(f.calls(), 1)
  assert.match(await f.materials(6), /当前最多可炼0炉/)
  assert.match(await f.materials(0), /没有这个序号/)
  f.character(); assert.match(await f.materials(), /请先发送/)
})

test('普通丹药无合成配方时明确说明，已存在的配方缓存仍可查询', async () => {
  const { GameData } = require(resolve(root, 'lib/data'))
  const data = new GameData(), f = fixture([], data.items)
  for (const name of ['渡厄丹', '幻心玄丹']) {
    assert.ok(data.findItemsByName(name).length)
    assert.match(await f.list(name), /当前没有合成配方，无法通过炼丹获得/)
  }
  assert.equal(f.calls(), 0)
})
test('扫描中重入仙途、停用群或热重载不回填旧配方', async () => {
  for (const change of ['character', 'deny', 'dispose'] as const) {
    const f = fixture(), pending = f.list(); await tick(); f[change](); f.release()
    assert.match(await pending, change === 'character' ? /角色状态已变化/ : /^$/)
    assert.match(await f.craft(), /请先发送/)
  }
})

test('搜索和不绑定过滤保留全局炼制序号，纯绑定数变化使缓存失效', async () => {
  const recipes = Array.from({ length: 36 }, (_, i) => ({ elixirId: i + 1, elixirName: `丹药${i + 1}`, desc: '药效', formulaShort: '药材3份', materialPolicy: i % 2 ? 'any' : 'unbound' }))
  const f = fixture(recipes), first = f.list(); await tick(); f.release(); await first
  assert.match(await f.list('丹药26'), /26、丹药26/)
  assert.equal(f.calls(), 1)
  assert.match(await f.list('不绑定'), /18 种丹药，18 个方案/)
  assert.match(await f.list(2), /11、丹药11/)
  assert.match(await f.list('不存在的丹'), /没有符合条件/)
  assert.match(await f.list('全部 8'), /36、丹药36/)
  f.bound(); const refresh = f.list('不绑定'); await tick(); assert.equal(f.calls(), 2); f.release(); await refresh
})
