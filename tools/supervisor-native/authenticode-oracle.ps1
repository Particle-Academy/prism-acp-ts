param([Parameter(Mandatory=$true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# CI-only disposable signing key; never import a certificate or change any trust/Defender setting.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_RUN_ID -notmatch '^\d+$') { throw 'CI signing oracle only' }
$target = [IO.Path]::GetFullPath($OutputRoot)
$parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $target.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $target)) { throw 'A new owned runner temporary directory is required' }
[void][IO.Directory]::CreateDirectory($target)
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$manifest = Get-Content -LiteralPath (Join-Path $packageRoot 'native/supervisor-manifest.json') -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PrismSipOracle {
 [StructLayout(LayoutKind.Sequential)] struct Blob { public uint size; public IntPtr bytes; }
 [StructLayout(LayoutKind.Sequential)] struct Algorithm { public IntPtr oid; public Blob parameters; }
 [StructLayout(LayoutKind.Sequential)] struct Attribute { public IntPtr oid; public Blob value; }
 [StructLayout(LayoutKind.Sequential)] struct Indirect { public Attribute data; public Algorithm algorithm; public Blob digest; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Subject {
  public uint size; public IntPtr guid, file; public string path, display;
  public uint reserved1, version; public IntPtr provider; public Algorithm algorithm;
  public uint flags, encoding, reserved2, capi, security, index, choice; public IntPtr extra, client;
 }
 [DllImport("crypt32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CryptSIPRetrieveSubjectGuid(string path, IntPtr file, out Guid guid);
 [DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptSIPCreateIndirectData(ref Subject subject, ref uint length, IntPtr output);
 public static string Digest(string path) {
  Guid value; if (!CryptSIPRetrieveSubjectGuid(path, IntPtr.Zero, out value)) throw new Win32Exception();
  IntPtr guid=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Guid))), oid=Marshal.StringToHGlobalAnsi("2.16.840.1.101.3.4.2.1"), buffer=IntPtr.Zero;
  try {
   Marshal.StructureToPtr(value,guid,false);
   var subject=new Subject { size=(uint)Marshal.SizeOf(typeof(Subject)), guid=guid, file=new IntPtr(-1), path=path, encoding=0x00010001, algorithm=new Algorithm { oid=oid } };
   uint length=0; if (!CryptSIPCreateIndirectData(ref subject,ref length,IntPtr.Zero)) throw new Win32Exception();
   if(length<Marshal.SizeOf(typeof(Indirect)) || length>65536) throw new Exception("Invalid native digest size");
   buffer=Marshal.AllocHGlobal((int)length); if(!CryptSIPCreateIndirectData(ref subject,ref length,buffer)) throw new Win32Exception();
   var data=(Indirect)Marshal.PtrToStructure(buffer,typeof(Indirect));
   if(data.digest.size!=32 || Marshal.PtrToStringAnsi(data.algorithm.oid)!="2.16.840.1.101.3.4.2.1") throw new Exception("Native oracle did not return SHA256");
   var bytes=new byte[32]; Marshal.Copy(data.digest.bytes,bytes,0,32); return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();
  } finally { if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer); Marshal.FreeHGlobal(oid); Marshal.FreeHGlobal(guid); }
 }
}
'@
$signTool = Get-ChildItem -LiteralPath "${env:ProgramFiles(x86)}/Windows Kits/10/bin" -Filter signtool.exe -Recurse | Where-Object { $_.FullName -match '\\x64\\signtool.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK signtool is required for the genuine signing oracle' }
$key = [Security.Cryptography.RSA]::Create(2048)
$certificate = $null
$pfx = Join-Path $target 'disposable-key.pfx'
$password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
try {
 $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Prism disposable CI test signer', $key, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
 $oids = [Security.Cryptography.OidCollection]::new(); [void]$oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
 $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids,$true))
 $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddHours(2))
 [IO.File]::WriteAllBytes($pfx,$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$password))
 $rows = @()
 foreach ($arch in @('x64','arm64')) {
  $source = Join-Path $packageRoot ('native/win32-' + $arch + '/prism-acp-supervisor.exe')
  $copy = Join-Path $target ($arch + '-signed.exe'); Copy-Item -LiteralPath $source -Destination $copy
  $before = [PrismSipOracle]::Digest($source)
  if ($before -ne $manifest.binaries.$arch.authenticodeSha256) { throw 'Windows SIP disagrees with the reviewed unsigned image pin' }
  & $signTool.FullName sign /fd SHA256 /f $pfx /p $password $copy | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Disposable signing failed' }
  $signature = Get-AuthenticodeSignature -LiteralPath $copy
  # This signer is deliberately NOT trusted: inspect actual signature identity without changing stores.
  if ($signature.SignatureType.ToString() -ne 'Authenticode' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint -or $signature.Status.ToString() -ne 'NotTrusted') { throw 'Expected a genuine signature from the disposable untrusted signer' }
  $after = [PrismSipOracle]::Digest($copy)
  $rawBefore = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  $rawAfter = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($after -ne $before -or $rawBefore -eq $rawAfter) { throw 'Signing did not preserve exactly the native image digest' }
  $rows += [ordered]@{ architecture=$arch; file=($arch+'-signed.exe'); windowsSipSha256=$after; rawBefore=$rawBefore; rawAfter=$rawAfter; signature='Authenticode'; chain='NotTrusted'; signerThumbprint=$certificate.Thumbprint }
 }
 [ordered]@{ schemaVersion=1; rows=$rows; noTrustStoreChanges=$true; disposableKeyRemoved=$true } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'signed-image-receipt.json') -Encoding utf8NoBOM
} finally {
 if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
 if ($null -ne $certificate) { $certificate.Dispose() }
 $key.Dispose(); $password=$null
}
