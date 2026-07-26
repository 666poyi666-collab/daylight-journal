$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Redact([string]$Text) {
    return $Text `
        -replace 'sk-[A-Za-z0-9_-]+', 'sk-[REDACTED]' `
        -replace 'tunnel_[A-Za-z0-9_-]+', 'tunnel_[REDACTED]' `
        -replace '(?i)(api[_-]?key["'' :=]+)[^,"'' ]+', '$1[REDACTED]' `
        -replace '\b(?:\d{1,3}\.){3}\d{1,3}\b', '[REDACTED_IP]'
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dataDir = $env:JOURNAL_MCP_DATA_DIR
if ([string]::IsNullOrWhiteSpace($dataDir)) { $dataDir = "$env:ProgramData\Poyi\JournalMcp" }
$keyPath = Join-Path $dataDir 'tunnel-runtime-key.dpapi'
$profileDir = Join-Path $dataDir 'tunnel-profile'
if (-not (Test-Path -LiteralPath $keyPath)) { throw 'Journal Tunnel runtime key is not installed.' }

$deadline = (Get-Date).AddMinutes(2)
do {
    Start-Sleep -Seconds 1
    try { $ready = Invoke-RestMethod 'http://127.0.0.1:8780/readyz' -TimeoutSec 2 }
    catch { $ready = $null }
} until ($null -ne $ready -or (Get-Date) -ge $deadline)
if ($null -eq $ready) { throw 'Journal MCP is not ready.' }

$encrypted = [Convert]::FromBase64String((Get-Content -Raw -LiteralPath $keyPath).Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('Poyi.JournalMcp.v1')
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
try {
    $env:CONTROL_PLANE_API_KEY = [Text.Encoding]::UTF8.GetString($plainBytes)
    $client = Get-ChildItem -LiteralPath (Join-Path $root 'tunnel-client') `
        -Filter 'tunnel-client.exe' -Recurse | Select-Object -First 1
    if ($null -eq $client) { throw 'tunnel-client.exe is missing.' }
    $tail = [Collections.Generic.Queue[string]]::new()
    $previous = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $client.FullName run --profile journal --profile-dir $profileDir `
            --log.format json --log.level info 2>&1 | ForEach-Object {
                $tail.Enqueue((Redact ([string]$_)))
                if ($tail.Count -gt 12) { [void]$tail.Dequeue() }
            }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) { Write-Error (Redact ($tail.ToArray() -join [Environment]::NewLine)) }
    exit $exitCode
} finally {
    $env:CONTROL_PLANE_API_KEY = $null
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    [Array]::Clear($encrypted, 0, $encrypted.Length)
}
