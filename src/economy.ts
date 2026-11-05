import { $ } from 'koishi'

/** 同一玩家的结算先锁定角色行，后续读写共用事务，失败时一起回滚。 */
export async function withEconomyTransaction(
  ctx: any, service: any, userId: string,
  action: (ctx: any, service: any) => Promise<string>,
): Promise<string> {
  return ctx.database.transact(async (database: any) => {
    await database.set('xiuxian_player', { userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    const scopedContext = new Proxy(ctx, {
      get(target, key) { return key === 'database' ? database : Reflect.get(target, key, target) },
    })
    // 取原型方法，避免 Cordis 的服务代理把事务上下文换回原上下文。
    const scopedService = Object.assign(Object.create(Object.getPrototypeOf(service)), {
      ctx: scopedContext, config: service.config, data: service.data,
    })
    return action(scopedContext, scopedService)
  })
}
