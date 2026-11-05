import { $ } from 'koishi'
import { createHash } from 'node:crypto'
import { withEconomyTransaction } from './economy'
import { formatWorkReward } from './work-reward'

export const BOSS_REWARDS = { version: 2, daily: 3, chance: 0.15, pity: 6, qualify: 0.005, maxInteger: 2147483647 }
export type BossGift = { id: number; count: number; bound: boolean }
export const characterKey = (p: any) => String(p?.createTime ? +new Date(p.createTime) : 0)
export const rewardDay = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
export function rewardWeek(ms: number) {
  const d = new Date(ms + 8 * 3600000)
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7)
  return d.toISOString().slice(0, 10)
}
const levelIndex = (data: any, level: string) => Math.max(0, data.levelOrder.indexOf(level))
export const majorName = (level: string) => level.replace(/(?:初期|中期|圆满)$/, '')
export function majorBounds(data: any, index: number) {
  const name = majorName(data.levelOrder[index]), indices = data.levelOrder.map((x: string, i: number) => majorName(x) === name ? i : -1).filter((i: number) => i >= 0)
  return { name, start: indices[0], end: indices[indices.length - 1] }
}
export function rewardIndex(data: any, boss: any, player: any, enteredLevel: string) {
  let difficulty = 0
  data.levelOrder.forEach((level: string, i: number) => { if (data.getLevelPower(level) <= boss.strength) difficulty = i })
  return Math.min(difficulty, levelIndex(data, enteredLevel), levelIndex(data, player.level))
}
export const stoneGuarantee = (index: number) => index <= 6 ? 50000 : index <= 12 ? 100000 : index <= 24 ? 200000 : 300000
export function contributionMerit(damage: number, maxHp: number, rank: number, lastHit: boolean) {
  // 一次/两次15%伤害封顶会向下取整，阈值允许至多两点差，避免完整出手漏掉对应档位。
  const reached = (rate: number) => damage >= Math.max(1, Math.floor(maxHp * rate) - 1)
  return 10 + (reached(0.3) ? 6 : reached(0.15) ? 4 : reached(0.05) ? 2 : 0) + ([4, 2, 1][rank] || 0) + Number(lastHit)
}

/** 先按20/80分配，封顶后仅向未封顶者回流；整数尾差不丢失。 */
export function allocateBossRewards(boss: any, input: any[], outcome: 'kill' | 'escape', killerId?: string) {
  const rows = input.filter(x => Number.isFinite(x.damage) && x.damage > 0).sort((a, b) => a.userId.localeCompare(b.userId))
  if (!rows.length) return []
  const totalDamage = rows.reduce((n, x) => n + x.damage, 0), n = rows.length
  const cap = n === 1 ? 1 : n === 2 ? 0.7 : n === 3 ? 0.5 : 0.4
  const weights = rows.map(x => Math.min(cap, 0.2 / n + 0.8 * x.damage / totalDamage))
  for (let round = 0; round <= n; round++) {
    const remaining = Math.max(0, 1 - weights.reduce((a, b) => a + b, 0))
    if (remaining < 1e-12) break
    const open = rows.map((_, i) => i).filter(i => weights[i] < cap - 1e-12)
    const damage = open.reduce((sum, i) => sum + rows[i].damage, 0)
    for (const i of open) weights[i] = Math.min(cap, weights[i] + remaining * rows[i].damage / damage)
  }
  const scale = outcome === 'kill' ? 1 : Math.min(totalDamage / boss.maxHp, 1) * 0.5
  function pool(value: number) {
    const total = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value * scale)))
    const exact = weights.map(w => w * total), amounts = exact.map(Math.floor)
    let left = total - amounts.reduce((a, b) => a + b, 0)
    const order = rows.map((_, i) => i).sort((a, b) => (exact[b] - amounts[b]) - (exact[a] - amounts[a]) || a - b)
    for (const i of order) { if (left <= 0) break; if (amounts[i] < Math.ceil(total * cap)) { amounts[i]++; left-- } }
    if (left) throw new Error('世界BOSS奖池分配异常')
    return amounts
  }
  const exp = pool(boss.expReward), stone = pool(boss.stone)
  return rows.map((x, i) => ({ userId: x.userId, platform: x.platform, damage: x.damage, exp: exp[i], stone: stone[i], lastHit: x.userId === killerId, items: [] as string[], merit: 0, rewardNote: '' }))
}

function itemIndex(data: any, info: any) {
  const rank = Number(info.rank), numeric = Number.isFinite(rank) ? 50 - rank : NaN
  const explicit = info['境界'] && data.levelOrder.findIndex((x: string) => x === info['境界'] || x.startsWith(info['境界']))
  return Number.isFinite(numeric) ? Math.max(0, numeric, explicit >= 0 ? explicit : 0) : explicit >= 0 ? explicit : Infinity
}
export function rewardItems(data: any, types: string[], index: number, sameMajor = false) {
  const start = majorBounds(data, index).start
  return (Object.entries(data.getItemsByType(types)) as Array<[string, any]>).map(([id, info]) => ({ id: +id, info, index: itemIndex(data, info) }))
    .filter(x => Number.isSafeInteger(x.id) && x.id > 0 && x.index <= index && (!sameMajor || x.index >= start))
    .sort((a, b) => a.id - b.id)
}
function herbsAt(data: any, index: number) {
  const all = (Object.entries(data.getItemsByType(['药材'])) as Array<[string, any]>).map(([id, info]) => ({ id: +id, info, index: itemIndex(data, info) }))
  const eligible = all.filter(x => x.index <= index)
  // 药材没有服用境界限制；初期尚无对应品阶时，只给静态库中的最低品阶药材。
  const target = eligible.length ? Math.max(...eligible.map(x => x.index)) : Math.min(...all.map(x => x.index))
  return all.filter(x => x.index === target).sort((a, b) => a.id - b.id)
}
const pick = <T>(list: T[], random: () => number): T => list[Math.min(list.length - 1, Math.max(0, Math.floor(random() * list.length)))]
export function bossSupplies(data: any, index: number, random = Math.random): BossGift[] {
  const herbs = [...herbsAt(data, index)], gifts: BossGift[] = []
  if (herbs.length < 3) throw new Error('世界BOSS药材奖励资料不完整')
  for (let i = 0; i < 3; i++) { const herb = pick(herbs, random); herbs.splice(herbs.indexOf(herb), 1); gifts.push({ id: herb.id, count: 2, bound: true }) }
  const pills = rewardItems(data, ['丹药'], index).filter(x => x.info.status === 1 && ['hp', 'all'].includes(x.info.buff_type))
  if (pills.length) { const best = Math.max(...pills.map(x => x.index)); gifts.push({ id: pick(pills.filter(x => x.index === best), random).id, count: 1, bound: true }) }
  else gifts[0].count += 2
  return gifts
}
export function rareBossItem(data: any, index: number, random = Math.random) {
  const weights: Record<string, number> = { 功法: 30, 神通: 30, 法器: 25, 防具: 15 }
  const pools = Object.entries(weights).map(([type, weight]) => ({ weight, pool: rewardItems(data, [type], index, true) })).filter(x => x.pool.length)
  if (!pools.length) return
  let roll = random() * pools.reduce((sum, x) => sum + x.weight, 0)
  const selected = pools.find(x => (roll -= x.weight) < 0) || pools[pools.length - 1]
  return pick(selected.pool, random)
}

export function extendBossRewards(ctx: any) {
  ctx.model.extend('xiuxian_boss_account', {
    platform: 'string', userId: 'string', token: { type: 'integer', initial: 0 }, merit: { type: 'integer', initial: 0 },
    day: 'string', kills: { type: 'integer', initial: 0 }, pity: { type: 'integer', initial: 0 }, week: 'string', books: { type: 'integer', initial: 0 },
    pendingRare: { type: 'json', initial: {} },
  }, { primary: ['platform', 'userId'] })
  ctx.model.extend('xiuxian_boss_reward', {
    bossId: 'unsigned', platform: 'string', userId: 'string', character: 'string', outcome: 'string', ruleVersion: 'integer',
    result: { type: 'json', initial: {} }, createdAt: 'timestamp',
  }, { primary: ['bossId', 'platform', 'userId'] })
  ctx.model.extend('xiuxian_boss_exchange', { request: 'string', platform: 'string', userId: 'string', result: 'text', createdAt: 'timestamp' }, { primary: 'request' })
}
export async function lockBossAccount(db: any, platform: string, userId: string) {
  const who = { platform, userId }
  await db.upsert('xiuxian_boss_account', [who])
  await db.set('xiuxian_boss_account', who, (row: any) => ({ token: $.add(row.token, 0) }))
  return (await db.get('xiuxian_boss_account', who))[0]
}
export async function deliverBossGifts(service: any, userId: string, gifts: BossGift[]) {
  const totals = new Map<number, number>()
  for (const g of gifts) totals.set(g.id, (totals.get(g.id) || 0) + g.count)
  for (const [id, count] of totals) {
    if (!service.data.getItem(id) || ((await service.getBackItem(userId, id))?.goodsNum || 0) + count > BOSS_REWARDS.maxInteger) throw Object.assign(new Error('奖励物品缺失或背包数量达到上限，本次未扣功勋或待领资格，请清理背包或联系管理员后重试。'), { code: 'BOSS_GIFT_CAPACITY' })
  }
  for (const gift of gifts) { const info = service.data.getItem(gift.id); await service.sendBack(userId, gift.id, info.name, info.item_type, gift.count, gift.bound ? 1 : 0) }
}

/** 调用方已按统一顺序锁定角色；此处再锁账号，跨群结算共用每日额度与保底。 */
export async function prepareBossBonus(scope: any, service: any, boss: any, row: any, player: any, rank: number, lastHit: boolean, now: number, random = Math.random) {
  const platform = row.platform || player.platform, who = { platform, userId: row.userId }
  const account = await lockBossAccount(scope.database, platform, row.userId), day = rewardDay(now)
  const kills = account.day === day ? account.kills : 0
  if (row.damage < boss.maxHp * BOSS_REWARDS.qualify && (row.effectiveAttacks || 0) < 2) return { granted: false, note: '未达到新增奖励条件', gifts: [] as BossGift[], merit: 0, guarantee: 0 }
  if (kills >= BOSS_REWARDS.daily) return { granted: false, note: '今日新增奖励3次已用完，仍获基础分成', gifts: [] as BossGift[], merit: 0, guarantee: 0 }
  const index = rewardIndex(service.data, boss, player, row.rewardLevel)
  const gifts = bossSupplies(service.data, index, random), pending = { ...(account.pendingRare || {}) }
  const rare = account.pity >= BOSS_REWARDS.pity - 1 || random() < BOSS_REWARDS.chance
  let pity = account.pity + 1, note = ''
  if (rare) {
    pity = 0
    const item = rareBossItem(service.data, index, random)
    if (item) gifts.push({ id: item.id, count: 1, bound: false })
    else { const key = String(majorBounds(service.data, index).start); pending[key] = (pending[key] || 0) + 1; note = '稀有已命中，本境物品暂缺，记为待领，可进阶后【领取讨伐战利品】自选' }
  }
  const merit = contributionMerit(row.damage, boss.maxHp, rank, lastHit)
  const credited = Math.min(merit, Math.max(0, BOSS_REWARDS.maxInteger - account.merit))
  await scope.database.set('xiuxian_boss_account', who, { day, kills: kills + 1, pity, merit: account.merit + credited, pendingRare: pending })
  return { granted: true, gifts, merit: credited, guarantee: stoneGuarantee(index), note: `${note ? note + '；' : ''}${credited < merit ? '功勋余额达上限；' : ''}今日新增奖励${kills + 1}/3，稀有保底进度${pity}/5` }
}

export function applyBossExchange(ctx: any, now = Date.now, srv = ctx.xiuxian) {
  const queryAccount = async (s: any) => (await ctx.database.get('xiuxian_boss_account', { platform: s.platform, userId: s.userId }))[0]
  const catalog = (player: any, category: string) => {
    const index = levelIndex(srv.data, player.level)
    if (category === '药材') { const choices = rewardItems(srv.data, ['药材'], index); return choices.length ? choices : herbsAt(srv.data, index) }
    if (category === '突破丹') return rewardItems(srv.data, ['合成丹药'], index, true).filter(x => x.info.buff_type === 'level_up_big')
    return rewardItems(srv.data, ['功法', '神通'], index, true)
  }
  ctx.command('xiuxian/讨伐功勋', '查看功勋、每日奖励次数和稀有保底').action(async ({ session: s }: any) => {
    const player = await srv.getPlayer(s.userId)
    if (!player) return '请先【我要修仙】加入修仙世界。'
    const a = await queryAccount(s), used = a?.day === rewardDay(now()) ? a.kills : 0
    const pending = Object.entries(a?.pendingRare || {}).filter(([, count]) => Number(count) > 0).map(([index, count]) => `${majorBounds(srv.data, +index).name}×${count}`).join('、')
    return `讨伐功勋：${a?.merit || 0}\n今日新增击杀奖励：${used}/3（跨群共享，UTC+8零点重置）\n稀有保底进度：${a?.pity || 0}/5，第6次必出\n本周自选功法/神通：${a?.week === rewardWeek(now()) ? a.books : 0}/1\n待领稀有：${pending || '无'}\n【讨伐兑换】查看目录，【领取讨伐战利品】查看待领，【讨伐战利】查最近到账。`
  })
  ctx.command('xiuxian/讨伐战利', '查看本人最近一次世界Boss奖励流水').action(async ({ session: s }: any) => {
    const [record] = await ctx.database.select('xiuxian_boss_reward').where({ platform: s.platform, userId: s.userId }).orderBy('createdAt', 'desc').orderBy('bossId', 'desc').limit(1).execute()
    if (!record) return '暂无世界BOSS奖励流水。'
    const r = record.result
    return [`最近讨伐奖励：BOSS编号${record.bossId}（${record.outcome === 'kill' ? '击杀' : '遁走'}，${record.ruleVersion >= 2 ? '新版' : '旧版'}奖励）`,
      `修为+${r.exp}，灵石+${r.stone}，功勋+${r.merit || 0}`, ...r.items.map((x: string) => `物品：${x}`), r.rewardNote || '', r.unpaidStone ? `余额上限，${r.unpaidStone}灵石未能入账。` : '', '此处只查询已结算流水，不重复发奖。'].filter(Boolean).join('\n')
  })
  ctx.command('xiuxian/讨伐兑换 [query:text]', '功勋兑换绑定物资，支持药材、突破丹、功法神通')
    .action(async ({ session: s }: any, query = '') => {
      const player = await srv.getPlayer(s.userId)
      if (!player) return '请先【我要修仙】加入修仙世界。'
      const parts = query.trim().split(/\s+/), category = parts.shift() || ''
      if (!category) return '讨伐兑换：\n30功勋：自选药材3种，各3份。例【讨伐兑换 药材】查看编号，再发【讨伐兑换 药材 编号1 编号2 编号3】\n60功勋：突破丹1枚，先发【讨伐兑换 突破丹】查看编号。\n120功勋：同大境界功法/神通1本，每周限1本，先发【讨伐兑换 功法】或【讨伐兑换 神通】查看。\n全部兑换物绑定；按本人境界筛选。'
      if (!['药材', '突破丹', '功法', '神通'].includes(category)) return '兑换类别支持：药材、突破丹、功法、神通。'
      const choices = catalog(player, category).filter(x => !['功法', '神通'].includes(category) || x.info.item_type === category)
      if (!parts.length) {
        const backs = await srv.getBack(s.userId), learned = await srv.getLearnedSkills(s.userId), account = await queryAccount(s)
        const book = ['功法', '神通'].includes(category), cost = category === '药材' ? 30 : category === '突破丹' ? 60 : 120
        const bought = account?.week === rewardWeek(now()) ? account.books : 0
        return choices.length ? [`${category}兑换目录（绑定，${cost}功勋，现有${account?.merit || 0}${book ? `，本周自选书${bought}/1` : ''}）：`, ...choices.map(x => `${x.id}、${formatWorkReward(srv.data, x.id)}${category === '药材' ? '' : `（需${srv.data.levelOrder[x.index]}）`}${backs.some((b: any) => b.goodsId === x.id && b.goodsNum > 0) || learned.some((b: any) => Number(b.skillId ?? b.id) === x.id) ? '（已拥有）' : ''}`), `发送【讨伐兑换 ${category} ${category === '药材' ? '编号1 编号2 编号3' : '编号'}】。`].join('\n') : '本境界暂没有可用的兑换物品，请进阶后再查；不会扣功勋。'
      }
      const ids = parts.map(x => /^\d+$/.test(x) ? Number(x) : 0)
      if (ids.some(x => !Number.isSafeInteger(x) || x <= 0) || ids.length !== (category === '药材' ? 3 : 1) || new Set(ids).size !== ids.length) return '药材需填3个不同的有效编号；其他类别填1个编号。'
      return transactExchange(s, '兑换:' + query, async (scope, service, p, a) => {
        const pool = catalog(p, category).filter(x => !['功法', '神通'].includes(category) || x.info.item_type === category)
        if (ids.some(id => !pool.some(x => x.id === id))) return '所选物品不在当前可兑换目录或境界不足，本次未扣功勋。'
        const book = ['功法', '神通'].includes(category), cost = category === '药材' ? 30 : category === '突破丹' ? 60 : 120
        const week = rewardWeek(now()), books = a.week === week ? a.books : 0
        if (book && books >= 1) return '本周自选功法/神通已兑换1本，请下周再来。'
        if (a.merit < cost) return `功勋不足，需要${cost}，现有${a.merit}。`
        await deliverBossGifts(service, s.userId, ids.map(id => ({ id, count: category === '药材' ? 3 : 1, bound: true })))
        await scope.database.set('xiuxian_boss_account', { platform: s.platform, userId: s.userId }, { merit: a.merit - cost, ...(book ? { week, books: books + 1 } : {}) })
        return `兑换成功，消耗${cost}功勋，获得${ids.map(id => `${service.data.getItem(id).name}×${category === '药材' ? 3 : 1}`).join('、')}（绑定），剩余${a.merit - cost}功勋。`
      })
    })
  ctx.command('xiuxian/领取讨伐战利品 [id:integer]', '自选领取物品断档时记下的稀有奖励').action(async ({ session: s }: any, id?: number) => {
    const player = await srv.getPlayer(s.userId)
    if (!player) return '请先【我要修仙】加入修仙世界。'
    const a = await queryAccount(s), pending = a?.pendingRare || {}
    const available = (p: any, record: any) => rewardItems(srv.data, ['功法', '神通', '法器', '防具'], levelIndex(srv.data, p.level)).filter(x => Number(record[String(majorBounds(srv.data, x.index).start)]) > 0)
    if (id === undefined) {
      const choices = available(player, pending)
      return choices.length ? ['待领稀有自选目录（不绑定，可交易）：', ...choices.map(x => `${x.id}、${formatWorkReward(srv.data, x.id)}`), '发送【领取讨伐战利品 编号】，每件消耗对应境界的1次待领资格。'].join('\n') : '暂无可领取的稀有物品。已有待领资格会保留，进阶或物品库补齐后再查；【讨伐功勋】查看对应境界。'
    }
    return transactExchange(s, '领取:' + id, async (scope, service, p, record) => {
      const item = available(p, record.pendingRare || {}).find(x => x.id === id)
      if (!item) return '没有对应境界的待领资格，或该物品当前不可使用。'
      const key = String(majorBounds(srv.data, item.index).start), next = { ...record.pendingRare, [key]: record.pendingRare[key] - 1 }
      await deliverBossGifts(service, s.userId, [{ id, count: 1, bound: false }])
      await scope.database.set('xiuxian_boss_account', { platform: s.platform, userId: s.userId }, { pendingRare: next })
      return `已领取稀有战利品【${item.info.name}】×1（不绑定，可赠送和出售）。`
    })
  })
  async function transactExchange(s: any, content: string, action: (scope: any, service: any, player: any, account: any) => Promise<string>) {
    const request = s.messageId ? createHash('sha256').update(JSON.stringify([s.platform, s.bot?.deviceAccountId || s.selfId, s.guildId || s.channelId, s.userId, s.messageId, content])).digest('hex') : ''
    return withEconomyTransaction(ctx, srv, s.userId, async (scope, service) => {
      const player = await service.getPlayer(s.userId)
      if (!player) return '角色状态已变化，请重新查询。'
      const account = await lockBossAccount(scope.database, s.platform, s.userId)
      if (request) { const [old] = await scope.database.get('xiuxian_boss_exchange', { request }); if (old) return old.result }
      const result = await action(scope, service, player, account)
      if (request) await scope.database.create('xiuxian_boss_exchange', { request, platform: s.platform, userId: s.userId, result, createdAt: new Date(now()) })
      return result
    }).catch((error: any) => { if (error.code === 'BOSS_GIFT_CAPACITY') return error.message; throw error })
  }
}
