import type { MixRecipe, YaocaiEntry } from '../lib/mix-elixir-util'

/** 同一药材兼任多种角色时，按实际消耗总量检查库存。 */
export function recipeMaterials(recipe: MixRecipe) {
  const materials = new Map<number, { name: string; num: number }>()
  for (const [id, name, num] of [
    [recipe.mainId, recipe.mainName, recipe.mainNum],
    [recipe.yaoyinId, recipe.yaoyinName, recipe.yaoyinNum],
    [recipe.fuyaoId, recipe.fuyaoName, recipe.fuyaoNum],
  ] as const) {
    materials.set(id, { name, num: (materials.get(id)?.num ?? 0) + num })
  }
  return materials
}

/** 每种成丹仅推荐一个最省药材的配方；相同消耗按药材 ID 排序，避免背包顺序影响序号。 */
export function selectMixRecipes(recipes: MixRecipe[], herbs: YaocaiEntry[]): MixRecipe[] {
  const stock = new Map(herbs.map(herb => [herb.id, herb.num]))
  const best = new Map<number, MixRecipe>()
  const order = (recipe: MixRecipe) => [
    recipe.mainNum + recipe.yaoyinNum + recipe.fuyaoNum,
    recipe.mainId, recipe.yaoyinId, recipe.fuyaoId,
    recipe.mainNum, recipe.yaoyinNum, recipe.fuyaoNum,
  ]
  const compare = (a: MixRecipe, b: MixRecipe) => {
    const left = order(a), right = order(b)
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i]
    return 0
  }
  for (const recipe of recipes) {
    if ([...recipeMaterials(recipe)].some(([id, material]) => material.num > (stock.get(id) ?? 0))) continue
    const previous = best.get(recipe.elixirId)
    if (!previous || compare(recipe, previous) < 0) best.set(recipe.elixirId, recipe)
  }
  return [...best.values()].sort((a, b) => a.elixirId - b.elixirId)
}

export function renderMixRecipePage(recipes: MixRecipe[], page: number, query = '', unbound = false): string {
  const indexed = recipes.map((recipe, index) => ({ recipe: recipe as MixRecipe & { materialPolicy?: string; maxBatches?: number }, index }))
    .filter(({ recipe }) => (!unbound || recipe.materialPolicy === 'unbound') && (!query || recipe.elixirName.includes(query) || String(recipe.elixirId) === query))
  const command = ['炼丹', unbound ? '不绑定' : '', query].filter(Boolean).join(' ')
  const pageSize = 5, totalPages = Math.max(1, Math.ceil(indexed.length / pageSize))
  if (!Number.isSafeInteger(page) || page < 1 || page > totalPages) {
    return `页码无效，共 ${totalPages} 页，请发送【${command} 1】至【${command} ${totalPages}】查看。`
  }
  const start = (page - 1) * pageSize
  const lines = ['☆------可炼制丹方------☆',
    `第 ${page}/${totalPages} 页，共 ${new Set(indexed.map(x => x.recipe.elixirId)).size} 种丹药，${indexed.length} 个方案`]
  if (!indexed.length) lines.push('没有符合条件的可炼丹方；可用【炼丹】查看全部，或【炼丹 丹药名】查找。')
  indexed.slice(start, start + pageSize).forEach(({ recipe, index }) => {
    const policy = recipe.materialPolicy === 'unbound' ? '不绑定' : recipe.materialPolicy === 'any' ? '混合材料，可能绑定' : ''
    const capacity = recipe.maxBatches === undefined ? '' : `，最多${Math.min(100, recipe.maxBatches)}炉/批`
    lines.push(`${index + 1}、${recipe.elixirName}${policy ? `【${policy}${capacity}】` : ''}：${recipe.formulaShort}`, `   效果：${recipe.desc}`)
  })
  if (page > 1) lines.push(`上一页：${command} ${page - 1}`)
  if (page < totalPages) lines.push(`下一页：${command} ${page + 1}`)
  lines.push('炼制 序号 [炉数]；查找：炼丹 丹药名；仅看可交易：炼丹 不绑定', '按上方【炼丹】指令翻页，不用【修仙翻页】；列表保留10分钟。')
  return lines.join('\n')
}
