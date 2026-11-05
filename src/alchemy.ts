import { withEconomyTransaction } from './economy'
import { recipeMaterials } from './mix-recipe-list'

/** 配方仅用于选择，库存、丹炉和角色在事务内重新检查。 */
export async function craftBatch(ctx: any, srv: any, userId: string, recipe: any, quantity = 1, tiaohe: Function) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) return '炼制数量需为1～100的整数，例如：炼制 1 10。'
  return withEconomyTransaction(ctx, srv, userId, async (_scope, service) => {
    if (!await service.getPlayer(userId)) return '修仙界没有道友的信息，请输入【我要修仙】加入！'
    const backs = await service.getBack(userId)
    const furnaces = backs.filter((b: any) => b.goodsNum > 0 && (b.goodsType === '炼丹炉' || service.data.getItem(b.goodsId)?.item_type === '炼丹炉'))
    if (!furnaces.length) return '道友背包内没有炼丹炉，发送【修仙商店】查看购买途径。'
    const bonus = Math.max(0, ...furnaces.map((b: any) => Math.min(Math.max(Math.floor(Number(service.data.getItem(b.goodsId)?.buff) || 0), 0), 2)))
    const produced = quantity * (1 + bonus)
    const elixir = service.data.getItem(recipe.elixirId)
    if (!elixir) return '丹方物品资料缺失，请重新【炼丹】扫描。'
    const old = await service.getBackItem(userId, recipe.elixirId)
    if ((old?.goodsNum || 0) + produced > 2147483647) return '丹药库存接近存储上限，请减少炼制数量。'
    const materials = recipeMaterials(recipe)
    for (const [id, material] of materials) {
      const back = await service.getBackItem(userId, id), need = material.num * quantity
      if (!back || back.goodsNum < need) return `药材不足：${material.name}需要${need}个，请重新【炼丹】刷新配方。`
      if (recipe.materialPolicy === 'unbound' && back.goodsNum - Math.max(0, back.bindNum || 0) < need) {
        return `未绑定药材不足：${material.name}需要${need}个，本次未消耗药材。不会自动使用绑定材料，请减少炉数或重新【炼丹 不绑定】。`
      }
    }
    if (tiaohe(service.data.getItem(recipe.mainId), recipe.mainNum, service.data.getItem(recipe.yaoyinId), recipe.yaoyinNum)) return '冷热调和失败！本次炼制未能成丹（药材未消耗）。'
    // 已绑定药材炼出的丹药也绑定，防止经炼丹绕过赠送/交易限制。
    let bound = false
    for (const [id, material] of materials) {
      const back = await service.getBackItem(userId, id), need = material.num * quantity
      const boundUsed = Math.max(need - Math.max(back.goodsNum - (back.bindNum || 0), 0), 0)
      if (boundUsed) bound = true
      await service.reduceBack(userId, id, need, 0)
      if (boundUsed) await _scope.database.set('xiuxian_back', { userId, goodsId: id }, { bindNum: back.bindNum - boundUsed })
    }
    await service.sendBack(userId, recipe.elixirId, elixir.name, elixir.item_type ?? '合成丹药', produced, bound ? 1 : 0)
    return `丹成！按【${recipe.formulaShort}】炼制${quantity}次，获得【${recipe.elixirName}】${produced}枚${bonus ? `（丹炉每次多产${bonus}枚，取最佳一炉，不叠加）` : ''}${bound ? '（含绑定药材，本批丹药绑定）' : ''}！`
  })
}
