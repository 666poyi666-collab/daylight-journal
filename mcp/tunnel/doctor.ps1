[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp",
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$output = if ($OutputPath) { [IO.Path]::GetFullPath($OutputPath) } else { Join-Path $DataDir 'journal-tunnel-doctor-redacted.json' }
$encrypted = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath (Join-Path $DataDir 'tunnel-runtime-key.dpapi')).Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('Poyi.JournalMcp.v1')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
try {
    $env:CONTROL_PLANE_API_KEY = [Text.Encoding]::UTF8.GetString($plain)
    $client = Get-ChildItem -LiteralPath (Join-Path $InstallDir 'tunnel-client') -Filter 'tunnel-client.exe' -Recurse | Select-Object -First 1
    $result = & $client.FullName doctor --profile journal --profile-dir (Join-Path $DataDir 'tunnel-profile') `
        --health.listen-addr '127.0.0.1:0' --explain --json 2>&1
    $code = $LASTEXITCODE
    $result | ForEach-Object {
        $_ -replace 'sk-[A-Za-z0-9_-]+', 'sk-[REDACTED]' `
            -replace 'tunnel_[A-Za-z0-9_-]+', 'tunnel_[REDACTED]' `
            -replace '(?i)(https?://)([^/:\s]+)', '$1[REDACTED]'
    } | Set-Content -LiteralPath $output -Encoding UTF8
    exit $code
} finally {
    $env:CONTROL_PLANE_API_KEY = $null
    [Array]::Clear($plain, 0, $plain.Length)
    [Array]::Clear($encrypted, 0, $encrypted.Length)
}
