<#
  自动点击系统托盘里的微信图标，唤出主窗口（处理"完全驻留托盘"场景）。

  原理：
    - UIA 在 Shell_TrayWnd 里找 name='微信' 的按钮，拿到屏幕坐标
    - 用真实鼠标点击（SetCursorPos + mouse_event）：点击发给 Explorer 托盘区，
      Explorer 会通知微信显示窗口（微信本身不处理这个点击，不受其注入过滤影响）
    - 单击后轮询窗口是否出现；不行再双击

  退出码: 0=成功唤出  1=失败
#>
param(
  [int]$TimeoutSec = 12
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public class TrayClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);

  static string N(AutomationElement e) { try { return (e.Current.Name ?? "").Trim(); } catch { return ""; } }

  /// 找托盘里微信图标中心（屏幕物理坐标）。找不到返回 null。
  public static int[] Find() {
    AutomationElement tray = null;
    foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      string cls = ""; try { cls = w.Current.ClassName ?? ""; } catch {}
      if (cls == "Shell_TrayWnd") { tray = w; break; }
    }
    if (tray == null) return null;
    var q = new Queue<AutomationElement>();
    q.Enqueue(tray);
    while (q.Count > 0) {
      var e = q.Dequeue();
      string name = N(e);
      if (name == "微信" || name == "WeChat" || name == "Weixin") {
        var r = e.Current.BoundingRectangle;
        return new int[] { (int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2) };
      }
      AutomationElementCollection kids;
      try { kids = e.FindAll(TreeScope.Children, Condition.TrueCondition); } catch { continue; }
      foreach (AutomationElement k in kids) q.Enqueue(k);
    }
    return null;
  }

  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(2, 0, 0, 0, UIntPtr.Zero);   // left down
    System.Threading.Thread.Sleep(60);
    mouse_event(4, 0, 0, 0, UIntPtr.Zero);   // left up
  }

  public static void DoubleClick(int x, int y) {
    for (int i = 0; i < 2; i++) {
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(120);
      mouse_event(2, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(50);
      mouse_event(4, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(80);
    }
  }
}
'@ -ReferencedAssemblies "UIAutomationClient","UIAutomationTypes","WindowsBase" -ErrorAction Stop

[TrayClick]::SetProcessDPIAware() | Out-Null

function Test-WindowAppeared {
  $p = Get-Process -Name Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  return $null -ne $p
}

$pos = [TrayClick]::Find()
if ($pos -eq $null) {
  Write-Output "未在托盘找到微信图标（可能在隐藏图标区）"
  exit 1
}
Write-Output "微信托盘图标中心: ($($pos[0]), $($pos[1]))"

Write-Output "单击托盘图标..."
[TrayClick]::Click($pos[0], $pos[1])

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if (Test-WindowAppeared) {
    Write-Output "微信窗口已出现 ✓"
    exit 0
  }
}

Write-Output "单击未生效，改双击..."
[TrayClick]::DoubleClick($pos[0], $pos[1])
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  if (Test-WindowAppeared) {
    Write-Output "微信窗口已出现（双击） ✓"
    exit 0
  }
}

Write-Output "托盘点击未能唤出微信窗口"
exit 1
