// Test-only Windows AppContainer host. All grants are to a freshly-created SID
// and fixture-owned paths. No network capability, credentials or model calls.
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class AppContainerHost
{
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved, desktop, title;
        public int x,y,xsize,ysize,xcount,ycount,fill,flags;
        public short show,reservedSize; public IntPtr reserved2,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities { public IntPtr sid,capabilities; public int count,reserved; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime,jobTime; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public Io io; public UIntPtr a,b,c,d; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint faults,total,active,terminated; }
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,uint count,out IntPtr sid);
    [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int returned);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr descriptor,out bool present,out IntPtr sacl,out bool defaulted);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name,int kind,uint information,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder args,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo process);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limits,int size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,int size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool contained);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateNamedPipeW(string name,uint mode,uint type,uint instances,uint output,uint input,uint timeout,IntPtr security);
    static void Check(bool success,string stage) { if(!success) throw new Exception(stage+":"+Marshal.GetLastWin32Error()); }
    static string Quote(string s) { return "\""+s.Replace("\\","\\").Replace("\"","\\\"")+"\""; }
    static void Grant(string directory,SecurityIdentifier sid,FileSystemRights rights) {
        var info=new DirectoryInfo(directory); var acl=info.GetAccessControl();
        acl.AddAccessRule(new FileSystemAccessRule(sid,rights,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        info.SetAccessControl(acl);
    }
    static void Low(string directory) {
        IntPtr descriptor; uint size; Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)",1,out descriptor,out size),"low descriptor");
        try { bool present,defaulted; IntPtr sacl; Check(GetSecurityDescriptorSacl(descriptor,out present,out sacl,out defaulted),"low sacl");
            uint error=SetNamedSecurityInfoW(directory,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl); if(error!=0) throw new Exception("low label:"+error);
        } finally { LocalFree(descriptor); }
    }
    static uint Active(IntPtr job) { Accounting a; Check(QueryInformationJobObject(job,1,out a,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"job count"); return a.active; }
    static int CheckDescendants(string root,IntPtr job,IntPtr sid) {
        string path=Path.Combine(root,"workspace","proof-pids"); if(!File.Exists(path)) return 0;
        if(new FileInfo(path).Length>4096) throw new Exception("oversized fixture proof");
        string[] lines; try { lines=File.ReadAllLines(path); } catch(IOException) { return 0; }
        if(lines.Length!=3) return 0;
        foreach(string line in lines) {
            int pid; if(!int.TryParse(line,out pid)||pid<=0) throw new Exception("invalid fixture pid");
            IntPtr process=OpenProcess(0x1000,false,pid); Check(process!=IntPtr.Zero,"proof process");
            try { bool contained; Check(IsProcessInJob(process,job,out contained)&&contained,"foreign job refused"); Check(IsContainer(process,sid),"descendant identity"); }
            finally { CloseHandle(process); }
        }
        File.WriteAllText(Path.Combine(root,"workspace","proof-ack"),"verified"); return 3;
    }
    static bool IsContainer(IntPtr process,IntPtr expected) {
        IntPtr token; Check(OpenProcessToken(process,8,out token),"token");
        IntPtr value=Marshal.AllocHGlobal(IntPtr.Size); int returned;
        try { Check(GetTokenInformation(token,29,value,4,out returned),"TokenIsAppContainer"); if(Marshal.ReadInt32(value)!=1) return false;
            GetTokenInformation(token,31,IntPtr.Zero,0,out returned);
            Marshal.FreeHGlobal(value); value=Marshal.AllocHGlobal(returned);
            Check(GetTokenInformation(token,31,value,returned,out returned),"TokenAppContainerSid");
            return new SecurityIdentifier(Marshal.ReadIntPtr(value)).Equals(new SecurityIdentifier(expected));
        } finally { Marshal.FreeHGlobal(value); CloseHandle(token); }
    }
    static int PipeProbe() {
        foreach(string prefix in new[]{@"\\?\pipe\uv\",@"\\.\pipe\LOCAL\prism-owned-"}) {
            for(int i=0;i<3;i++) { IntPtr h=CreateNamedPipeW(prefix+Guid.NewGuid().ToString("N"),0x40080003,0,1,4096,4096,0,IntPtr.Zero);
                int error=h==new IntPtr(-1)?Marshal.GetLastWin32Error():0; if(error==0) CloseHandle(h);
                Console.WriteLine("{\"stage\":\"native_pipe\",\"local\":"+(prefix.Contains("LOCAL")?"true":"false")+",\"error\":"+error+"}");
            }
        } return 0;
    }
    static int PipeAclProbe() {
        using(var identity=WindowsIdentity.GetCurrent()) {
            int size; GetTokenInformation(identity.Token,31,IntPtr.Zero,0,out size);
            IntPtr data=Marshal.AllocHGlobal(size);
            try {
                Check(GetTokenInformation(identity.Token,31,data,size,out size),"ACL token SID");
                var container=new SecurityIdentifier(Marshal.ReadIntPtr(data));
                foreach(int standard in new[]{-10,-11,-12}) {
                    // Inspect only; never bind the inherited handle to a second IOCP.
                    using(var pipe=new NamedPipeServerStream(PipeDirection.InOut,false,true,new SafePipeHandle(GetStdHandle(standard),false))) {
                        var acl=pipe.GetAccessControl(); Check(acl.AreAccessRulesProtected,"protected pipe ACL");
                        int rules=0;
                        foreach(PipeAccessRule rule in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                            Check(rule.AccessControlType==AccessControlType.Allow&&!rule.IsInherited,"explicit pipe grant");
                            Check(rule.IdentityReference.Equals(identity.User)||rule.IdentityReference.Equals(container),"foreign pipe grant"); rules++;
                        }
                        Check(rules==2,"two pipe principals");
                    }
                }
            } finally { Marshal.FreeHGlobal(data); }
        }
        Console.WriteLine("{\"stage\":\"stdio_acl\",\"protected\":true,\"principals\":2,\"pipes\":3}"); return 0;
    }
    static int Main(string[] args) {
        if(args.Length==1&&args[0]=="--pipe-probe") return PipeProbe();
        if(args.Length==1&&args[0]=="--pipe-acl") return PipeAclProbe();
        if(args.Length!=6) return 2;
        string root=Path.GetFullPath(args[0]),node=Path.GetFullPath(args[1]),worker=Path.GetFullPath(args[2]),mode=args[3],foreign=Path.GetFullPath(args[4]);
        int timeout=int.Parse(args[5]); if(timeout<100||timeout>30000) return 2;
        string name="prism-acp-fixture-"+Guid.NewGuid().ToString("N");
        IntPtr sid=IntPtr.Zero,foreignSid=IntPtr.Zero,job=IntPtr.Zero,list=IntPtr.Zero,capsMemory=IntPtr.Zero,environment=IntPtr.Zero;
        ProcessInfo child=new ProcessInfo(); bool created=false,foreignCreated=false,removed=false,foreignRemoved=false,empty=false,timedOut=false,verified=false; uint exit=255,remaining=uint.MaxValue; int descendants=0;
        try {
            int result=CreateAppContainerProfile(name,name,"Owned Prism ACP fixture",IntPtr.Zero,0,out sid);
            if(result!=0) throw new Exception("profile:"+result); created=true;
            result=CreateAppContainerProfile(name+"-foreign",name+"-foreign","Owned foreign fixture",IntPtr.Zero,0,out foreignSid);
            if(result!=0) throw new Exception("foreign profile:"+result); foreignCreated=true;
            Grant(Path.GetDirectoryName(foreign),new SecurityIdentifier(foreignSid),FileSystemRights.ReadAndExecute);
            var identity=new SecurityIdentifier(sid); Grant(root,identity,FileSystemRights.ReadAndExecute);
            string cwd=Path.Combine(root,"workspace"),home=Path.Combine(root,"home");
            Grant(cwd,identity,FileSystemRights.Modify); Grant(home,identity,FileSystemRights.Modify);
            Grant(cwd,WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl); Grant(home,WindowsIdentity.GetCurrent().User,FileSystemRights.FullControl);
            Low(cwd); Low(home);
            job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"job"); var limits=new ExtendedLimit(); limits.basic.flags=0x2000;
            Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit))),"job limits");
            IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size); list=Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(list,1,0,ref size),"attributes");
            var caps=new SecurityCapabilities(); caps.sid=sid; capsMemory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities))); Marshal.StructureToPtr(caps,capsMemory,false);
            Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20009),capsMemory,new IntPtr(Marshal.SizeOf(typeof(SecurityCapabilities))),IntPtr.Zero,IntPtr.Zero),"capabilities");
            var startup=new StartupEx(); startup.startup.cb=Marshal.SizeOf(typeof(StartupEx)); startup.attributes=list;
            startup.startup.flags=0x100; startup.startup.input=GetStdHandle(-10); startup.startup.output=GetStdHandle(-11); startup.startup.error=GetStdHandle(-12);
            string env="HOME="+home+"\0LOCALAPPDATA="+home+"\0PATH="+Path.GetDirectoryName(node)+"\0PRISM_FIXTURE_NATIVE="+System.Reflection.Assembly.GetExecutingAssembly().Location+"\0SystemRoot="+Environment.GetEnvironmentVariable("SystemRoot")+"\0TEMP="+cwd+"\0TMP="+cwd+"\0USERPROFILE="+home+"\0\0";
            environment=Marshal.StringToHGlobalUni(env);
            // Physical fixture paths: avoid Node's realpath walk through denied
            // ancestors; grant no permission to the drive root or other repos.
            string command=Quote(node)+" --preserve-symlinks --preserve-symlinks-main "+Quote(worker)+" "+Quote(root)+" "+Quote(mode)+" "+Quote(foreign);
            Check(CreateProcessW(node,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x08080404,environment,cwd,ref startup,out child),"create");
            if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,1); Check(false,"assign"); }
            verified=IsContainer(child.process,sid); Check(verified,"identity");
            Console.WriteLine("{\"fixture\":\"identity\",\"appContainer\":true,\"pid\":"+child.pid+"}");
            Check(ResumeThread(child.thread)!=uint.MaxValue,"resume");
            var clock=Stopwatch.StartNew();
            while(WaitForSingleObject(child.process,20)==258) {
                if(descendants==0) descendants=CheckDescendants(root,job,sid);
                if(clock.ElapsedMilliseconds>=timeout) { timedOut=true; break; }
            }
            GetExitCodeProcess(child.process,out exit);
            // Measure before the fixture's cleanup kill: host death must itself
            // remove the supervisor and all descendants, not rely on this host.
            remaining=Active(job);
            if(!timedOut) for(int i=0;i<100&&remaining!=0;i++) { Thread.Sleep(20); remaining=Active(job); }
        } catch(Exception error) { Console.Error.WriteLine(error.Message); }
        finally {
            if(job!=IntPtr.Zero) {
                try { TerminateJobObject(job,1); for(int i=0;i<250&&Active(job)!=0;i++) Thread.Sleep(20); empty=Active(job)==0; }
                catch(Exception error) { Console.Error.WriteLine("cleanup:"+error.Message); }
                finally { CloseHandle(job); }
            }
            if(child.thread!=IntPtr.Zero) CloseHandle(child.thread); if(child.process!=IntPtr.Zero) CloseHandle(child.process);
            if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
            if(capsMemory!=IntPtr.Zero) Marshal.FreeHGlobal(capsMemory); if(environment!=IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if(created) removed=DeleteAppContainerProfile(name)==0; if(sid!=IntPtr.Zero) FreeSid(sid);
            if(foreignCreated) foreignRemoved=DeleteAppContainerProfile(name+"-foreign")==0; if(foreignSid!=IntPtr.Zero) FreeSid(foreignSid);
        }
        Console.WriteLine("{\"fixture\":\"result\",\"verified\":"+(verified?"true":"false")+",\"timedOut\":"+(timedOut?"true":"false")+",\"workerExit\":"+exit+",\"empty\":"+(empty?"true":"false")+",\"profileRemoved\":"+(removed?"true":"false")+",\"foreignProfileRemoved\":"+(foreignRemoved?"true":"false")+",\"remainingBeforeCleanup\":"+remaining+",\"descendantsVerified\":"+descendants+"}");
        return verified&&empty&&removed&&foreignRemoved?0:1;
    }
}
