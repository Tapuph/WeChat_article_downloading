# wechat-article-downloader

批量下载微信公众号文章：告知「公众号名称 + 篇数」，自动完成
搜索 → 进入主页 → 滚动浏览 → 从微信内存读取文章链接 → 下载正文与图片（离线 HTML）。

全程不依赖 OCR：界面操作用固定坐标 + 内存计数验证，微信升级后可用内置校准器重新标定坐标。

## 一、环境要求

- Windows 10 / 11（64 位）
- 微信 PC 版 4.x，**已登录**（窗口最小化、驻留托盘均可，程序会自动调出）
- Node.js 18+（开发环境为 Node 24）
- PowerShell 5.1（Windows 自带）

## 二、包放到哪里

解压/克隆后放到**任意英文路径目录**即可，例如：

```
D:\tools\wechat-article-downloader
C:\Users\<你>\wechat-article-downloader
```

所有脚本按“相对自身位置”解析路径，可整体移动、可改名，无需安装。

## 三、安装到 harness（供 agent 调用）

把包目录告诉 agent（例如：“我装了公众号下载插件，路径是 D:\tools\wechat-article-downloader”），
或把 `SKILL.md` 复制到 harness 的技能目录：

```
%USERPROFILE%\.dsh\skills\wechat-article-downloader\SKILL.md
```

（目录不存在就新建；放置后重启 harness 会话即可识别。）

> 说明：DeepSeek Harness 的原生插件机制为 pnpm profile bundle（`dsh plugin --profile ...`）。
> 本包以“独立脚本 + 技能文档”方式集成，不依赖特定版本的 harness API，
> 因此无论 harness 版本如何变化都能通过 agent 直接执行命令。

## 四、首次使用（一次性准备）

### 1. 获取公众平台凭证（用于按名称定位公众号）

```powershell
cd <包目录>
node tool\login.mjs
```

会弹出 Edge 窗口，扫码登录微信公众平台，自动生成 `creds.json`（机器相关，已 gitignore）。

### 2. 微信保持登录

下载过程中微信需处于已登录状态（最小化/驻留托盘均可，程序会自动恢复；
若需要扫码，程序会提示，扫码后重跑同一条命令即可）。

## 五、使用（两种方式）

### 方式 A：告诉 agent

> “下载公众号『牧之野』的最近 10 篇文章到 D:\articles”

agent 会执行：

```powershell
node <包目录>\tool\wechat-download.mjs --account "牧之野" --count 10 --out "D:\articles"
```

### 方式 B：PowerShell 直接执行

```powershell
cd <包目录>
node tool\wechat-download.mjs --account "公众号名" --count 篇数 --out "输出目录"
```

参数说明：

| 参数 | 必填 | 说明 |
|---|---|---|
| `--account` | 是 | 公众号名称 |
| `--count` | 否 | 下载最近 N 篇，默认 10 |
| `--biz` | 否 | 直接指定公众号 fakeid，跳过按名称查询（公众平台凭证过期时用这个） |
| `--skip-existing` | 否 | 先取“最新 N 篇”，再剔除已下载过的，只下缺的那些（不向前补老文章） |
| `--out` | 否 | 输出目录，默认 `<包目录>\out` |
| `--dry-run` | 否 | 只验证公众号能否定位，不动微信 |

### 批量脚本（一次跑多个账号）

```powershell
powershell -ExecutionPolicy Bypass -File tool\run-4-accounts.ps1
```

脚本里每个账号一行，已带 `--biz` 与 `--skip-existing`，可自行增删账号。

### 未知 fakeid 的账号（自动发现）

内存计数差分法：先记录基线 → 在微信里搜该账号并翻页 → 再扫描，新增最多的那个 biz 即为目标。

```powershell
node tool\discover-new-biz.mjs --baseline
powershell -ExecutionPolicy Bypass -File tool\wx-search-det.ps1 -Keyword "公众号名" -MaxRounds 8
node tool\discover-new-biz.mjs --account "公众号名" --count 3
```

输出结构（`<输出目录>\by_account\<公众号名>\`）：

```
公众号名\
├── 2026-09-21_文章标题.html      # 离线 HTML（含本地图片引用）
├── assets\                      # 图片
└── _latest_公众号名.json         # 汇总清单
```

## 六、坐标校准（微信升级导致流程失效时）

部分步骤依赖“微信最大化布局”下的界面坐标。微信更新后界面若变化，运行：

```powershell
powershell -ExecutionPolicy Bypass -File tool\wx-calibrate.ps1
```

按提示依次用鼠标点击 5 个锚点（聊天图标 / 搜索框 / 搜索结果里的账号名 / 账号头像 / 主页空白处），
程序自动记录并写入 `tool\config.json`，之后无需改任何代码。

agent 也可以在失败时直接调用该脚本引导用户完成校准。

## 七、常见问题

- **提示扫码登录**：微信退登了。扫码后重跑同一条命令（已下载的会覆盖/跳过）。
- **公众平台凭证过期**：重跑 `node tool\login.mjs`。
- **图片不显示**：本包已内置修复；HTML 与 assets 文件夹需保持在同一目录。
- **只下载到少数几篇**：正常。内存中只有客户端加载过的文章；篇数不足时流程会自动回退重试。

## 八、免责声明

本工具仅用于个人备份已公开内容。请遵守微信服务条款与当地著作权法规，勿用于商业或非法用途。
