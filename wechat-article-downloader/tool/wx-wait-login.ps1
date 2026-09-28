<#
  标准化流程的辅助步骤：等待微信登录完成（窗口从登录框变为大窗口）。

  判定：微信登录窗口是 368x484 的小窗，登录后主窗口 >1000 宽。
  轮询直到出现大窗口或超时。
#>
param(
  [int]$TimeoutSec = 120,
  [int]$MinWidth = 1000
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class WL {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public static int[] Rect(IntPtr h){RECT r;GetWindowRect(h,out r);return new int[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};}
}
'@ -ErrorAction Stop
[WL]::SetProcessDPIAware() | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $r = [WL]::Rect([IntPtr]$p.MainWindowHandle)
    if ($r -and $r[2] -ge $MinWidth) {
      Write-Output "已登录：窗口 $($r[2])x$($r[3])"
      exit 0
    }
  }
  Start-Sleep -Seconds 3
}
Write-Output "超时：仍未出现登录后的主窗口（可能还需扫码）"
exit 3
