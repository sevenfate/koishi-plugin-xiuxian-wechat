type ItemInfo = { level?: unknown; rank?: unknown; name?: string; item_type?: string }
type ItemData = { getItem(id: number): ItemInfo | undefined; formatItemRealmRequirement?(info: ItemInfo): string | undefined }

function grade(level: unknown): number | undefined {
  if (typeof level !== 'string') return
  const skill = /^(人|黄|玄|地|天|仙)阶(下|中|上|极)品$/.exec(level)
  if (skill) return ['人', '黄', '玄', '地', '天', '仙'].indexOf(skill[1]) * 4 + ['下', '中', '上', '极'].indexOf(skill[2])
  const herb = /^([一二三四五六七八九十])品药材$/.exec(level)
  if (herb) return '一二三四五六七八九十'.indexOf(herb[1]) + 1
  const gear = /^(下|中|上|极)品(符器|法器|玄器|纯阳(?:法器)?|通天(?:法器)?|仙器)$/.exec(level)
  if (gear) {
    const tiers: Record<string, number> = { 符器: 0, 法器: 1, 玄器: 1, 纯阳: 2, 纯阳法器: 2, 通天: 3, 通天法器: 3, 仙器: 4 }
    return tiers[gear[2]] * 4 + ['下', '中', '上', '极'].indexOf(gear[1])
  }
}

function key(info?: ItemInfo): [number, number] {
  const value = grade(info?.level)
  if (value !== undefined) return [0, -value]
  // 上游 rank 越小，所对应的境界越高；空值不能被 Number() 当成最高等级。
  const rank = info?.rank
  if (rank !== '' && rank !== null && rank !== undefined && Number.isFinite(Number(rank)) && Number(rank) > 0) return [1, Number(rank)]
  return [2, 0]
}

export function compareItemGrade(a: ItemInfo | undefined, aId: number, b: ItemInfo | undefined, bId: number): number {
  const left = key(a), right = key(b)
  return left[0] - right[0] || left[1] - right[1] || aId - bId
}

/** 返回新数组，只调整显示顺序，不修改背包、已学技能或战斗的随机候选池。 */
export function sortByItemGrade<T>(items: readonly T[], data: ItemData, getId: (item: T) => number): T[] {
  return [...items].sort((a, b) => compareItemGrade(data.getItem(getId(a)), getId(a), data.getItem(getId(b)), getId(b)))
}

type BackItem = { goodsId: number; goodsName: string; goodsType: string; goodsNum: number; state: number; bindNum?: number }

export function formatSortedBackpack(backs: readonly BackItem[], data: ItemData): string[] {
  const groups = new Map<string, BackItem[]>()
  for (const item of backs) {
    const type = data.getItem(item.goodsId)?.item_type || item.goodsType
    const group = type === '法器' || type === '防具' ? '装备' : type
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(item)
  }
  const lines: string[] = []
  for (const [type, items] of groups) {
    lines.push(`☆------${type}------☆`)
    for (const item of sortByItemGrade(items, data, item => item.goodsId)) {
      const info = data.getItem(item.goodsId)
      const level = info?.level || (info && data.formatItemRealmRequirement?.(info))
      const type = info?.item_type || item.goodsType
      const isEquipment = type === '法器' || type === '防具' || item.goodsType === '装备'
      const bound = Math.min(Math.max(item.bindNum || 0, 0), item.goodsNum)
      lines.push(`${level ? `${level} ` : ''}${info?.name || item.goodsName} x${item.goodsNum}${isEquipment && item.state === 1 ? '（已装备）' : ''}（绑定${bound}，可交易${isEquipment && item.state === 1 ? 0 : item.goodsNum - bound}）${isEquipment && item.state === 1 ? `（未绑定${item.goodsNum - bound}）` : ''}（编号${item.goodsId}）`)
    }
  }
  return lines
}

/** 分类与名称可组合；仅影响查询，不扣物品、不改变交易绑定规则。 */
export function queryBackpack(backs: readonly BackItem[], data: ItemData, query = ''): string[] {
  let freeOnly = false
  const tokens = query.trim().split(/\s+/).filter(Boolean).filter(token => {
    if (token === '不绑定' || token === '未绑定') { freeOnly = true; return false }
    return token !== '全部'
  })
  const types: Record<string, string[]> = { 丹药: ['丹药', '合成丹药'], 药材: ['药材'], 装备: ['法器', '防具', '装备'], 功法: ['功法', '辅修功法'] }
  const selected = backs.filter(back => {
    if (back.goodsNum <= 0 || freeOnly && back.goodsNum <= Math.max(0, back.bindNum || 0)) return false
    const info = data.getItem(back.goodsId), type = info?.item_type || back.goodsType
    return tokens.every(token => types[token] ? types[token].includes(type) : token === type || String(back.goodsId) === token || (info?.name || back.goodsName).includes(token))
  })
  const lines = selected.length ? formatSortedBackpack(selected, data) : ['背包中没有符合条件的物品（仅查询现有库存）。']
  return [`筛选：${query.trim() || '全部'}；共${selected.length}种。可交易数量不包含绑定和已装备物品。`, ...lines,
    '直接查：我的背包 物品名/编号；分类：我的丹药 / 我的药材；仅看未绑定：我的背包 不绑定 药材。']
}
