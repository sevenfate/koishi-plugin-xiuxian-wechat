import { parentPort, workerData } from 'node:worker_threads'
import { findMixRecipeChoices } from './mix-recipe-search'

try {
  parentPort?.postMessage({ recipes: findMixRecipeChoices(workerData.herbs, workerData.items) })
} catch {
  parentPort?.postMessage({ error: '丹方扫描失败，请稍后重试。' })
} finally { parentPort?.close() }
