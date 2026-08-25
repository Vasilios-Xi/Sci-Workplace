import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const JOB_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace OpenLabNative {
  public static class JobHost {
    private const uint JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
      var output = new StringBuilder("\"");
      var slashes = 0;
      foreach (var character in value) {
        if (character == '\\') { slashes++; continue; }
        if (character == '"') {
          output.Append('\\', slashes * 2 + 1).Append('"');
          slashes = 0;
          continue;
        }
        output.Append('\\', slashes).Append(character);
        slashes = 0;
      }
      output.Append('\\', slashes * 2).Append('"');
      return output.ToString();
    }

    private static string BuildArguments(string[] arguments) {
      var output = new StringBuilder();
      for (var index = 0; index < arguments.Length; index++) {
        if (index > 0) output.Append(' ');
        output.Append(Quote(arguments[index]));
      }
      return output.ToString();
    }

    public static int Guard(int targetPid, int ownerPid, long memoryMb, long cpuMs, uint activeProcesses) {
      var job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
      Process target = null;
      Process owner = null;
      try {
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_TIME | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        information.BasicLimitInformation.PerJobUserTimeLimit = checked(cpuMs * 10000L);
        information.BasicLimitInformation.ActiveProcessLimit = activeProcesses;
        information.JobMemoryLimit = (UIntPtr)checked((ulong)memoryMb * 1024UL * 1024UL);
        if (!SetInformationJobObject(job, 9, ref information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
        target = Process.GetProcessById(targetPid);
        owner = Process.GetProcessById(ownerPid);
        if (!AssignProcessToJobObject(job, target.Handle)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
        }
        Console.Out.WriteLine("OPENLAB_JOB_READY");
        Console.Out.Flush();
        while (true) {
          try { if (target.HasExited || owner.HasExited) break; }
          catch (InvalidOperationException) { break; }
          Thread.Sleep(200);
        }
        return 0;
      } finally {
        if (target != null) target.Dispose();
        if (owner != null) owner.Dispose();
        CloseHandle(job);
      }
    }

    public static int Run(string executable, string[] arguments, string workingDirectory, long memoryMb, long cpuMs, uint activeProcesses) {
      var job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
      try {
        var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_TIME | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        information.BasicLimitInformation.PerJobUserTimeLimit = checked(cpuMs * 10000L);
        information.BasicLimitInformation.ActiveProcessLimit = activeProcesses;
        information.JobMemoryLimit = (UIntPtr)checked((ulong)memoryMb * 1024UL * 1024UL);
        if (!SetInformationJobObject(job, 9, ref information, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }

        var start = new ProcessStartInfo {
          FileName = executable,
          Arguments = BuildArguments(arguments),
          WorkingDirectory = workingDirectory,
          UseShellExecute = false,
          CreateNoWindow = true,
          RedirectStandardInput = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
        };
        start.EnvironmentVariables.Remove("OPENLAB_JOB_EXE_B64");
        start.EnvironmentVariables.Remove("OPENLAB_JOB_ARGS_B64");
        start.EnvironmentVariables.Remove("OPENLAB_JOB_CWD_B64");
        start.EnvironmentVariables.Remove("OPENLAB_JOB_MEMORY_MB");
        start.EnvironmentVariables.Remove("OPENLAB_JOB_CPU_MS");
        start.EnvironmentVariables.Remove("OPENLAB_JOB_ACTIVE_PROCESSES");

        using (var process = Process.Start(start)) {
          if (process == null) throw new InvalidOperationException("Target process did not start");
          if (!AssignProcessToJobObject(job, process.Handle)) {
            try { process.Kill(); } catch { }
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
          }
          var output = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
          var error = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
          var input = Console.OpenStandardInput().CopyToAsync(process.StandardInput.BaseStream).ContinueWith(_ => {
            try { process.StandardInput.Close(); } catch { }
          });
          process.WaitForExit();
          try { process.StandardInput.Close(); } catch { }
          Task.WaitAll(new[] { output, error }, 5000);
          return process.ExitCode;
        }
      } finally {
        CloseHandle(job);
      }
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  if ($env:OPENLAB_JOB_TARGET_PID) {
    $guardExit = [OpenLabNative.JobHost]::Guard([int] $env:OPENLAB_JOB_TARGET_PID, [int] $env:OPENLAB_JOB_OWNER_PID, [long] $env:OPENLAB_JOB_MEMORY_MB, [long] $env:OPENLAB_JOB_CPU_MS, [uint32] $env:OPENLAB_JOB_ACTIVE_PROCESSES)
    exit $guardExit
  }
  function Decode-OpenLab([string] $value) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }
  $executable = Decode-OpenLab $env:OPENLAB_JOB_EXE_B64
  $workingDirectory = Decode-OpenLab $env:OPENLAB_JOB_CWD_B64
  $argumentJson = Decode-OpenLab $env:OPENLAB_JOB_ARGS_B64
  [string[]] $targetArguments = @((ConvertFrom-Json -InputObject $argumentJson) | ForEach-Object { [string] $_ })
  $exitCode = [OpenLabNative.JobHost]::Run($executable, $targetArguments, $workingDirectory, [long] $env:OPENLAB_JOB_MEMORY_MB, [long] $env:OPENLAB_JOB_CPU_MS, [uint32] $env:OPENLAB_JOB_ACTIVE_PROCESSES)
  exit $exitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;

const ENCODED_JOB_HOST = Buffer.from(JOB_HOST_SCRIPT, 'utf16le').toString('base64');

function utf8Base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export interface WindowsJobLimits {
  memoryMb: number;
  cpuMs: number;
  activeProcesses: number;
}

export interface WindowsJobAttachment {
  ready: Promise<void>;
  stop(): void;
}

export function attachWindowsJobObject(targetPid: number, limits: WindowsJobLimits): WindowsJobAttachment {
  if (process.platform !== 'win32') return { ready: Promise.resolve(), stop: () => undefined };
  const guardian = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_JOB_HOST], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      OPENLAB_JOB_TARGET_PID: String(targetPid),
      OPENLAB_JOB_OWNER_PID: String(process.pid),
      OPENLAB_JOB_MEMORY_MB: String(Math.max(128, Math.trunc(limits.memoryMb))),
      OPENLAB_JOB_CPU_MS: String(Math.max(1_000, Math.trunc(limits.cpuMs))),
      OPENLAB_JOB_ACTIVE_PROCESSES: String(Math.max(1, Math.trunc(limits.activeProcesses))),
    },
  });
  let errorOutput = '';
  let settled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, reject) => { resolveReady = resolvePromise; rejectReady = reject; });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    guardian.kill();
    rejectReady(new Error('Windows Job Object 宿主启动超时'));
  }, 10_000);
  guardian.stdout.on('data', (chunk: Buffer) => {
    if (settled || !chunk.toString('utf8').includes('OPENLAB_JOB_READY')) return;
    settled = true;
    clearTimeout(timer);
    resolveReady();
  });
  guardian.stderr.on('data', (chunk: Buffer) => { errorOutput = `${errorOutput}${chunk.toString('utf8')}`.slice(-8_000); });
  guardian.once('exit', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectReady(new Error(`Windows Job Object 宿主退出（${code ?? '未知'}）：${errorOutput.trim() || '无诊断输出'}`));
  });
  guardian.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectReady(error);
  });
  return { ready, stop: () => guardian.kill() };
}

export function spawnWithResourceLimits(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; limits: WindowsJobLimits },
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') {
    return spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_JOB_HOST], {
    cwd: options.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...options.env,
      OPENLAB_JOB_EXE_B64: utf8Base64(executable),
      OPENLAB_JOB_ARGS_B64: utf8Base64(JSON.stringify(args)),
      OPENLAB_JOB_CWD_B64: utf8Base64(options.cwd),
      OPENLAB_JOB_MEMORY_MB: String(Math.max(128, Math.trunc(options.limits.memoryMb))),
      OPENLAB_JOB_CPU_MS: String(Math.max(1_000, Math.trunc(options.limits.cpuMs))),
      OPENLAB_JOB_ACTIVE_PROCESSES: String(Math.max(1, Math.trunc(options.limits.activeProcesses))),
    },
  });
}
