import { $ } from 'koishi'
import { withMarketTransaction } from './market-lock'

const MAX_INT = 2147483647
const validAmount = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= MAX_INT

/** 锁住货架，再按固定顺序锁买卖双方；购买、下架和过期回收共用此事务。 */
async function withListing(ctx: any, service: any, id: number, userId: string | undefined, action: Function) {
  return ctx.database.transact(async (database: any) => {
    await database.set('xiuxian_shop', { id }, (row: any) => ({ goodsNum: $.add(row.goodsNum, 0) }))
    const [item] = await database.get('xiuxian_shop', { id })
    const users = [...new Set([userId, item?.sellerId].filter(id => id && id !== '0'))].sort()
    for (const userId of users) {
      await database.set('xiuxian_player', { userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    }
    const scope = new Proxy(ctx, { get: (target, key) => key === 'database' ? database : Reflect.get(target, key, target) })
    const srv = Object.assign(Object.create(Object.getPrototypeOf(service)), { ctx: scope, config: service.config, data: service.data })
    return action(scope, srv, item)
  })
}

export async function listGoods(ctx: any, service: any, config: any, session: any, name: string, price: number, quantity = 1) {
  if (!session.guildId) return '坊市仅在群聊中使用！'
  if (!validAmount(price)) return '请输入正确的单价（正整数）！'
  if (!validAmount(quantity)) return '请输入正确的数量（正整数）！'
  return withMarketTransaction(ctx, session.guildId, async scope => {
    await scope.database.set('xiuxian_player', { userId: session.userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    const srv = Object.assign(Object.create(Object.getPrototypeOf(service)), { ctx: scope, config: service.config, data: service.data })
    const player = await srv.getPlayer(session.userId)
    if (!player) return '修仙界没有道友的信息，请输入【我要修仙】加入！'
    const shop = await scope.database.get('xiuxian_shop', { guildId: session.guildId })
    if (shop.length >= config.shopCapacity) return `坊市货架已满（上限${config.shopCapacity}件），请稍后再来！`
    const backs = await srv.getBack(session.userId)
    const exact = backs.filter((b: any) => b.goodsName === name)
    const matches = exact.length ? exact : backs.filter((b: any) => b.goodsName.includes(name))
    if (!matches.length) return `背包中没有【${name}】！`
    if (matches.length > 1) return '匹配到多种物品，请输入完整物品名！'
    const back = matches[0]
    if (back.state === 1) return '已装备的物品无法上架！'
    if (back.goodsNum - (back.bindNum || 0) < quantity) return '可出售物品数量不足（绑定物品不可出售）！'
    await srv.reduceBack(session.userId, back.goodsId, quantity, 0)
    await scope.database.create('xiuxian_shop', {
      guildId: session.guildId, sellerId: session.userId, sellerName: player.userName,
      goodsId: back.goodsId, goodsName: back.goodsName, goodsType: back.goodsType,
      price, goodsNum: quantity, createTime: new Date(),
    })
    return `【${back.goodsName}】已上架坊市，数量${quantity}个，单价${price}灵石！\n（若${config.shopExpireHours}小时内无人购买将自动下架退回）`
  })
}

export async function buyGoods(ctx: any, service: any, config: any, session: any, id: number, quantity = 1) {
  if (!session.guildId) return '坊市仅在群聊中使用！'
  if (!validAmount(quantity)) return '请输入正确的数量（正整数）！'
  return withListing(ctx, service, id, session.userId, async (scope: any, srv: any, item: any) => {
    if (!await srv.getPlayer(session.userId)) return '修仙界没有道友的信息，请输入【我要修仙】加入！'
    if (!item || item.guildId !== session.guildId) return '请输入正确的坊市编号！'
    if (item.sellerId === session.userId) return '不能购买自己上架的物品！'
    if (quantity > item.goodsNum) return `库存不足，当前剩余${item.goodsNum}个！`
    const total = item.price * quantity
    if (!validAmount(item.price) || !validAmount(total)) return '购买总价超出支持范围，请减少数量！'
    const back = await srv.getBackItem(session.userId, item.goodsId)
    if ((back?.goodsNum || 0) + quantity > MAX_INT) return '背包数量超出支持范围，请减少数量！'
    const charge = Math.floor(total * config.shopServiceCharge)
    if (!Number.isSafeInteger(charge) || charge < 0 || charge > total) throw new Error('坊市手续费配置无效')
    if (!await srv.costStoneForUser(session.userId, total, session.platform)) return `购买需要灵石${total}枚，道友灵石不足！`
    await srv.sendBack(session.userId, item.goodsId, item.goodsName, item.goodsType, quantity)
    if (item.sellerId !== '0') {
      const seller = await srv.getPlayer(item.sellerId)
      if (!seller) throw new Error('卖家信息不存在')
      const platform = seller.platform || session.platform
      if (!(await srv.getCanonicalUid(item.sellerId, platform))) throw new Error('卖家钱包不存在')
      if (await srv.getStoneForUser(item.sellerId, platform) + total - charge > MAX_INT) throw new Error('卖家余额超出支持范围')
      await srv.gainStoneForUser(item.sellerId, total - charge, platform)
    }
    if (quantity === item.goodsNum) await scope.database.remove('xiuxian_shop', { id })
    else await scope.database.set('xiuxian_shop', { id }, { goodsNum: item.goodsNum - quantity })
    return `道友购得【${item.goodsName}】${quantity}个，花费灵石${total}枚！`
  })
}

export async function removeGoods(ctx: any, service: any, config: any, session: any, id: number, expired = false) {
  if (!expired && !session.guildId) return '坊市仅在群聊中使用！'
  return withListing(ctx, service, id, undefined, async (scope: any, srv: any, item: any) => {
    if (!item || (!expired && item.guildId !== session.guildId)) return '请输入正确的编号！'
    if (expired) {
      if (Date.now() - new Date(item.createTime).getTime() <= config.shopExpireHours * 3600000) return ''
    } else if (item.sellerId !== session.userId && item.sellerId !== '0' && !config.adminQQ.includes(session.userId)) {
      return '这不是你的上架物品！'
    }
    if (item.sellerId !== '0') await srv.sendBack(item.sellerId, item.goodsId, item.goodsName, item.goodsType, item.goodsNum)
    await scope.database.remove('xiuxian_shop', { id })
    return `已下架【${item.goodsName}】${item.goodsNum}个！`
  })
}
