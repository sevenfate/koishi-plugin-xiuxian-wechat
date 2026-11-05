import { $ } from 'koishi'

/** 稳定的账号记录不随删档消失；签到和重入必须先锁它，再锁角色。 */
export async function withAccount(service: any, userId: string, action: (scope: any, srv: any) => Promise<string>,
  prepare?: (database: any) => Promise<void>) {
  const ctx = service.ctx
  if (!prepare) await ctx.database.upsert('xiuxian_sign', [{ userId }])
  return ctx.database.transact(async (database: any) => {
    if (prepare) { await prepare(database); await database.upsert('xiuxian_sign', [{ userId }]) }
    await database.set('xiuxian_sign', { userId }, (row: any) => ({ token: $.add(row.token, 0) }))
    await database.set('xiuxian_player', { userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    const scope = new Proxy(ctx, { get: (target, key) => key === 'database' ? database : Reflect.get(target, key, target) })
    const srv = Object.assign(Object.create(Object.getPrototypeOf(service)), { ctx: scope, config: service.config, data: service.data })
    return action(scope, srv)
  })
}

export async function signOnce(service: any, userId: string, platform: string | undefined, today: () => string) {
  return withAccount(service, userId, async (scope, srv) => {
    const player = await srv.getPlayer(userId)
    if (!player) return '修仙界没有你的足迹，输入 我要修仙 加入修仙世界吧！'
    const date = today()
    const [record] = await scope.database.get('xiuxian_sign', { userId })
    if (record.lastSignDate === date || player.lastSignDate === date) {
      // 兼容升级前已签到的角色，并保留独立记录。
      await scope.database.set('xiuxian_sign', { userId }, { lastSignDate: date })
      return '今日已签到，请明日0点后再来。'
    }
    const lo = srv.config.signInLingShiLowerLimit, hi = srv.config.signInLingShiUpperLimit
    const stone = Math.floor(Math.random() * (hi - lo + 1)) + lo
    if (!Number.isSafeInteger(stone) || stone <= 0) throw new Error('签到奖励配置无效')
    const resolvedPlatform = platform ?? player.platform
    if (await srv.getCanonicalUid(userId, resolvedPlatform) <= 0) throw new Error('签到无法解析玩家钱包')
    if (await srv.getStoneForUser(userId, resolvedPlatform) + stone > 2147483647) return '灵石余额接近存储上限，本次未签到，请使用部分灵石后再试。'
    await srv.gainStoneForUser(userId, stone, resolvedPlatform)
    await scope.database.set('xiuxian_sign', { userId }, { lastSignDate: date })
    await scope.database.set('xiuxian_player', { userId }, { isSign: 1, lastSignDate: date })
    return `签到成功，获取${stone}块灵石!`
  })
}

export async function remakeKeepingSign(service: any, userId: string, platform?: string) {
  return withAccount(service, userId, async (scope, srv) => {
    const player = await srv.getPlayer(userId)
    if (!player) return '修仙界没有你的足迹，输入 我要修仙 加入修仙世界吧！'
    if (await srv.getSectByOwner(userId)) return '道友为一宗之主，请先转让宗主之位或解散宗门后再重入仙途！'
    if (!await srv.costStoneForUser(userId, srv.config.remakeCost, platform)) return '你的灵石还不够呢，快去赚点灵石吧！'
    const [record] = await scope.database.get('xiuxian_sign', { userId })
    if (player.lastSignDate && player.lastSignDate > (record.lastSignDate || '')) {
      await scope.database.set('xiuxian_sign', { userId }, { lastSignDate: player.lastSignDate })
    }
    await srv.wipeUserData(userId)
    return '逆天改命，前尘尽散！请发送【我要修仙】重新踏入仙路。'
  })
}
