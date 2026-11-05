import { $ } from 'koishi'
import { withEconomyTransaction } from './economy'
import { displayName } from './wechat-profile'

export const FURNACE_PRICE = 200000
const missing = '修仙界没有道友的信息，请输入【我要修仙】加入！'

async function gift(ctx: any, srv: any, session: any, target: string | undefined, query: string, quantity = 1) {
  if (!session.guildId) return '物品赠送仅在群聊中使用，请在群里艾特接收道友。'
  if (!target) return '请艾特接收道友，例如：赠送物品 丹药名 5 @道友。'
  if (target === session.userId) return '不能把物品赠送给自己。'
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) return '赠送数量需为1～1000的整数。'
  if (!query?.trim()) return '请输入物品编号或完整名称。'
  return ctx.database.transact(async (database: any) => {
    for (const userId of [session.userId, target].sort()) await database.set('xiuxian_player', { userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    const scope = new Proxy(ctx, { get: (t, k) => k === 'database' ? database : Reflect.get(t, k, t) })
    const service = Object.assign(Object.create(Object.getPrototypeOf(srv)), { ctx: scope, config: srv.config, data: srv.data })
    if (!await service.getPlayer(session.userId)) return missing
    const recipient = await service.getPlayer(target)
    if (!recipient) return '对方尚未加入修仙世界，无法接收物品。'
    const backs = await service.getBack(session.userId), text = query.trim()
    const matches = backs.filter((b: any) => /^\d+$/.test(text) ? String(b.goodsId) === text : b.goodsName === text)
    if (!matches.length) return '背包中没有该物品，请发送【我的背包】确认编号或完整名称。'
    if (matches.length > 1) return '存在同名物品，请使用物品编号赠送。'
    const back = matches[0]
    if (back.state === 1) return '已装备的物品不能赠送，请先卸下。'
    if (back.goodsNum - (back.bindNum || 0) < quantity) return '可赠送数量不足，绑定物品不能赠送。'
    const dest = await service.getBackItem(target, back.goodsId)
    if ((dest?.goodsNum || 0) + quantity > 2147483647) return '对方背包数量达到上限，本次未赠送。'
    await service.reduceBack(session.userId, back.goodsId, quantity, 0)
    await service.sendBack(target, back.goodsId, back.goodsName, back.goodsType, quantity)
    return `已向${await displayName(ctx, session, target, recipient.userName)}赠送【${back.goodsName}】${quantity}个。`
  })
}

export function applyPlayerServices(ctx: any, config: any, getAtId: Function, today: () => string) {
  const srv = ctx.xiuxian
  ctx.command('xiuxian/赠送物品 <name:string> [quantity:integer]', '赠送未绑定物品给艾特的道友')
    .alias('送物品').action(({ session }: any, name: string, quantity = 1) => gift(ctx, srv, session, getAtId(session), name, quantity))
  ctx.command('xiuxian/修仙商店', '查看稳定供应的入门物资')
    .action(() => `修仙商店：\n4003、陨铁炉（炼丹炉）：${FURNACE_PRICE}灵石/个，常驻供应。\n发送【修仙购买 炼丹炉】购买一个。已有可用丹炉时无需重复购买。\n药材可通过【悬赏令】、【探索秘境】、【灵田情况】和【坊市查看】获取。`)
  ctx.command('xiuxian/修仙购买 <name:string>', '购买一件入门物资')
    .action(({ session }: any, name: string) => withEconomyTransaction(ctx, srv, session.userId, async (_scope, service) => {
      if (!await service.getPlayer(session.userId)) return missing
      if (!['4003', '陨铁炉', '炼丹炉'].includes(name)) return '该物品未在常驻商店出售，请发送【修仙商店】查看。'
      const backs = await service.getBack(session.userId)
      if (backs.some((b: any) => b.goodsNum > 0 && service.data.getItem(b.goodsId)?.item_type === '炼丹炉')) return '道友已有可用炼丹炉，发送【炼丹】扫描丹方，无需重复购买。'
      const info = service.data.getItem(4003)
      if (!info) return '商店物品资料异常，请稍后再试。'
      if (!await service.costStoneForUser(session.userId, FURNACE_PRICE, session.platform)) return `购买陨铁炉需要${FURNACE_PRICE}灵石，余额不足。可通过【修仙签到】或【悬赏令结算 灵石】积攒。`
      await service.sendBack(session.userId, 4003, info.name, '炼丹炉', 1)
      return `花费${FURNACE_PRICE}灵石购得【陨铁炉】！发送【炼丹】扫描背包中的可用丹方。`
    }))
  ctx.command('xiuxian/修仙指引 [topic:string]', '按主题查看玩法与下一步操作').alias('修仙攻略')
    .action(async (_: any, topic?: string) => {
      const guides: Record<string, string> = {
        入门: '【我要修仙】建号 →【修仙签到】领灵石 →【宗门列表】选宗门 →【闭关】【出关】积累修为 →【突破】查看条件。气血耗尽会重伤，可闭关出关恢复。',
        炼丹: '【修仙商店】买炼丹炉 → 悬赏、秘境、灵田或坊市获取药材 →【炼丹】扫描丹方 →【炼制 1 10】炼十炉 →【使用 丹药名 数量】服用。无配方通常是药材不足或冷热不调。',
        交易: '【坊市查看】看单价与库存；【坊市上架 物品名 单价 数量】出售；【坊市购买 编号 数量】购买；【赠送物品 编号 数量】并艾特道友可直接赠送。绑定物品不可交易或赠送。',
        宗门: '【宗门列表】查看全部宗门 →【加入宗门 编号】→【接取宗门任务】【完成宗门任务】；【我的宗门任务】查进度，【宗门每日供奉】领奖，【宗门贡献兑换】查看兑换规则。',
        战斗: '【我的状态】查气血、攻击、减伤；【我的神通】看战斗随机选用池；【遗忘神通 编号】先预览再确认。战斗详看【查看战斗详情】；持续神通可能一轮造成多段伤害。世界Boss用【查看世界boss】【讨伐世界boss】，独立冷却30分钟；悬赏/闭关期间也可讨伐，重伤需先恢复。',
        爬塔: '【无尽塔】看下一层 →【挑战无尽塔】或【连闯无尽塔 10】。幻境满状态战斗，不消耗现实气血或丹药；失败保留已通层数。每5层药材、每10层额外丹药、每50层额外功法或神通，首通自动发放绑定奖励。用【无尽塔奖励 层数】预览、【无尽塔战报】看过程。重入与跨群不重领。',
        悬赏: '【悬赏令】只查看，首次生成；【悬赏令刷新】重抽（每日免费3次，之后每次500000灵石）；【悬赏令接取 编号】接取；到时【悬赏令结算】领修为或【悬赏令结算 灵石】领灵石。',
      }
      if (!topic) return '修仙指引：入门｜炼丹｜交易｜宗门｜战斗｜爬塔｜悬赏\n例如【修仙指引 爬塔】；发送【今日修仙】查看自己的状态与可做事项。'
      return guides[topic] ?? '没有这个主题，请发送【修仙指引】查看。'
    })
  ctx.command('xiuxian/今日修仙', '查看自己的签到、秘境与悬赏进度')
    .action(async ({ session }: any) => {
      const player = await srv.getPlayer(session.userId)
      if (!player) return missing
      const date = today(), [record] = await ctx.database.get('xiuxian_sign', { userId: session.userId })
      const [work] = await ctx.database.get('xiuxian_work', { userId: session.userId })
      const [cd] = await ctx.database.get('xiuxian_cd', { userId: session.userId })
      const lines = ['☆------今日修仙------☆', `境界：${player.level}`,
        `签到：${record?.lastSignDate === date || player.lastSignDate === date ? '今日已领取' : '可发送【修仙签到】'}`,
        `秘境：今日剩余${Math.max(3 - (player.riftDailyCount || 0), 0)}/3次（另有1小时冷却）`,
        `悬赏免费刷新：剩余${Math.max(3 - (player.workRefreshCount || 0), 0)}/3次`,
      ]
      if (work) {
        const remaining = Math.max(Math.ceil((+new Date(work.startTime) + work.time * 60000 - Date.now()) / 60000), 0)
        lines.push(`悬赏【${work.workName}】：${remaining ? `${remaining}分钟后可结算` : '已完成，发送【悬赏令结算】或【悬赏令结算 灵石】'}`)
      } else lines.push(cd?.type === 1 || cd?.type === 3 ? '悬赏：当前闭关或秘境中，结束后可查看和接取。' : '悬赏：可发送【悬赏令】查看任务。')
      if (cd?.type === 1 || cd?.type === 2 || cd?.type === 3) lines.push('秘境状态：当前有事在身，结束闭关/悬赏/秘境后再探索。')
      lines.push('世界Boss独立冷却30分钟，发送【查看世界boss】看自己的可战时间；无需等待悬赏结算。')
      if (cd?.type === 1) lines.push('当前正在闭关，发送【出关】结算并恢复状态。')
      lines.push(player.sectId ? '宗门：可用【我的宗门任务】、【宗门每日供奉】。' : '尚无宗门，发送【宗门列表】查看并加入。', '更多玩法与获取途径：修仙指引')
      return lines.join('\n')
    })
}
