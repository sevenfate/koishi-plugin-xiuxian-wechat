# Koishi 修仙 · 微信扩展版

一个可独立构建和安装的群聊修仙文字游戏，基于 [huaji-xiuxian 0.6.5](https://github.com/HuaJi114/koishi_plugin_xiuxian) 持续扩展。支持修炼突破、宗门、炼丹、坊市、秘境、世界 Boss 和无尽塔，并增强微信的群昵称、艾特互动和长回复显示。

当前版本：`0.6.5-wechat.23`。这是独立维护的扩展版，保留上游署名与来源，详见 [NOTICE.md](NOTICE.md)。

## 主要功能

| 玩法 | 内容 |
| --- | --- |
| 修炼成长 | 建号、签到、闭关、突破、功法、神通、转世 |
| 宗门社交 | 加入与创建宗门、贡献兑换、双修、物品赠送 |
| 炼丹交易 | 配方搜索与分页、非绑定材料方案、批量炼制、坊市批量交易 |
| 世界 Boss | 群内定时刷新、伤害排行、功勋兑换、稀有掉落与保底 |
| 无尽塔 | 1000 层固定守卫、连续闯关、首通奖励、群排行榜 |
| 微信体验 | 当前群昵称、结构化艾特识别、文字分页、可选长文本转图 |

通用玩法使用 Koishi 标准接口；微信增强按 `webridge` 平台启用。其他适配器的支持取决于其消息、群成员接口和平台限制，尚未逐平台真机验证。

## 安装

需要 **Node.js 22 或更新版本**、**Koishi 4.18.11 或兼容版本**，以及已启用的数据库服务和 `monetary` 灵石经济服务。SQLite 可用于试用，PostgreSQL 可用于部署。

1. 从 [Releases](https://github.com/sevenfate/koishi-plugin-xiuxian-wechat/releases) 下载 `.tgz` 安装包。
2. 在 **Koishi 实例根目录** 安装，示例使用 Yarn：

   ```sh
   yarn add ./koishi-plugin-huaji-xiuxian-0.6.5-wechat.23.tgz
   ```

   使用 npm 管理实例时，可改用 `npm install ./koishi-plugin-huaji-xiuxian-0.6.5-wechat.23.tgz`。

3. 在 Koishi 控制台安装并启用数据库插件和 `monetary`，然后启用 `huaji-xiuxian`。
4. 在群里发送 `我要修仙` 创建角色，再发送 `修仙帮助` 或 `修仙指引`。

本仓库通过 GitHub 分发，**直接从插件市场安装原包会得到上游版本**。请使用本仓库 Release 的安装包。升级前备份数据库；已有角色数据由实例数据库保存，不包含在插件安装包中。请勿同时启用上游和本扩展版。

### 基础配置

默认仅响应群聊，群白名单默认关闭。需要限定群时，开启 `groupWhitelistEnabled`，在 `groupWhitelist` 中填写适配器实际提供的群 ID。开启白名单却未填群 ID 会静默忽略所有群。

`adminQQ` 沿用上游字段名，填写平台用户 ID 后会将对应用户的 Koishi `authority` 提升至 **999**，只应填写可信维护者。`currency` 指定灵石使用的 monetary 币种，默认 `default`。

默认可使用纯文字，无需图片服务。需要长文本转图时，额外安装并启用 `markdown-to-image-service` 及其所需的 Puppeteer 服务，再开启 `longTextToImage`。微信图片显示还需要可访问的图片托管服务；渲染不可用时回退为分页文字。微信连接由独立的适配器负责，本游戏不包含微信登录程序。

## 常用指令

| 用途 | 指令 |
| --- | --- |
| 入门 | `我要修仙`、`修仙帮助`、`修仙指引`、`今日修仙` |
| 成长 | `修仙签到`、`我的修仙信息`、`闭关`、`出关`、`突破` |
| 物品 | `我的背包`、`我的功法`、`我的神通`、`修仙商店` |
| 炼丹 | `炼丹`、`炼丹 2`、`炼丹 不绑定`、`炼制 序号 炉数` |
| 交易 | `坊市查看`、`坊市上架 物品 单价 数量`、`坊市购买 编号 数量` |
| Boss | `查看世界boss`、`讨伐世界boss`、`讨伐功勋`、`讨伐兑换` |
| 爬塔 | `无尽塔`、`挑战无尽塔`、`连闯无尽塔 10`、`无尽塔奖励` |
| 回复显示 | `修仙显示 文字`、`修仙显示 图片`、`修仙翻页 2` |

详细规则见 [玩法说明](docs/玩法说明.md)。平台要求指令前缀或艾特机器人时，请按实例配置发送。

## 从源码构建

```sh
git clone https://github.com/sevenfate/koishi-plugin-xiuxian-wechat.git
cd koishi-plugin-xiuxian-wechat
npm ci
npm run check
npm pack
```

`npm pack` 会自动构建，并生成可安装的 `.tgz`。解包由 Node.js 依赖处理，无需额外安装系统解压工具。

首次构建会从 npm 下载 `upstream.json` 固定的上游发布包并校验 SHA-512，缓存于本项目的 `.cache/`；之后严格应用 `patches/wechat-profile.json` 并编译 `src/`。这套流程复用上游发布的游戏基础与静态资料，**构建需要联网下载上游包，且不依赖原来的业务仓库**。任一补丁定位或完整性不匹配都会中止。

仓库中的 `src/` 是本扩展新增的 TypeScript 模块，`patches/` 记录对上游编译产物的改动；完整可运行产物在构建后的 `lib/` 和 Release 安装包中。

## 验证与贡献

`npm run check` 执行构建、类型检查、离线回归测试和安装包内容检查。测试使用隔离的内存数据库与假机器人，不连接真实群；需要额外数据库配置的 PostgreSQL 专项测试默认跳过。CI 在 Linux 的 Node.js 22、24 和 Windows 的 Node.js 22 上验证。

发现问题可提交 [Issue](https://github.com/sevenfate/koishi-plugin-xiuxian-wechat/issues)，请提供插件版本、Koishi 版本、数据库类型、复现指令和脱敏日志。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

代码使用 [MIT](LICENSE)；内嵌字体遵循 [SIL OFL 1.1](licenses/Sarasa-Gothic-OFL.txt)。感谢上游作者 `huaji250` 及修仙项目的贡献者。
