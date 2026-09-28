<#
  标准化流程的第 1 步（确定性 UI 驱动，无 OCR）：
  在微信里搜索指定公众号 → 进入主页 → 滚动浏览文章。

  所有控制信号都是确定性的：
    - 窗口先强制最大化 → 坐标恒定（最大化布局下已实测标定）
    - 点账号名后用"内存里该 __biz 的文章数"验证是否生效
    - 点账号名失败时自动回退：头像位置 → 绿色文字像素定位

  参数（均为最大化布局 2560x1440 下的实测值）：
    聊天图标 (43,137)  搜索框 (197,76)
    账号卡片名 (2130,350)  备用头像 (2060,350)
    页面聚焦点 (2100,240)

  结果写入 StatusFile（JSON），供编排器读取。
#>
param(
  [Parameter(Mandatory)][string]$Keyword,
  [string]$Biz = "",
  [int]$TargetCount = 10,
  [int]$MaxRounds = 25,
  [int]$ChatX = 43,  [int]$ChatY = 137,
  [int]$BoxX = 197,  [int]$BoxY = 76,
  [int]$CardX = 2130, [int]$CardY = 350,
  [int]$AvatarX = 2060, [int]$AvatarY = 350,
  [int]$FocusX = 2100, [int]$FocusY = 240,
  [string]$StatusFile = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $StatusFile) { $StatusFile = Join-Path (Split-Path $here -Parent) "work\last-ui-status.json" }

# 载入坐标配置（微信升级后可运行 wx-calibrate.ps1 重新标定）
$cfgPath = Join-Path $here "config.json"
if (Test-Path $cfgPath) {
  try {
    $raw = [System.IO.File]::ReadAllText($cfgPath, [System.Text.Encoding]::UTF8)
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $cfg = $raw | ConvertFrom-Json
    if ($cfg.chatIcon)        { $ChatX = [int]$cfg.chatIcon[0];        $ChatY = [int]$cfg.chatIcon[1] }
    if ($cfg.searchBox)       { $BoxX  = [int]$cfg.searchBox[0];       $BoxY  = [int]$cfg.searchBox[1] }
    if ($cfg.accountCard)     { $CardX = [int]$cfg.accountCard[0];     $CardY = [int]$cfg.accountCard[1] }
    if ($cfg.accountAvatar)   { $AvatarX = [int]$cfg.accountAvatar[0]; $AvatarY = [int]$cfg.accountAvatar[1] }
    if ($cfg.pageFocus)       { $FocusX = [int]$cfg.pageFocus[0];      $FocusY = [int]$cfg.pageFocus[1] }
    Write-Output "[config] 已从 config.json 载入坐标"
  } catch {
    Write-Output "[config] config.json 解析失败，使用内置默认坐标: $($_.Exception.Message)"
  }
}

. "$here\wx-driver.ps1"
Add-Type -AssemblyName System.Windows.Forms

# ---- Chromium 渲染窗口的点击（网页内容由它渲染，必须投给它） ----
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public class DR {
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  const uint WM_MOUSEMOVE=0x0200, WM_LBUTTONDOWN=0x0201, WM_LBUTTONUP=0x0202;
  public static IntPtr Render(IntPtr root) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(root, (h, p) => {
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      if (cb.ToString().Contains("Chrome_RenderWidgetHostHWND")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Click(IntPtr h, int sx, int sy) {
    if (h == IntPtr.Zero) return false;
    POINT p; p.X=sx; p.Y=sy; ScreenToClient(h, ref p);
    IntPtr lp = (IntPtr)((p.Y<<16)|(p.X & 0xFFFF));
    PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
    System.Threading.Thread.Sleep(80);
    PostMessage(h, WM_LBUTTONDOWN, (IntPtr)1, lp);
    System.Threading.Thread.Sleep(90);
    PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
    return true;
  }
}
'@ -ErrorAction Stop

function Set-Status {
  param([bool]$Ok, [string]$Step, [string]$Message, [int]$Count)
  $obj = [ordered]@{
    ok = $Ok; step = $Step; message = $Message; keyword = $Keyword; biz = $Biz;
    memoryCount = $Count; finishedAt = (Get-Date).ToString("o")
  }
  $obj | ConvertTo-Json -Depth 3 | Set-Content -Path $StatusFile -Encoding UTF8
}

function Get-Count {
  $out = & node (Join-Path $PSScriptRoot "count-biz.mjs") $Biz 2>&1
  # 优先解析 ASCII 标记（PowerShell 5.1 的 GBK 控制台会把中文输出变乱码，
  # 之前用"命中 X 篇"匹配在用户环境全部失败返回 -1）
  $m = ($out | Select-String -Pattern "RESULT_COUNT=(\d+)").Matches
  if ($m.Count -gt 0) { return [int]$m[0].Groups[1].Value }
  # 兜底：兼容旧版输出
  $m = ($out | Select-String -Pattern "命中\s+(\d+)\s+篇").Matches
  if ($m.Count -gt 0) { return [int]$m[0].Groups[1].Value }
  # 失败时把原始输出打到日志，暴露真实原因
  Write-Output "      [内存计数失败，原始输出如下]"
  $out | Select-Object -First 10 | ForEach-Object { Write-Output "        $_" }
  return -1
}

try {
  # 1) 激活并最大化
  $h = Wx-Focus
  Write-Output "[1/6] 微信已激活 hwnd=$h"

  # 2) 清掉可能残留的菜单，回到聊天列表
  Wx-Key -Keys "{ESC}" -WaitMs 500 | Out-Null
  Wx-Click -X $ChatX -Y $ChatY -WaitMs 1500 | Out-Null
  Write-Output "[2/6] 已回到聊天列表"

  # 3) 搜索
  Wx-Click -X $BoxX -Y $BoxY -WaitMs 1500 | Out-Null
  Wx-Key -Keys "^a" -WaitMs 250 | Out-Null
  Wx-Key -Keys "{DEL}" -WaitMs 400 | Out-Null
  Wx-Type -Text $Keyword -WaitMs 1800 | Out-Null
  Wx-Key -Keys "{ENTER}" -WaitMs 3500 | Out-Null
  Write-Output "[3/6] 已搜索「$Keyword」"

  # 4) 点账号卡片（首选账号名，失败回退头像）
  $render = [DR]::Render($h)
  if ($render -eq [IntPtr]::Zero) { throw "未找到 Chromium 渲染窗口（搜索可能失败）" }
  [DR]::Click($render, $CardX, $CardY) | Out-Null
  Start-Sleep -Milliseconds 4500
  Write-Output "[4/6] 已点击账号卡片 ($CardX,$CardY)"

  # 5) 聚焦页面并滚动加载文章
  [DR]::Click($render, $FocusX, $FocusY) | Out-Null
  Start-Sleep -Milliseconds 1200

  if (-not $Biz) {
    # 未知 biz（例如用它自动发现公众号）：不做计数，固定滚动若干轮把文章载入内存
    Write-Output "[5/6] 未指定 biz，固定滚动 $MaxRounds 轮以加载文章"
    for ($i = 1; $i -le $MaxRounds; $i++) {
      [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
      Start-Sleep -Milliseconds 550
      [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
      Start-Sleep -Milliseconds 900
    }
    Write-Output "[6/6] 加载完成（供后续扫描使用）"
    Set-Status -Ok $true -Step "loaded" -Message "已加载（未指定 biz，固定滚动 $MaxRounds 轮）" -Count -1
    exit 0
  }

  $base = Get-Count
  $need = $TargetCount + 15
  Write-Output "[5/6] 开始滚动加载（基线 $base 篇，目标 >= $need）"
  $last = $base; $stable = 0
  for ($i = 1; $i -le $MaxRounds; $i++) {
    [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
    Start-Sleep -Milliseconds 550
    [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
    Start-Sleep -Milliseconds 1100
    $now = Get-Count
    Write-Output ("      第 {0,2} 轮 -> {1} 篇" -f $i, $now)
    if ($now -ge $need) { Write-Output "      已达到目标，停止"; break }
    if ($now -gt $last) { $stable = 0 } else { $stable++ }
    $last = $now
    if ($stable -ge 6) { Write-Output "      连续 6 轮无增长，停止"; break }
  }

  $final = Get-Count
  if ($final -lt 1) { throw "内存中未发现该公众号的任何文章（滚动/进入主页可能失败）" }

  # 回退：如果加载数量不够（可能没点进主页，只搜到了固定几篇），
  # 改点账号头像再滚一轮，这是确定性回退，不需要 OCR。
  if ($final -lt ($TargetCount + 5)) {
    Write-Output "      数量不足($final)，回退：点击账号头像 ($AvatarX,$AvatarY) 再滚动"
    $render2 = [DR]::Render((Wx-GetHwnd))
    [DR]::Click($render2, $AvatarX, $AvatarY) | Out-Null
    Start-Sleep -Milliseconds 4500
    [DR]::Click($render2, $FocusX, $FocusY) | Out-Null
    Start-Sleep -Milliseconds 1200
    $stable = 0; $last = $final
    for ($j = 1; $j -le $MaxRounds; $j++) {
      [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
      Start-Sleep -Milliseconds 550
      [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
      Start-Sleep -Milliseconds 1100
      $now2 = Get-Count
      Write-Output ("      回退轮 {0,2} -> {1} 篇" -f $j, $now2)
      if ($now2 -ge $need) { break }
      if ($now2 -gt $last) { $stable = 0 } else { $stable++ }
      $last = $now2
      if ($stable -ge 6) { break }
    }
    $final = Get-Count
  }

  Write-Output "[6/6] 完成，内存中该号文章 $final 篇"
  Set-Status -Ok $true -Step "done" -Message "内存中该号文章 $final 篇" -Count $final
  exit 0
}
catch {
  Write-Output "失败: $($_.Exception.Message)"
  Set-Status -Ok $false -Step "error" -Message $_.Exception.Message -Count -1
  exit 2
}
