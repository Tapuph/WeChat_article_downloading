using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WxArticleScan {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, int len);

  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
    public IntPtr RegionSize; public uint State; public uint Protect; public uint Type;
  }
  const int PROCESS_VM_READ = 0x0010, PROCESS_QUERY_INFORMATION = 0x0400;
  const uint MEM_COMMIT = 0x1000, PAGE_NOACCESS = 0x01, PAGE_GUARD = 0x100;

  class Cand {
    public string Url;
    public int Score;
  }

  /// 扫描内存中所有 mp.weixin.qq.com/s 文章链接。
  ///
  /// 关键点：不做"参数裁剪"。微信文章页需要完整的签名参数
  /// （__biz + mid + idx + sn，或客户端 URL 上的 key/uin 签名），
  /// 裁掉参数会直接导致页面返回"参数错误"。所以这里保留原始完整 URL，
  /// 只在同一篇文章的多个候选之间挑选"最完整可用"的那个。
  ///
  /// 输出每行: biz \t url
  public static List<string> Scan(int pid, int maxUrls) {
    var outLines = new List<string>();
    var best = new Dictionary<string, Cand>();
    IntPtr h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
    if (h == IntPtr.Zero) { outLines.Add("OPEN_FAILED"); return outLines; }
    byte[] needle = Encoding.ASCII.GetBytes("mp.weixin.qq.com/s");
    byte[] buf = new byte[16 * 1024 * 1024];
    long scannedMb = 0;
    try {
      IntPtr addr = IntPtr.Zero;
      MEMORY_BASIC_INFORMATION mbi;
      int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
      while (VirtualQueryEx(h, addr, out mbi, mbiSize) != 0) {
        long regionSize = (long)mbi.RegionSize;
        bool readable = mbi.State == MEM_COMMIT && (mbi.Protect & PAGE_NOACCESS) == 0 && (mbi.Protect & PAGE_GUARD) == 0;
        if (readable && regionSize > 0 && regionSize < 2L * 1024 * 1024 * 1024) {
          long done = 0;
          while (done < regionSize) {
            int want = (int)Math.Min(buf.Length, regionSize - done);
            IntPtr read;
            IntPtr at = (IntPtr)((long)mbi.BaseAddress + done);
            if (ReadProcessMemory(h, at, buf, want, out read) && (long)read > 64) {
              int n = (int)read;
              scannedMb += n / 1048576;
              for (int i = 0; i + needle.Length + 2 < n; i++) {
                if (buf[i] != (byte)'m' || buf[i + 1] != (byte)'p') continue;
                bool match = true;
                for (int k = 0; k < needle.Length; k++) { if (buf[i + k] != needle[k]) { match = false; break; } }
                if (!match) continue;

                int start = i;
                for (int b = i - 1; b >= 0 && b > i - 9; b--) {
                  if (buf[b] == (byte)'h' && b + 7 < n && buf[b+1]==(byte)'t' && buf[b+2]==(byte)'t' && buf[b+3]==(byte)'p') { start = b; break; }
                }
                int end = i;
                while (end < n && end - start < 1500) {
                  byte c = buf[end];
                  if (c <= 0x20 || c == (byte)'"' || c == (byte)'\'' || c == (byte)'>' || c == (byte)'<' || c == (byte)'\\' || c == (byte)','|| c == (byte)')') break;
                  end++;
                }
                if (end - start < 35) continue;
                string u = Encoding.ASCII.GetString(buf, start, end - start);
                if (u.IndexOf("mp.weixin.qq.com/s", StringComparison.Ordinal) < 0) continue;
                if (u.Contains("index.html") || u.Contains("searchwordbaike")) continue;

                string key = IdentityKey(u);
                if (key == null) continue;
                int score = Score(u);
                if (score < 0) continue;

                Cand cur;
                if (!best.TryGetValue(key, out cur) || score > cur.Score) {
                  var c = new Cand(); c.Url = u; c.Score = score;
                  best[key] = c;
                }
                if (best.Count >= maxUrls * 3) break;
              }
            }
            done += want;
          }
        }
        long next = (long)mbi.BaseAddress + regionSize;
        if (next <= (long)addr) next = (long)addr + 0x1000;
        addr = (IntPtr)next;
        if ((long)addr < 0 || (long)addr > 0x7FFFFFFFFFFF) break;
      }
    } finally { CloseHandle(h); }

    // 过滤：只保留真正可用的候选
    foreach (var kv in best) {
      if (kv.Value.Score <= 0) continue;
      string biz = ExtractParam(kv.Value.Url, "__biz");
      outLines.Add(biz + "\t" + kv.Value.Url);
      if (outLines.Count >= maxUrls) break;
    }
    outLines.Add("SCANNED_MB=" + scannedMb);
    return outLines;
  }

  /// 文章唯一标识：优先 (__biz,mid,idx)，其次短链 token。
  static string IdentityKey(string u) {
    string biz = ExtractParam(u, "__biz");
    string mid = ExtractParam(u, "mid");
    string idx = ExtractParam(u, "idx");
    if (!string.IsNullOrEmpty(biz) && !string.IsNullOrEmpty(mid))
      return biz + "|" + mid + "|" + (string.IsNullOrEmpty(idx) ? "1" : idx);
    int p = u.IndexOf("/s/", StringComparison.Ordinal);
    if (p >= 0) {
      string tail = u.Substring(p + 3);
      var sb = new StringBuilder();
      foreach (char c in tail) { if (char.IsLetterOrDigit(c) || c == '-' || c == '_') sb.Append(c); else break; }
      if (sb.Length >= 16) return "short|" + sb.ToString();
    }
    return null;
  }

  /// 可用性打分：越完整越可信。
  ///  5 = 客户端签名 URL（带 key=，微信客户端实际在用，必然可用）
  ///  4 = 带 chksm / sn 的完整网页 URL
  ///  3 = __biz+mid+idx+sn
  ///  2 = __biz+mid+idx
  /// <=0 = 参数残缺（含非法字符或字段不全），丢弃
  static int Score(string u) {
    if (u.IndexOf('@') >= 0 || u.IndexOf('?', u.IndexOf('?') + 1) >= 0) return -100;
    string biz = ExtractParam(u, "__biz");
    bool hasMid = ExtractParam(u, "mid").Length > 0;
    bool hasIdx = ExtractParam(u, "idx").Length > 0;
    bool hasSn = ExtractParam(u, "sn").Length >= 32;
    bool hasChksm = ExtractParam(u, "chksm").Length > 0;
    bool hasKey = ExtractParam(u, "key").Length >= 32;

    if (hasKey) return 5;
    if (hasChksm) return 4;
    if (hasSn) return 3;
    if (biz.Length >= 12 && hasMid && hasIdx) return 2;
    if (u.IndexOf("/s/", StringComparison.Ordinal) >= 0) {
      string t = u.Substring(u.IndexOf("/s/", StringComparison.Ordinal) + 3);
      var sb = new StringBuilder();
      foreach (char c in t) { if (char.IsLetterOrDigit(c) || c == '-' || c == '_') sb.Append(c); else break; }
      if (sb.Length >= 16) return 3; // 短链本身就是完整凭证
    }
    return -1;
  }

  static string ExtractParam(string u, string name) {
    string pat = name + "=";
    int p = u.IndexOf(pat, StringComparison.Ordinal);
    if (p < 0) return "";
    int s = p + pat.Length;
    int e = s;
    while (e < u.Length && u[e] != '&' && u[e] != '#' && u[e] != ' ') e++;
    return u.Substring(s, e - s);
  }
}
