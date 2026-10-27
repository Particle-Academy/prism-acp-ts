import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A real executable, not a Node script. App mode exits silently without ever running JS. */
export function buildFakeElectron(directory: string): string {
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
 if (mode && !strcmp(mode,"hang")) { sleep(60); return 0; }
 argv[0] = getenv("PRISM_FAKE_ELECTRON_NODE");
 if (!argv[0]) return 127;
 execv(argv[0], argv); return 127;
}`);
    execFileSync('cc', [source, '-o', binary], { stdio: 'pipe' });
  }
  return binary;
}
