[CmdletBinding()]
param(
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedData = [IO.Path]::GetFullPath($DataDir)
if (-not $resolvedData.StartsWith([IO.Path]::GetFullPath($env:ProgramData), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DataDir must be under ProgramData.'
}

function Get-AnonymousStatus([string]$Uri) {
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5 | Out-Null
        return 200
    } catch {
        # A refused connection carries no HTTP response object; report -1
        # instead of tripping StrictMode on the missing property.
        $response = $_.Exception.PSObject.Properties['Response']
        if ($null -ne $response -and $null -ne $response.Value) { return [int]$response.Value.StatusCode }
        return -1
    }
}

function Test-DynamicPortExclusion([int]$Port) {
    # Inside a dynamic WinNAT excluded range a privileged bind "succeeds" with
    # no reachable listener (BUG-019); administered ranges (*) are the Journal
    # reservation and are expected.
    foreach ($line in & netsh int ipv4 show excludedportrange protocol=tcp) {
        if ($line -match '^\s*(\d+)\s+(\d+)(\s*\*)?\s*$') {
            if ($Port -ge [int]$Matches[1] -and $Port -le [int]$Matches[2] -and -not $Matches[3]) { return $true }
        }
    }
    return $false
}

if ((Test-DynamicPortExclusion 8780) -or (Test-DynamicPortExclusion 8781)) {
    throw 'Journal ports 8780/8781 sit inside a dynamic WinNAT excluded port range; rerun mcp\service\install.ps1 to reserve them.'
}

$token = (Get-Content -Raw -LiteralPath (Join-Path $resolvedData 'journal-api-token')).Trim()
$headers = @{ Authorization = "Bearer $token" }
$anonymousStatus = Get-AnonymousStatus 'http://127.0.0.1:8780/v1/status'
$status = Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:8780/v1/status' -TimeoutSec 5
$capabilities = Invoke-RestMethod -Headers $headers -Uri 'http://127.0.0.1:8780/v1/capabilities' -TimeoutSec 5
$lanHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8781/healthz' -TimeoutSec 5
$lanAnonymousStatus = Get-AnonymousStatus 'http://127.0.0.1:8781/v1/status'
$lanMcpStatus = Get-AnonymousStatus 'http://127.0.0.1:8781/mcp'
$listenerProcesses = @(Get-NetTCPConnection -LocalPort 8780, 8781 -State Listen |
    Select-Object -ExpandProperty OwningProcess -Unique)

$auditPath = Join-Path $resolvedData 'logs\journal-mcp-audit.jsonl'
$audit = if (Test-Path -LiteralPath $auditPath) {
    Get-Content -Raw -LiteralPath $auditPath
} else {
    ''
}
$sensitiveValues = [Collections.Generic.List[string]]::new()
$journal = Get-Content -Raw -LiteralPath (Join-Path $resolvedData 'journals.json') | ConvertFrom-Json
foreach ($property in $journal.PSObject.Properties) {
    $entry = $property.Value
    foreach ($name in @('title', 'content', 'coverImage')) {
        $member = $entry.PSObject.Properties[$name]
        if ($null -ne $member -and $member.Value -is [string] -and $member.Value.Length -gt 0) {
            $sensitiveValues.Add($member.Value)
        }
    }
    $tags = $entry.PSObject.Properties['tags']
    if ($null -ne $tags) {
        foreach ($tag in @($tags.Value)) {
            if ($tag -is [string] -and $tag.Length -gt 0) { $sensitiveValues.Add($tag) }
        }
    }
}
$sensitiveValueFound = $audit.Contains($token)
foreach ($value in $sensitiveValues) {
    if ($audit.Contains($value)) { $sensitiveValueFound = $true }
}

$result = [pscustomobject]@{
    AnonymousStatus = $anonymousStatus
    AuthorizedState = $status.state
    ApiVersion = $capabilities.apiVersion
    Authentication = $capabilities.authentication
    ControlCommandCount = @($capabilities.controlCommands).Count
    LanHealth = $lanHealth.ok
    LanAnonymousStatus = $lanAnonymousStatus
    LanMcpStatus = $lanMcpStatus
    ListenerProcessCount = $listenerProcesses.Count
    AuditLineCount = @($audit -split "`n" | Where-Object { $_ }).Count
    SensitiveValueFound = $sensitiveValueFound
}
$result | ConvertTo-Json

if ($result.AnonymousStatus -ne 401 -or
    $result.AuthorizedState -ne 'ready' -or
    $result.ApiVersion -ne 1 -or
    $result.Authentication -ne 'bearer_token' -or
    $result.ControlCommandCount -ne 0 -or
    -not $result.LanHealth -or
    $result.LanAnonymousStatus -ne 401 -or
    $result.LanMcpStatus -ne 404 -or
    $result.ListenerProcessCount -ne 1 -or
    $result.SensitiveValueFound) {
    throw 'Journal service verification failed.'
}

$token = $null
