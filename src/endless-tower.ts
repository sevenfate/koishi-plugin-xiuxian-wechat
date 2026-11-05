import { createHash, randomUUID } from 'node:crypto'
import { withAccount } from './sign-in'
import { formatWorkReward } from './work-reward'
import { displayName } from './wechat-profile'
import { prepareTowerTransaction } from './tower-transaction'

export const TOWER = { floors: 1000, batch: 10, cooldownMs: 5000, maxStat: 1e14, receiptMs: 2 * 86400000, batchMs: 8000, attemptMs: 15000 }
const missing = '修仙界没有道友的信息，请输入【我要修仙】加入！'
const styles = [
  { name: '玄甲傀儡', hint: '护甲较高，破防更有利', hp: 1.1, atk: 0.9, defense: 0.25 },
  { name: '赤焰妖将', hint: '攻击较高，气血与减伤更有利', hp: 0.9, atk: 1.25, defense: 0.05 },
  { name: '苍木灵卫', hint: '气血较高，持续输出更有利', hp: 1.4, atk: 0.8, defense: 0.1 },
]
const validFloor = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= TOWER.floors
const rankOf = (item: any) => Number(item.rank)
type Reward = { id: number; name: string; type: string; count: number; label: string }

/** 同层使用固定境界锚点，段内平滑增长；顶境界以后继续增长，不能跟随挑战者变强。 */
export function towerEnemy(data: any, floor: number) {
  if (!validFloor(floor)) throw Error('塔层超出开放范围')
  const index = Math.floor((floor - 1) / 20), fraction = ((floor - 1) % 20) / 20
  const last = data.levelOrder.length - 1
  const low = data.getLevelPower(data.levelOrder[Math.min(index, last)])
  const high = data.getLevelPower(data.levelOrder[Math.min(index + 1, last)])
  const strength = index < last ? low * (high / low) ** fraction
    : low * 1.12 ** ((floor - 1 - last * 20) / 4)
  const style = styles[Math.floor((floor - 1) / 10) % styles.length], boss = floor % 10 === 0
  const scale = boss ? 1.2 : 1
  const hp = Math.max(1, Math.floor(strength * 0.35 * style.hp * scale))
  const atk = Math.max(1, Math.floor(strength * 0.04 * style.atk * scale))
  if (![hp, atk].every(n => Number.isFinite(n) && n <= TOWER.maxStat)) throw Error('塔层数值超出安全范围')
  return { userId: `tower-${floor}`, name: `${style.name}${boss ? '·守关首领' : ''}`, hp, atk,
    mp: 0, crit: 1, critDamage: 1.5, defense: style.defense, armorPen: 0, hint: style.hint, boss }
}

/** 奖励由层数确定，查询不抽奖；优先不高于该层段的品阶，轮换同阶物品。 */
export function towerRewards(data: any, floor: number): Reward[] {
  if (!validFloor(floor) || floor % 5) return []
  const rank = 50 - Math.min(Math.floor((floor - 1) / 20), data.levelOrder.length - 1)
  function pool(types: string[]) {
    const all = Object.entries(data.getItemsByType(types)).map(([id, info]: [string, any]) => ({ id: Number(id), info }))
      .filter(x => Number.isSafeInteger(x.id) && x.info.name && Number.isFinite(rankOf(x.info))
        && (x.info.item_type !== '丹药' || x.info.status === 1))
    const eligible = all.filter(x => rankOf(x.info) >= rank)
    const choices = eligible.length ? eligible : all
    if (!choices.length) throw Error('无尽塔奖励物品配置不完整')
    const closest = Math.min(...choices.map(x => Math.abs(rankOf(x.info) - rank)))
    return choices.filter(x => Math.abs(rankOf(x.info) - rank) === closest).sort((a, b) => a.id - b.id)
  }
  const rewards: Reward[] = []
  function add(item: { id: number; info: any }, count: number) {
    rewards.push({ id: item.id, name: item.info.name, type: item.info.item_type, count, label: formatWorkReward(data, item.id) })
  }
  const herbs = pool(['药材']), offset = Math.floor(floor / 5)
  for (let i = 0; i < Math.min(3, herbs.length); i++) add(herbs[(offset + i) % herbs.length], 2)
  if (floor % 10 === 0) { const pills = pool(['丹药']); add(pills[Math.floor(floor / 10) % pills.length], 1) }
  if (floor % 50 === 0) {
    const books = pool(Math.floor(floor / 50) % 2 ? ['神通'] : ['功法'])
    add(books[Math.floor(floor / 50) % books.length], 1)
  }
  return rewards
}

const rewardText = (items: Reward[]) => items.map(x => `${x.label}×${x.count}`).join('、')
const botKey = (s: any) => s.bot?.deviceAccountId || s.selfId
const memberKey = (s: any) => ({ platform: s.platform, bot: botKey(s), guildId: s.guildId, userId: s.userId })

export function applyEndlessTower(ctx: any, deps: any, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now, srv = ctx.xiuxian
  const running = new Map<string, { startedAt: number; phase: string }>()
  ctx.model.extend('xiuxian_tower', {
    userId: 'string', platform: 'string', floor: { type: 'unsigned', initial: 0 }, reachedAt: 'timestamp', attemptedAt: 'timestamp',
    battle: 'text', battleGuild: 'string', battleBot: 'string', stopReason: 'string',
  }, { primary: 'userId' })
  ctx.model.extend('xiuxian_tower_reward', {
    userId: 'string', floor: 'unsigned', items: { type: 'json', initial: [] }, createdAt: 'timestamp',
  }, { primary: ['userId', 'floor'] })
  ctx.model.extend('xiuxian_tower_request', {
    userId: 'string', request: 'string', reply: 'text', createdAt: 'timestamp',
  }, { primary: ['userId', 'request'] })
  ctx.model.extend('xiuxian_tower_member', {
    platform: 'string', bot: 'string', guildId: 'string', userId: 'string', lastSeen: 'timestamp',
  }, { primary: ['platform', 'bot', 'guildId', 'userId'] })

  const read = async (s: any) => (await ctx.database.get('xiuxian_tower', { userId: s.userId }))[0]
  const keyOf = (s: any) => `${s.platform}:${s.userId}`
  function busyText(s: any) {
    const job = running.get(keyOf(s))!
    return `无尽塔正在${job.phase}，已用${Math.max(Math.floor((now() - job.startedAt) / 1000), 0)}秒。无需重复发送，可用【无尽塔状态】查看。`
  }
  async function available(s: any) {
    if (!s.guildId) return '请在允许修仙的群内使用无尽塔。'
    const player = await srv.getPlayer(s.userId)
    if (!player || player.platform !== s.platform) return missing
  }

  async function challenge(s: any, count: number) {
    if (!Number.isSafeInteger(count) || count < 1 || count > TOWER.batch) return '连闯层数需为1～10的整数，例如：连闯无尽塔 10。'
    const guard = keyOf(s)
    if (running.has(guard)) return busyText(s)
    const job = { startedAt: now(), phase: '检查角色状态' }
    running.set(guard, job)
    const checkpoint = () => {
      if (now() - job.startedAt >= TOWER.attemptMs) throw Object.assign(new Error('本次挑战超过处理时限'), { code: 'TOWER_TIMEOUT' })
    }
    try {
      const unavailable = await available(s)
      if (unavailable) return unavailable
      checkpoint()
      const timestamp = s.event?.timestamp
      if (timestamp && now() - timestamp > TOWER.receiptMs) return '这条挑战消息已过期，请重新发送指令。'
      const id = s.messageId || randomUUID()
      const request = createHash('sha256').update(JSON.stringify([s.platform, botKey(s), s.guildId, id])).digest('hex')
      job.phase = '等待账号结算'
      return await withAccount(srv, s.userId, async (scope, service) => {
        checkpoint()
        if (!ctx.filter(s)) return '本群当前无法挑战无尽塔。'
        const player = await service.getPlayer(s.userId)
        if (!player || player.platform !== s.platform) return missing
        const [cached] = await scope.database.get('xiuxian_tower_request', { userId: s.userId, request })
        if (cached) return cached.reply
        const [row] = await scope.database.get('xiuxian_tower', { userId: s.userId })
        let floor = row?.floor || 0
        if (floor >= TOWER.floors) return `已通关当前开放的${TOWER.floors}层，后续将扩展更高层。`
        const wait = +(row?.attemptedAt || 0) + TOWER.cooldownMs - now()
        if (wait > 0) return `道友刚刚挑战过，请${Math.ceil(wait / 1000)}秒后再试。`
        job.phase = '准备战斗'
        const fighter = await deps.buildFighter(service, s.userId)
        const merged = deps.mergeSkillBuffs(await service.getLearnedSkills(s.userId), service.data)
        const { maxHp, maxMp } = deps.getEffectiveMaxHpMp(player.exp, merged.hpbuff, merged.mpbuff)
        checkpoint()
        const snapshot = { ...fighter, hp: maxHp, mp: maxMp, name: '道友', displayName: '道友' }
        if (!fighter || ![snapshot.hp, snapshot.mp, snapshot.atk].every(n => Number.isFinite(n) && n > 0 && n <= TOWER.maxStat)) {
          return '角色战斗数值异常，暂不能挑战无尽塔，请联系管理员。'
        }
        snapshot.defense = Math.min(Math.max(Number(snapshot.defense) || 0, 0), 0.9)
        const started = now(), from = floor + 1, lines: string[] = [], earned: string[] = []
        let battle = '', failed = false, stopReason = ''
        for (let i = 0; i < count && floor < TOWER.floors; i++) {
          checkpoint()
          if (i && now() - started > TOWER.batchMs) { stopReason = '达到本次连闯时间上限，已通层数保留。'; break }
          const next = floor + 1, enemy = towerEnemy(service.data, next)
          job.phase = `挑战第${next}层`
          const [log, , hp] = deps.playerFight({ ...snapshot, secSkillIds: [...(snapshot.secSkillIds || [])] }, { ...enemy }, service.data)
          checkpoint()
          const won = Number.isFinite(hp[enemy.userId]) && hp[enemy.userId] <= 0 && hp[s.userId] > 0
          const summary = won ? '守卫已被击败。' : hp[s.userId] <= 0 ? '道友气血耗尽，本层挑战失败。' : '已达战斗回合上限，守卫未被击杀，本层未通过。'
          // 通用引擎在回合耗尽时按剩血判胜；塔内要求击杀，不能保留误导性的“道友胜”。
          const details = won ? log : log.filter((line: string, i: number) => i !== log.length - 1 || !line.endsWith('胜'))
          battle = `【无尽塔第${next}层·${enemy.name}】\n${details.join('\n').slice(0, 20000)}\n${summary}`
          if (!won) {
            failed = true
            const left = Math.max(Math.ceil(hp[enemy.userId] || 0), 0)
            stopReason = `第${next}层${hp[s.userId] <= 0 ? '战败' : '回合耗尽'}，连闯已结束；守卫剩余气血${left}/${enemy.hp}，道友剩余气血${Math.max(Math.ceil(hp[s.userId] || 0), 0)}。`
            lines.push(`第${next}层挑战失败：${enemy.hint}。`); break
          }
          if (!ctx.filter(s)) throw Error('群已停止允许修仙')
          const items = towerRewards(service.data, next)
          if (items.length) {
            job.phase = `结算第${next}层首通奖励`
            const existing = await scope.database.get('xiuxian_tower_reward', { userId: s.userId, floor: next })
            if (existing.length) throw Error('塔层与发奖记录不一致')
            for (const item of items) {
              const back = await service.getBackItem(s.userId, item.id)
              if ((back?.goodsNum || 0) + item.count > 2147483647) throw Error('奖励物品库存已达上限，请先使用部分库存')
              await service.sendBack(s.userId, item.id, item.name, item.type, item.count, 1)
              checkpoint()
            }
            await scope.database.create('xiuxian_tower_reward', { userId: s.userId, floor: next, items, createdAt: new Date(now()) })
            earned.push(`第${next}层首通：${rewardText(items)}（绑定）`)
          }
          floor = next
        }
        const passed = floor - from + 1
        if (passed) lines.unshift(`本次通过第${from}～${floor}层，共${passed}层。`)
        stopReason ||= floor >= TOWER.floors ? `已通关当前开放的${TOWER.floors}层。` : `已完成本次${count}层挑战；每条指令最多连闯${TOWER.batch}层，需要再次发送指令继续。`
        lines.push(`【本次挑战已结束】${stopReason}`)
        lines.push(`最高通关：${floor}层${floor < TOWER.floors ? `；下次挑战第${floor + 1}层` : '（已达当前开放上限）'}。`)
        lines.push(...earned)
        if (!earned.length && floor < TOWER.floors) lines.push(`下个奖励节点：第${Math.ceil((floor + 1) / 5) * 5}层，发送【无尽塔奖励】查看。`)
        lines.push('幻境战斗不消耗现实气血、真元或丹药；战报：无尽塔战报。')
        if (!failed && floor < TOWER.floors) lines.push('继续请发送【连闯无尽塔 10】；只打一层请发送【挑战无尽塔】。')
        const reply = lines.join('\n'), stamp = new Date(now())
        checkpoint(); job.phase = '保存进度'
        if (!ctx.filter(s)) throw Error('群已停止允许修仙')
        await scope.database.upsert('xiuxian_tower', [{ userId: s.userId, platform: s.platform, floor,
          reachedAt: passed ? stamp : row?.reachedAt || new Date(0), attemptedAt: stamp,
          battle, battleGuild: s.guildId, battleBot: botKey(s), stopReason }])
        await scope.database.upsert('xiuxian_tower_member', [{ ...memberKey(s), lastSeen: stamp }])
        await scope.database.create('xiuxian_tower_request', { userId: s.userId, request, reply, createdAt: stamp })
        await scope.database.remove('xiuxian_tower_request', { userId: s.userId, createdAt: { $lt: new Date(now() - TOWER.receiptMs) } })
        checkpoint()
        return reply
      }, async database => { await prepareTowerTransaction(database, s.userId); checkpoint() })
    } catch (error: any) {
      ctx.logger('huaji-xiuxian').warn('无尽塔结算已回滚：%s', error.message)
      if (['55P03', '57014', 'TOWER_TIMEOUT'].includes(error.code)) return '无尽塔本次挑战等待超时，已取消并回滚，本次进度与奖励均未保存。请稍后重新发送指令；可用【无尽塔状态】查看，不会在后台继续发奖。'
      return '无尽塔结算暂未完成，本次进度与奖励均未保存。请检查背包库存或稍后重试；仍失败时联系管理员。'
    } finally { running.delete(guard) }
  }

  ctx.command('xiuxian/无尽塔', '查看无尽塔进度和下一层').alias('镇妖塔').alias('无尽塔状态')
    .action(async ({ session: s }: any) => {
      const unavailable = await available(s); if (unavailable) return unavailable
      const row = await read(s), floor = row?.floor || 0
      if (floor >= TOWER.floors) return `最高通关${floor}层，已达当前开放上限。排行：无尽塔排行榜。`
      const enemy = towerEnemy(srv.data, floor + 1)
      return [`【无尽塔】最高通关：${floor}层；当前开放${TOWER.floors}层。`,
        running.has(keyOf(s)) ? busyText(s) : `当前没有正在执行的挑战。${row?.stopReason ? `上次结束原因：${row.stopReason}` : ''}`,
        `下一层：${floor + 1}层 ${enemy.name}，气血${enemy.hp}，攻击${enemy.atk}，减伤${Math.round(enemy.defense * 100)}%。`,
        `特点：${enemy.hint}。`, '单层：挑战无尽塔；连闯：连闯无尽塔 10。',
        '每5层药材、每10层额外丹药、每50层额外功法或神通；首通自动发放绑定物品。',
        '永久进度，无每日次数限制，挑战间隔5秒；幻境战斗不消耗现实状态。',
        '无尽塔奖励 [层数]｜无尽塔战报｜无尽塔排行榜。重入不会重置首通奖励。'].join('\n')
    })
  ctx.command('xiuxian/挑战无尽塔', '挑战无尽塔下一层').action(({ session }: any) => challenge(session, 1))
  ctx.command('xiuxian/连闯无尽塔 [count:integer]', '连续挑战，遇败即停，最多10层')
    .alias('连续推进')
    .action(({ session }: any, count = 10) => challenge(session, count))
  ctx.command('xiuxian/无尽塔奖励 [floor:integer]', '查看指定首通节点的奖励')
    .action(async ({ session: s }: any, floor?: number) => {
      const unavailable = await available(s); if (unavailable) return unavailable
      const row = await read(s), best = row?.floor || 0
      floor ??= Math.min(Math.ceil((best + 1) / 5) * 5, TOWER.floors)
      if (!validFloor(floor) || floor % 5) return `请填写5的倍数，范围5～${TOWER.floors}，例如：无尽塔奖励 50。`
      const [record] = await ctx.database.get('xiuxian_tower_reward', { userId: s.userId, floor })
      return `【第${floor}层首通奖励·${record ? '已到账' : '未解锁'}】\n${rewardText(record?.items || towerRewards(srv.data, floor))}（全部绑定）\n首通时自动结算，每个账号只领一次；查询不发奖。`
    })
  ctx.command('xiuxian/无尽塔战报', '查看本人在当前群的上一场塔内战斗')
    .action(async ({ session: s }: any) => {
      const unavailable = await available(s); if (unavailable) return unavailable
      const row = await read(s)
      return row?.battleGuild === s.guildId && row?.battleBot === botKey(s) && row.battle || '暂无本人在当前群的塔内战报，请先挑战。'
    })
  ctx.command('xiuxian/无尽塔排行榜', '查看本群参与者的最高通关层')
    .action(async ({ session: s }: any) => {
      const unavailable = await available(s); if (unavailable) return unavailable
      const { userId, ...group } = memberKey(s)
      const members = await ctx.database.get('xiuxian_tower_member', group)
      if (!members.length) return '本群暂无无尽塔挑战记录，发送【挑战无尽塔】开始。'
      const rows = (await ctx.database.get('xiuxian_tower', { platform: s.platform, userId: { $in: members.map((m: any) => m.userId) }, floor: { $gt: 0 } }))
        .sort((a: any, b: any) => b.floor - a.floor || +a.reachedAt - +b.reachedAt || a.userId.localeCompare(b.userId)).slice(0, 10)
      const lines = await Promise.all(rows.map(async (row: any, i: number) => {
        const player = await srv.getPlayer(row.userId)
        const name = await displayName(ctx, s, row.userId, player?.userName)
        return `${i + 1}. ${name}：${row.floor}层`
      }))
      return ['【本群无尽塔排行榜】', ...lines, '同层按到达时间排序，个人进度跨群共享。'].join('\n')
    })
  return { challenge }
}
