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
Add-Type -AssemblyName System.Security.Cryptography.Pkcs
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
 [DllImport("crypt32.dll", SetLastError=true)] static extern bool CryptSIPGetSignedDataMsg(ref Subject subject, out uint encoding, uint index, ref uint length, IntPtr output);
 public static byte[] SignedMessage(string path) {
  Guid value; if(!CryptSIPRetrieveSubjectGuid(path,IntPtr.Zero,out value))throw new Win32Exception();
  IntPtr guid=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Guid))),buffer=IntPtr.Zero;
  try {
   Marshal.StructureToPtr(value,guid,false);
   var subject=new Subject { size=(uint)Marshal.SizeOf(typeof(Subject)),guid=guid,file=new IntPtr(-1),path=path,encoding=0x00010001 };
   uint length=0,encoding;
   if(!CryptSIPGetSignedDataMsg(ref subject,out encoding,0,ref length,IntPtr.Zero))throw new Win32Exception();
   if(length<32 || length>8*1024*1024)throw new Exception("Invalid native signed-message size");
   buffer=Marshal.AllocHGlobal((int)length);
   if(!CryptSIPGetSignedDataMsg(ref subject,out encoding,0,ref length,buffer))throw new Win32Exception();
   var bytes=new byte[length];Marshal.Copy(buffer,bytes,0,(int)length);return bytes;
  } finally {if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);Marshal.FreeHGlobal(guid);}
 }
 // Read only the canonical DER SpcIndirectDataContent/DigestInfo envelope.
 // SignedCms supplies the cryptographic verification; no custom crypto here.
 static byte[] Value(byte[] bytes,ref int at,byte tag) {
  if(at+2>bytes.Length || bytes[at++]!=tag)throw new Exception("Invalid signed-content DER tag");
  int length=bytes[at++];
  if((length&128)!=0) {
   int count=length&127; if(count<1 || count>3 || at+count>bytes.Length || bytes[at]==0)throw new Exception("Invalid signed-content DER length");
   length=0;for(int i=0;i<count;i++)length=(length<<8)|bytes[at++];
   if(length<128)throw new Exception("Noncanonical signed-content DER length");
  }
  if(length>bytes.Length-at)throw new Exception("Truncated signed-content DER");
  var value=new byte[length];Buffer.BlockCopy(bytes,at,value,0,length);at+=length;return value;
 }
 public static string ContentDigest(byte[] bytes) {
  if(bytes.Length>65536)throw new Exception("Oversized signed content");
  int at=0;var outer=Value(bytes,ref at,0x30);if(at!=bytes.Length)throw new Exception("Trailing signed content");
  at=0;Value(outer,ref at,0x30);var info=Value(outer,ref at,0x30);if(at!=outer.Length)throw new Exception("Extra signed-content field");
  at=0;var algorithm=Value(info,ref at,0x30);var digest=Value(info,ref at,0x04);
  var oid=BitConverter.ToString(algorithm).Replace("-","");
  if((oid!="0609608648016503040201" && oid!="06096086480165030402010500") || at!=info.Length || digest.Length!=32)throw new Exception("Signed content must contain exactly one SHA256 digest");
  return BitConverter.ToString(digest).Replace("-","").ToLowerInvariant();
 }
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
  Write-Output ([ordered]@{ signedOracleDiagnostic=$arch; signatureType=$signature.SignatureType.ToString(); signatureStatus=$signature.Status.ToString(); statusMessage=$signature.StatusMessage } | ConvertTo-Json -Compress)
  # A trust-status label is not proof of a valid signature. Verify the native
  # SIP-extracted CMS message cryptographically, then bind its authenticated
  # file digest to Windows SIP. Check chain trust separately without installing it.
  $cms = [Security.Cryptography.Pkcs.SignedCms]::new()
  $cms.Decode([PrismSipOracle]::SignedMessage($copy)); $cms.CheckSignature($true)
  if ($cms.ContentInfo.ContentType.Value -ne '1.3.6.1.4.1.311.2.1.4' -or $cms.SignerInfos.Count -ne 1 -or $cms.SignerInfos[0].Certificate.Thumbprint -ne $certificate.Thumbprint) { throw 'Unexpected Authenticode CMS signer/content' }
  $signedDigest = [PrismSipOracle]::ContentDigest($cms.ContentInfo.Content)
  $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
  try {
   $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
   $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
   [void]$chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.3'))
   $trusted = $chain.Build($cms.SignerInfos[0].Certificate)
   $chainErrors = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
   if ($trusted -or $chainErrors.Count -ne 1 -or $chainErrors[0] -ne 'UntrustedRoot') { throw 'Disposable signer must have only the expected untrusted root failure' }
  } finally { $chain.Dispose() }
  $after = [PrismSipOracle]::Digest($copy)
  $rawBefore = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  $rawAfter = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($after -ne $before -or $signedDigest -ne $after -or $rawBefore -eq $rawAfter) { throw 'Signed CMS digest does not bind exactly the native program image' }
  $rows += [ordered]@{ architecture=$arch; file=($arch+'-signed.exe'); windowsSipSha256=$after; cmsContentSha256=$signedDigest; cmsSignatureVerified=$true; rawBefore=$rawBefore; rawAfter=$rawAfter; signature='Authenticode'; chain='UntrustedRoot'; powerShellStatus=$signature.Status.ToString(); signerThumbprint=$certificate.Thumbprint }
 }
 [ordered]@{ schemaVersion=1; rows=$rows; noTrustStoreChanges=$true; disposableKeyRemoved=$true } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $target 'signed-image-receipt.json') -Encoding utf8NoBOM
} finally {
 if (Test-Path -LiteralPath $pfx) { Remove-Item -LiteralPath $pfx -Force }
 if ($null -ne $certificate) { $certificate.Dispose() }
 $key.Dispose(); $password=$null
}
