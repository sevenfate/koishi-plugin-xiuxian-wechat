import { withEconomyTransaction } from './economy'
import { sortByItemGrade } from './item-order'

type LearnedSkill = { skillId: number; skillType: string }

async function learnedSecSkills(service: any, userId: string): Promise<LearnedSkill[]> {
  const skills: LearnedSkill[] = (await service.getLearnedSkills(userId)).filter((skill: LearnedSkill) => skill.skillType === '神通')
  return sortByItemGrade(skills, service.data, skill => skill.skillId)
}

function skillName(service: any, skill: LearnedSkill): string {
  return service.data.getItem(skill.skillId)?.name || `未知神通（${skill.skillId}）`
}

function resolveSkill(service: any, skills: LearnedSkill[], query: string) {
  const id = /^\d+$/.test(query) ? Number(query) : undefined
  return skills.filter(skill => id === undefined
    ? skillName(service, skill) === query
    : skill.skillId === id)
}

export function applyForgetSkill(ctx: any) {
  const service = ctx.xiuxian
  const missingPlayer = '修仙界没有道友的信息，请输入【我要修仙】加入！'
  ctx.command('xiuxian/遗忘神通 [name:text]', '查看已学神通或预览遗忘目标')
    .alias('我的神通')
    .action(async ({ session }: any, name?: string) => {
      const userId = session.userId
      if (!await service.getPlayer(userId)) return missingPlayer
      const skills = await learnedSecSkills(service, userId)
      if (!skills.length) return '道友尚未学会任何神通。'
      const query = name?.trim()
      if (!query) return [
        '☆------已学神通------☆',
        '按品阶从高到低排列：',
        ...skills.map(skill => `${skill.skillId}、${skillName(service, skill)}【${service.data.getItem(skill.skillId)?.level || '品阶未标注'}】`),
        '战斗会从已学神通中随机选用。',
        '发送【遗忘神通 名称或编号】查看遗忘说明，例如：遗忘神通 ' + skills[0].skillId,
      ].join('\n')
      const matches = resolveSkill(service, skills, query)
      if (!matches.length) return '道友未学会这个神通，请发送【我的神通】查看名称和编号；暂不支持遗忘功法。'
      if (matches.length > 1) return '存在同名神通，请按编号选择：\n' + matches.map(skill => `${skill.skillId}、${skillName(service, skill)}`).join('\n')
      const target = matches[0]
      return [
        `即将遗忘神通【${skillName(service, target)}】（编号 ${target.skillId}）。`,
        '遗忘后不再进入战斗随机选用池，不返还秘籍；再次获得秘籍后可重新学习。',
        `确定后请发送【确认遗忘神通 ${target.skillId}】，不确认则保留。`,
      ].join('\n')
    })
  ctx.command('xiuxian/确认遗忘神通 <name:text>', '确认移除自己已学的指定神通，不返还秘籍')
    .action(async ({ session }: any, name?: string) => {
      const userId = session.userId, query = name?.trim()
      if (!query) return '请先发送【遗忘神通 名称或编号】查看说明。'
      try {
        // 删除技能与清理旧神通引用必须在同一事务中，避免失败或重启后恢复旧记录。
        return await withEconomyTransaction(ctx, service, userId, async (scope, service) => {
          if (!await service.getPlayer(userId)) return missingPlayer
          const skills = await learnedSecSkills(service, userId)
          const matches = resolveSkill(service, skills, query)
          if (!matches.length) return '道友未学会这个神通，或已经遗忘，请发送【我的神通】查看。'
          if (matches.length > 1) return '存在同名神通，请发送【我的神通】查看编号后再确认。'
          const target = matches[0]
          await scope.database.remove('xiuxian_skill', { userId, skillId: target.skillId, skillType: '神通' })
          await scope.database.set('xiuxian_buff', { userId, secBuff: target.skillId }, { secBuff: 0 })
          return `已遗忘神通【${skillName(service, target)}】，以后战斗不会再随机选用。秘籍不返还，再次获得秘籍后可重新学习。`
        })
      } catch (error) {
        ctx.logger('huaji-xiuxian').warn('遗忘神通事务失败：%s', error instanceof Error ? error.message : '未知错误')
        return '遗忘失败，本次修改已回滚，请稍后重试。'
      }
    })
}
