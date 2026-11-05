import { removeGoods } from './shop-trade'
import { withMarketTransaction } from './market-lock'

export const RESTOCK_MS = 3 * 3600000
const categories: Record<string, string> = {
  功法: '功法', 辅修功法: '功法', 神通: '神通', 药材: '药材', 丹药: '丹药', 合成丹药: '丹药',
  法器: '装备', 防具: '装备', 炼丹炉: '工具', 聚灵旗: '工具',
}

export function marketPrice(info: any) {
  const rank = Math.min(Math.max(Number(info.rank) || 50, 1), 50)
  const factor = info.item_type === '药材' ? 0.1 : ['丹药', '合成丹药'].includes(info.item_type) ? 0.25 : 1
  return Math.max(1000, Math.floor((51 - rank) ** 2 * 1000 * factor))
}

export function selectMarketGoods(data: any, count: number, random = Math.random) {
  const groups = new Map<string, Array<{ id: number; info: any }>>()
  for (const [key, info] of Object.entries(data.items) as Array<[string, any]>) {
    const group = categories[info.item_type]
    if (!group || !info.name) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push({ id: Number(key), info })
  }
  const shuffled = [...groups.values()]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, count).map(pool => {
    const { id, info } = pool[Math.floor(random() * pool.length)]
    return { goodsId: id, goodsName: info.name, goodsType: info.item_type, price: marketPrice(info),
      goodsNum: ['药材', '丹药', '合成丹药'].includes(info.item_type) ? 3 : 1 }
  })
}

/** 群目录独立于货架，卖空后仍会补货；换批只移除神秘人的商品。 */
export function createMarketStock(ctx: any, srv: any, config: any, normalize: (id: string) => string,
  options: { now?: () => number; timer?: boolean; random?: () => number } = {}) {
  const now = options.now ?? Date.now, logger = ctx.logger?.('huaji-xiuxian')
  const slots = Math.min(5, Math.max(Math.floor(Number(config.shopRestockThreshold) || 0), 0))
  const allowed = (gid: string) => !config.groupWhitelistEnabled || (config.groupWhitelist || []).map(normalize).includes(normalize(gid))
  ctx.model.extend('xiuxian_market', { guildId: 'string', token: { type: 'integer', initial: 0 }, nextRestockAt: 'timestamp' }, { primary: 'guildId' })

  async function visit(guildId: string) {
    if (!slots || !allowed(guildId)) return
    return withMarketTransaction(ctx, guildId, async scope => {
      const database = scope.database
      const [state] = await database.get('xiuxian_market', { guildId }), t = now()
      if (state.nextRestockAt && +state.nextRestockAt > t) return state
      const all = await database.get('xiuxian_shop', { guildId })
      const own = all.filter((it: any) => it.sellerId === '0' && it.sellerName === '神秘人')
      const room = Math.max(Math.floor(config.shopCapacity) - (all.length - own.length), 0)
      const goods = selectMarketGoods(srv.data, Math.min(slots, room), options.random)
      // 删除、上新和下次时间在同一事务中；购买已加货架行锁，换批会等待在途购买完成。
      if (own.length) await database.remove('xiuxian_shop', { id: own.map((it: any) => it.id) })
      for (const item of goods) await database.create('xiuxian_shop', {
        ...item, guildId, sellerId: '0', sellerName: '神秘人', createTime: new Date(t),
      })
      const nextRestockAt = new Date(t + RESTOCK_MS)
      await database.set('xiuxian_market', { guildId }, { nextRestockAt })
      return { ...state, nextRestockAt }
    })
  }

  let ticking = false
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const all = await ctx.database.get('xiuxian_shop', {})
      for (const item of all) {
        if (!allowed(item.guildId) || now() - +new Date(item.createTime) <= config.shopExpireHours * 3600000) continue
        await removeGoods(ctx, srv, config, null, item.id, true)
      }
      if (!slots) return
      const states = await ctx.database.get('xiuxian_market', {})
      for (const state of states) {
        if (!allowed(state.guildId) || +state.nextRestockAt > now()) continue
        try { await visit(state.guildId) } catch (error: any) { logger?.warn('神秘人补货失败：%s', error.message) }
      }
    } catch (error: any) { logger?.warn('坊市定时维护失败：%s', error.message) }
    finally { ticking = false }
  }

  ctx.on?.('ready', async () => {
    // 仅补建目录，不覆盖已有时间；重载或重启不能免费换一批。
    if (slots) {
      const old = await ctx.database.get('xiuxian_shop', {})
      for (const guildId of new Set(old.map((it: any) => it.guildId))) {
        await ctx.database.upsert('xiuxian_market', [{ guildId }])
      }
    }
    if (options.timer === false) return
    ctx.setInterval(tick, 60000)
    await tick()
  })

  const describe = (state: any) => state ? `神秘人每3小时换一批，最多${slots}类；下次换货：${new Date(state.nextRestockAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}。售罄后等待换批，反复查看不会刷新。` : ''
  return { visit, tick, describe }
}
