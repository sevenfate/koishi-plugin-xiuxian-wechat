import { $, h } from 'koishi'
import { displayName, readableName } from './wechat-profile'
import { formatWorkReward } from './work-reward'
import { BOSS_REWARDS, allocateBossRewards, applyBossExchange, characterKey, deliverBossGifts, extendBossRewards, prepareBossBonus, rewardDay, rewardIndex, stoneGuarantee } from './boss-rewards'

/** 由 index.js 注入的上游函数：battle-detail 有模块级状态，不能被 esbuild 打包出第二份。 */
export interface BossDeps {
  buildFighter: (srv: any, userId: string, session?: any) => Promise<any>
  playerFight: (p1: any, p2: any, data: any) => [string[], string, Record<string, number>, string]
  isHeavilyInjured: (exp: number, hp: number) => boolean
  storeBattleDetail: (record: any) => void
  BATTLE_DETAIL_HINT: string
  formatAmount: (n: number) => string
  randChoice: <T>(list: T[]) => T
  luckPoints: (rebirth?: number) => number
}

export interface BossOptions {
  /** 测试注入时钟 */
  now?: () => number
  /** 测试关闭每分钟的定时检查，改为手动调用 tick */
  timer?: boolean
  /** 隔离测试可固定随机数和旧发奖版本；生产新刷Boss默认使用新版奖励。 */
  random?: () => number
  rewardVersion?: 1 | 2
}

/** 新规则的 Boss 版本号；旧版（按全服第一生成）的记录在启动时删除。 */
export const BOSS_VERSION = 2
export const RULES = {
  attackCooldownMs: 30 * 60_000,
  defaultHours: 6, minHours: 1, maxHours: 72,
  activeDays: 7, minHeadcount: 3, maxHeadcount: 20, fallbackStrength: 1000, minStrength: 100,
  atkRate: 0.1, hpRate: 1.5, hitCapRate: 0.15,
  expPoolRate: 0.05, stonePoolRate: 0.03,
  floorRate: 0.2, capRate: 0.3, lastHitRate: 0.1, escapeRate: 0.5, lootShareRate: 0.05,
  quietEndHour: 8, activityDebounceMs: 60 * 60_000,
}
const BOSS_NAMES = ['金凰儿', '九寒', '莫女', '术方', '卫起', '血枫', '衣以候', '以向']
const LOOT_TYPES = ['功法', '神通', '丹药', '法器', '防具']
const HOUR = 3600_000

/** 只接受完整的 Boss 指令，避免把提到 Boss 的普通聊天当作管理操作。 */
export function normalizeBossCommand(input: string): { command: string; text: string } | undefined {
  const match = input.replace(/^xiuxian(?:\.|\s+)/i, '').match(/^(?:(查看|讨伐|启动|停止|创建)\s*)?世界\s*(?:boss|boos)\s*(.*?)\s*$/i)
  if (!match) return
  const [, action, argument] = match
  let command: string
  if (!action) {
    if (argument && !['帮助', '奖励'].includes(argument)) return
    command = argument ? `世界boss${argument}` : '查看世界boss'
  } else {
    if (action === '启动') { if (argument && !/^\d+(?:\s*(?:小时|h))?$/i.test(argument)) return }
    else if (action === '讨伐') { if (argument && !/^\d+$/.test(argument)) return }
    else if (argument) return
    command = `${action}世界boss`
  }
  return { command, text: command + (action && argument ? ' ' + argument : '') }
}

export function parseBossHours(value?: string | number): number {
  if (value === undefined) return RULES.defaultHours
  const match = String(value).trim().match(/^(\d+)\s*(?:小时|h)?$/i)
  return match ? Number(match[1]) : NaN
}
/** 上海无夏令时，固定 UTC+8 即可换算本地钟点。 */
const SHANGHAI_OFFSET = 8 * HOUR

/** 落在 0～8 点的时刻推迟到当天 8 点，避免半夜刷新或逃走时往群里推消息。 */
export function deferQuiet(ms: number) {
  const local = ms + SHANGHAI_OFFSET
  const dayStart = local - (local % (24 * HOUR))
  const quietEnd = dayStart + RULES.quietEndHour * HOUR
  return local < quietEnd ? quietEnd - SHANGHAI_OFFSET : ms
}

export const isQuiet = (ms: number) => deferQuiet(ms) !== ms

/** 上海时间 MM-DD HH:mm */
export function formatClock(ms: number) {
  const d = new Date(ms + SHANGHAI_OFFSET)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function formatSpan(ms: number) {
  const minutes = Math.max(Math.ceil(ms / 60_000), 1)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分` : ''}` : `${minutes}分钟`
}

export const formatBossPercent = (damage: number, maxHp: number) => `${(maxHp > 0 ? damage / maxHp * 100 : 0).toFixed(1)}%`
const percent = formatBossPercent

export function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** S 取本群活跃玩家修为中位数，N 为活跃人数；数值随群内实力变化，不再参考全服第一。 */
export function bossStats(strength: number, headcount: number) {
  const n = Math.min(Math.max(headcount, RULES.minHeadcount), RULES.maxHeadcount)
  const s = Math.max(Math.floor(strength), RULES.minStrength)
  return {
    strength: s, headcount: n,
    atk: Math.floor(s * RULES.atkRate),
    maxHp: Math.floor(s * n * RULES.hpRate),
    expPool: Math.floor(s * n * RULES.expPoolRate),
    stonePool: Math.floor(s * n * RULES.stonePoolRate),
  }
}

export interface Share { userId: string; platform?: string; damage: number; exp: number; stone: number; lastHit: boolean; items: string[]; unpaidStone?: number; merit?: number; rewardNote?: string }

/**
 * 按伤害占 Boss 最大气血的比例分奖池：击杀时全部伤害合计即满额，逃走再乘 50%。
 * 造成过伤害的人保底拿人均份额的 20%，单人最多拿奖池的 30%，抑制大号独占和小号蹭奖。
 */
export function allocate(boss: { maxHp: number; expReward: number; stone: number; headcount: number },
  rows: { userId: string; platform?: string; damage: number }[], outcome: 'kill' | 'escape', killerId?: string): Share[] {
  const scale = outcome === 'kill' ? 1 : RULES.escapeRate
  const pay = (pool: number, damage: number) => {
    const raw = pool * scale * Math.min(damage / boss.maxHp, 1)
    const floor = damage > 0 ? pool * scale / boss.headcount * RULES.floorRate : 0
    return Math.floor(Math.min(Math.max(raw, floor), pool * scale * RULES.capRate))
  }
  const shares = rows.filter(row => row.damage > 0 || row.userId === killerId).map(row => {
    const lastHit = outcome === 'kill' && row.userId === killerId
    const bonus = lastHit ? Math.floor(boss.stone * RULES.lastHitRate) : 0
    return { userId: row.userId, platform: row.platform, damage: row.damage, exp: pay(boss.expReward, row.damage),
      stone: pay(boss.stone, row.damage) + bonus, lastHit, items: [] }
  })
  // 实际参战人数可能远超生成时人数；不能让大量微量伤害的保底奖励超发奖池。
  const bonus = Math.floor(boss.stone * RULES.lastHitRate)
  const totalExp = shares.reduce((sum, share) => sum + share.exp, 0)
  const totalStone = shares.reduce((sum, share) => sum + share.stone - (share.lastHit ? bonus : 0), 0)
  for (const share of shares) {
    if (totalExp > boss.expReward * scale) share.exp = Math.floor(share.exp * boss.expReward * scale / totalExp)
    if (totalStone > boss.stone * scale) {
      share.stone = Math.floor((share.stone - (share.lastHit ? bonus : 0)) * boss.stone * scale / totalStone)
        + (share.lastHit ? bonus : 0)
    }
  }
  return shares
}

/** 击杀战利品：伤害第一必得 1 件，再按伤害加权从占比 ≥5% 的人里抽 1 件。 */
export function lootRecipients(shares: Share[], maxHp: number, random = Math.random) {
  if (!shares.length) return []
  const ranked = [...shares].sort((a, b) => b.damage - a.damage)
  const pool = ranked.filter(share => share.damage >= maxHp * RULES.lootShareRate)
  const total = pool.reduce((sum, share) => sum + share.damage, 0)
  let roll = random() * total
  const second = pool.find(share => (roll -= share.damage) < 0) ?? pool[pool.length - 1]
  return second ? [ranked[0].userId, second.userId] : [ranked[0].userId]
}

type Target = { channelId: string; platform: string; selfId: string; guildId: string; targetId: string }
const pickTarget = (row: any): Target => ({ channelId: row.channelId, platform: row.platform, selfId: row.selfId, guildId: row.guildId, targetId: row.targetId })

/** 与上游 boss 模块一致：群聊按 guildId 区分，取不到时退回 channelId。 */
const channelOf = (session: any) => session.guildId || session.channelId || 'private'
const targetOf = (session: any): Target => ({
  channelId: channelOf(session), platform: session.platform, selfId: session.selfId,
  guildId: session.guildId || '', targetId: session.channelId || session.guildId,
})

export function applyWorldBoss(ctx: any, adminCtx: any, deps: BossDeps, options: BossOptions = {}) {
  const srv = ctx.xiuxian
  const now = options.now ?? Date.now
  const logger = ctx.logger('huaji-xiuxian')
  const fmt = deps.formatAmount

  // 只规范输入，后续仍走原生指令权限、冷却和群过滤，不直接调用管理回调。
  const inputCtx = (adminCtx ?? ctx).union(ctx)
  inputCtx.middleware(async (session: any, next: any) => {
    const content = session.stripped.content
    if (typeof content !== 'string') return next()
    const value = session.resolve(ctx.root.config.prefix)
    const prefixes = (Array.isArray(value) ? value : [value || '']).map((p: string) => h.escape(p)).sort((a: string, b: string) => b.length - a.length)
    const prefix = prefixes.find((p: string) => content.startsWith(p))
    if (prefix === undefined && !session.stripped.appel) return next()
    const body = content.slice((prefix || '').length).replace(/^\/(?!\/)/, '')
    const result = normalizeBossCommand(body)
    if (!result) return next()
    const command = ctx.$commander.get(result.command, session)
    if (!command || !command.ctx.filter(session)) return next()
    let parent = command
    for (; parent && parent.name !== 'xiuxian'; parent = parent.parent) {}
    if (parent) session.stripped.content = (prefix || '') + result.text
    return next()
  }, true)

  function targetAllowed(target: Target) {
    const bot = ctx.bots.find((b: any) => b.platform === target.platform && b.selfId === target.selfId)
      ?? ctx.bots.find((b: any) => b.platform === target.platform)
    if (!bot) return false
    const session = bot.session({ type: 'message', guild: { id: target.guildId }, channel: { id: target.targetId, type: 0 }, user: { id: bot.selfId } })
    return ctx.filter(session)
  }

  ctx.model.extend('xiuxian_boss', {
    id: 'unsigned', channelId: 'string', name: 'string', level: 'string',
    hp: 'double', maxHp: 'double', atk: 'double',
    // stone / expReward 沿用旧列名，分别存灵石奖池与修为奖池
    stone: 'double', expReward: 'double',
    version: { type: 'integer', initial: 0 },
    rewardVersion: { type: 'integer', initial: 1 },
    platform: 'string', selfId: 'string', guildId: 'string', targetId: 'string',
    strength: 'double', headcount: { type: 'integer', initial: 0 },
    createdAt: 'timestamp', expireAt: 'timestamp',
  }, { primary: 'id', autoInc: true })
  ctx.model.extend('xiuxian_boss_participant', {
    bossId: 'unsigned', userId: 'string', platform: 'string',
    damage: { type: 'double', initial: 0 }, lastAttackAt: 'timestamp',
    character: 'string', rewardLevel: 'string', effectiveAttacks: { type: 'integer', initial: 0 },
  }, { primary: ['bossId', 'userId'] })
  // 同一群的刷新/开关操作共用持久化锁，防止定时器与管理员并发生成两只。
  ctx.model.extend('xiuxian_boss_channel', { channelId: 'string', token: { type: 'integer', initial: 0 } }, { primary: 'channelId' })
  ctx.model.extend('xiuxian_boss_schedule', {
    channelId: 'string', platform: 'string', selfId: 'string', guildId: 'string', targetId: 'string',
    intervalHours: { type: 'integer', initial: RULES.defaultHours }, nextSpawnAt: 'timestamp',
  }, { primary: 'channelId' })
  ctx.model.extend('xiuxian_boss_activity', {
    channelId: 'string', userId: 'string', lastSeen: 'timestamp',
  }, { primary: ['channelId', 'userId'] })
  extendBossRewards(ctx)
  applyBossExchange(ctx, now, srv)

  // 记录本群近期发过修仙指令的玩家，作为难度基准；同一人每小时最多写一次库。
  const seen = new Map<string, number>()
  ctx.on('command/before-execute', async ({ command, session }: any) => {
    let cmd = command, isXiuxian = false
    for (; cmd; cmd = cmd.parent) if (cmd.name === 'xiuxian') { isXiuxian = true; break }
    if (!isXiuxian || !session?.guildId || !session.userId || !ctx.filter(session)) return
    const key = `${channelOf(session)}:${session.userId}`, t = now()
    if (t - (seen.get(key) ?? 0) < RULES.activityDebounceMs) return
    seen.set(key, t)
    try {
      await ctx.database.upsert('xiuxian_boss_activity', [{ channelId: channelOf(session), userId: session.userId, lastSeen: new Date(t) }])
    } catch (error: any) { logger.warn('记录世界BOSS活跃玩家失败：%s', error?.message) }
  })

  async function measure(channelId: string, scope = ctx) {
    const since = new Date(now() - RULES.activeDays * 24 * HOUR)
    await scope.database.remove('xiuxian_boss_activity', { lastSeen: { $lt: since } })
    const rows = await scope.database.get('xiuxian_boss_activity', { channelId })
    const players = rows.length ? await scope.database.get('xiuxian_player', { userId: rows.map((r: any) => r.userId) }) : []
    if (!players.length) return { strength: RULES.fallbackStrength, headcount: 0, level: '江湖好手' }
    const sorted = [...players].sort((a: any, b: any) => a.exp - b.exp)
    return { strength: median(players.map((p: any) => p.exp)), headcount: players.length, level: sorted[(sorted.length - 1) >> 1].level }
  }

  async function spawn(target: Target, expireAt: number, scope = ctx) {
    const { strength, headcount, level } = await measure(target.channelId, scope)
    const stats = bossStats(strength, headcount)
    return scope.database.create('xiuxian_boss', {
      ...target, version: BOSS_VERSION, rewardVersion: options.rewardVersion ?? BOSS_REWARDS.version, name: deps.randChoice(BOSS_NAMES), level,
      hp: stats.maxHp, maxHp: stats.maxHp, atk: stats.atk, stone: stats.stonePool, expReward: stats.expPool,
      strength: stats.strength, headcount: stats.headcount, createdAt: new Date(now()), expireAt: new Date(expireAt),
    })
  }

  const spawnText = (boss: any) => [
    `妖气冲天，大妖【${boss.name}】（编号${boss.id}，${boss.level}）现世！`,
    `气血${fmt(boss.maxHp)}，攻击${fmt(boss.atk)}，将于${formatClock(+boss.expireAt)}遁走。`,
    `修为奖池${fmt(boss.expReward)}、灵石奖池${fmt(boss.stone)}，按伤害分配。发送【讨伐世界boss】出手！`,
    boss.rewardVersion >= 2 ? '新版奖励：每日跨群前3次合格击杀，灵石保底5万～30万、药材、恢复丹、功勋；稀有独立15%，第6次保底。发送【世界boss奖励】看条件。' : '本只沿用旧版奖励规则。',
  ].join('\n')

  async function liveBoss(channelId: string, scope = ctx) {
    const list = await scope.database.select('xiuxian_boss').where({ channelId, version: BOSS_VERSION }).orderBy('id').execute()
    return list[0]
  }

  /** 先锁 Boss 行再读：同一只 Boss 的讨伐、击杀和逃走结算串行执行，奖励只发一次。 */
  async function withBoss<T>(bossId: number, action: (scope: any, service: any, boss: any) => Promise<T>): Promise<T> {
    return ctx.database.transact(async (database: any) => {
      await database.set('xiuxian_boss', { id: bossId }, (row: any) => ({ hp: $.add(row.hp, 0) }))
      const [boss] = await database.get('xiuxian_boss', { id: bossId })
      const scope = new Proxy(ctx, { get: (target, key) => key === 'database' ? database : Reflect.get(target, key, target) })
      // 取原型方法，避免 Cordis 的服务代理把事务上下文换回原上下文。
      const service = Object.assign(Object.create(Object.getPrototypeOf(srv)), { ctx: scope, config: srv.config, data: srv.data })
      return action(scope, service, boss)
    })
  }

  async function withChannel<T>(channelId: string, action: (scope: any) => Promise<T>): Promise<T> {
    await ctx.database.upsert('xiuxian_boss_channel', [{ channelId }])
    return ctx.database.transact(async (database: any) => {
      await database.set('xiuxian_boss_channel', { channelId }, (row: any) => ({ token: $.add(row.token, 0) }))
      const scope = new Proxy(ctx, { get: (target, key) => key === 'database' ? database : Reflect.get(target, key, target) })
      return action(scope)
    })
  }

  async function lockPlayers(scope: any, ids: string[]) {
    for (const userId of [...new Set(ids)].sort()) {
      await scope.database.set('xiuxian_player', { userId }, (row: any) => ({ exp: $.add(row.exp, 0) }))
    }
  }

  function pickLoot(service: any, player: any) {
    const rank = service.data.itemRankByLevel(player.level)
    const luck = deps.luckPoints(player.rebirth)
    for (const types of [[deps.randChoice(LOOT_TYPES)], LOOT_TYPES, undefined]) {
      const id = Number(service.data.randomItemIdByRank(rank, types, luck))
      const info = id ? service.data.getItem(id) : undefined
      if (info) return { id, info }
    }
  }

  /** 在 withBoss 事务内发奖并删除 Boss；按 userId 顺序写玩家行，避免两只 Boss 同时结算时互相等锁。 */
  async function settle(scope: any, service: any, boss: any, outcome: 'kill' | 'escape', killerId?: string) {
    const rows = await scope.database.get('xiuxian_boss_participant', { bossId: boss.id })
    await lockPlayers(scope, rows.map((row: any) => row.userId))
    const modern = boss.rewardVersion >= 2, players = new Map<string, any>()
    for (const row of rows) players.set(row.userId, await service.getPlayer(row.userId))
    const valid = modern ? rows.filter((r: any) => players.get(r.userId) && r.character === characterKey(players.get(r.userId))) : rows
    const shares: Share[] = (modern ? allocateBossRewards(boss, valid, outcome, killerId) : allocate(boss, rows, outcome, killerId)).sort((a, b) => a.userId < b.userId ? -1 : 1)
    const ranked = [...shares].sort((a, b) => b.damage - a.damage || a.userId.localeCompare(b.userId))
    const looters = !modern && outcome === 'kill' ? lootRecipients(shares, boss.maxHp) : []
    const settledAt = now()
    for (const share of shares) {
      const player = players.get(share.userId)
      if (!player) { share.exp = share.stone = 0; continue }
      const platform = share.platform || player.platform
      const receipt = { bossId: boss.id, platform, userId: share.userId }
      if ((await scope.database.get('xiuxian_boss_reward', receipt)).length) { share.exp = share.stone = 0; share.rewardNote = '本场已结算，不重复发奖'; continue }
      const baseStone = share.stone
      const bonus = modern && outcome === 'kill' ? await prepareBossBonus(scope, service, boss, valid.find((r: any) => r.userId === share.userId), player, ranked.indexOf(share), share.lastHit, settledAt, options.random) : undefined
      if (bonus) { share.stone = Math.max(share.stone, bonus.guarantee); share.merit = bonus.merit; share.rewardNote = bonus.note }
      await service.addExp(share.userId, share.exp)
      await service.updatePower(share.userId)
      if (share.stone > 0) {
        if (await service.getCanonicalUid(share.userId, platform) <= 0) throw new Error('世界BOSS奖励无法解析玩家钱包')
        const balance = await service.getStoneForUser(share.userId, platform)
        const credited = Math.min(share.stone, Math.max(2147483647 - balance, 0))
        share.unpaidStone = share.stone - credited
        share.stone = credited
        await service.gainStoneForUser(share.userId, credited, platform)
      }
      for (const userId of looters) {
        if (userId !== share.userId) continue
        const loot = pickLoot(service, player)
        if (!loot) continue
        await service.sendBack(share.userId, loot.id, loot.info.name, loot.info.item_type ?? '丹药', 1)
        share.items.push(formatWorkReward(service.data, loot.id))
      }
      if (bonus) {
        await deliverBossGifts(service, share.userId, bonus.gifts)
        share.items.push(...bonus.gifts.map(g => `${formatWorkReward(service.data, g.id)}×${g.count}（${g.bound ? '绑定' : '不绑定，可交易'}）`))
      }
      await scope.database.create('xiuxian_boss_reward', { ...receipt, character: characterKey(player), outcome, ruleVersion: boss.rewardVersion || 1, result: { ...share, baseStone, extraGranted: bonus?.granted || false, gifts: bonus?.gifts || [], boss: { maxHp: boss.maxHp, strength: boss.strength, level: boss.level } }, createdAt: new Date(settledAt) })
    }
    await scope.database.remove('xiuxian_boss_participant', { bossId: boss.id })
    await scope.database.remove('xiuxian_boss', { id: boss.id })
    return shares.sort((a, b) => b.damage - a.damage)
  }

  /** 结算排行：只列前 10 名，其余合并成一句，避免刷屏。 */
  async function settleText(session: any, boss: any, shares: Share[], outcome: 'kill' | 'escape') {
    if (!shares.length) return `【${boss.name}】无人讨伐，已遁走。`
    const head = outcome === 'kill'
      ? `【${boss.name}】已被讨伐！${shares.length}位道友按伤害分得奖励：`
      : `【${boss.name}】久战不下，已遁走！${shares.length}位道友按伤害分得一半奖励（逃走不掉落战利品）：`
    const lines = [head]
    for (const [i, share] of shares.slice(0, 10).entries()) {
      const player = await srv.getPlayer(share.userId)
      const name = session ? await displayName(ctx, session, share.userId, player?.userName)
        : readableName(player?.userName, share.userId) || '无名道友'
      lines.push(`${i + 1}. ${name}${share.lastHit ? '（最后一击）' : ''} 伤害${fmt(share.damage)}（${percent(share.damage, boss.maxHp)}），`
        + `修为+${fmt(share.exp)}，灵石+${fmt(share.stone)}${share.unpaidStone ? `（余额上限，${fmt(share.unpaidStone)}灵石无法入账）` : ''}${share.merit ? `，功勋+${share.merit}` : ''}${share.items.length ? `，战利品：${share.items.join('、')}` : ''}${share.rewardNote ? `\n   ${share.rewardNote}` : ''}`)
    }
    if (shares.length > 10) lines.push(`……另有${shares.length - 10}位道友各得相应奖励。`)
    return lines.join('\n')
  }

  /** 定时刷新、逃走没有触发消息的会话，按记录的平台和机器人账号主动推送到群。 */
  async function announce(target: Target, render: (session: any) => Promise<string> | string) {
    const bot = ctx.bots.find((b: any) => b.platform === target.platform && b.selfId === target.selfId)
      ?? ctx.bots.find((b: any) => b.platform === target.platform)
    if (!bot) return logger.warn('世界BOSS推送失败：找不到 %s 平台的机器人', target.platform)
    try {
      const session = bot.session({ type: 'message', guild: { id: target.guildId }, channel: { id: target.targetId, type: 0 }, user: { id: bot.selfId } })
      await bot.sendMessage(target.targetId, await render(session))
    } catch (error: any) { logger.warn('世界BOSS推送到 %s 失败：%s', target.targetId, error?.message) }
  }

  let ticking = false
  /** 先结算到期的 Boss，再刷新到点的群；停机错过多次也只补刷一只，下次时间从现在重新算。 */
  async function tick() {
    if (ticking) return
    ticking = true
    try {
      const t = now()
      // 到期与刷新时间都已避开 0～8 点；停机后在夜里补跑的，留到 8 点再处理。
      if (isQuiet(t)) return
      const expired = await ctx.database.get('xiuxian_boss', { version: BOSS_VERSION, expireAt: { $lte: new Date(t) } })
      for (const row of expired) {
        if (!targetAllowed(row)) continue
        const result = await withBoss(row.id, async (scope, service, boss) => {
          if (!boss || +boss.expireAt > t) return
          return { boss, shares: await settle(scope, service, boss, 'escape') }
        })
        if (result) await announce(result.boss, session => settleText(session, result.boss, result.shares, 'escape'))
      }
      const plans = await ctx.database.get('xiuxian_boss_schedule', { nextSpawnAt: { $lte: new Date(t) } })
      for (const plan of plans) {
        if (!targetAllowed(plan)) continue
        const result = await withChannel(plan.channelId, async scope => {
          // 计划在锁外枚举，进锁后必须重新检查是否已被关闭或改期。
          const [current] = await scope.database.get('xiuxian_boss_schedule', { channelId: plan.channelId })
          if (!current || +current.nextSpawnAt > t) return
          const live = await liveBoss(plan.channelId, scope)
          if (live) {
            await scope.database.set('xiuxian_boss_schedule', { channelId: plan.channelId }, { nextSpawnAt: live.expireAt })
            return
          }
          const next = deferQuiet(t + current.intervalHours * HOUR)
          const boss = await spawn(pickTarget(current), next, scope)
          await scope.database.set('xiuxian_boss_schedule', { channelId: plan.channelId }, { nextSpawnAt: new Date(next) })
          return { boss, plan: current }
        })
        if (result) await announce(result.plan, () => spawnText(result.boss))
      }
    } catch (error: any) {
      logger.warn('世界BOSS定时检查失败：%s', error?.message)
    } finally { ticking = false }
  }

  ctx.on('ready', async () => {
    // 旧版 Boss 按全服第一生成，套不上新奖池，升级时直接删除，不发奖。
    const legacy = (await ctx.database.get('xiuxian_boss', {})).filter((b: any) => b.version !== BOSS_VERSION)
    if (legacy.length) {
      await ctx.database.remove('xiuxian_boss', { id: legacy.map((b: any) => b.id) })
      logger.info('已删除%d只旧版世界BOSS', legacy.length)
    }
    const alive = (await ctx.database.get('xiuxian_boss', {})).map((b: any) => b.id)
    await ctx.database.remove('xiuxian_boss_participant', alive.length ? { bossId: { $nin: alive } } : {})
    if (options.timer === false) return
    ctx.setInterval(tick, 60_000)
    await tick()
  })

  const missing = '修仙界没有道友的信息，请输入【我要修仙】加入！'
  ctx.command('xiuxian/讨伐世界boss [id:integer]', '讨伐世界BOSS')
    .action(async ({ session }: any, id?: number) => {
      const userId = session.userId
      // 装备同步、神通读取有多次查询，放在锁外，缩短 Boss 行被锁住的时间。
      const player = await srv.getPlayer(userId)
      if (!player) return missing
      const fighter = await deps.buildFighter(srv, userId, session)
      if (!fighter) return missing
      if (deps.isHeavilyInjured(player.exp, player.hp)) return '道友重伤未愈，无法讨伐BOSS！'
      const live = await liveBoss(channelOf(session))
      if (!live) return '本群暂无世界BOSS！'
      if (id && id !== live.id) return `没有这个编号的世界BOSS！当前为编号${live.id}。`
      const result = await withBoss(live.id, async (scope, service, boss) => {
        if (!boss || +boss.expireAt <= now()) return { kind: 'gone' as const }
        const [record] = await scope.database.get('xiuxian_boss_participant', { bossId: boss.id, userId })
        if (boss.rewardVersion >= 2 && record && record.character !== characterKey(player)) return { kind: 'stale' as const }
        const wait = record?.lastAttackAt ? +record.lastAttackAt + RULES.attackCooldownMs - now() : 0
        if (wait > 0) return { kind: 'cooldown' as const, wait }
        // 击杀前也按全体参与者的固定顺序锁玩家，不能先锁最后一击者再逆序结算。
        const participants = await scope.database.get('xiuxian_boss_participant', { bossId: boss.id })
        await lockPlayers(scope, [...participants.map((row: any) => row.userId), userId])
        const fresh = await service.getPlayer(userId)
        if (!fresh || deps.isHeavilyInjured(fresh.exp, fresh.hp)) return { kind: 'injured' as const }
        if (boss.rewardVersion >= 2 && characterKey(fresh) !== characterKey(player)) return { kind: 'changed' as const }
        // 单次伤害最多打掉最大气血的 15%：用"本次可打的气血"作为 Boss 的战斗血量。
        const budget = Math.min(boss.hp, Math.max(Math.floor(boss.maxHp * RULES.hitCapRate), 1))
        const enemy = { userId: `boss-${boss.id}`, name: boss.name, hp: budget, atk: Math.floor(boss.atk),
          mp: 0, crit: 1, critDamage: 1.5, defense: 0, armorPen: 0 }
        const [log, , finalHp] = deps.playerFight({ ...fighter, hp: Math.max(Math.floor(Math.min(fresh.hp, Math.floor(fresh.exp / 2)) * (fighter.hpScale ?? 1)), 1) }, enemy, service.data)
        const damage = Math.max(budget - Math.max(finalHp[enemy.userId], 0), 0)
        const playerHp = Math.max(finalHp[userId] ?? 0, 0)
        const total = (record?.damage ?? 0) + damage
        const stamp = new Date(now())
        const progress = { damage: total, lastAttackAt: stamp, platform: session.platform, effectiveAttacks: (record?.effectiveAttacks || 0) + Number(damage > 0) }
        if (record) await scope.database.set('xiuxian_boss_participant', { bossId: boss.id, userId }, progress)
        else await scope.database.create('xiuxian_boss_participant', { bossId: boss.id, userId, ...progress, character: characterKey(fresh), rewardLevel: fresh.level })
        await service.applyBattleHp(userId, playerHp)
        deps.storeBattleDetail({ kind: 'boss', userId, bossId: boss.id, detail: log.join('\n') })
        const rounds = Math.ceil(log.length / 2)
        if (damage >= boss.hp) return { kind: 'kill' as const, boss, rounds, playerHp, shares: await settle(scope, service, boss, 'kill', userId) }
        await scope.database.set('xiuxian_boss', { id: boss.id }, { hp: boss.hp - damage })
        return { kind: 'hit' as const, boss, damage, total, capped: damage >= budget, left: boss.hp - damage, playerHp }
      })
      if (result.kind === 'gone') return '这只世界BOSS已被讨伐或遁走了。'
      if (result.kind === 'cooldown') return `道友刚与BOSS交过手，请${formatSpan(result.wait)}后再战。`
      if (result.kind === 'injured') return '道友重伤未愈，无法讨伐BOSS！'
      if (result.kind === 'stale') return '本轮参战记录属于重入前的角色，请等下一只BOSS再参战。'
      if (result.kind === 'changed') return '角色状态已变化，请重新发送讨伐指令。'
      const injury = result.playerHp <= 0 ? '\n道友气血耗尽，重伤濒危。' : ''
      if (result.kind === 'kill') {
        return `道友历经${result.rounds}回合，终斩【${result.boss.name}】！\n`
          + await settleText(session, result.boss, result.shares, 'kill') + injury + '\n' + deps.BATTLE_DETAIL_HINT
      }
      return [
        result.capped ? `道友重创【${result.boss.name}】，大妖负伤暂退！` : `道友不敌【${result.boss.name}】，败下阵来。`,
        `本次伤害${fmt(result.damage)}（${percent(result.damage, result.boss.maxHp)}），累计伤害${fmt(result.total)}（${percent(result.total, result.boss.maxHp)}）。`,
        `BOSS剩余气血${fmt(result.left)}/${fmt(result.boss.maxHp)}，道友剩余气血${fmt(result.playerHp)}。${injury}`,
        `${formatSpan(RULES.attackCooldownMs)}后可再次讨伐。${deps.BATTLE_DETAIL_HINT}`,
      ].join('\n')
    })

  ctx.command('xiuxian/查看世界boss', '查看当前群内的世界BOSS')
    .alias('世界boss')
    .action(async ({ session }: any) => {
      const channelId = channelOf(session)
      const [boss, [plan]] = await Promise.all([liveBoss(channelId), ctx.database.get('xiuxian_boss_schedule', { channelId })])
      if (!boss) return plan ? `本群暂无世界BOSS，下一只将于${formatClock(+plan.nextSpawnAt)}现世。`
        : '本群暂无世界BOSS，可由管理员发送【启动世界boss】开启定时刷新。'
      const rows = await ctx.database.get('xiuxian_boss_participant', { bossId: boss.id })
      rows.sort((a: any, b: any) => b.damage - a.damage)
      const lines = [
        `✨世界BOSS【${boss.name}】（编号${boss.id}，${boss.level}）✨`,
        `气血：${fmt(boss.hp)}/${fmt(boss.maxHp)}，攻击：${fmt(boss.atk)}`,
        `遁走时间：${formatClock(+boss.expireAt)}（剩余${formatSpan(+boss.expireAt - now())}）`,
        `修为奖池${fmt(boss.expReward)}、灵石奖池${fmt(boss.stone)}，已有${rows.length}位道友参战`,
      ]
      if (rows.length) lines.push('伤害排行：')
      for (const [i, row] of rows.slice(0, 5).entries()) {
        const player = await srv.getPlayer(row.userId)
        lines.push(`${i + 1}. ${await displayName(ctx, session, row.userId, player?.userName)} ${fmt(row.damage)}（${percent(row.damage, boss.maxHp)}）`)
      }
      const mine = rows.find((row: any) => row.userId === session.userId)
      if (mine) {
        const wait = mine.lastAttackAt ? +mine.lastAttackAt + RULES.attackCooldownMs - now() : 0
        lines.push(`道友累计伤害${fmt(mine.damage)}（${percent(mine.damage, boss.maxHp)}），${wait > 0 ? `${formatSpan(wait)}后可再战` : '现在可以讨伐'}。`)
      } else lines.push('道友尚未出手，发送【讨伐世界boss】参战。')
      lines.push('讨伐每人每只冷却30分钟，单次伤害上限15%；悬赏和闭关不占用此冷却，重伤时需先恢复。')
      if (plan) lines.push(`本群每${plan.intervalHours}小时刷新一只世界BOSS。`)
      if (boss.rewardVersion >= 2) {
        const player = await srv.getPlayer(session.userId)
        if (player) {
          const index = rewardIndex(srv.data, boss, player, mine?.rewardLevel || player.level)
          const [account] = await ctx.database.get('xiuxian_boss_account', { platform: session.platform, userId: session.userId })
          const used = account?.day === rewardDay(now()) ? account.kills : 0
          const qualified = mine && (mine.damage >= boss.maxHp * BOSS_REWARDS.qualify || mine.effectiveAttacks >= 2)
          lines.push(`本人新增奖励：灵石保底${fmt(stoneGuarantee(index))}，今日剩余${Math.max(0, 3 - used)}次；${qualified ? '本场已达参战门槛' : '需累计伤害≥0.5%或2次正伤害讨伐'}。`)
        }
      }
      lines.push(boss.rewardVersion >= 2 ? '新版奖励：20%均分、80%按伤害；合格击杀每日跨群前3次有新增奖励。【世界boss奖励】看详情，【讨伐功勋】看次数和保底。' : '本只按旧奖励结算；下次新刷BOSS采用新版奖励。')
      return lines.join('\n')
    })

  const admin = adminCtx ?? ctx
  // 与上游 helpers.ADMIN_AUTHORITY 一致
  const ADMIN = { authority: 999 }
  const groupOnly = '世界BOSS仅在群聊中使用！'
  admin.command('xiuxian/创建世界boss', '【管理】立即生成一只世界BOSS', ADMIN)
    .action(async ({ session }: any) => {
      if (!session.guildId) return groupOnly
      const target = targetOf(session)
      if (!targetAllowed(target)) return '本群未启用修仙，无法生成世界BOSS。'
      return withChannel(target.channelId, async scope => {
        if (await liveBoss(target.channelId, scope)) return '本群已有世界BOSS存活，讨伐或遁走后才能再生成。'
        const [plan] = await scope.database.get('xiuxian_boss_schedule', { channelId: target.channelId })
        const expireAt = deferQuiet(now() + (plan?.intervalHours ?? RULES.defaultHours) * HOUR)
        const boss = await spawn(target, expireAt, scope)
        // 已开启定时刷新时，下次刷新对齐到这只 Boss 遁走的时间。
        if (plan) await scope.database.set('xiuxian_boss_schedule', { channelId: target.channelId }, { nextSpawnAt: new Date(expireAt) })
        return spawnText(boss)
      })
    })

  admin.command('xiuxian/启动世界boss [hours:text]', '【管理】开启本群世界BOSS定时刷新', ADMIN)
    .action(async ({ session }: any, hours?: string | number) => {
      if (!session.guildId) return groupOnly
      const interval = parseBossHours(hours)
      if (!Number.isInteger(interval) || interval < RULES.minHours || interval > RULES.maxHours) {
        return `刷新间隔需为${RULES.minHours}～${RULES.maxHours}的整数小时，例如：启动世界boss 6`
      }
      const target = targetOf(session)
      if (!targetAllowed(target)) return '本群未启用修仙，无法开启世界BOSS定时刷新。'
      return withChannel(target.channelId, async scope => {
        const live = await liveBoss(target.channelId, scope)
        const tip = `已开启本群世界BOSS定时刷新：每${interval}小时一只，0～8点不刷新（到点顺延到8点）。`
        if (live) {
          await scope.database.upsert('xiuxian_boss_schedule', [{ ...target, intervalHours: interval, nextSpawnAt: live.expireAt }])
          return `${tip}\n当前世界BOSS【${live.name}】仍在，${formatClock(+live.expireAt)}后刷新下一只。`
        }
        // 管理员手动启动时立即刷出第一只，不受夜间限制；遁走时间仍避开夜间。
        const next = deferQuiet(now() + interval * HOUR)
        const boss = await spawn(target, next, scope)
        await scope.database.upsert('xiuxian_boss_schedule', [{ ...target, intervalHours: interval, nextSpawnAt: new Date(next) }])
        return `${tip}\n${spawnText(boss)}`
      })
    })

  admin.command('xiuxian/停止世界boss', '【管理】关闭本群世界BOSS定时刷新', ADMIN)
    .action(async ({ session }: any) => {
      if (!session.guildId) return groupOnly
      const channelId = channelOf(session)
      return withChannel(channelId, async scope => {
        const [plan] = await scope.database.get('xiuxian_boss_schedule', { channelId })
        if (!plan) return '本群未开启世界BOSS定时刷新。'
        await scope.database.remove('xiuxian_boss_schedule', { channelId })
        const live = await liveBoss(channelId, scope)
        return '已关闭本群世界BOSS定时刷新。' + (live ? `当前【${live.name}】仍可讨伐，${formatClock(+live.expireAt)}遁走。` : '')
      })
    })

  ctx.command('xiuxian/世界boss帮助', '世界BOSS帮助')
    .action(() => [
      '世界BOSS帮助信息:',
      '1、查看世界boss：查看本群BOSS、伤害排行和自己的冷却',
      '2、讨伐世界boss：出手攻击，每人每30分钟一次，单次伤害最多为BOSS最大气血的15%',
      '3、启动世界boss [间隔小时]：【管理】开启定时刷新，默认每6小时一只，0～8点不刷新',
      '4、停止世界boss：【管理】关闭定时刷新',
      '5、创建世界boss：【管理】立即生成一只',
      '输入支持：世界boss（直接查看）、启动世界 boss 3小时；Boss大小写、boss前空格及常见boos拼写均可识别，管理命令仍需修仙管理员权限。',
      '新刷BOSS奖励：灵石保底5万～30万、药材、恢复丹、功勋；稀有独立15%，第6次保底。发送【世界boss奖励】查看资格与绑定规则，【讨伐功勋】【讨伐兑换】查看进度与兑换。存活旧BOSS沿用旧规则。',
    ].join('\n'))

  ctx.command('xiuxian/世界boss奖励', '世界Boss奖励资格、保底和绑定规则').action(() => [
    '新版世界BOSS奖励（存活旧BOSS仍按旧规则）：',
    '基础资源：20%均分、80%按伤害，小队按人数封顶后回流；最后一击改为额外1功勋。',
    '新增资格：累计伤害≥0.5%，或累计2次造成正伤害的讨伐。每日前3次合格击杀跨群共享，UTC+8零点刷新；之后仍有基础资源。',
    '保底灵石按本人参战境界和BOSS难度取较低档：江湖～筑基5万、结丹～元婴10万、化神～大乘20万、渡劫以上30万；基础奖励更高则保留。',
    '物资：3种药材各2份、可用恢复丹1枚，均绑定；无可用恢复丹时改给2份药材。功勋10点起，贡献加成后最多21点。',
    '稀有：每人独立15%，连续5次未出第6次必出，不绑定，可赠送出售。物品断档时记为待领，进阶后【领取讨伐战利品】自选。',
    '遁走只按实际伤害进度发半额基础资源，不给新增物资和功勋，不消耗3次击杀额度。',
    '【讨伐功勋】看次数、功勋及保底；【讨伐兑换】查看绑定物品目录。重入仙途不重置账号奖励记录。',
  ].join('\n'))

  return { tick, spawn, measure }
}
