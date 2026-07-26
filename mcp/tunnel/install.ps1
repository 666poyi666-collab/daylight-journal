[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^tunnel_[A-Za-z0-9_-]+$')]
    [string]$TunnelId,
    [Security.SecureString]$RuntimeApiKey,
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run install.ps1 from an elevated PowerShell session.'
    }
}

function Get-VerifiedDownload([string]$Url, [string]$Sha256, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Destination -Force
        throw "SHA-256 mismatch for $Url"
    }
}

function Invoke-Quiet([string]$FilePath, [string[]]$ArgumentList) {
    # Native stderr noise must not become terminating under the Stop
    # preference; run with Continue and let callers judge the exit code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $FilePath @ArgumentList 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}

function Reserve-JournalPorts([int]$StartPort, [int]$Count) {
    # WinNAT re-picks its dynamic excluded port ranges after network-stack
    # events; when one lands on the Tunnel health port a privileged bind
    # "succeeds" with no reachable listener (BUG-019). An administered
    # exclusion pins the port so dynamic ranges avoid it permanently.
    $endPort = $StartPort + $Count - 1
    $administered = $false
    $dynamicHit = $false
    foreach ($line in & netsh int ipv4 show excludedportrange protocol=tcp) {
        if ($line -match '^\s*(\d+)\s+(\d+)(\s*\*)?\s*$') {
            $rangeStart = [int]$Matches[1]
            $rangeEnd = [int]$Matches[2]
            if ($rangeStart -le $StartPort -and $rangeEnd -ge $endPort -and $Matches[3]) { $administered = $true }
            elseif ($rangeStart -le $endPort -and $rangeEnd -ge $StartPort -and -not $Matches[3]) { $dynamicHit = $true }
        }
    }
    if ($administered) { return }
    if ($dynamicHit) { Invoke-Quiet 'net' @('stop', 'winnat') }
    Invoke-Quiet 'netsh' @('int', 'ipv4', 'add', 'excludedportrange', 'protocol=tcp', "startport=$StartPort", "numberofports=$Count", 'store=persistent')
    $added = $LASTEXITCODE
    if ($dynamicHit) { Invoke-Quiet 'net' @('start', 'winnat') }
    if ($added -ne 0) { throw "Failed to reserve Journal Tunnel port $StartPort against dynamic exclusions." }
}

function Protect-Secret([Security.SecureString]$Secret, [string]$Destination) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $bytes = [Text.Encoding]::UTF8.GetBytes($plain)
        $entropy = [Text.Encoding]::UTF8.GetBytes('Poyi.JournalMcp.v1')
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $bytes, $entropy, [Security.Cryptography.DataProtectionScope]::LocalMachine)
        [IO.File]::WriteAllText($Destination, [Convert]::ToBase64String($encrypted))
        [Array]::Clear($bytes, 0, $bytes.Length)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}

Assert-Administrator
if ($null -eq $RuntimeApiKey) { $RuntimeApiKey = Read-Host 'Journal Tunnel runtime API key' -AsSecureString }
if (-not (Get-Service -Name 'PoyiJournalMcp' -ErrorAction SilentlyContinue)) {
    throw 'Install PoyiJournalMcp before the Journal Tunnel.'
}
$resolvedInstall = [IO.Path]::GetFullPath($InstallDir)
$resolvedData = [IO.Path]::GetFullPath($DataDir)
if (-not $resolvedInstall.StartsWith([IO.Path]::GetFullPath($env:ProgramFiles), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallDir must be under Program Files.'
}
if (-not $resolvedData.StartsWith([IO.Path]::GetFullPath($env:ProgramData), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DataDir must be under ProgramData.'
}

$dependencies = Get-Content -Raw -LiteralPath (Join-Path $resolvedInstall 'mcp\service\dependencies.json') | ConvertFrom-Json
$downloadDir = Join-Path $env:TEMP ('journal-tunnel-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadDir | Out-Null
try {
    $winsw = Join-Path $downloadDir 'WinSW-x64.exe'
    $zip = Join-Path $downloadDir 'tunnel-client.zip'
    Get-VerifiedDownload $dependencies.winsw.url $dependencies.winsw.sha256 $winsw
    Get-VerifiedDownload $dependencies.tunnelClient.url $dependencies.tunnelClient.sha256 $zip
    Copy-Item -LiteralPath $winsw -Destination (Join-Path $resolvedInstall 'PoyiJournalTunnel.exe') -Force
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $resolvedInstall 'tunnel-client') -Force
} finally {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
}

$profileDir = Join-Path $resolvedData 'tunnel-profile'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
$client = Get-ChildItem -LiteralPath (Join-Path $resolvedInstall 'tunnel-client') `
    -Filter 'tunnel-client.exe' -Recurse | Select-Object -First 1
& $client.FullName init --profile journal --profile-dir $profileDir --force `
    --tunnel-id $TunnelId --mcp-server-url 'http://127.0.0.1:8780/mcp' `
    --health-listen-addr '127.0.0.1:8887' `
    --control-plane-api-key-ref 'env:CONTROL_PLANE_API_KEY'
if ($LASTEXITCODE -ne 0) { throw 'Journal Tunnel profile creation failed.' }
Protect-Secret $RuntimeApiKey (Join-Path $resolvedData 'tunnel-runtime-key.dpapi')

$configurationPath = Join-Path $resolvedInstall 'PoyiJournalTunnel.xml'
Copy-Item -LiteralPath (Join-Path $resolvedInstall 'mcp\tunnel\service.xml') -Destination $configurationPath -Force
[xml]$configuration = Get-Content -Raw -LiteralPath $configurationPath
foreach ($envNode in @($configuration.SelectNodes('/service/env'))) {
    if ($envNode.GetAttribute('name') -eq 'JOURNAL_MCP_DATA_DIR') {
        $envNode.SetAttribute('value', [string]$resolvedData)
    }
}
$configuration.SelectSingleNode('/service/logpath').InnerText = [string](Join-Path $resolvedData 'service-logs\tunnel')
$configuration.Save($configurationPath)

$existing = Get-Service -Name 'PoyiJournalTunnel' -ErrorAction SilentlyContinue
$serviceExe = Join-Path $resolvedInstall 'PoyiJournalTunnel.exe'
if ($null -ne $existing) {
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name 'PoyiJournalTunnel' -Force }
    & $serviceExe uninstall | Out-Null
}
& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw 'PoyiJournalTunnel service installation failed.' }

$serviceSid = 'NT SERVICE\PoyiJournalTunnel'
$tunnelLog = Join-Path $resolvedData 'service-logs\tunnel'
New-Item -ItemType Directory -Path $tunnelLog -Force | Out-Null
& icacls $resolvedInstall /grant:r "$serviceSid`:RX" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal Tunnel installation ACLs.' }
& icacls $resolvedInstall /grant:r "$serviceSid`:(OI)(CI)RX" | Out-Null
& icacls $resolvedData /grant:r "$serviceSid`:RX" | Out-Null
& icacls $profileDir /grant:r "$serviceSid`:RX" /T /C | Out-Null
& icacls $profileDir /grant:r "$serviceSid`:(OI)(CI)RX" | Out-Null
& icacls $tunnelLog /grant:r "$serviceSid`:M" /T /C | Out-Null
& icacls $tunnelLog /grant:r "$serviceSid`:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal Tunnel runtime ACLs.' }
& icacls (Join-Path $resolvedData 'tunnel-runtime-key.dpapi') /inheritance:r `
    /grant:r 'BUILTIN\Administrators:F' "$serviceSid`:R" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the Journal Tunnel runtime key.' }

Reserve-JournalPorts -StartPort 8887 -Count 1

& $serviceExe start
if ($LASTEXITCODE -ne 0) { throw 'PoyiJournalTunnel service failed to start.' }
Write-Host 'Installed independent PoyiJournalTunnel.' -ForegroundColor Green
