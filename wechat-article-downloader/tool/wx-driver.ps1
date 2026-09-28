<#
  微信 UI 驱动器（基于 PostMessage，已验证可生效）。

  为什么用 PostMessage：
    SendInput / mouse_event 会被微信过滤（光标位置正确但控件无响应）。
    PostMessage 把 WM_LBUTTONDOWN/UP 直接投进窗口消息队列，微信会正常处理。
    已通过 A/B 测试验证：可切换侧栏面板。

  提供函数：
    Wx-GetHwnd          取微信主窗口
    Wx-Focus            恢复+最大化+激活
    Wx-ClickScreen      按屏幕坐标点击
    Wx-Shot             全屏截图
    Wx-Type             输入文本（剪贴板粘贴）
    Wx-Wheel            滚轮
#>

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("WxD" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WxD {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  const uint WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202;
  const uint WM_MOUSEWHEEL = 0x020A, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
  const uint WM_LBUTTONDBLCLK = 0x0203;
  const int MK_LBUTTON = 1;

  public static bool FG(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    ShowWindow(h, 3);
    IntPtr fg = GetForegroundWindow();
    uint tf = GetWindowThreadProcessId(fg, IntPtr.Zero), tm = GetCurrentThreadId();
    bool at = tf != tm && AttachThreadInput(tm, tf, true);
    try { return SetForegroundWindow(h); } finally { if (at) AttachThreadInput(tm, tf, false); }
  }

  static IntPtr LP(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }

  /// 屏幕坐标 PostMessage 左键单击
  public static string Click(IntPtr h, int sx, int sy) {
    POINT p; p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    IntPtr lp = LP(p.X, p.Y);
    PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
    System.Threading.Thread.Sleep(60);
    PostMessage(h, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
    System.Threading.Thread.Sleep(80);
    PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
    return "click screen(" + sx + "," + sy + ") client(" + p.X + "," + p.Y + ")";
  }

  /// 双击
  public static string DoubleClick(IntPtr h, int sx, int sy) {
    POINT p; p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    IntPtr lp = LP(p.X, p.Y);
    PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
    System.Threading.Thread.Sleep(50);
    for (int i = 0; i < 2; i++) {
      PostMessage(h, WM_LBUTTONDOWN, (IntPtr)MK_LBUTTON, lp);
      System.Threading.Thread.Sleep(40);
      PostMessage(h, WM_LBUTTONUP, IntPtr.Zero, lp);
      System.Threading.Thread.Sleep(60);
    }
    return "dblclick screen(" + sx + "," + sy + ")";
  }

  /// 右键
  public static string RightClick(IntPtr h, int sx, int sy) {
    POINT p; p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    IntPtr lp = LP(p.X, p.Y);
    PostMessage(h, WM_MOUSEMOVE, IntPtr.Zero, lp);
    System.Threading.Thread.Sleep(60);
    PostMessage(h, WM_RBUTTONDOWN, (IntPtr)2, lp);
    System.Threading.Thread.Sleep(80);
    PostMessage(h, WM_RBUTTONUP, IntPtr.Zero, lp);
    return "rclick screen(" + sx + "," + sy + ")";
  }

  /// 滚轮：PostMessage WM_MOUSEWHEEL，delta 正数向上
  public static string Wheel(IntPtr h, int sx, int sy, int delta) {
    POINT p; p.X = sx; p.Y = sy;
    ScreenToClient(h, ref p);
    IntPtr lp = LP(p.X, p.Y);
    IntPtr wp = (IntPtr)((delta << 16) & unchecked((int)0xFFFF0000));
    PostMessage(h, WM_MOUSEWHEEL, wp, lp);
    return "wheel screen(" + sx + "," + sy + ") delta=" + delta;
  }
}
'@ -ErrorAction Stop
}

[WxD]::SetProcessDPIAware() | Out-Null

$script:WxLastHwnd = [IntPtr]::Zero
function Wx-GetHwnd {
  <#
    取微信主窗口句柄，带缓存与校验：
    - 优先用进程 MainWindowHandle
    - 若中途瞬变 0，则回退到上次成功的句柄（校验 IsWindow）
    - 都不行才报错
  #>
  $p = Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $script:WxLastHwnd = [IntPtr]$p.MainWindowHandle
    return $script:WxLastHwnd
  }
  if ($script:WxLastHwnd -ne [IntPtr]::Zero -and [WxD]::IsWindow($script:WxLastHwnd)) {
    return $script:WxLastHwnd
  }
  throw "微信主窗口未找到（可能未运行或未登录）"
}

function Wx-Focus {
  $h = Wx-GetHwnd
  [WxD]::FG($h) | Out-Null
  Start-Sleep -Milliseconds 900
  $h
}

function Wx-ScreenSize { @([WxD]::GetSystemMetrics(0), [WxD]::GetSystemMetrics(1)) }

function Wx-Shot {
  param([string]$Name = "shot", [string]$Dir = "")
  if (-not $Dir) { $Dir = Join-Path (Split-Path $PSScriptRoot -Parent) "work" }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  $sz = Wx-ScreenSize
  $b = New-Object System.Drawing.Bitmap $sz[0], $sz[1]
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen(0, 0, 0, 0, $b.Size)
  $g.Dispose()
  $p = Join-Path $Dir "$Name.png"
  $b.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
  $p
}

function Wx-Click {
  param([int]$X, [int]$Y, [int]$WaitMs = 1500)
  $h = Wx-GetHwnd
  $r = [WxD]::Click($h, $X, $Y)
  Start-Sleep -Milliseconds $WaitMs
  $r
}

function Wx-DoubleClick {
  param([int]$X, [int]$Y, [int]$WaitMs = 1500)
  $h = Wx-GetHwnd
  $r = [WxD]::DoubleClick($h, $X, $Y)
  Start-Sleep -Milliseconds $WaitMs
  $r
}

function Wx-RightClick {
  param([int]$X, [int]$Y, [int]$WaitMs = 1200)
  $h = Wx-GetHwnd
  $r = [WxD]::RightClick($h, $X, $Y)
  Start-Sleep -Milliseconds $WaitMs
  $r
}

function Wx-Wheel {
  param([int]$X, [int]$Y, [int]$Delta = -360, [int]$Times = 1, [int]$WaitMs = 900)
  $h = Wx-GetHwnd
  $last = ""
  for ($i = 0; $i -lt $Times; $i++) {
    $last = [WxD]::Wheel($h, $X, $Y, $Delta)
    Start-Sleep -Milliseconds $WaitMs
  }
  $last
}

function Wx-Type {
  <# 输入文本：优先剪贴板粘贴（中文可靠），失败可回退 SendKeys #>
  param([Parameter(Mandatory)][string]$Text, [switch]$UseSendKeys, [int]$WaitMs = 1500)
  if ($UseSendKeys) {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
  } else {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^v")
  }
  Start-Sleep -Milliseconds $WaitMs
}

function Wx-Key {
  param([Parameter(Mandatory)][string]$Keys, [int]$WaitMs = 1200)
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  Start-Sleep -Milliseconds $WaitMs
}
