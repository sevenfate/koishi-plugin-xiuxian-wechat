# 来源与第三方声明

本项目是独立维护的 Koishi 修仙扩展版，不是上游官方仓库。

- 游戏基础来自 [HuaJi114/koishi_plugin_xiuxian](https://github.com/HuaJi114/koishi_plugin_xiuxian)，作者 `huaji250`。固定使用 npm `koishi-plugin-huaji-xiuxian@0.6.5`；该发布包声明 MIT 许可证，原作者信息保留在 `package.json` 与 `LICENSE` 中。
- 上游说明游戏由 [nonebot-plugin-xiuxian-2](https://github.com/luolianxiyou/nonebot-plugin-xiuxian-2) 移植重构而来，本项目保留这一来源说明。
- 本仓库维护的 TypeScript 扩展、补丁与构建脚本采用 MIT 许可证。
- 上游内嵌的 `sarasa-mono-sc-regular.ttf` 字体来自 [Sarasa Gothic](https://github.com/be5invis/Sarasa-Gothic)，按 SIL Open Font License 1.1 分发。完整声明见 [licenses/Sarasa-Gothic-OFL.txt](licenses/Sarasa-Gothic-OFL.txt)，构建时也会复制到字体目录。

`upstream.json` 保存发布包地址、版本与 SHA-512 完整性摘要。构建只复制游戏使用的静态资料，不分发上游附带的旧数据库或旧运行配置。

保留原包名 `koishi-plugin-huaji-xiuxian` 和配置键 `huaji-xiuxian` 是为了兼容已有 Koishi 安装。本仓库通过 GitHub Release 分发独立构建的安装包；不会向原作者的 npm 包发布版本，也不声明拥有该 npm 包。
