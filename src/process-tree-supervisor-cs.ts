/**
 * The Windows process-tree supervisor, as C# source. It is compiled once per install with the csc.exe that ships with
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
//
// A host explicitly selects the additional TCP/real-pipe mode with a tcp://127.0.0.1:<port> channel. The named-pipe
// mode below is unchanged. TCP adds bounded authentication in both directions and three independent byte streams;
// see docs/windows-supervisor-protocol.md for its limits, ACKs and EOF/drain rules. No TS host opts in by default.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
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

    const int TcpDeadlineMs = 5000;
    const int MaxControlLine = 262144;
    const int MaxAuthLine = 128;

    /** ASCII framing with bounded allocation, an absolute handshake/partial-line deadline, and no content in errors. */
    sealed class TcpLines
    {
        readonly NetworkStream stream;
        readonly byte[] buffer;
        int offset, count;

        // Stdio authentication reads exactly through LF, never consuming the first raw stdin bytes with its ACK.
        public TcpLines(NetworkStream stream, bool readAhead) { this.stream = stream; buffer = new byte[readAhead ? 4096 : 1]; }

        public string ReadLine(int limit, bool allowIdle)
        {
            var line = new StringBuilder();
            long deadline = allowIdle ? 0 : Stopwatch.GetTimestamp() + Stopwatch.Frequency * TcpDeadlineMs / 1000;
            for (;;)
            {
                if (deadline != 0 && Stopwatch.GetTimestamp() >= deadline) throw new TimeoutException();
                if (offset == count)
                {
                    if (deadline == 0) stream.ReadTimeout = Timeout.Infinite;
                    else
                    {
                        long remaining = (deadline - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
                        if (remaining <= 0) throw new TimeoutException();
                        stream.ReadTimeout = (int)remaining;
                    }
                    count = stream.Read(buffer, 0, buffer.Length); offset = 0;
                    if (count == 0)
                    {
                        if (line.Length != 0) throw new FormatException();
                        return null;
                    }
                }
                // A previous line read may already have buffered this command's first byte.
                if (deadline == 0) deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * TcpDeadlineMs / 1000;
                byte value = buffer[offset++];
                if (value == 10)
                {
                    if (line.Length != 0 && line[line.Length - 1] == '\r') line.Length--;
                    return line.ToString();
                }
                if (line.Length == limit || (line.Length != 0 && line[line.Length - 1] == '\r') ||
                    (value != 13 && (value < 32 || value > 126))) throw new FormatException();
                line.Append((char)value);
            }
        }
    }

    static bool SameTokenLine(string actual, string expected)
    {
        if (actual == null || actual.Length != expected.Length) return false;
        int different = 0;
        for (int i = 0; i < expected.Length; i++) different |= actual[i] ^ expected[i];
        return different == 0;
    }

    static TcpClient ConnectTcp(int port)
    {
        var client = new TcpClient(AddressFamily.InterNetwork);
        try
        {
            var pending = client.BeginConnect(IPAddress.Loopback, port, null, null);
            using (var wait = pending.AsyncWaitHandle)
            {
                if (!wait.WaitOne(TcpDeadlineMs)) throw new TimeoutException();
                client.EndConnect(pending);
            }
            client.NoDelay = true;
            // A provider must not inherit a control socket that could keep its host's EOF hidden from us.
            if (!SetHandleInformation(client.Client.Handle, 1, 0)) throw new IOException();
            client.GetStream().WriteTimeout = TcpDeadlineMs;
            return client;
        }
        catch { client.Close(); throw; }
    }

    static void TcpSay(NetworkStream stream, string line)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
        stream.Write(bytes, 0, bytes.Length); stream.Flush();
    }

    static string DecodeTcpField(string value)
    {
        byte[] bytes = Convert.FromBase64String(value);
        if (Convert.ToBase64String(bytes) != value) throw new FormatException();
        string text = new UTF8Encoding(false, true).GetString(bytes);
        if (text.Length == 0 || text.IndexOf('\0') != -1) throw new FormatException();
        return text;
    }

    static bool AbsoluteWindowsPath(string path)
    {
        // C:relative and \relative are not absolute application/cwd paths.
        return Path.IsPathRooted(path) && Path.GetPathRoot(path).Length >= 3;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    /** Genuine provider pipes, with independent bounded-memory pumps. Only the child ends are inheritable. */
    sealed class TcpStdio : IDisposable
    {
        public readonly IntPtr[] Child = new IntPtr[3];
        readonly FileStream[] files = new FileStream[3];
        readonly TcpClient[] clients = new TcpClient[3];
        readonly Thread[] pumps = new Thread[3];
        readonly ManualResetEvent failed;
        int disposing, faulted;
        public bool Faulted { get { return Interlocked.CompareExchange(ref faulted, 0, 0) != 0; } }

        public TcpStdio(int port, string token, ManualResetEvent failed)
        {
            this.failed = failed;
            try
            {
                for (int i = 0; i < 3; i++)
                {
                    clients[i] = ConnectTcp(port);
                    var stream = clients[i].GetStream();
                    TcpSay(stream, "stdio " + token + " " + i);
                    if (!SameTokenLine(new TcpLines(stream, false).ReadLine(MaxAuthLine, false), "auth " + token + " " + i)) throw new FormatException();
                    stream.ReadTimeout = Timeout.Infinite;
                    stream.WriteTimeout = Timeout.Infinite;

                    var attributes = new SecurityAttributes();
                    attributes.length = Marshal.SizeOf(typeof(SecurityAttributes)); attributes.inherit = 1;
                    IntPtr read, write;
                    if (!CreatePipe(out read, out write, ref attributes, 0)) throw new IOException();
                    Child[i] = i == 0 ? read : write;
                    var parent = new SafeFileHandle(i == 0 ? write : read, true);
                    try
                    {
                        if (!SetHandleInformation(parent.DangerousGetHandle(), 1, 0)) throw new IOException();
                        files[i] = new FileStream(parent, i == 0 ? FileAccess.Write : FileAccess.Read, 8192, false);
                    }
                    catch { parent.Dispose(); throw; }
                    int fd = i;
                    pumps[i] = new Thread(() => Pump(fd));
                    pumps[i].IsBackground = true;
                }
            }
            catch { Dispose(); throw; }
        }

        void Pump(int fd)
        {
            try
            {
                Stream source = fd == 0 ? (Stream)clients[fd].GetStream() : files[fd];
                Stream destination = fd == 0 ? (Stream)files[fd] : clients[fd].GetStream();
                var bytes = new byte[8192];
                int count;
                while ((count = source.Read(bytes, 0, bytes.Length)) > 0)
                {
                    destination.Write(bytes, 0, count);
                    // FileStream's small stdin writes otherwise stay buffered until EOF; protocol peers need them now.
                    destination.Flush();
                }
            }
            catch
            {
                if (Interlocked.CompareExchange(ref disposing, 0, 0) == 0)
                {
                    Interlocked.Exchange(ref faulted, 1);
                    failed.Set();
                }
            }
            finally
            {
                // Input EOF closes the provider's real stdin. Output EOF becomes TCP FIN after all preceding bytes.
                try { files[fd].Dispose(); } catch { }
                clients[fd].Close();
            }
        }

        public void Start()
        {
            CloseChildEnds();
            foreach (var pump in pumps) pump.Start();
        }

        public bool DrainOutputs()
        {
            var elapsed = Stopwatch.StartNew();
            for (int i = 1; i < 3; i++)
            {
                int remaining = TcpDeadlineMs - (int)elapsed.ElapsedMilliseconds;
                if (remaining <= 0 || !pumps[i].Join(remaining)) return false;
            }
            return true;
        }

        void CloseChildEnds()
        {
            for (int i = 0; i < 3; i++) if (Child[i] != IntPtr.Zero) { CloseHandle(Child[i]); Child[i] = IntPtr.Zero; }
        }

        public void Dispose()
        {
            Interlocked.Exchange(ref disposing, 1);
            CloseChildEnds();
            // Close sockets first: this cancels a pump held by peer backpressure or an idle input read.
            foreach (var client in clients) if (client != null) client.Close();
            foreach (var file in files) if (file != null) try { file.Dispose(); } catch { }
        }
    }

    static int RunTcp(string channel, string token)
    {
        const string prefix = "tcp://127.0.0.1:";
        int port;
        if (!channel.StartsWith(prefix, StringComparison.Ordinal) ||
            !int.TryParse(channel.Substring(prefix.Length), NumberStyles.None, CultureInfo.InvariantCulture, out port) || port < 1 || port > 65535) return 125;
        if (token.Length != 64) return 125;
        foreach (char ch in token) if (!(ch >= '0' && ch <= '9') && !(ch >= 'a' && ch <= 'f')) return 125;

        using (var client = ConnectTcp(port))
        {
            var stream = client.GetStream();
            var reader = new TcpLines(stream, true);
            TcpSay(stream, "hello " + token);
            if (!SameTokenLine(reader.ReadLine(MaxAuthLine, false), "auth " + token)) return 125;
            string spec = reader.ReadLine(MaxControlLine, false);
            if (spec == null) return 125;
            string[] parts = spec.Split(' ');
            if (parts.Length != 4 || parts[0] != "spawn") return 125;
            string application = DecodeTcpField(parts[1]), commandLine = DecodeTcpField(parts[2]), cwd = DecodeTcpField(parts[3]);
            if (!AbsoluteWindowsPath(application) || !AbsoluteWindowsPath(cwd) || commandLine.Length > 32766) return 125;
            control = new StreamWriter(stream, new UTF8Encoding(false));

            IntPtr job = IntPtr.Zero;
            var info = new ProcessInformation();
            bool assigned = false;
            TcpStdio bridge = null;
            var killed = new ManualResetEvent(false);
            int invalidControl = 0;
            try
            {
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero) { Say("failed " + Marshal.GetLastWin32Error()); return 126; }
                var limit = new ExtendedLimit(); limit.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit))))
                { Say("failed " + Marshal.GetLastWin32Error()); return 126; }

                bridge = new TcpStdio(port, token, killed);
                var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = bridge.Child[0]; startup.hStdOutput = bridge.Child[1]; startup.hStdError = bridge.Child[2];
                if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
                    IntPtr.Zero, cwd, ref startup, out info)) { Say("failed " + Marshal.GetLastWin32Error()); return 127; }
                if (!AssignProcessToJobObject(job, info.hProcess)) { Say("failed " + Marshal.GetLastWin32Error()); return 126; }
                assigned = true;
                bridge.Start();
                if (ResumeThread(info.hThread) == uint.MaxValue) { Say("failed " + Marshal.GetLastWin32Error()); return 127; }
                CloseHandle(info.hThread); info.hThread = IntPtr.Zero;
                Say("started " + info.dwProcessId);

                var listener = new Thread(() =>
                {
                    try
                    {
                        string line = reader.ReadLine(MaxControlLine, true);
                        if (line != null && line != "kill") Interlocked.Exchange(ref invalidControl, 1);
                    }
                    catch { Interlocked.Exchange(ref invalidControl, 1); }
                    killed.Set();
                });
                listener.IsBackground = true; listener.Start();
                var exited = new ManualResetEvent(false);
                exited.SafeWaitHandle = new SafeWaitHandle(info.hProcess, false);
                int which = WaitHandle.WaitAny(new WaitHandle[] { exited, killed });
                uint code = 1;
                if (which == 0) { GetExitCodeProcess(info.hProcess, out code); Say("exited " + code); }
                uint active = EndTree(job);
                bool drained = bridge.DrainOutputs();
                if (Interlocked.CompareExchange(ref invalidControl, 0, 0) != 0) Say("failed control");
                else if (!drained || bridge.Faulted) Say("failed io");
                Say("empty " + active);
                return which == 0 && drained && !bridge.Faulted && Interlocked.CompareExchange(ref invalidControl, 0, 0) == 0 ? (int)code : 1;
            }
            finally
            {
                // A failure before assignment must also end the suspended process, which is not in the job yet.
                if (!assigned && info.hProcess != IntPtr.Zero) TerminateProcess(info.hProcess, 1);
                if (job != IntPtr.Zero) { EndTree(job); CloseHandle(job); }
                if (bridge != null) bridge.Dispose();
                if (info.hThread != IntPtr.Zero) CloseHandle(info.hThread);
                if (info.hProcess != IntPtr.Zero) CloseHandle(info.hProcess);
            }
        }
    }

    static int Main()
    {
        string channel = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL");
        string token = Environment.GetEnvironmentVariable("PRISM_ACP_TREE_TOKEN");
        // Never inherited by the provider.
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_CHANNEL", null);
        Environment.SetEnvironmentVariable("PRISM_ACP_TREE_TOKEN", null);
        if (string.IsNullOrEmpty(channel) || string.IsNullOrEmpty(token)) return 125;
        if (channel.StartsWith("tcp://", StringComparison.Ordinal))
        {
            try { return RunTcp(channel, token); } catch { return 125; }
        }
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
