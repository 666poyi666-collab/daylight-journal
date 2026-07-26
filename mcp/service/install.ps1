[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

function Wait-Ready([int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try { $ready = Invoke-RestMethod 'http://127.0.0.1:8780/readyz' -TimeoutSec 2 }
        catch { $ready = $null }
        if ($null -ne $ready -and $ready.ok) { return }
        Start-Sleep -Milliseconds 500
    } until ((Get-Date) -ge $deadline)
    throw 'PoyiJournalMcp did not become ready.'
}

function Invoke-Quiet([string]$FilePath, [string[]]$ArgumentList) {
    # Native stderr noise must not become terminating under the Stop
    # preference; run with Continue and let callers judge the exit code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $FilePath @ArgumentList 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
}

function Invoke-Icacls([string[]]$ArgumentList) {
    Invoke-Quiet 'icacls' $ArgumentList
}

function Reserve-JournalPorts([int]$StartPort, [int]$Count) {
    # WinNAT re-picks its dynamic excluded port ranges after network-stack
    # events; when one lands on the Journal ports a privileged bind "succeeds"
    # with no reachable listener (BUG-019). An administered exclusion pins the
    # ports so dynamic ranges avoid them permanently.
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
    if ($added -ne 0) { throw "Failed to reserve Journal ports $StartPort-$endPort against dynamic exclusions." }
}

function Wait-TunnelReady([int]$TimeoutSeconds = 45) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try { $ready = Invoke-RestMethod 'http://127.0.0.1:8887/readyz' -TimeoutSec 2 }
        catch { $ready = $null }
        if ($ready -eq 'ready') { return }
        Start-Sleep -Milliseconds 500
    } until ((Get-Date) -ge $deadline)
    throw 'PoyiJournalTunnel did not become ready after the MCP upgrade.'
}

Assert-Administrator
$sourceRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$resolvedSource = (Resolve-Path -LiteralPath $sourceRoot).Path
$resolvedInstall = [IO.Path]::GetFullPath($InstallDir)
$resolvedData = [IO.Path]::GetFullPath($DataDir)
if (-not $resolvedInstall.StartsWith([IO.Path]::GetFullPath($env:ProgramFiles), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallDir must be under Program Files.'
}
if (-not $resolvedData.StartsWith([IO.Path]::GetFullPath($env:ProgramData), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DataDir must be under ProgramData.'
}

$tunnel = Get-Service -Name 'PoyiJournalTunnel' -ErrorAction SilentlyContinue
$tunnelWasRunning = $null -ne $tunnel -and $tunnel.Status -eq 'Running'
$existing = Get-Service -Name 'PoyiJournalMcp' -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name 'PoyiJournalMcp' -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    $oldExe = Join-Path $resolvedInstall 'PoyiJournalMcp.exe'
    if (Test-Path -LiteralPath $oldExe) { & $oldExe uninstall | Out-Null }
}

# A force-killed WinSW wrapper can leave its Node child behind; the absolute
# entry point makes cleanup specific to Journal and prevents split listeners.
$entryPoint = Join-Path $resolvedInstall 'mcp\main.mjs'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entryPoint) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

New-Item -ItemType Directory -Path $resolvedInstall, $resolvedData -Force | Out-Null
foreach ($name in @('mcp', 'journal-api.mjs', 'journal-store.mjs', 'sync-merge.mjs',
        'mcp-server.mjs', 'package.json', 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $resolvedSource $name) -Destination $resolvedInstall -Recurse -Force
}

$sourceJournal = Join-Path $resolvedSource 'data\journals.json'
$targetJournal = Join-Path $resolvedData 'journals.json'
if ((Test-Path -LiteralPath $sourceJournal) -and -not (Test-Path -LiteralPath $targetJournal)) {
    Copy-Item -LiteralPath $sourceJournal -Destination $targetJournal
}

Push-Location $resolvedInstall
try {
    & npm.cmd ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
} finally {
    Pop-Location
}

$dependencies = Get-Content -Raw -LiteralPath (Join-Path $resolvedInstall 'mcp\service\dependencies.json') | ConvertFrom-Json
$downloadDir = Join-Path $env:TEMP ('journal-mcp-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadDir | Out-Null
try {
    $winsw = Join-Path $downloadDir 'WinSW-x64.exe'
    Get-VerifiedDownload $dependencies.winsw.url $dependencies.winsw.sha256 $winsw
    Copy-Item -LiteralPath $winsw -Destination (Join-Path $resolvedInstall 'PoyiJournalMcp.exe') -Force
} finally {
    Remove-Item -LiteralPath $downloadDir -Recurse -Force -ErrorAction SilentlyContinue
}

$configurationPath = Join-Path $resolvedInstall 'PoyiJournalMcp.xml'
Copy-Item -LiteralPath (Join-Path $resolvedInstall 'mcp\service\service.xml') -Destination $configurationPath -Force
[xml]$configuration = Get-Content -Raw -LiteralPath $configurationPath
$node = (Get-Command node.exe -ErrorAction Stop).Source
$configuration.SelectSingleNode('/service/executable').InnerText = [string]$node
foreach ($envNode in @($configuration.SelectNodes('/service/env'))) {
    if ($envNode.GetAttribute('name') -eq 'JOURNAL_DATA_DIR') {
        $envNode.SetAttribute('value', [string]$resolvedData)
    }
}
$configuration.SelectSingleNode('/service/logpath').InnerText = [string](Join-Path $resolvedData 'service-logs\mcp')
$configuration.Save($configurationPath)

$serviceExe = Join-Path $resolvedInstall 'PoyiJournalMcp.exe'
& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw 'PoyiJournalMcp service installation failed.' }

$serviceSid = 'NT SERVICE\PoyiJournalMcp'
$auditDir = Join-Path $resolvedData 'logs'
$serviceLogDir = Join-Path $resolvedData 'service-logs\mcp'
New-Item -ItemType Directory -Path $auditDir, $serviceLogDir -Force | Out-Null
Invoke-Icacls @($resolvedInstall, '/grant:r', "$serviceSid`:RX", '/T', '/C')
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal installation ACLs.' }
Invoke-Icacls @($resolvedInstall, '/grant:r', "$serviceSid`:(OI)(CI)RX")
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal installation inheritance.' }

# Existing files need direct ACEs; propagation flags only govern future children.
# The recursive grant must skip Tunnel-owned objects: its WinSW log stays locked
# while the Tunnel service runs, and the DPAPI runtime key must never carry a
# Journal MCP ACE.
Invoke-Icacls @($resolvedData, '/inheritance:r', '/grant:r', 'BUILTIN\Administrators:F', "$serviceSid`:M")
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal data ACLs.' }
$dataTargets = @(
    Get-ChildItem -LiteralPath $resolvedData -Force |
        Where-Object { $_.Name -ne 'service-logs' -and $_.Name -ne 'tunnel-runtime-key.dpapi' } |
        ForEach-Object { $_.FullName }
) + @($serviceLogDir)
foreach ($dataTarget in $dataTargets) {
    Invoke-Icacls @($dataTarget, '/grant:r', 'BUILTIN\Administrators:F', "$serviceSid`:M", '/T', '/C')
    if ($LASTEXITCODE -ne 0) { throw "Failed to configure Journal data ACLs for $dataTarget." }
}
Invoke-Icacls @($resolvedData, '/grant:r', 'BUILTIN\Administrators:(OI)(CI)F', "$serviceSid`:(OI)(CI)M")
if ($LASTEXITCODE -ne 0) { throw 'Failed to configure Journal data ACLs.' }

$firewallRule = Get-NetFirewallRule -Name 'PoyiJournalSyncApi' -ErrorAction SilentlyContinue
if ($null -eq $firewallRule) {
    New-NetFirewallRule -Name 'PoyiJournalSyncApi' -DisplayName 'Poyi Journal Sync API' `
        -Description 'Authenticated Journal business API; MCP remains loopback-only.' `
        -Enabled True -Profile Private -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort 8781 -RemoteAddress LocalSubnet -Program $node | Out-Null
} else {
    Set-NetFirewallRule -Name 'PoyiJournalSyncApi' -Enabled True -Profile Private `
        -Direction Inbound -Action Allow -Program $node | Out-Null
    $firewallRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter `
        -Protocol TCP -LocalPort 8781 | Out-Null
    $firewallRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter `
        -RemoteAddress LocalSubnet | Out-Null
}

Reserve-JournalPorts -StartPort 8780 -Count 2

& $serviceExe start
if ($LASTEXITCODE -ne 0) { throw 'PoyiJournalMcp service failed to start.' }
Wait-Ready
if ($tunnelWasRunning) {
    Start-Service -Name 'PoyiJournalTunnel'
    Wait-TunnelReady
}
Write-Host "Installed PoyiJournalMcp in $resolvedInstall" -ForegroundColor Green
