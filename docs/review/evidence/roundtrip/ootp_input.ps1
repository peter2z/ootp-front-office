# Hardware-level input helper for driving OOTP 27 during the write-channel experiments.
#
# OOTP's custom UI ignores message-posted clicks (the kind generic automation tools send),
# but accepts SendInput at the HID level. Two guards keep input from reaching anything else:
#   1. OOTP must own the foreground window before any key or click goes out.
#   2. The window under the click point must belong to OOTP (topmost windows of other apps,
#      such as the assistant's own window, would otherwise swallow the click).
#
# Usage:
#   powershell -NoProfile -File ootp_input.ps1 -Actions "focus;click:1630,193;wait:500;key:escape;type:hello"
#
# Actions (screen pixel coordinates in the logical 1707x1067 space):
#   focus            bring the OOTP window to the foreground (retries; fails loudly if it cannot)
#   probe:X,Y        print which process owns the window under the point (no input sent)
#   click:X,Y        left click        dblclick:X,Y   double click     rclick:X,Y   right click
#   move:X,Y         move the cursor   scroll:X,Y,N   wheel N notches (negative = down)
#   key:NAME         escape|return|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|space|f1..f12|ctrl+a|ctrl+c|ctrl+v
#   type:TEXT        type literal text (unicode)      wait:MS         sleep
param([Parameter(Mandatory = $true)][string]$Actions)

Add-Type @"
using System; using System.Runtime.InteropServices;
public static class OI {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public IU u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  static int Sz() { return Marshal.SizeOf(typeof(INPUT)); }
  static INPUT M(int nx, int ny, uint flags) { var i = new INPUT(); i.type = 0; i.u.mi = new MOUSEINPUT { dx = nx, dy = ny, dwFlags = flags }; return i; }
  static void Norm(int x, int y, out int nx, out int ny) { int w = GetSystemMetrics(0), h = GetSystemMetrics(1); nx = (int)Math.Round(x * 65535.0 / (w - 1)); ny = (int)Math.Round(y * 65535.0 / (h - 1)); }
  public static void Move(int x, int y) { int nx, ny; Norm(x, y, out nx, out ny); SendInput(1, new[] { M(nx, ny, 0x8001) }, Sz()); }
  public static void Click(int x, int y, uint down, uint up) { int nx, ny; Norm(x, y, out nx, out ny); SendInput(1, new[] { M(nx, ny, 0x8001) }, Sz()); System.Threading.Thread.Sleep(120); SendInput(1, new[] { M(nx, ny, 0x8001 | down) }, Sz()); System.Threading.Thread.Sleep(70); SendInput(1, new[] { M(nx, ny, 0x8001 | up) }, Sz()); }
  public static void Wheel(int x, int y, int notches) { int nx, ny; Norm(x, y, out nx, out ny); SendInput(1, new[] { M(nx, ny, 0x8001) }, Sz()); System.Threading.Thread.Sleep(80); var i = M(0, 0, 0x0800); i.u.mi.mouseData = (uint)(notches * 120); SendInput(1, new[] { i }, Sz()); }
  static INPUT K(ushort vk, ushort sc, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki = new KEYBDINPUT { wVk = vk, wScan = sc, dwFlags = flags }; return i; }
  public static void Key(ushort vk) { SendInput(1, new[] { K(vk, 0, 0) }, Sz()); System.Threading.Thread.Sleep(40); SendInput(1, new[] { K(vk, 0, 2) }, Sz()); }
  public static void Chord(ushort mod, ushort vk) { SendInput(1, new[] { K(mod, 0, 0) }, Sz()); System.Threading.Thread.Sleep(30); Key(vk); System.Threading.Thread.Sleep(30); SendInput(1, new[] { K(mod, 0, 2) }, Sz()); }
  public static void Text(string s) { foreach (char c in s) { SendInput(1, new[] { K(0, c, 4) }, Sz()); System.Threading.Thread.Sleep(15); SendInput(1, new[] { K(0, c, 4 | 2) }, Sz()); System.Threading.Thread.Sleep(15); } }
  public static string ProcName(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; } }
  public static string OwnerAt(int x, int y) { var p = new POINT { x = x, y = y }; IntPtr h = WindowFromPoint(p); if (h == IntPtr.Zero) return "(none)"; IntPtr root = GetAncestor(h, 2); return ProcName(root == IntPtr.Zero ? h : root); }
  // Windows only lets the process that last received input steal the foreground, so try three
  // techniques in turn: attach to the foreground thread, SwitchToThisWindow, then an ALT tap.
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindowAsync(h, 9); System.Threading.Thread.Sleep(400); }
    for (int i = 0; i < 6; i++) {
      IntPtr fg = GetForegroundWindow();
      if (fg == h) return true;
      uint pid; uint fgt = GetWindowThreadProcessId(fg, out pid); uint me = GetCurrentThreadId();
      if (i % 3 == 0) { bool att = fgt != me && AttachThreadInput(me, fgt, true); SetForegroundWindow(h); BringWindowToTop(h); if (att) AttachThreadInput(me, fgt, false); }
      else if (i % 3 == 1) { SwitchToThisWindow(h, true); }
      else { Key(0x12); SetForegroundWindow(h); }
      System.Threading.Thread.Sleep(400);
    }
    return GetForegroundWindow() == h;
  }
}
"@

function Assert-Ootp {
  $name = [OI]::ProcName([OI]::GetForegroundWindow())
  if ($name -ne 'ootp27') { throw "foreground window belongs to '$name', not ootp27 - refusing to send input" }
}
function Assert-Under($x, $y) {
  $o = [OI]::OwnerAt([int]$x, [int]$y)
  if ($o -ne 'ootp27') { throw "window under ($x,$y) belongs to '$o', not ootp27 - refusing to click there" }
}

$vk = @{ escape = 0x1B; return = 0x0D; tab = 0x09; backspace = 0x08; delete = 0x2E; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22; space = 0x20 }
1..12 | ForEach-Object { $vk["f$_"] = 0x6F + $_ }

foreach ($step in $Actions.Split(';')) {
  $step = $step.Trim(); if (-not $step) { continue }
  $name, $arg = $step.Split(':', 2)
  switch ($name.ToLower()) {
    'wait'     { Start-Sleep -Milliseconds ([int]$arg); continue }
    'focus'    {
      $h = (Get-Process ootp27 | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
      if (-not [OI]::Focus($h)) { Assert-Ootp; throw "could not bring ootp27 to the foreground" }
    }
    'probe'    { $x, $y = $arg.Split(','); Write-Output ("under ({0},{1}): {2}" -f $x, $y, [OI]::OwnerAt([int]$x, [int]$y)); continue }
    'click'    { Assert-Ootp; $x, $y = $arg.Split(','); Assert-Under $x $y; [OI]::Click([int]$x, [int]$y, 0x0002, 0x0004) }
    'dblclick' { Assert-Ootp; $x, $y = $arg.Split(','); Assert-Under $x $y; [OI]::Click([int]$x, [int]$y, 0x0002, 0x0004); Start-Sleep -Milliseconds 90; [OI]::Click([int]$x, [int]$y, 0x0002, 0x0004) }
    'rclick'   { Assert-Ootp; $x, $y = $arg.Split(','); Assert-Under $x $y; [OI]::Click([int]$x, [int]$y, 0x0008, 0x0010) }
    'move'     { Assert-Ootp; $x, $y = $arg.Split(','); [OI]::Move([int]$x, [int]$y) }
    'scroll'   { Assert-Ootp; $x, $y, $n = $arg.Split(','); Assert-Under $x $y; [OI]::Wheel([int]$x, [int]$y, [int]$n) }
    'type'     { Assert-Ootp; [OI]::Text($arg) }
    'key'      {
      Assert-Ootp
      $k = $arg.ToLower()
      if ($k -like 'ctrl+*') { $letter = $k.Substring(5).ToUpper(); [OI]::Chord(0x11, [uint16][char]$letter) }
      elseif ($vk.ContainsKey($k)) { [OI]::Key([uint16]$vk[$k]) }
      else { throw "unknown key '$arg'" }
    }
    default    { throw "unknown action '$name'" }
  }
  Start-Sleep -Milliseconds 150
}
Write-Output ("ok: {0} (foreground now: {1})" -f $Actions, [OI]::ProcName([OI]::GetForegroundWindow()))
