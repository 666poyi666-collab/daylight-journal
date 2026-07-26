$ErrorActionPreference = 'Stop'
Start-Service -Name 'PoyiJournalMcp'
$tunnel = Get-Service -Name 'PoyiJournalTunnel' -ErrorAction SilentlyContinue
if ($null -ne $tunnel) { Start-Service -Name 'PoyiJournalTunnel' }
