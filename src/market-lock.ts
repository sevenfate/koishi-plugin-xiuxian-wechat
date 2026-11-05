import { $ } from 'koishi'

/** 上新和玩家/管理员上架共用群锁，容量检查与新增货架不能分开。 */
export async function withMarketTransaction<T>(ctx: any, guildId: string, action: (scope: any) => Promise<T>): Promise<T> {
  await ctx.database.upsert('xiuxian_market', [{ guildId }])
  return ctx.database.transact(async (database: any) => {
    await database.set('xiuxian_market', { guildId }, (row: any) => ({ token: $.add(row.token, 0) }))
    const scope = new Proxy(ctx, { get: (target, key) => key === 'database' ? database : Reflect.get(target, key, target) })
    return action(scope)
  })
}
