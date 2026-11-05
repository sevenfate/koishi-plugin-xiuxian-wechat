import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(__filename), root = process.env.XIUXIAN_PACKAGE_DIR || resolve(__dirname, '..')
const { allocateBossRewards, bossSupplies, rareBossItem, rewardItems, rewardDay, rewardWeek, rewardIndex, stoneGuarantee, contributionMerit } = require(resolve(root, 'lib/boss-rewards'))
const data = new (require(resolve(root, 'lib/data')).GameData)()

test('新奖池按20/80分完，人数封顶回流，遁走按真实进度减半', () => {
  const boss = { maxHp: 672106, expReward: 22403, stone: 13442 }
  const result = allocateBossRewards(boss, [{ userId: 'a', damage: 369661 }, { userId: 'b', damage: 302445 }], 'kill', 'a')
  assert.deepEqual(result.map((x: any) => [x.exp, x.stone]), [[12098, 7259], [10305, 6183]])
  const capped = allocateBossRewards({ maxHp: 100, expReward: 1000, stone: 1000 }, [{ userId: 'a', damage: 99 }, { userId: 'b', damage: 1 }], 'kill')
  assert.deepEqual(capped.map((x: any) => x.exp), [700, 300])
  const escape = allocateBossRewards({ maxHp: 100, expReward: 1000, stone: 1000 }, [{ userId: 'a', damage: 1 }], 'escape')
  assert.equal(escape[0].exp, 5)
  assert.deepEqual(allocateBossRewards(boss, [{ userId: 'a', damage: 0 }], 'kill'), [])
})

test('多人数与小整数奖池的总额、单人上限、输入顺序稳定', () => {
  let seed = 301
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let i = 0; i < 200; i++) {
    const n = 1 + Math.floor(random() * 50), total = Math.floor(random() * 100000), cap = n === 1 ? 1 : n === 2 ? 0.7 : n === 3 ? 0.5 : 0.4
    const rows = Array.from({ length: n }, (_, j) => ({ userId: String(j), damage: 1 + Math.floor(random() * 100000) }))
    const boss = { maxHp: rows.reduce((s, r) => s + r.damage, 0), expReward: total, stone: total }
    const shares = allocateBossRewards(boss, rows, 'kill')
    assert.equal(shares.reduce((sum: number, x: any) => sum + x.exp, 0), total)
    assert.ok(shares.every((x: any) => x.exp >= 0 && x.exp <= Math.ceil(total * cap)))
    assert.deepEqual(shares, allocateBossRewards(boss, [...rows].reverse(), 'kill'))
  }
})

test('所有境界均可提供不越级的保底物资，稀有只选可用同大境界，空档不降阶', () => {
  for (let index = 0; index < data.levelOrder.length; index++) {
    const gifts = bossSupplies(data, index, () => 0.1)
    const herbs = gifts.filter((x: any) => data.getItem(x.id).item_type === '药材')
    assert.equal(new Set(herbs.map((x: any) => x.id)).size, 3)
    assert.ok(gifts.every((x: any) => x.bound))
    for (const gift of gifts.filter((x: any) => data.getItem(x.id).item_type === '丹药')) assert.ok(50 - Number(data.getItem(gift.id).rank) <= index)
    const rare = rareBossItem(data, index, () => 0.1)
    if (rare) {
      assert.ok(rare.index <= index)
      const major = (x: string) => x.replace(/(?:初期|中期|圆满)$/, '')
      assert.equal(major(data.levelOrder[rare.index]), major(data.levelOrder[index]))
    }
  }
  assert.equal(rareBossItem(data, 1), undefined)
  assert.ok(rareBossItem(data, 3))
  assert.ok(rewardItems(data, ['功法'], 5, true).length)
})

test('奖励档取快照、当前境界与难度较低者，UTC+8日周边界稳定', () => {
  assert.equal(contributionMerit(Math.floor(22505 * 0.15), 22505, 9, false), 14)
  assert.equal(contributionMerit(Math.floor(22505 * 0.15) * 2, 22505, 9, false), 16)
  assert.equal(rewardIndex(data, { strength: 1000 }, { level: '金仙境初期' }, '金仙境初期'), 1)
  assert.equal(rewardIndex(data, { strength: 1e9 }, { level: '练气境初期' }, '金仙境初期'), 1)
  assert.deepEqual([6, 7, 12, 13, 24, 25].map(stoneGuarantee), [50000, 100000, 100000, 200000, 200000, 300000])
  assert.equal(rewardDay(Date.UTC(2026, 10, 1, 15, 59)), '2026-11-01')
  assert.equal(rewardDay(Date.UTC(2026, 10, 1, 16)), '2026-11-02')
  assert.equal(rewardWeek(Date.UTC(2026, 10, 1, 15, 59)), '2026-10-26')
  assert.equal(rewardWeek(Date.UTC(2026, 10, 1, 16)), '2026-11-02')
})
