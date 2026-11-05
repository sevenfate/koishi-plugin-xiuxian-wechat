import { h, type Bot } from 'koishi'

/**
 * 离线会话夹具：只使用 Koishi 的公开消息元素构造微信风格的结构化提及。
 * 不依赖某个适配器的源码或私有协议，也不代表真机验收。
 */
export function buildSession(this: Bot & { deviceAccountId?: string }, frame: any, text: string, _media: unknown[] = []) {
  const body = frame.body || {}
  const mentions: string[] = body.at_user_list || []
  const atSelf = body.is_at === true || (!!this.deviceAccountId && mentions.includes(this.deviceAccountId))
  const elements = [
    ...(atSelf ? [h.at(this.selfId)] : []),
    ...mentions.filter(id => id !== 'notify@all' && (!atSelf || id !== this.deviceAccountId)).map(id => h.at(id)),
    ...(body.at_all ? [h.at('all')] : []),
    h.text(text),
  ]
  return this.session({
    type: 'message',
    user: { id: body.sender_id, name: body.sender_id },
    channel: { id: body.chat_id || body.room_id || body.sender_id, type: body.is_group ? 0 : 1 },
    ...(body.is_group ? { guild: { id: body.room_id || body.chat_id } } : {}),
    message: { id: body.message_id, elements },
    timestamp: body.create_time * 1000,
  })
}
