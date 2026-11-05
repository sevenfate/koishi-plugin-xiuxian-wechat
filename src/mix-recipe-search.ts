import type { MixRecipe, YaocaiEntry } from '../lib/mix-elixir-util'
import { recipeMaterials } from './mix-recipe-list'

export type InventoryHerb = YaocaiEntry & { bindNum?: number }
export type RecipeChoice = MixRecipe & { materialPolicy?: 'unbound' | 'any'; maxBatches?: number }

/** 两种库存分别选最优方案，避免最省材料方案遮住可交易的成丹方案。 */
export function findMixRecipeChoices(herbs: InventoryHerb[], items: Record<string, any>): RecipeChoice[] {
  const free = herbs.map(x => ({ ...x, num: Math.max(0, x.num - Math.max(0, Number(x.bindNum) || 0)) }))
  const plain = findBestMixRecipes(free, items), all = findBestMixRecipes(herbs, items)
  const stock = new Map(herbs.map(x => [x.id, x.num])), freeStock = new Map(free.map(x => [x.id, x.num]))
  const batches = (r: MixRecipe, inventory: Map<number, number>) => Math.min(...[...recipeMaterials(r)].map(([id, m]) => Math.floor((inventory.get(id) || 0) / m.num)))
  const result: RecipeChoice[] = plain.map(r => ({ ...r, materialPolicy: 'unbound', maxBatches: batches(r, freeStock) }))
  for (const r of all) {
    const safe = plain.find(p => p.elixirId === r.elixirId)
    const same = safe && ['mainId', 'mainNum', 'yaoyinId', 'yaoyinNum', 'fuyaoId', 'fuyaoNum'].every(k => (safe as any)[k] === (r as any)[k])
    if (same && batches(r, stock) === batches(r, freeStock)) continue
    result.push({ ...r, materialPolicy: 'any', maxBatches: batches(r, stock) })
  }
  return result.sort((a, b) => a.elixirId - b.elixirId || Number(a.materialPolicy === 'any') - Number(b.materialPolicy === 'any'))
}

const number = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0
type Role = { herb: YaocaiEntry; amount: number; type: string; power: number; heat: number }

/** 主药/辅药决定成丹，药引只需平衡冷热。先索引药引，避免枚举三种药材的笛卡尔积。 */
export function findBestMixRecipes(input: YaocaiEntry[], items: Record<string, any>): MixRecipe[] {
  const stock = new Map<number, YaocaiEntry>()
  for (const herb of input) if (Number.isSafeInteger(herb.id) && herb.id > 0 && Number.isFinite(herb.num) && herb.num > 0) {
    stock.set(herb.id, { ...herb, num: Math.floor(herb.num) })
  }
  const mains: Role[] = [], supplements: Role[] = [], reagents = new Map<number, Role[]>()
  for (const herb of [...stock.values()].sort((a, b) => a.id - b.id)) {
    for (let amount = 1; amount <= Math.min(herb.num, 5); amount++) {
      const main = herb.info['主药'], reagent = herb.info['药引'], supplement = herb.info['辅药']
      const role = (info: any, defaultType: number): Role => ({ herb, amount, type: String(info?.type ?? defaultType),
        power: number(info?.power) * amount, heat: number(info?.h_a_c?.type) * number(info?.h_a_c?.power) * amount })
      mains.push(role(main, 2)); supplements.push(role(supplement, 3))
      const yy = role(reagent, 2)
      if (!reagents.has(yy.heat)) reagents.set(yy.heat, [])
      reagents.get(yy.heat)!.push(yy)
    }
  }
  for (const pool of reagents.values()) pool.sort((a, b) => a.amount - b.amount || a.herb.id - b.herb.id)
  const formulas = new Map<string, Array<{ id: number; keys: string[]; config: Record<string, number>; score: number; order: number }>>()
  Object.entries(items).forEach(([key, item], order) => {
    if (!item.elixir_config) return
    const keys = Object.keys(item.elixir_config).sort(), signature = JSON.stringify(keys)
    if (!formulas.has(signature)) formulas.set(signature, [])
    formulas.get(signature)!.push({ id: Number(key), keys, config: item.elixir_config,
      score: Object.values(item.elixir_config).reduce<number>((sum, value) => sum + number(value), 0), order })
  })
  for (const pool of formulas.values()) pool.sort((a, b) => b.score - a.score || a.order - b.order)
  const matches = new Map<string, { id: number; config: Record<string, number> }>()
  const best = new Map<number, MixRecipe>()
  for (const main of mains) {
    const pool = reagents.get(-main.heat)
    if (!pool) continue
    for (const supplement of supplements) {
      if (main.herb.id === supplement.herb.id && main.amount + supplement.amount > main.herb.num) continue
      const key = JSON.stringify([main.type, main.power, supplement.type, supplement.power])
      let match = matches.get(key)
      if (!match) {
        // 保持原规则：同类型辅药覆盖主药贡献；效果键必须完全匹配，优先最高药效配方。
        const config = { [main.type]: main.power, [supplement.type]: supplement.power }
        const options = formulas.get(JSON.stringify(Object.keys(config).sort())) || []
        const found = options.find(x => x.keys.every(k => config[k] >= x.config[k]))
        match = { id: found?.id || 0, config }; matches.set(key, match)
      }
      if (!match.id) continue
      // 给定主药、辅药后，只需最省数量且 ID 最小的合法药引；其他选择不可能更优。
      const reagent = pool.find(x => x.herb.id !== main.herb.id && main.amount + supplement.amount + x.amount <= 10
        && (x.herb.id !== supplement.herb.id || x.amount + supplement.amount <= x.herb.num))
      if (!reagent) continue
      const previous = best.get(match.id)
      const order = [main.amount + reagent.amount + supplement.amount, main.herb.id, reagent.herb.id, supplement.herb.id, main.amount, reagent.amount, supplement.amount]
      if (previous) {
        const old = [previous.mainNum + previous.yaoyinNum + previous.fuyaoNum, previous.mainId, previous.yaoyinId, previous.fuyaoId, previous.mainNum, previous.yaoyinNum, previous.fuyaoNum]
        const index = order.findIndex((value, i) => value !== old[i])
        if (index < 0 || order[index] > old[index]) continue
      }
      const item = items[String(match.id)]
      best.set(match.id, {
        elixirId: match.id, elixirName: item.name, desc: item.desc ?? '',
        mainId: main.herb.id, mainName: main.herb.info.name, mainNum: main.amount, mainLevel: main.herb.info.level ?? '',
        yaoyinId: reagent.herb.id, yaoyinName: reagent.herb.info.name, yaoyinNum: reagent.amount, yaoyinLevel: reagent.herb.info.level ?? '',
        fuyaoId: supplement.herb.id, fuyaoName: supplement.herb.info.name, fuyaoNum: supplement.amount, fuyaoLevel: supplement.herb.info.level ?? '',
        formulaShort: `主药${main.herb.info.name}${main.amount}药引${reagent.herb.info.name}${reagent.amount}辅药${supplement.herb.info.name}${supplement.amount}`,
        elixirConfig: match.config,
      })
    }
  }
  return [...best.values()].sort((a, b) => a.elixirId - b.elixirId)
}
