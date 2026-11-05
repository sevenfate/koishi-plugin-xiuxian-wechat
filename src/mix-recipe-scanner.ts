import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { MixRecipe, YaocaiEntry } from '../lib/mix-elixir-util'

type Job = { herbs: YaocaiEntry[]; items: Record<string, any>; expires: number; done: boolean; timer?: NodeJS.Timeout;
  worker?: Worker; closing?: Promise<void>; resolve: (recipes: MixRecipe[]) => void; reject: (error: Error) => void }
export function createRecipeScanner(ctx: any, options: { workerFile?: string; timeoutMs?: number; concurrency?: number; capacity?: number } = {}) {
  const concurrency = options.concurrency ?? 2, capacity = options.capacity ?? 8, timeoutMs = options.timeoutMs ?? 3000
  const queue: Job[] = [], active = new Set<Job>()
  let stopped = false
  function finish(job: Job, error?: Error, recipes?: MixRecipe[]) {
    if (job.done) return
    job.done = true; clearTimeout(job.timer)
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1)
    // 先确认线程退出再返回，超时后不能仍占 CPU 或在后台回填旧配方。
    job.closing = Promise.resolve(job.worker?.terminate()).catch(() => {}).then(() => {
      active.delete(job)
      if (error) job.reject(error); else job.resolve(recipes!)
      pump()
    })
  }
  function pump() {
    while (!stopped && active.size < concurrency && queue.length) {
      const job = queue.shift()!
      if (Date.now() >= job.expires) { finish(job, new Error('丹方扫描超时，已停止计算，请稍后重试。')); continue }
      active.add(job)
      try {
        job.worker = new Worker(options.workerFile ?? join(__dirname, 'mix-recipe-worker.js'), {
          workerData: { herbs: job.herbs, items: job.items },
          resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
        })
        job.worker.on('message', value => {
          if (!value || !Array.isArray(value.recipes)) return finish(job, new Error('丹方扫描失败，请稍后重试。'))
          finish(job, undefined, value.recipes)
        })
        job.worker.once('error', () => finish(job, new Error('丹方扫描失败，请稍后重试。')))
        job.worker.once('exit', () => { if (!job.done) finish(job, new Error('丹方扫描中断，请重新发送【炼丹】。')) })
      } catch { finish(job, new Error('丹方扫描暂不可用，请稍后重试。')) }
    }
  }
  async function dispose() {
    stopped = true
    const jobs = [...queue, ...active]
    for (const job of jobs) finish(job, new Error('插件已重载，丹方扫描已停止，请重新发送【炼丹】。'))
    await Promise.all(jobs.map(job => job.closing))
  }
  ctx.on?.('dispose', dispose)
  return {
    run(herbs: YaocaiEntry[], items: Record<string, any>): Promise<MixRecipe[]> {
      if (stopped) return Promise.reject(new Error('丹方扫描服务已停止。'))
      if (queue.length + active.size >= capacity) return Promise.reject(new Error('当前炼丹扫描较多，请稍后重试。'))
      return new Promise((resolve, reject) => {
        const job: Job = { herbs, items, resolve, reject, expires: Date.now() + timeoutMs, done: false }
        job.timer = setTimeout(() => finish(job, new Error('丹方扫描超时，已停止计算，请稍后重试。')), timeoutMs)
        queue.push(job); pump()
      })
    }, dispose,
    stats: () => ({ active: active.size, queued: queue.length, stopped }),
  }
}
