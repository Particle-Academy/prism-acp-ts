/**
 * The Windows process-tree supervisor, as C# source. It is compiled once per process with the csc.exe that ships with
 * .NET Framework 4.8 (part of every supported Windows 10 and 11), so this package carries no binary and no dependency.
 * See process-tree.ts for the protocol and why it exists.
 */
export const SUPERVISOR_CS = String.raw`// prism-acp process-tree supervisor (Windows). Runs ONE provider inside a Job Object and ends the whole tree with it.
//
// Protocol, one ASCII line each way over the named pipe in PRISM_ACP_TREE_CHANNEL:
//   -> hello <token>                       (the token from PRISM_ACP_TREE_TOKEN)
//   <- spawn <base64 application> <base64 command line> <base64 cwd>
//   -> started <pid>        | failed <win32 error>
//   <- kill                 (or the pipe closes: the client is gone)
//   -> exited <code>        (the provider ended on its own)
//   -> empty <active>       (the job was terminated; active = processes left, 0 when the tree is gone)
//
// The job has KILL_ON_JOB_CLOSE and no breakaway, and only this process holds its handle, so whatever ends this
// process -- a kill, a crash, the client's death taking it down -- ends every process in the tree.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class Supervisor
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
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
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicAccounting
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint CREATE_SUSPENDED = 0x4;
    const int STARTF_USESTDHANDLES = 0x100;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out BasicAccounting info, int length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static StreamWriter control;
    static readonly object writeLock = new object();

    static void Say(string line)
    {
        lock (writeLock)
        {
            try { control.Write(line + "\n"); control.Flush(); } catch { }
        }
    }

    static string Unbase64(string s)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(s));
    }

    static uint Active(IntPtr job)
    {
        BasicAccounting info;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero)) return uint.MaxValue;
        return info.ActiveProcesses;
    }

    /** Terminate every process in the job, then wait (up to 5 s) for the job to report none left. */
    static uint EndTree(IntPtr job)
    {
        TerminateJobObject(job, 1);
        uint active = Active(job);
        for (int i = 0; i < 250 && active != 0; i++) { Thread.Sleep(20); active = Active(job); }
        return active;
    }

    static int Main()
    {
        string channel = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL");
        string token = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_TOKEN");
        // Never inherited by the provider.
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL", null);
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_TOKEN", null);
        if (string.IsNullOrEmpty(channel) || string.IsNullOrEmpty(token)) return 125;
        const string prefix = @"\\.\pipe\";
        if (!channel.StartsWith(prefix)) return 125;

        // Overlapped: a synchronous pipe handle serialises I/O, so a write would wait behind the listener's pending read.
        var pipe = new NamedPipeClientStream(".", channel.Substring(prefix.Length), PipeDirection.InOut, PipeOptions.Asynchronous);
        try { pipe.Connect(10000); } catch { return 125; }
        var reader = new StreamReader(pipe, new UTF8Encoding(false));
        control = new StreamWriter(pipe, new UTF8Encoding(false));
        Say("hello " + token);

        string spec = reader.ReadLine();
        if (spec == null) return 125;
        string[] parts = spec.Split(' ');
        if (parts.Length != 4 || parts[0] != "spawn") return 125;
        string application, commandLine, cwd;
        try { application = Unbase64(parts[1]); commandLine = Unbase64(parts[2]); cwd = Unbase64(parts[3]); }
        catch { return 125; }

        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) { Say("failed " + Marshal.GetLastWin32Error()); return 126; }
        var limit = new ExtendedLimit();
        limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))))
        {
            Say("failed " + Marshal.GetLastWin32Error());
            return 126;
        }

        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        ProcessInformation info;
        // SUSPENDED, so it is in the job before it can run a single instruction or start a child.
        if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
                IntPtr.Zero, cwd, ref startup, out info))
        {
            Say("failed " + Marshal.GetLastWin32Error());
            return 127;
        }
        if (!AssignProcessToJobObject(job, info.hProcess))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.hProcess, 1);
            Say("failed " + error);
            return 126;
        }
        ResumeThread(info.hThread);
        CloseHandle(info.hThread);
        Say("started " + info.dwProcessId);

        var killed = new ManualResetEvent(false);
        var listener = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line == "kill") break;
                }
            }
            catch { }
            // A kill, or the client is gone: either way the tree ends.
            killed.Set();
        });
        listener.IsBackground = true;
        listener.Start();

        var exited = new ManualResetEvent(false);
        exited.SafeWaitHandle = new SafeWaitHandle(info.hProcess, false);
        int which = WaitHandle.WaitAny(new WaitHandle[] { exited, killed });

        uint code = 1;
        if (which == 0)
        {
            GetExitCodeProcess(info.hProcess, out code);
            Say("exited " + code);
        }
        Say("empty " + EndTree(job));
        return which == 0 ? (int)code : 1;
    }
}
`;
