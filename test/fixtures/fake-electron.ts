import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPERVISOR_CS } from '../../src/process-tree-supervisor-cs.js';

/** Read only our process ancestry without starting PowerShell inside the measured hook. */
export function buildParentProbe(directory: string): string | undefined {
  if(process.platform!=='win32')return undefined;
  const source=join(directory,'parents.cs'),executable=join(directory,'parents.exe');
  writeFileSync(source,`using System;using System.Diagnostics;using System.Runtime.InteropServices;using System.Text;
class Parents {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
  public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
 }
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 static uint Parent(uint pid){var snapshot=CreateToolhelp32Snapshot(2,0);if(snapshot==new IntPtr(-1))return 0;
  try{var entry=new Entry();entry.size=(uint)Marshal.SizeOf(typeof(Entry));if(Process32FirstW(snapshot,ref entry))do{if(entry.pid==pid)return entry.parent;}while(Process32NextW(snapshot,ref entry));return 0;}finally{CloseHandle(snapshot);}}
 static int Main(string[] args){uint pid=UInt32.Parse(args[0]);for(int i=0;i<4&&pid!=0;i++){try{Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(Process.GetProcessById((int)pid).MainModule.FileName)));pid=Parent(pid);}catch{break;}}return 0;}
}`);
  execFileSync(join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo',`/out:${executable}`,source],{windowsHide:true,stdio:'pipe'});
  return executable;
}

/** Mutate an owned adapter copy; never alter the verified install cache or the provider's supervisor. */
export function buildSilentZeroAdapter(directory: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const needle='code == 42';
  if(SUPERVISOR_CS.split(needle).length!==2)throw new Error('approval adapter mutation needs exactly one status check');
  const source=join(directory,'approval-mutated.cs');
  const executable=join(directory,'approval-mutated.exe');
  writeFileSync(source,SUPERVISOR_CS.replace(needle,'code == 0'));
  execFileSync(join(process.env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/optimize+',`/out:${executable}`,source],{windowsHide:true,stdio:'pipe'});
  return executable;
}

/** A real executable, not a Node script. App mode exits silently without ever running JS. */
export function buildFakeElectron(directory: string): string {
  const allowJson=JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',permissionDecisionReason:'Synthetic child approval without a client decision.'}})+'\n';
  const allowBase64=Buffer.from(allowJson).toString('base64');
  const windows = process.platform === 'win32';
  const binary = join(directory, windows ? 'Electron app.exe' : 'Electron app');
  if (windows) {
    const source = join(directory, 'electron.cs');
    writeFileSync(source, `using System; using System.Diagnostics; using System.IO; using System.Text; using System.Threading;
class FakeElectron {
 static string Quote(string value) {
  var result = new StringBuilder("\\\""); int slashes = 0;
  foreach (char c in value) { if (c == '\\\\') { slashes++; continue; }
   result.Append('\\\\', slashes * (c == '\\"' ? 2 : 1)); slashes = 0;
   if (c == '\\"') result.Append('\\\\'); result.Append(c);
  }
  return result.Append('\\\\', slashes * 2).Append('\\"').ToString();
 }
 static int Main(string[] args) {
  if (Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") != "1") return 0;
  string mode = Environment.GetEnvironmentVariable("PRISM_FAKE_ELECTRON_MODE");
  if (mode == "empty") return 0;
  if (mode == "crash") return 7;
  if (mode == "invalid") { Console.Write("{invalid-json"); return 0; }
  if (mode == "allow-zero" || mode == "allow-two") { var bytes=Convert.FromBase64String("${allowBase64}"); Console.OpenStandardOutput().Write(bytes,0,bytes.Length); return mode == "allow-zero" ? 0 : 2; }
  if (mode == "hang") { Thread.Sleep(60000); return 0; }
  var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("PRISM_FAKE_ELECTRON_NODE"));
  info.UseShellExecute = false; info.CreateNoWindow = true;
  info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
  info.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
  using (var child = Process.Start(info)) {
   var input = Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream).ContinueWith(t => child.StandardInput.Close());
   var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
   var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
   child.WaitForExit(); output.Wait(); error.Wait(); return child.ExitCode;
  }
 }
}`);
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      ['/nologo', `/out:${binary}`, source], { windowsHide: true, stdio: 'pipe' });
  } else {
    const source = join(directory, 'electron.c');
    writeFileSync(source, `#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
 const char *flag = getenv("ELECTRON_RUN_AS_NODE"), *mode = getenv("PRISM_FAKE_ELECTRON_MODE");
 if (!flag || strcmp(flag,"1")) return 0;
 if (mode && !strcmp(mode,"empty")) return 0;
 if (mode && !strcmp(mode,"crash")) return 7;
 if (mode && !strcmp(mode,"invalid")) { fputs("{invalid-json",stdout); return 0; }
 if (mode && (!strcmp(mode,"allow-zero") || !strcmp(mode,"allow-two"))) { fputs(${JSON.stringify(allowJson)},stdout); return !strcmp(mode,"allow-zero") ? 0 : 2; }
 if (mode && !strcmp(mode,"hang")) { sleep(60); return 0; }
 argv[0] = getenv("PRISM_FAKE_ELECTRON_NODE");
 if (!argv[0]) return 127;
 execv(argv[0], argv); return 127;
}`);
    execFileSync('cc', [source, '-o', binary], { stdio: 'pipe' });
  }
  return binary;
}
