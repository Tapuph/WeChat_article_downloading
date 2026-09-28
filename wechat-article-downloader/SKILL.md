# 技能：wechat-article-downloader（公众号文章批量下载）

## 触发条件
用户要求“下载公众号 XX 的最近 N 篇文章 / 文章正文 + 图片”到指定位置。

## 执行方式
直接执行（包目录记为 PKG）：

```
node PKG\tool\wechat-download.mjs --account "<公众号名>" --count <N> [--out "<输出目录>"]
```

- `--account`：必填，公众号名称
- `--count`：篇数，默认 10
- `--biz`：直接指定 fakeid，跳过按名称查询（凭证过期时的兜底）
- `--skip-existing`：只下“最新 N 篇”里还没下载过的（常用；不向前补老文章）
- `--out`：输出目录，默认 PKG\out
- `--dry-run`：只验证公众号定位（不动微信）

批量：`powershell -ExecutionPolicy Bypass -File PKG\tool\run-4-accounts.ps1`（脚本内按账号逐行调用）。
fakeid 未知的账号：先用 `PKG\tool\discover-new-biz.mjs`（配合 `wx-search-det.ps1 -Keyword`）自动发现。

## 前置条件（缺一不可）
1. 微信 PC 已登录（最小化/托盘均可，程序会自动调出）
2. PKG\creds.json 存在（首次：运行 `node PKG\tool\login.mjs`，用户扫码登录公众平台）

## 失败处理
- 提示扫码登录 → 请用户在微信扫码后重跑同一命令
- 提示“UI 阶段失败”且坐标疑似不准（微信更新过）→ 运行
  `powershell -ExecutionPolicy Bypass -File PKG\tool\wx-calibrate.ps1` 引导用户点击 5 个锚点，再重跑
- 凭证过期 → 重跑 login.mjs

## 输出
`<输出目录>\by_account\<公众号名>\`：每篇一个离线 HTML + assets 图片目录 + _latest_*.json 清单。
如需纯文本：`node PKG\tool\html-to-text.mjs --account "<公众号名>"` 导出 TXT/MD。
