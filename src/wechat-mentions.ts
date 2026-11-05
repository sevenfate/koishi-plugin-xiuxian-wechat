import { Argv, h, type Context, type Session, type Command } from 'koishi'
import { getAtId } from '../lib/helpers'

const targetCommands = ['赠送物品', '送灵石', '偷灵石', '抢灵石', '双修', '虚神界对决', '宗门职位变更', '踢出宗门', '宗主传位', '神秘力量', '重置状态']
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function belongsToGame(command: Command) {
  for (let parent: Command | null = command; parent; parent = parent.parent) if (parent.name === 'xiuxian') return true
  return false
}

async function mentionLabels(session: Session) {
  const elements = h.select(session.elements ?? [], 'at')
  const labels = new Set<string>()
  const ids = new Set<string>()
  for (const { attrs } of elements) {
    if (!attrs.id || attrs.type === 'all' || attrs.type === 'here' || ['all', 'here', 'notify@all'].includes(attrs.id)) continue
    ids.add(attrs.id === session.selfId ? (session.bot as any).deviceAccountId || attrs.id : attrs.id)
    if (attrs.name) labels.add(String(attrs.name))
  }
  if (session.guildId && session.bot?.getGuildMember) {
    let timer: NodeJS.Timeout | undefined
    try {
      // 只用结构化提及的成员资料去除显示名；不从 @ 后的文字反推微信 ID。
      await Promise.race([
        Promise.all([...ids].slice(0, 20).map(async id => {
          try {
            const member = await session.bot.getGuildMember(session.guildId!, id)
            for (const name of [member?.nick, member?.user?.nick, member?.user?.name]) if (name?.trim()) labels.add(name)
          } catch { /* 资料不可用时仍可处理已是标准 at 元素的指令。 */ }
        })),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000) }),
      ])
    } finally { clearTimeout(timer) }
  }
  for (const id of ids) labels.add(id)
  return [...labels].filter(Boolean).sort((a, b) => b.length - a.length)
}

export function applyMentionCompat(ctx: Context) {
  ctx.middleware(async (session, next) => {
    if (session.platform !== 'webridge' || session.isDirect || !session.guildId || !getAtId(session)) return next()
    const commands = new Set(targetCommands.map(name => ctx.$commander.get(name, session))
      .filter((command): command is Command => !!command && belongsToGame(command) && command.ctx.filter(session)))
    const aliases = [...commands].flatMap(command => Object.keys(command._aliases))
    const original = session.stripped.content
    const value = session.resolve(ctx.root.config.prefix)
    const prefixes = (Array.isArray(value) ? value : [value || '']).map(prefix => h.escape(prefix)).sort((a, b) => b.length - a.length)
    const prefix = prefixes.find(prefix => original.startsWith(prefix))
    if (prefix === undefined && !session.stripped.appel) return next()
    const body = original.slice((prefix || '').length).replace(/^\/(?!\/)/, '')
    const head = body.replace(/^xiuxian(?:\.|\s+)/i, '')
    if (!aliases.some(alias => head.startsWith(alias) && /^(?:$|[\s@<])/.test(head.slice(alias.length)))) return next()
    let content = body
    if (content.includes('@')) {
      for (const label of await mentionLabels(session)) {
        const pattern = new RegExp('@' + escapeRegex(h.escape(label)) + '(?=$|\\s)', 'gu')
        content = content.replace(pattern, ' ')
      }
    }
    // 标准消息中的 at 元素只作目标参数，不应交给数值参数解析；原始 elements 不修改。
    content = h.parse(content).filter(element => element.type !== 'at').join('').trim()
    const argv: Argv = { ...Argv.parse(content), session }
    const command = ctx.$commander.inferCommand(argv)
    if (!command || !commands.has(command)) return next()
    session.stripped.content = (prefix || '') + content
    // 保留 atSelf=false；只解除“给群友的普通对话”判断，后续仍走原生指令、权限和冷却。
    if (!session.stripped.atSelf) session.stripped.hasAt = false
    return next()
  }, true)
}
