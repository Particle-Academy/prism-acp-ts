param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($Directory)) { throw 'Absolute artifact directory required' }
$rows = @()
foreach ($arch in @('x64', 'arm64')) {
    $file = Join-Path $Directory ('win32-' + $arch + '/prism-acp-supervisor.exe')
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) { throw ('Publisher signature is not valid: ' + $arch) }
    if ($null -eq $signature.SignerCertificate -or $null -eq $signature.TimeStamperCertificate) { throw ('Verified publisher and timestamp certificates required: ' + $arch) }
    if ($signature.SignatureType -ne [System.Management.Automation.SignatureType]::Authenticode) { throw ('Embedded Authenticode signature required: ' + $arch) }
    $publisherName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($publisherName -cne 'Renaissance Analytics') { throw ('Unexpected supervisor publisher: ' + $arch) }
    $rows += [ordered]@{
        architecture = $arch
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        status = [string]$signature.Status
        signatureType = [string]$signature.SignatureType
        publisher = $signature.SignerCertificate.Subject
        publisherName = $publisherName
        certificateThumbprint = $signature.SignerCertificate.Thumbprint
        timestampPublisher = $signature.TimeStamperCertificate.Subject
        hasTimestamp = $true
    }
}
ConvertTo-Json -InputObject $rows -Depth 4 -Compress
