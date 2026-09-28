<#
  坐标校准器（微信升级、界面变化后重新标定锚点）。

  用法:
    powershell -ExecutionPolicy Bypass -File tool\wx-calibrate.ps1

  流程：
    1) 自动最大化并前置微信
    2) 依次提示 5 个锚点，你在微信界面上用鼠标点击对应位置
       （点击瞬间程序记录鼠标物理坐标）
    3) 写回 tool\config.json，下次下载自动使用新坐标

  需要点击的锚点：
    1. 左侧栏「聊天」图标
    2. 顶部「搜索」输入框中央
    3. 搜一搜结果页里，目标公众号的「账号名」文字
    4. 该账号卡片左侧「头像」
    5. 账号主页里的简介/空白区域（不要点在文章链接上）
#>
param()

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$here\wx-driver.ps1"

Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class CAL {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static bool Cursor(out int x, out int y) {
    POINT p; bool ok = GetCursorPos(out p); x = p.X; y = p.Y; return ok;
  }
}
'@ -ErrorAction Stop

[CAL]::SetProcessDPIAware() | Out-Null

function Wait-Click {
  # 等待一次鼠标左键按下，记录坐标，并等待松开（避免一次点击记两次）
  while ($true) {
    $s = [CAL]::GetAsyncKeyState(1)  # VK_LBUTTON
    if (($s -band 0x8000) -ne 0) {
      $x = 0; $y = 0
      [CAL]::Cursor([ref]$x, [ref]$y) | Out-Null
      while (($([CAL]::GetAsyncKeyState(1)) -band 0x8000) -ne 0) { Start-Sleep -Milliseconds 30 }
      return @($x, $y)
    }
    Start-Sleep -Milliseconds 40
  }
}

function Wait-Enter {
  while ($true) {
    if (($([CAL]::GetAsyncKeyState(13)) -band 0x8000) -ne 0) {
      while (($([CAL]::GetAsyncKeyState(13)) -band 0x8000) -ne 0) { Start-Sleep -Milliseconds 30 }
      return
    }
    Start-Sleep -Milliseconds 40
  }
}

Write-Output "=================================================="
Write-Output " 微信界面坐标校准器"
Write-Output "=================================================="
Write-Output ""
Write-Output "正在最大化并前置微信窗口..."
Wx-Focus | Out-Null
Start-Sleep -Milliseconds 1500
Write-Output ""

$anchors = [ordered]@{
  chatIcon      = "1/5 左侧栏「聊天」图标"
  searchBox     = "2/5 顶部「搜索」输入框中央"
  accountCard   = "3/5 搜一搜结果页里目标公众号的「账号名」文字"
  accountAvatar = "4/5 该账号卡片左侧的「头像」"
  pageFocus     = "5/5 账号主页里的简介/空白区域（别点在文章链接上）"
}

$result = [ordered]@{ version = 2; layout = "user-calibrated" }

foreach ($key in $anchors.Keys) {
  if ($key -eq "accountCard" -or $key -eq "accountAvatar") {
    Write-Output ""
    Write-Output ">>> 请先在微信搜索框搜索任意一个公众号（例如输入『原点时间』回车），"
    Write-Output "    看到搜一搜结果页后，按 Enter 继续。"
    Wait-Enter
    Write-Output ""
  }
  if ($key -eq "pageFocus") {
    Write-Output ""
    Write-Output ">>> 请先进入某个公众号的主页（点结果页里的账号名即可进入），"
    Write-Output "    看到主页后，按 Enter 继续。"
    Wait-Enter
    Write-Output ""
  }
  Write-Output "【$($anchors[$key])】—— 请用鼠标点击它，程序会自动记录坐标..."
  $pt = Wait-Click
  Write-Output "    已记录: ($($pt[0]), $($pt[1]))"
  $result[$key] = @([int]$pt[0], [int]$pt[1])
}

$cfgPath = Join-Path $here "config.json"
$json = $result | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ""
Write-Output "=================================================="
Write-Output " 校准完成，已写入: $cfgPath"
Write-Output " 内容:"
Write-Output $json
Write-Output "=================================================="
Write-Output " 下次运行 node tool\wechat-download.mjs 将自动使用新坐标。"
