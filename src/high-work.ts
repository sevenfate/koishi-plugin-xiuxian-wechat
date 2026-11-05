/** 原资料在渡劫后断档；高境界使用本境突破修为为基准，不依赖全服最高玩家。 */
export function makeHighWork(data: any, level: string, exp: number, rebirth: number, random: any) {
  const threshold = Number(data.getLevelPower(level))
  if (!Number.isFinite(threshold) || threshold <= 0) return []
  const realm = level.replace(/(初期|中期|圆满|[一二三四五六七八九]层)$/, '')
  const themes = ['采集仙域灵材', '镇守界域裂隙', '讨伐域外妖魔']
  return themes.map((theme, i) => {
    const needed = threshold * (0.75 + i * 0.25)
    const rate = Math.min(100, Math.max(1, Math.floor(exp / needed * 100)))
    const itemType = random.randChoice(['功法', '神通', '药材'])
    const itemId = Number(data.randomItemIdByRank(data.itemRankByLevel(level), [itemType], random.luckPoints(rebirth))) || 0
    return { name: `${realm}·${theme}`, rate,
      award: Math.min(1000000000, Math.max(100, Math.floor(threshold * (0.005 + i * 0.005)))),
      time: 60 + i * 30, itemId,
      successMsg: `道友完成【${realm}·${theme}】，平安归来`, failMsg: `【${realm}·${theme}】遭遇强敌，道友保全性命，领取半数报酬`,
    }
  })
}
