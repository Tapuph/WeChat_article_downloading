<#
  可靠地把微信窗口带到前台：
    Alt 键释放前台锁 → BringWindowToTop + AttachThreadInput + SetForegroundWindow
    循环重试直到成功，成功后截图。

  用法:
    powershell -File tool\wx-front2.ps1
#>
param(
  [int]$Attempts = 6,
  [string]$Tag = "front"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class FR {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public static int[] Rect(IntPtr h){RECT r;GetWindowRect(h,out r);return new int[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};}
  public static bool TryFG(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    ShowWindow(h, 3); ShowWindow(h, 5);
    BringWindowToTop(h);
    IntPtr fg = GetForegroundWindow();
    uint tf = GetWindowThreadProcessId(fg, IntPtr.Zero), tm = GetCurrentThreadId();
    bool at = tf != tm && AttachThreadInput(tm, tf, true);
    try { SetForegroundWindow(h); } finally { if (at) AttachThreadInput(tm, tf, false); }
    return GetForegroundWindow() == h;
  }
}
'@ -ErrorAction Stop

[FR]::SetProcessDPIAware() | Out-Null

$p = Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "微信无窗口"; exit 1 }
$h = [IntPtr]$p.MainWindowHandle
Write-Output "微信主窗口 hwnd=$h rect=$(([FR]::Rect($h)) -join ',')"

$ok = $false
for ($i = 1; $i -le $Attempts; $i++) {
  [System.Windows.Forms.SendKeys]::SendWait("%")   # Alt 释放前台锁
  Start-Sleep -Milliseconds 250
  $ok = [FR]::TryFG($h)
  Start-Sleep -Milliseconds 700
  Write-Output "  第 $i 次: 前台=$([FR]::GetForegroundWindow()) 目标=$h 成功=$ok"
  if ($ok) { break }
}
Write-Output "最终前台 = $([FR]::GetForegroundWindow())"

$w = [FR]::GetSystemMetrics(0); $hh = [FR]::GetSystemMetrics(1)
$b = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, $b.Size)
$g.Dispose()
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "work\$Tag.png"
$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output "截图: $out"
