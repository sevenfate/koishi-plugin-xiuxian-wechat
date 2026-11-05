import { formatSkillEffect, formatMergedSkillSummary, mergeSkillBuffs } from '../lib/skills'
import { compareItemGrade } from './item-order'

export function applyViewTechniques(ctx: any) {
  const service = ctx.xiuxian
  ctx.command('xiuxian/我的功法', '按品阶查看本人已学功法及效果')
    .alias('查看功法')
    .action(async ({ session }: any) => {
      const userId = session.userId
      if (!await service.getPlayer(userId)) return '修仙界没有道友的信息，请输入【我要修仙】加入！'
      const skills = (await service.getLearnedSkills(userId))
        .filter((skill: any) => skill.skillType === '功法' || skill.skillType === '辅修功法')
        .map((skill: any) => ({ ...skill, info: service.data.getItem(skill.skillId) }))
        .sort((a: any, b: any) => compareItemGrade(a.info, a.skillId, b.info, b.skillId))
      if (!skills.length) return '道友尚未学会任何功法。可发送【查看修仙界物品 功法】查看图鉴，获得秘籍后使用学习。'
      const lines = [`☆------已学功法（${skills.length}本）------☆`, '按品阶从高到低排列：']
      for (const skill of skills) {
        lines.push(`${skill.skillId}、【${skill.info?.level || '品阶未标注'}】${skill.info?.name || '未知功法'}（${skill.skillType}）`,
          `效果：${skill.info ? formatSkillEffect(skill.info) : '物品资料缺失，学习记录已保留'}`)
      }
      lines.push(`合并功法增益：${formatMergedSkillSummary(mergeSkillBuffs(skills, service.data))}`,
        '同属性增益取最高，不叠加；具体效果以角色面板为准。',
        '查看详情：查看修仙界物品 编号，例如：查看修仙界物品 ' + skills[0].skillId)
      return lines.join('\n')
    })
}
