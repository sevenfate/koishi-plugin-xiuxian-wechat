import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { MixRecipe, YaocaiEntry } from '../lib/mix-elixir-util'
import { renderMixRecipePage } from './mix-recipe-list'
import { createRecipeScanner } from './mix-recipe-scanner'
import { craftBatch } from './alchemy'
import type { InventoryHerb } from './mix-recipe-search'
const localRequire = createRequire(__filename)

type Cache = { recipes: MixRecipe[]; signature: string; character: string; expires: number; view?: { query: string; unbound: boolean } }
export function applyAlchemy(ctx: any, _config: any, options: { scan?: (herbs: YaocaiEntry[], items: Record<string, any>) => Promise<MixRecipe[]> } = {}) {
  const srv = ctx.xiuxian, cache = new Map<string, Cache>(), scans = new Map<string, { signature: string; promise: Promise<MixRecipe[]> }>()
  const scanner = options.scan ? { run: options.scan } : createRecipeScanner(ctx)
  let disposed = false
  const keyOf = (s: any) => `${s.platform || ''}:${s.userId}`
  const characterOf = (p: any) => String(p.createTime instanceof Date ? +p.createTime : p.createTime || '')
  const prune = () => { for (const [key, entry] of cache) if (entry.expires <= Date.now()) cache.delete(key) }
  ctx.on?.('dispose', () => { disposed = true; cache.clear(); scans.clear() })
  ctx.command('xiuxian/炼丹帮助', '炼丹系统帮助').action(() => [
    '炼丹：扫描背包；炼丹 2：下一页；炼丹 丹药名：直接查找，不用逐页翻。',
    '炼丹 不绑定：只看未绑定材料方案；也支持【炼丹 不绑定 丹药名】。每种丹药分别推荐不绑定和混合材料方案。',
    '炼制 序号 [炉数]：每批1～100炉，例如【炼制 1 10】。需有炼丹炉。',
    '配方保留10分钟，翻页不重新扫描；背包变化后发送【炼丹】刷新。炼丹配方帮助：查看冷热规则。',
  ].join('\n'))
  ctx.command('xiuxian/炼丹配方帮助', '炼丹配方说明').action(() =>
    '主药、药引需冷热调和，主药与辅药的药效决定成丹。每个角色用药1～5份，总量最多10份；同一药材兼任角色时合计检查库存。需持有炼丹炉。')
  ctx.command('xiuxian/炼丹 [query:text]', '按名称或页码查看丹方，支持不绑定材料方案')
    .action(async ({ session: s }: any, input: string | number = '') => {
      const tokens = String(input).trim().split(/\s+/).filter(Boolean)
      let page = 1
      if (tokens.length && /^-?\d+(?:\.\d+)?$/.test(tokens[tokens.length - 1])) page = Number(tokens.pop())
      if (!Number.isSafeInteger(page) || page < 1) return '请输入正确的页码，例如：炼丹 1。'
      prune()
      const key = keyOf(s), player = await srv.getPlayer(s.userId)
      if (!player) { cache.delete(key); return '修仙界没有道友的信息，请输入【我要修仙】加入！' }
      const character = characterOf(player), previous = cache.get(key)
      let unbound = false
      if (tokens[0] === '不绑定' || tokens[0] === '全部') unbound = tokens.shift() === '不绑定'
      const view = !tokens.length && String(input).trim() && /^\d+$/.test(String(input).trim())
        ? previous?.view || { query: '', unbound: false } : { query: tokens.join(' '), unbound }
      const render = (entry: Cache) => { entry.view = view; return renderMixRecipePage(entry.recipes, page, view.query, view.unbound) }
      if (page > 1 && previous?.character === character && previous.recipes.length) return render(previous)
      const backs = await srv.getBack(s.userId)
      if (!backs.some((b: any) => b.goodsNum > 0 && (b.goodsType === '炼丹炉' || srv.data.getItem(b.goodsId)?.item_type === '炼丹炉'))) {
        cache.delete(key); return '道友背包内没有炼丹炉，无法炼丹！发送【修仙商店】查看购买途径。'
      }
      const herbs: InventoryHerb[] = backs.filter((b: any) => b.goodsNum > 0 && srv.data.getItem(b.goodsId)?.item_type === '药材')
        .map((b: any) => ({ id: b.goodsId, info: srv.data.getItem(b.goodsId), num: b.goodsNum, bindNum: b.bindNum || 0 }))
      if (!herbs.length) { cache.delete(key); return '道友背包内没有药材，无法炼丹！' }
      const signature = createHash('sha256').update(JSON.stringify([character, herbs.map(x => [x.id, x.num, x.bindNum || 0] as const).sort((a, b) => a[0] - b[0])])).digest('hex')
      let recipes: MixRecipe[]
      try {
        if (previous?.signature === signature) recipes = previous.recipes
        else {
          let job = scans.get(key)
          if (job && job.signature !== signature) return '上一份丹方仍在扫描，背包已变化，请稍后重新发送【炼丹】。'
          if (!job) {
            cache.delete(key)
            const promise = scanner.run(herbs, srv.data.getItemsByType(['合成丹药']))
            job = { signature, promise }; scans.set(key, job)
            void promise.finally(() => { if (scans.get(key)?.promise === promise) scans.delete(key) }).catch(() => {})
          }
          recipes = await job.promise
        }
        if (disposed || ctx.filter && !ctx.filter(s)) return ''
        const current = await srv.getPlayer(s.userId)
        if (!current || characterOf(current) !== character) { cache.delete(key); return '角色状态已变化，请重新发送【炼丹】扫描。' }
        const entry: Cache = { recipes, signature, character, expires: Date.now() + 600000 }
        cache.delete(key); cache.set(key, entry)
        while (cache.size > 200) cache.delete(cache.keys().next().value!)
        if (!recipes.length) return '系统未检测到可用丹方，道友背包内的药材不满足配方或冷热失和！'
        return render(entry)
      } catch (error: any) {
        if (disposed || ctx.filter && !ctx.filter(s)) return ''
        return error.message || '丹方扫描暂不可用，请稍后重试。'
      }
    })
  ctx.command('xiuxian/炼制 <num:integer> [quantity:integer]', '按序号批量炼制丹药')
    .action(async ({ session: s }: any, num: number, quantity = 1) => {
      if (!Number.isSafeInteger(num) || num < 1) return '请输入正确的配方序号！'
      prune()
      const key = keyOf(s), entry = cache.get(key), player = await srv.getPlayer(s.userId)
      if (!entry?.recipes.length || !player || entry.character !== characterOf(player)) return '请先发送【炼丹】查看可用配方；列表保留10分钟。'
      const recipe = entry.recipes[num - 1]
      if (!recipe) return '没有这个序号的配方，请重新【炼丹】查看列表！'
      return craftBatch(ctx, srv, s.userId, recipe, quantity, localRequire('./mix-elixir-util').tiaohe)
    })
}
