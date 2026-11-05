import type { Context, Session } from 'koishi'

interface Player { userId: string; userName?: string; platform?: string }


export function readableName(value: unknown, userId?: string) {
  if (typeof value !== 'string') return
  const name = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').trim()
  if (!name || name === userId || /^wxid_/i.test(name)) return
  // 上游用字符串拼消息；昵称只作文字，不能被解析成 at/image 等消息元素。
  return Array.from(name).slice(0, 255).join('').replace(/</g, '＜').replace(/>/g, '＞')
}

function sessionName(session: Session, userId: string) {
  if (session.userId !== userId) return
  return [session.event.member?.nick, session.event.member?.name, session.event.user?.nick,
    session.event.user?.name, session.username].map(name => readableName(name, userId)).find(Boolean)
}

export function createNameResolver(timeout = 1000) {
  // 只在当前消息内合并查询，不能跨账号、跨群缓存昵称，也不能写回全局道号。
  const sessions = new WeakMap<Session, Map<string, Promise<string | undefined>>>()
  return async (_ctx: Pick<Context, 'get'>, session: Session, userId: string, fallback?: string) => {
    if (session.platform !== 'webridge') return fallback || sessionName(session, userId) || userId
    let members = sessions.get(session)
    if (!members) sessions.set(session, members = new Map())
    let pending = members.get(userId)
    if (!pending) {
      pending = (async () => {
        const bot = session.bot
        if (!session.guildId || !bot?.getGuildMember) return
        let timer: NodeJS.Timeout | undefined
        try {
          const member = await Promise.race([
            bot.getGuildMember(session.guildId!, userId),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout) }),
          ])
          return readableName(member?.nick, userId) || readableName(member?.user?.nick || member?.user?.name, userId)
        } catch { return }
        finally { clearTimeout(timer) }
      })()
      members.set(userId, pending)
    }
    return await pending || sessionName(session, userId) || readableName(fallback, userId) || '无名道友'
  }
}

export const displayName = createNameResolver()

export function playerName(ctx: Pick<Context, 'get'>, session: Session, player: Player) {
  if (player.platform && player.platform !== session.platform) return Promise.resolve(readableName(player.userName, player.userId) || '无名道友')
  return displayName(ctx, session, player.userId, player.userName)
}
