$ErrorActionPreference = 'Stop'
$tunnel = Get-Service -Name 'PoyiJournalTunnel' -ErrorAction SilentlyContinue
if ($null -ne $tunnel -and $tunnel.Status -ne 'Stopped') { Stop-Service -Name 'PoyiJournalTunnel' -Force }
$mcp = Get-Service -Name 'PoyiJournalMcp' -ErrorAction SilentlyContinue
if ($null -ne $mcp -and $mcp.Status -ne 'Stopped') { Stop-Service -Name 'PoyiJournalMcp' -Force }
