[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp",
    [string]$ResultPath = ''
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run verify-pairing.ps1 from an elevated PowerShell session.'
}

$entry = Join-Path $InstallDir 'mcp\pairing-cli.mjs'
$output = & node.exe $entry --data-dir $DataDir 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $output -notmatch '([0-9]{6})') {
    throw 'Pairing code generation failed.'
}

$code = $Matches[1]
$body = @{ code = $code } | ConvertTo-Json -Compress
$paired = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8781/pairing/exchange' `
    -ContentType 'application/json' -Body $body
try {
    Invoke-WebRequest -UseBasicParsing -Method Post `
        -Uri 'http://127.0.0.1:8781/pairing/exchange' `
        -ContentType 'application/json' -Body $body | Out-Null
    $replayStatus = 200
} catch {
    $replayStatus = [int]$_.Exception.Response.StatusCode
}

$result = [pscustomobject]@{
    Paired = $paired.token -is [string] -and $paired.token.Length -ge 32
    TokenLength = $paired.token.Length
    ReplayStatus = $replayStatus
}
$safeJson = $result | ConvertTo-Json -Compress
if ($ResultPath) {
    $resolvedResult = [IO.Path]::GetFullPath($ResultPath)
    if (-not $resolvedResult.StartsWith([IO.Path]::GetFullPath($env:TEMP), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ResultPath must be inside the current user temp directory.'
    }
    Set-Content -LiteralPath $resolvedResult -Value $safeJson -Encoding utf8
} else {
    $safeJson
}

if (-not $result.Paired -or $result.ReplayStatus -ne 410) {
    throw 'Production pairing verification failed.'
}
$code = $null
$paired = $null
