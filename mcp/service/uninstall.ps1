[CmdletBinding()]
param(
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [switch]$PurgeData
)
$ErrorActionPreference = 'Stop'
foreach ($name in @('PoyiJournalTunnel', 'PoyiJournalMcp')) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($null -ne $service -and $service.Status -ne 'Stopped') { Stop-Service -Name $name -Force }
    $exe = Join-Path $InstallDir "$name.exe"
    if ($null -ne $service -and (Test-Path -LiteralPath $exe)) { & $exe uninstall | Out-Null }
}
$firewallRule = Get-NetFirewallRule -Name 'PoyiJournalSyncApi' -ErrorAction SilentlyContinue
if ($null -ne $firewallRule) { Remove-NetFirewallRule -Name 'PoyiJournalSyncApi' }
if ($PurgeData) {
    throw 'Data purge is intentionally not automatic. Remove ProgramData\Poyi\JournalMcp only after a verified export.'
}
Write-Host 'Journal services removed. Journal data was retained.' -ForegroundColor Green
