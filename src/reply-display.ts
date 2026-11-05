import { h } from 'koishi'

const TTL = 10 * 60_000, BODY_CHARS = 500, BODY_LINES = 10
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 保留全部字符，不在 UTF-16 代理对中间截断；页面拼接可还原原文。 */
export function splitReply(text: string): string[] {
  const chars = Array.from(text), pages: string[] = []
  let start = 0
  while (start < chars.length) {
    let end = start, lines = 0, lastBreak = -1
    while (end < chars.length && end - start < BODY_CHARS) {
      if (chars[end++] === '\n') { lastBreak = end; if (++lines >= BODY_LINES) break }
    }
    if (end < chars.length && end - start === BODY_CHARS && lastBreak > start + 100) end = lastBreak
    pages.push(chars.slice(start, end).join('')); start = end
  }
  return pages.length ? pages : ['']
}

export function replyCard(text: string) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;background:#f6f4ee}#card{box-sizing:border-box;width:760px;padding:28px;color:#222;background:#fffdf8;font:20px/1.55 "Noto Sans CJK SC","Microsoft YaHei",sans-serif;border-top:5px solid #657953}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><main id="card"><pre>${escapeHtml(text)}</pre></main></html>`
}

export async function renderReplyImage(ctx: any, text: string): Promise<Buffer> {
  const renderer = ctx.get('wechatRender')
  if (renderer?.render) return renderer.render(replyCard(text), { width: 760, height: 1200, selector: '#card' })
  const markdown = ctx.get('markdownToImage')
  if (markdown?.convertToImage) return markdown.convertToImage(replyCard(text))
  throw new Error('图片渲染服务不可用')
}

function gameCommand(command: any) {
  for (let cmd = command; cmd; cmd = cmd.parent) if (cmd.name === 'xiuxian') return true
  return false
}

type Entry = { pages: string[]; command: string; expires: number; images: Map<number, string>; recipePage?: boolean }
export function applyReplyDisplay(ctx: any, config: any, options: { now?: () => number; commandContext?: any } = {}) {
  const now = options.now ?? Date.now, records = new Map<string, Entry>()
  const commandContext = options.commandContext ?? ctx
  const keyOf = (s: any) => JSON.stringify([s.platform, s.bot?.deviceAccountId || s.selfId, s.guildId || s.channelId, s.userId])
  ctx.model.extend('xiuxian_display', { platform: 'string', userId: 'string', mode: 'string' }, { primary: ['platform', 'userId'] })
  const who = (s: any) => ({ platform: s.platform, userId: s.userId })
  async function modeOf(s: any) { return (await ctx.database.get('xiuxian_display', who(s)))[0]?.mode || '自动' }
  function prune() {
    for (const [key, entry] of records) if (entry.expires <= now()) records.delete(key)
  }
  let warnedAt = 0
  async function page(s: any, entry: Entry, number: number) {
    const body = entry.recipePage ? [entry.pages[0].trimEnd()] : [`${entry.command} · 第${number}/${entry.pages.length}页`, entry.pages[number - 1].trimEnd()]
    if (!entry.recipePage && number > 1) body.push(`上一页：修仙翻页 ${number - 1}`)
    if (!entry.recipePage && number < entry.pages.length) body.push(`下一页：修仙翻页 ${number + 1}`)
    body.push('显示偏好：修仙显示 文字 / 图片 / 自动（翻页10分钟内有效）')
    const text = body.join('\n')
    let mode = '文字'
    try { mode = await modeOf(s) } catch { /* 显示偏好查询失败时也保留完整分页文字。 */ }
    if (mode === '图片' || (mode === '自动' && config.longTextToImage)) {
      try {
        const cached = entry.images.get(number)
        if (cached) return h.image(cached)
        const assets = ctx.get('assets')
        if (!assets?.upload) throw new Error('图片托管服务不可用')
        const buffer = await renderReplyImage(ctx, text)
        if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('图片数据无效或过大')
        const url = String(await assets.upload(`data:image/png;base64,${buffer.toString('base64')}`, ''))
        if (url.length > 2048 || !/^https?:\/\/\S+$/i.test(url)) throw new Error('图片托管未返回可下载地址')
        entry.images.set(number, url)
        return h.image(url)
      } catch {
        if (now() - warnedAt >= 60_000) { warnedAt = now(); ctx.logger('huaji-xiuxian').warn('修仙回复转图暂不可用，已回退分页文字。') }
        return h.text('图片暂不可用，已用分页文字显示。\n' + text)
      }
    }
    return h.text(text)
  }

  async function format(s: any, text: string, command: string) {
    prune()
    if (Array.from(text).length > 250000) return h.text('本次回复内容过多，请使用分类或单项查询。')
    // 炼丹已按五个方案分页，保留完整一页及其导航，避免嵌套分页只读到首批丹方。
    const recipePage = command === '炼丹' && text.startsWith('☆------可炼制丹方------☆') && text.length <= 4000
    const entry: Entry = { pages: recipePage ? [text] : splitReply(text), command, expires: now() + TTL, images: new Map(), recipePage }
    records.delete(keyOf(s)); records.set(keyOf(s), entry)
    let length = [...records.values()].reduce((sum, item) => sum + item.pages.join('').length, 0)
    while (records.size > 200 || length > 2000000) {
      const key = records.keys().next().value!
      length -= records.get(key)!.pages.join('').length; records.delete(key)
    }
    return page(s, entry, 1)
  }

  commandContext.command('xiuxian/修仙显示 [mode:string]', '选择长回复的文字或图片显示')
    .action(async ({ session }: any, mode?: string) => {
      if (!mode) return `当前显示：${await modeOf(session)}。可发送【修仙显示 文字】、【修仙显示 图片】或【修仙显示 自动】。仅影响自己的修仙长回复。`
      if (!['自动', '文字', '图片'].includes(mode)) return '显示模式支持：自动、文字、图片。'
      await ctx.database.upsert('xiuxian_display', [{ ...who(session), mode }])
      return `已设置修仙长回复为【${mode}】，内容会分页；可用【修仙翻页 页码】阅读上一份长回复。`
    })
  commandContext.command('xiuxian/修仙翻页 [page:integer]', '阅读上一份修仙长回复，不重复执行操作')
    .action(async ({ session }: any, number = 1) => {
      prune()
      const entry = records.get(keyOf(session))
      if (!entry) return '没有可翻页的长回复，或记录已过期。请重新发送相应的查询指令。'
      if (entry.recipePage) return '炼丹列表请按上份回复的【炼丹 页码】翻页，例如【炼丹 2】；查找指定丹药可发送【炼丹 丹药名】。'
      if (!Number.isSafeInteger(number) || number < 1 || number > entry.pages.length) return `页码无效，共${entry.pages.length}页。例如：修仙翻页 1。`
      return page(session, entry, number)
    })

  // command.execute 的结果会由 Session 直接发送，中间件 next() 拿不到原始回复。
  ctx.on('before-send', async (out: any, sendOptions: any) => {
    const source = sendOptions?.session, command = source?.argv?.command
    if (source?.platform !== 'webridge' || !source.userId || !gameCommand(command) || !command.ctx.filter(source)) return
    if (['修仙翻页', '修仙显示'].includes(command.name)) return
    const elements = out.elements || []
    if (elements.some((el: any) => !['text', 'quote'].includes(el.type))) return
    const text = elements.filter((el: any) => el.type === 'text').map((el: any) => el.attrs.content).join('')
    const recipePage = command.name === '炼丹' && text.startsWith('☆------可炼制丹方------☆')
    if (!recipePage && Array.from(text).length <= BODY_CHARS && text.split('\n').length <= Math.max(1, Number(config.longTextLineThreshold) || 20)) return
    const result = await format(source, text, command.name)
    out.elements = [...elements.filter((el: any) => el.type === 'quote'), ...h.normalize(result)]
  })

  ctx.middleware(async (session: any, next: any) => {
    if (session.platform !== 'webridge') return next()
    const value = session.resolve(ctx.root.config.prefix)
    const prefixes = (Array.isArray(value) ? value : [value || '']).map((s: string) => h.escape(s)).sort((a: string, b: string) => b.length - a.length)
    const content = session.stripped.content
    if (typeof content !== 'string') return next()
    const prefix = prefixes.find((p: string) => content.startsWith(p))
    if (prefix === undefined && !session.stripped.appel) return next()
    const body = content.slice((prefix || '').length), match = body.match(/^(\/?)(炼丹|修仙翻页|炼制)(\d+)(\s+\d+)?\s*$/)
    if (match?.[4] && match[2] !== '炼制') return next()
    const command = match && ctx.$commander.get(match[2], session)
    if (command && gameCommand(command) && command.ctx.filter(session)) session.stripped.content = (prefix || '') + match[1] + match[2] + ' ' + match[3] + (match[4] || '')
    return next()
  }, true)
  return { format, records }
}
