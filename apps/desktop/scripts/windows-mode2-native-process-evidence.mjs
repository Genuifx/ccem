const NATIVE_EVIDENCE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

public static class CcemMode2NativeEvidence {
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint TOKEN_QUERY = 0x0008;
  const int ERROR_INSUFFICIENT_BUFFER = 122;
  const int TokenGroups = 2;
  const int TokenRestrictedSids = 11;
  const int TokenIntegrityLevel = 25;
  const int TokenIsAppContainer = 29;
  const int TokenCapabilities = 30;
  const int TokenAppContainerSid = 31;
  const int TokenIsLessPrivilegedAppContainer = 46;

  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  struct POINT { public int X, Y; }

  [StructLayout(LayoutKind.Sequential)]
  struct FILETIME { public uint Low, High; }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint GetProcessId(IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(
    IntPtr process,
    out FILETIME creation,
    out FILETIME exit,
    out FILETIME kernel,
    out FILETIME user
  );

  [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageName(
    IntPtr process,
    uint flags,
    StringBuilder path,
    ref uint size
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(
    IntPtr token,
    int informationClass,
    IntPtr information,
    uint informationLength,
    out uint returnLength
  );

  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool IsTokenRestricted(IntPtr token);

  [DllImport("advapi32.dll", EntryPoint = "ConvertSidToStringSidW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr stringSid);

  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessMitigationPolicy(
    IntPtr process,
    int policy,
    IntPtr buffer,
    UIntPtr length
  );

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool IsWindow(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool IsWindowVisible(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr GetParent(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetWindowRect(IntPtr window, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetClientRect(IntPtr window, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool ScreenToClient(IntPtr window, ref POINT point);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetDpiForWindow(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);

  [DllImport("user32.dll", SetLastError = true)]
  static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

  public sealed class TokenFacts {
    public bool isAppContainer { get; set; }
    public bool isLessPrivilegedAppContainer { get; set; }
    public string appContainerSid { get; set; }
    public string integritySid { get; set; }
    public int integrityRid { get; set; }
    public bool isRestricted { get; set; }
    public int restrictedSidCount { get; set; }
    public string[] restrictedSids { get; set; }
    public int capabilitySidCount { get; set; }
    public string[] capabilitySids { get; set; }
    public int groupSidCount { get; set; }
    public string[] groupSids { get; set; }
  }

  public sealed class ProcessIdentityFacts {
    public uint nativePid { get; set; }
    public string nativeImagePath { get; set; }
    public string creationTime100ns { get; set; }
  }

  public sealed class MitigationFacts {
    public bool depEnabled { get; set; }
    public bool bottomUpAslr { get; set; }
    public bool highEntropyAslr { get; set; }
    public bool dynamicCodeProhibited { get; set; }
    public bool strictHandleChecks { get; set; }
    public bool win32kSystemCallsDisabled { get; set; }
    public bool extensionPointsDisabled { get; set; }
    public bool controlFlowGuardEnabled { get; set; }
  }

  public sealed class WindowFacts {
    public string hwnd { get; set; }
    public string parentHwnd { get; set; }
    public uint ownerPid { get; set; }
    public int x { get; set; }
    public int y { get; set; }
    public int width { get; set; }
    public int height { get; set; }
    public int parentClientWidth { get; set; }
    public int parentClientHeight { get; set; }
    public bool visible { get; set; }
    public uint dpi { get; set; }
  }

  static Exception NativeFailure(string operation) {
    return new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }

  static IntPtr RequireProcess(int processId, uint access, string operation) {
    IntPtr process = OpenProcess(access, false, (uint)processId);
    if (process == IntPtr.Zero) throw NativeFailure(operation);
    return process;
  }

  static IntPtr RequireLimitedProcess(int processId) {
    return RequireProcess(
      processId,
      PROCESS_QUERY_LIMITED_INFORMATION,
      "OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)"
    );
  }

  static IntPtr RequireMitigationProcess(int processId) {
    // GetProcessMitigationPolicy requires PROCESS_QUERY_INFORMATION. Do not
    // reuse the weaker identity/token handle or downgrade AccessDenied into a
    // partial sandbox claim: every observed CEF process must yield real policy.
    return RequireProcess(
      processId,
      PROCESS_QUERY_INFORMATION,
      "OpenProcess(PROCESS_QUERY_INFORMATION for mitigation policy)"
    );
  }

  static IntPtr RequireToken(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, TOKEN_QUERY, out token)) throw NativeFailure("OpenProcessToken");
    return token;
  }

  static IntPtr ReadTokenBuffer(IntPtr token, int informationClass, out uint length) {
    length = 0;
    GetTokenInformation(token, informationClass, IntPtr.Zero, 0, out length);
    if (length == 0 || Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER) {
      throw NativeFailure("GetTokenInformation(size)");
    }
    IntPtr buffer = Marshal.AllocHGlobal((int)length);
    if (!GetTokenInformation(token, informationClass, buffer, length, out length)) {
      Marshal.FreeHGlobal(buffer);
      throw NativeFailure("GetTokenInformation(data)");
    }
    return buffer;
  }

  static int ReadTokenInt32(IntPtr token, int informationClass) {
    uint length;
    IntPtr buffer = ReadTokenBuffer(token, informationClass, out length);
    try { return Marshal.ReadInt32(buffer); }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  static string SidString(IntPtr sid) {
    if (sid == IntPtr.Zero) return null;
    IntPtr value;
    if (!ConvertSidToStringSid(sid, out value)) throw NativeFailure("ConvertSidToStringSid");
    try { return Marshal.PtrToStringUni(value); }
    finally { LocalFree(value); }
  }

  static string ReadTokenSid(IntPtr token, int informationClass) {
    uint length;
    IntPtr buffer = ReadTokenBuffer(token, informationClass, out length);
    try { return SidString(Marshal.ReadIntPtr(buffer)); }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  static string[] ReadTokenSidList(IntPtr token, int informationClass) {
    uint length;
    IntPtr buffer = ReadTokenBuffer(token, informationClass, out length);
    try {
      int count = Marshal.ReadInt32(buffer);
      int first = IntPtr.Size == 8 ? 8 : 4;
      int entrySize = IntPtr.Size == 8 ? 16 : 8;
      List<string> result = new List<string>();
      for (int index = 0; index < count; index++) {
        IntPtr sid = Marshal.ReadIntPtr(buffer, first + (index * entrySize));
        string value = SidString(sid);
        if (!String.IsNullOrWhiteSpace(value)) result.Add(value);
      }
      return result.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  static uint ReadMitigationFlags(IntPtr process, int policy, int size) {
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      for (int offset = 0; offset < size; offset++) Marshal.WriteByte(buffer, offset, 0);
      if (!GetProcessMitigationPolicy(process, policy, buffer, (UIntPtr)(uint)size)) {
        throw NativeFailure("GetProcessMitigationPolicy");
      }
      return unchecked((uint)Marshal.ReadInt32(buffer));
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }

  public static TokenFacts ReadToken(int processId) {
    IntPtr process = RequireLimitedProcess(processId);
    try {
      IntPtr token = RequireToken(process);
      try {
        string integritySid = ReadTokenSid(token, TokenIntegrityLevel);
        int integrityRid;
        if (!Int32.TryParse(integritySid.Split('-').Last(), out integrityRid)) {
          throw new InvalidOperationException("integrity SID has no RID");
        }
        string[] restricted = ReadTokenSidList(token, TokenRestrictedSids);
        string[] capabilities = ReadTokenSidList(token, TokenCapabilities);
        string[] groups = ReadTokenSidList(token, TokenGroups);
        bool appContainer = ReadTokenInt32(token, TokenIsAppContainer) != 0;
        return new TokenFacts {
          isAppContainer = appContainer,
          isLessPrivilegedAppContainer =
            ReadTokenInt32(token, TokenIsLessPrivilegedAppContainer) != 0,
          appContainerSid = appContainer ? ReadTokenSid(token, TokenAppContainerSid) : null,
          integritySid = integritySid,
          integrityRid = integrityRid,
          isRestricted = IsTokenRestricted(token),
          restrictedSidCount = restricted.Length,
          restrictedSids = restricted,
          capabilitySidCount = capabilities.Length,
          capabilitySids = capabilities,
          groupSidCount = groups.Length,
          groupSids = groups
        };
      }
      finally { CloseHandle(token); }
    }
    finally { CloseHandle(process); }
  }

  public static ProcessIdentityFacts ReadProcessIdentity(int processId) {
    IntPtr process = RequireLimitedProcess(processId);
    try {
      uint nativePid = GetProcessId(process);
      if (nativePid == 0) throw NativeFailure("GetProcessId");
      FILETIME creation;
      FILETIME exit;
      FILETIME kernel;
      FILETIME user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) {
        throw NativeFailure("GetProcessTimes");
      }
      uint size = 32768;
      StringBuilder imagePath = new StringBuilder((int)size);
      if (!QueryFullProcessImageName(process, 0, imagePath, ref size)) {
        throw NativeFailure("QueryFullProcessImageName");
      }
      ulong creationTime = ((ulong)creation.High << 32) | creation.Low;
      return new ProcessIdentityFacts {
        nativePid = nativePid,
        nativeImagePath = imagePath.ToString(),
        creationTime100ns = creationTime.ToString(CultureInfo.InvariantCulture)
      };
    }
    finally { CloseHandle(process); }
  }

  public static bool ReadInJob(int processId) {
    IntPtr process = RequireLimitedProcess(processId);
    try {
      bool result;
      if (!IsProcessInJob(process, IntPtr.Zero, out result)) throw NativeFailure("IsProcessInJob");
      return result;
    }
    finally { CloseHandle(process); }
  }

  public static MitigationFacts ReadMitigations(int processId) {
    IntPtr process = RequireMitigationProcess(processId);
    try {
      uint dep = ReadMitigationFlags(process, 0, 8);
      uint aslr = ReadMitigationFlags(process, 1, 4);
      uint dynamicCode = ReadMitigationFlags(process, 2, 4);
      uint strictHandle = ReadMitigationFlags(process, 3, 4);
      uint win32k = ReadMitigationFlags(process, 4, 4);
      uint extensionPoints = ReadMitigationFlags(process, 6, 4);
      uint controlFlowGuard = ReadMitigationFlags(process, 7, 4);
      return new MitigationFacts {
        depEnabled = (dep & 1) != 0,
        bottomUpAslr = (aslr & 1) != 0,
        highEntropyAslr = (aslr & 4) != 0,
        dynamicCodeProhibited = (dynamicCode & 1) != 0,
        strictHandleChecks = (strictHandle & 1) != 0,
        win32kSystemCallsDisabled = (win32k & 1) != 0,
        extensionPointsDisabled = (extensionPoints & 1) != 0,
        controlFlowGuardEnabled = (controlFlowGuard & 1) != 0
      };
    }
    finally { CloseHandle(process); }
  }

  static IntPtr ParseWindow(string value) {
    if (String.IsNullOrWhiteSpace(value) || !value.StartsWith("0x", StringComparison.Ordinal)) {
      throw new ArgumentException("invalid opaque HWND");
    }
    ulong bits = Convert.ToUInt64(value.Substring(2), 16);
    return new IntPtr(unchecked((long)bits));
  }

  static string WindowString(IntPtr value) {
    return "0x" + unchecked((ulong)value.ToInt64()).ToString("x");
  }

  public static WindowFacts ReadWindow(string opaqueWindow) {
    IntPtr window = ParseWindow(opaqueWindow);
    if (!IsWindow(window)) throw NativeFailure("IsWindow");
    IntPtr parent = GetParent(window);
    if (parent == IntPtr.Zero || !IsWindow(parent)) throw NativeFailure("GetParent");
    IntPtr targetDpiContext = GetWindowDpiAwarenessContext(window);
    if (targetDpiContext == IntPtr.Zero) throw NativeFailure("GetWindowDpiAwarenessContext");
    IntPtr previousDpiContext = SetThreadDpiAwarenessContext(targetDpiContext);
    if (previousDpiContext == IntPtr.Zero) throw NativeFailure("SetThreadDpiAwarenessContext(target)");
    try {
      RECT windowRect;
      RECT parentClient;
      if (!GetWindowRect(window, out windowRect)) throw NativeFailure("GetWindowRect");
      if (!GetClientRect(parent, out parentClient)) throw NativeFailure("GetClientRect");
      POINT topLeft = new POINT { X = windowRect.Left, Y = windowRect.Top };
      POINT bottomRight = new POINT { X = windowRect.Right, Y = windowRect.Bottom };
      if (!ScreenToClient(parent, ref topLeft) || !ScreenToClient(parent, ref bottomRight)) {
        throw NativeFailure("ScreenToClient");
      }
      uint ownerPid;
      if (GetWindowThreadProcessId(window, out ownerPid) == 0) {
        throw NativeFailure("GetWindowThreadProcessId");
      }
      uint dpi = GetDpiForWindow(window);
      if (dpi == 0) throw NativeFailure("GetDpiForWindow");
      return new WindowFacts {
        hwnd = WindowString(window),
        parentHwnd = WindowString(parent),
        ownerPid = ownerPid,
        x = topLeft.X,
        y = topLeft.Y,
        width = bottomRight.X - topLeft.X,
        height = bottomRight.Y - topLeft.Y,
        parentClientWidth = parentClient.Right - parentClient.Left,
        parentClientHeight = parentClient.Bottom - parentClient.Top,
        visible = IsWindowVisible(window),
        dpi = dpi
      };
    }
    finally {
      if (SetThreadDpiAwarenessContext(previousDpiContext) == IntPtr.Zero) {
        throw NativeFailure("SetThreadDpiAwarenessContext(restore)");
      }
    }
  }
}
`;

export function windowsNativeEvidenceBootstrapPowerShell() {
  const source = Buffer.from(NATIVE_EVIDENCE_SOURCE, 'utf8').toString('base64');
  return [
    `$nativeSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))`,
    'Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop',
  ];
}
