# 批量下载 4 个公众号的最新 3 篇（已下载过的跳过）
# 用法（任意位置均可，脚本按自身位置解析路径）:
#   powershell -ExecutionPolicy Bypass -File <包目录>\tool\run-4-accounts.ps1
param(
  [int]$Count = 3
)
$ErrorActionPreference = "Continue"
$Tool = $PSScriptRoot
$Root = Split-Path -Parent $Tool
Set-Location $Root

function Step($msg) { Write-Output ""; Write-Output ("===== " + $msg + " =====") }

Step "1/4 原点时间"
node "$Tool\wechat-download.mjs" --account "原点时间" --count $Count --biz "Mzg4MzY5NzE3MQ==" --skip-existing

Step "2/4 牧之野"
node "$Tool\wechat-download.mjs" --account "牧之野" --count $Count --biz "MzU1MTExMTE2NQ==" --skip-existing

Step "3/4 之乎者野记"
node "$Tool\wechat-download.mjs" --account "之乎者野记" --count $Count --biz "MzkyNzUyNDEzNw==" --skip-existing

Step "4/4 慕云思辨（biz 已发现：MzA3NDcwNzU2Mw==，账号自称「慕云思辩」）"
node "$Tool\wechat-download.mjs" --account "慕云思辨" --count $Count --biz "MzA3NDcwNzU2Mw==" --skip-existing

# 若账号 biz 变化，或要加 fakeid 未知的新账号，改用下面三步自动发现：
#   node "$Tool\discover-new-biz.mjs" --baseline
#   powershell -ExecutionPolicy Bypass -File "$Tool\wx-search-det.ps1" -Keyword "公众号名" -MaxRounds 8
#   node "$Tool\discover-new-biz.mjs" --account "公众号名" --count 3

Step "全部完成"
