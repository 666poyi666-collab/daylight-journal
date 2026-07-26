$services = @('PoyiJournalMcp', 'PoyiJournalTunnel') | ForEach-Object {
    Get-Service -Name $_ -ErrorAction SilentlyContinue
}
$services | Select-Object Name, Status, StartType
try { Invoke-RestMethod 'http://127.0.0.1:8780/readyz' -TimeoutSec 3 | ConvertTo-Json -Depth 4 }
catch { Write-Warning 'Journal MCP readiness endpoint is unavailable.' }
