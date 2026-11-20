# NERVDOG Harness plugins

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，配合 [nervdog-harness](https://github.com/Nervdog-Tech/nervdog-harness) 使用。一个目录一个插件；编好的 `lib/` 直接提交，装的时候不用再编。

| 插件 | 包名 | 做什么 |
|---|---|---|
| [brand](brand/) | `@local/nervdog-brand` | 侧边栏左上角换成哈士奇 + NERVDOG 字标 + Harness；首页标题前的鲸鱼换成哈士奇。也放着桌面版 exe / 托盘 / 关于面板用的图标（`brand/icons/`，由 nervdog-harness 的 `desktop/brand-exe.mjs` 取用） |

## 安装

用绝对路径，按本地目录链接安装，改了插件重启 DeepSeek Harness 就生效：

- 网页版：`dsh plugin --profile web add link:<绝对路径>/nervdog-harness-plugins/brand`
- 桌面版：插件 → 添加插件 → 填同一个绝对路径 → 安装 → 立即启用（命令行不允许管理 desktop 配置）

卸载：`dsh plugin --profile web remove @local/nervdog-brand`，桌面版在插件页卸载。

## brand

```
brand/
  package.json  cordis.patch.yml  index.js   插件清单、补丁行、空的服务端入口
  src/client.js                              网页端源码
  lib/client.js                              编好的产物
  scripts/                                   生成脚本
  art/                                       原图
  assets/                                    内嵌进插件的字体和图
  icons/                                     给桌面版 exe 用的图标
```

- 插槽：`sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`，优先级 -10，盖过官方品牌插件但不禁用它。
- 改了 `src/client.js` 或 `assets/` 后，在 `brand/` 下跑 `node scripts/build.mjs`（把字体和图内嵌成 data URL，包成 `lib/client.js`），提交产物。
- 改了原图后，在 `brand/` 下跑 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1`，再跑 `node scripts/pack-ico.mjs` 和 `node scripts/build.mjs`；生成 `assets/mark.png`、`icons/nervdog-harness.ico`、`icons/icon.png`，圆角都是边长的 1/4。中间帧 `icons/png/` 不提交。

## License

The code in this repository is licensed under the MIT License, see `LICENSE`. The MIT License does not cover the names, marks and images described below, nor the Luckiest Guy font.

## Trademarks and intellectual property

NERVDOG, Nervdog, 紧张狗, Nervdog Tech and NERVDOG Harness, the NERVDOG wordmark, and the husky character together with every icon and image derived from it are trademarks and intellectual property of Shanghai Nervdog Technology Co., Ltd. ("Nervdog Tech"). All rights reserved. This covers `brand/art/`, `brand/assets/mark.png`, `brand/icons/` and the wordmark rendered by `brand/src/client.js`. Neither this repository nor any license that applies to its code grants a license to them. Do not use, copy, modify or distribute them, or use them in a way that suggests affiliation with or endorsement by Nervdog Tech, without prior written permission.

The Luckiest Guy font (`brand/assets/LuckiestGuy.ttf`) is not covered by the paragraph above: it is licensed under the Apache License 2.0, see `brand/assets/LuckiestGuy-LICENSE.txt`.

DeepSeek and DeepSeek Harness are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
