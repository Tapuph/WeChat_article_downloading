<#
  确保微信窗口可见（修正版 v3）。

  关键修正：
    之前"进程在但窗口不可见"时会重新启动 Weixin.exe —— 这会开出第二个实例
    （显示 368x484 扫码登录框），干扰判断。
    正确行为：
      1) 无进程        → 启动 Weixin.exe
      2) 有进程        → 绝不启动；枚举该进程所有顶层窗口（含隐藏/最小化），
                         取面积最大者恢复 + 最大化 + 激活
      3) 有进程但无任何窗口（托盘驻留、窗口已销毁）→ 明确报告，交给用户点托盘图标

  用法:
    powershell -File tool\wx-ensure2.ps1 [-Tag name]
  退出码:
    0 = 已恢复并激活主窗口
    4 = 进程在但找不到窗口（需要用户点托盘图标）
    5 = 微信未运行且启动失败
#>
param(
  [int]$TimeoutSec = 25,
  [string]$Tag = "ensure"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EN3 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);

  public class W { public IntPtr H; public string Cls; public bool Vis; public bool Min; public int Wd,Ht; }

  public static List<W> List(uint[] pids) {
    var l = new List<W>();
    EnumWindows((h, p) => {
      uint pid = GetWindowThreadProcessId(h, IntPtr.Zero);
      bool mine = false; foreach (uint x in pids) if (x == pid) { mine = true; break; }
      if (!mine) return true;
      var cb = new StringBuilder(256); GetClassName(h, cb, cb.Capacity);
      RECT r; GetWindowRect(h, out r);
      l.Add(new W { H = h, Cls = cb.ToString(), Vis = IsWindowVisible(h), Min = IsIconic(h), Wd = r.Right-r.Left, Ht = r.Bottom-r.Top });
      return true;
    }, IntPtr.Zero);
    return l;
  }

  public static int[] Rect(IntPtr h){RECT r; if(!GetWindowRect(h,out r)) return null; return new int[]{r.Left,r.Top,r.Right-r.Left,r.Bottom-r.Top};}

  public static bool Revive(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
    ShowWindow(h, 3);                    // SW_MAXIMIZE
    ShowWindow(h, 5);                    // SW_SHOW
    BringWindowToTop(h);
    IntPtr fg = GetForegroundWindow();
    uint tf = GetWindowThreadProcessId(fg, IntPtr.Zero), tm = GetCurrentThreadId();
    bool at = tf != tm && AttachThreadInput(tm, tf, true);
    try { SetForegroundWindow(h); } finally { if (at) AttachThreadInput(tm, tf, false); }
    return GetForegroundWindow() == h;
  }
}
'@ -ErrorAction Stop

[EN3]::SetProcessDPIAware() | Out-Null

$procs = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Write-Output "微信未运行，启动..."
  $exe = "D:\Tencent\Weixin\Weixin.exe"
  if (-not (Test-Path $exe)) { $exe = "D:\Tencent\Weixin\4.1.13.12\Weixin.exe" }
  Start-Process -FilePath $exe | Out-Null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 800
    $procs = @(Get-Process -Name Weixin -ErrorAction SilentlyContinue)
    if ($procs.Count -gt 0) { break }
  }
  if ($procs.Count -eq 0) { Write-Output "启动失败"; exit 5 }
  Start-Sleep -Seconds 3
}

$pids = New-Object System.Collections.Generic.List[uint32]
foreach ($p in $procs) { $pids.Add([uint32]$p.Id) }

$wins = [EN3]::List($pids.ToArray())
Write-Output "微信进程 $($procs.Count) 个，窗口 $($wins.Count) 个:"
foreach ($w in $wins) {
  $r = [EN3]::Rect($w.H)
  Write-Output ("  hwnd={0,-12} vis={1,-5} min={2,-5} {3}x{4}@({5},{6})  cls={7}" -f $w.H.ToString(), $w.Vis, $w.Min, $w.Wd, $w.Ht, $r[0], $r[1], $w.Cls)
}

# 第一优先：.NET MainWindowHandle（最可靠，不受枚举影响）
$cand = $null
$bestArea = 0
foreach ($p in $procs) {
  if ($p.MainWindowHandle -ne 0) {
    $hh2 = [IntPtr]$p.MainWindowHandle
    $r2 = [EN3]::Rect($hh2)
    if ($r2 -ne $null -and $r2[2] -gt 0 -and $r2[3] -gt 0) {
      $area = $r2[2] * $r2[3]
      if ($area -gt $bestArea) { $bestArea = $area; $cand = $hh2 }
    }
  }
}

# 兜底：枚举窗口（含隐藏/最小化），取面积最大者
if ($cand -eq $null) {
  $w2 = $wins | Sort-Object { -($_.Wd * $_.Ht) } | Select-Object -First 1
  if ($w2) { $cand = $w2.H }
}

if ($cand -eq $null) {
  Write-Output ""
  Write-Output "微信完全驻留托盘（窗口被销毁），尝试自动点击托盘图标唤出..."
  & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "wx-tray-open.ps1")
  if ($LASTEXITCODE -eq 0) {
    # 唤出成功，重新选窗口
    Start-Sleep -Milliseconds 1200
    foreach ($p in $procs) {
      if ($p.MainWindowHandle -ne 0) {
        $hh2 = [IntPtr]$p.MainWindowHandle
        $r2 = [EN3]::Rect($hh2)
        if ($r2 -ne $null -and $r2[2] -gt 0 -and $r2[3] -gt 0) {
          $area = $r2[2] * $r2[3]
          if ($area -gt $bestArea) { $bestArea = $area; $cand = $hh2 }
        }
      }
    }
  }
  if ($cand -eq $null) {
    Write-Output "自动唤出失败。请手动点击任务栏/托盘的微信图标打开窗口，然后重试本命令。"
    exit 4
  }
}

Write-Output ""
$cr = [EN3]::Rect($cand)
Write-Output "选中 hwnd=$cand ($($cr[2])x$($cr[3]))"
$ok = [EN3]::Revive($cand)
Start-Sleep -Milliseconds 1600
$r = [EN3]::Rect($cand)
Write-Output "恢复+最大化+激活: $ok  rect=$($r -join ',') 前台=$([EN3]::GetForegroundWindow())"

$w = [EN3]::GetSystemMetrics(0); $hh = [EN3]::GetSystemMetrics(1)
$b = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(0, 0, 0, 0, $b.Size)
$g.Dispose()
$out = Join-Path (Split-Path $PSScriptRoot -Parent) "work\$Tag.png"
$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output "截图: $out"
exit 0
