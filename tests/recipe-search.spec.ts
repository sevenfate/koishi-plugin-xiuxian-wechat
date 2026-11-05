import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { selectMixRecipes, recipeMaterials } from '../src/mix-recipe-list'

const require = createRequire(__filename)
const root = resolve(process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..'))
const { findMixRecipes, tiaohe, checkMix } = require(resolve(root, 'lib/mix-elixir-util'))
const { createRecipeScanner } = require(resolve(root, 'lib/mix-recipe-scanner'))
const { GameData } = require(resolve(root, 'lib/data'))
const { findMixRecipeChoices } = require(resolve(root, 'lib/mix-recipe-search'))
const projection = (r: any) => [r.elixirId, r.mainId, r.yaoyinId, r.fuyaoId, r.mainNum, r.yaoyinNum, r.fuyaoNum, r.elixirConfig]

test('便宜配方使用绑定药材时仍提供不同的非绑定配方，兼任角色合计可炼炉数', () => {
  const hot = { name: '热药', 主药: { type: 2, power: 10, h_a_c: { type: 1, power: 1 } }, 辅药: { type: 3, power: 10 } }
  const cold = { name: '寒药', 药引: { h_a_c: { type: -1, power: 1 } }, 辅药: { type: 3, power: 10 } }
  const herbs = [{ id: 1, info: hot, num: 5, bindNum: 5 }, { id: 2, info: cold, num: 5, bindNum: 0 }, { id: 3, info: hot, num: 5, bindNum: 0 }]
  const items = { 100: { name: '测试丹', elixir_config: { 2: 10, 3: 10 } } }
  const choices = findMixRecipeChoices(herbs, items)
  assert.equal(choices.length, 2)
  assert.equal(choices[0].materialPolicy, 'unbound')
  assert.equal(choices[0].mainId, 3)
  assert.equal(choices[0].maxBatches, 2)
  assert.equal(choices[1].materialPolicy, 'any')
  assert.equal(choices[1].mainId, 1)
  assert.deepEqual(findMixRecipeChoices(herbs.map(x => ({ ...x, bindNum: x.num })), items).map((x: any) => x.materialPolicy), ['any'])
  assert.ok(findMixRecipeChoices(herbs.map(x => ({ ...x, bindNum: 0 })), items).every((x: any) => x.materialPolicy === 'unbound'))
})

// 独立穷举旧规则作对照，不复用优化器的药性索引和剪枝。
function exhaustive(herbs: any[], items: any) {
  const configs = Object.fromEntries(Object.entries(items).map(([id, item]: any) => [id, item.elixir_config]))
  const candidates: any[] = []
  for (const main of herbs) for (const yy of herbs) for (const fy of herbs) {
    if (main.id === yy.id) continue
    for (let a = 1; a <= Math.min(main.num, 5); a++) for (let b = 1; b <= Math.min(yy.num, 5); b++) for (let c = 1; c <= Math.min(fy.num, 5); c++) {
      if (a + b + c > 10 || tiaohe(main.info, a, yy.info, b)) continue
      const elixirConfig = { [String(main.info.主药.type)]: main.info.主药.power * a, [String(fy.info.辅药.type)]: fy.info.辅药.power * c }
      const elixirId = checkMix(elixirConfig, configs)
      if (elixirId) candidates.push({ elixirId, mainId: main.id, yaoyinId: yy.id, fuyaoId: fy.id, mainNum: a, yaoyinNum: b, fuyaoNum: c, elixirConfig })
    }
  }
  return selectMixRecipes(candidates, herbs).map(projection)
}

test('固定随机药性与穷举旧规则等价，包括同类型覆盖、并列药效和兼任库存', () => {
  let seed = 7631
  const rand = (n: number) => ((seed = (seed * 1664525 + 1013904223) >>> 0) % n)
  const items = { 100: { name: '甲', elixir_config: { 2: 2, 3: 2 } }, 101: { name: '乙', elixir_config: { 2: 3, 3: 1 } },
    102: { name: '丙', elixir_config: { 2: 4, 3: 4 } }, 103: { name: '丁', elixir_config: { 2: 2 } }, 104: { name: '戊', elixir_config: { 3: 1 } } }
  for (let i = 0; i < 70; i++) {
    const herbs = Array.from({ length: 3 + rand(3) }, (_, j) => ({ id: j + 1, num: 1 + rand(5), info: { name: `药${j}`,
      主药: { type: 2 + rand(2), power: 1 + rand(4), h_a_c: { type: rand(3) - 1, power: 1 + rand(2) } },
      药引: { h_a_c: { type: rand(3) - 1, power: 1 + rand(2) } }, 辅药: { type: 2 + rand(2), power: 1 + rand(4) } } }))
    assert.deepEqual(findMixRecipes(herbs, items).map(projection), exhaustive(herbs, items), `样本${i}`)
  }
})

test('全部108种药材极大库存在线程内完成，主线程继续响应且结果确定合法', async () => {
  const data = new GameData(), items = data.getItemsByType(['合成丹药'])
  const herbs = Object.entries(data.getItemsByType(['药材'])).map(([id, info]) => ({ id: +id, info, num: 2147483647 }))
  assert.equal(herbs.length, 108)
  const scanner = createRecipeScanner({}), started = Date.now()
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  try {
    const result = await scanner.run(herbs, items)
    assert.ok(result.length > 0 && result.length <= 36)
    assert.ok(ticks > 0, '主线程定时器没有被计算阻塞')
    assert.deepEqual(result.map(projection), findMixRecipes([...herbs].reverse(), items).map(projection))
    assert.ok(result.every((r: any) => r.materialPolicy === 'unbound'))
    for (const r of result) {
      assert.ok(r.mainId !== r.yaoyinId)
      assert.ok(r.mainNum + r.yaoyinNum + r.fuyaoNum <= 10)
      for (const material of recipeMaterials(r).values()) assert.ok(material.num <= 10)
      assert.equal(tiaohe(data.getItem(r.mainId), r.mainNum, data.getItem(r.yaoyinId), r.yaoyinNum), false)
    }
    assert.ok(Date.now() - started < 3000)
  } finally { clearInterval(timer); await scanner.dispose() }
  assert.deepEqual(scanner.stats(), { active: 0, queued: 0, stopped: true })
})

test('超时真正终止线程、排队有界、错误恢复和热重载清理', async () => {
  const workerFile = resolve(__dirname, 'fixtures/recipe-worker.cjs')
  const scanner = createRecipeScanner({}, { workerFile, concurrency: 1, capacity: 2, timeoutMs: 1500 })
  const stalled = scanner.run([{ id: -1 }], {})
  const queued = scanner.run([], {})
  const rejected = Promise.allSettled([stalled, queued])
  await assert.rejects(scanner.run([], {}), /较多/)
  const results = await rejected
  assert.equal(results[0].status, 'rejected')
  assert.deepEqual(scanner.stats(), { active: 0, queued: 0, stopped: false })
  await assert.rejects(scanner.run([{ id: -2 }], {}), /失败|中断/)
  assert.deepEqual(await scanner.run([], {}), [])
  const running = scanner.run([{ id: -1 }], {}), waiting = scanner.run([], {})
  const stopped = Promise.allSettled([running, waiting])
  await scanner.dispose()
  assert.ok((await stopped).every(x => x.status === 'rejected'))
  await assert.rejects(scanner.run([], {}), /停止/)
  assert.equal(scanner.stats().active, 0)
})
