import type { GameData } from '../lib/data'

/** 预览与结算使用同一展示文案，不把品阶写入实际背包物品名称。 */
export function formatWorkReward(data: Pick<GameData, 'getItem' | 'formatItemRealmRequirement'>, itemId: number): string {
  const item = data.getItem(itemId)
  if (!item) return `未知物品（编号${itemId}）【等级未标注】`
  const grade = item.level?.trim()
  if (grade) return `${item.name}【${grade}】`
  const realm = data.formatItemRealmRequirement(item)
  return `${item.name}【${realm ? `境界：${realm}` : '等级未标注'}】`
}
