$ErrorActionPreference = 'Stop'
$mcp = Invoke-RestMethod 'http://127.0.0.1:8780/readyz' -TimeoutSec 3
$tunnel = Invoke-RestMethod 'http://127.0.0.1:8987/readyz' -TimeoutSec 3
if (-not $mcp.ok) { throw 'Journal MCP is not ready.' }
if ($null -eq $tunnel) { throw 'Journal Tunnel is not ready.' }
Write-Host 'Journal MCP and independent Secure MCP Tunnel are ready.' -ForegroundColor Green
