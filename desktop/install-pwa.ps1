[CmdletBinding()]
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\Poyi\JournalPwa"
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$resolvedSource = (Resolve-Path -LiteralPath $sourceRoot).Path
$resolvedInstall = [IO.Path]::GetFullPath($InstallDir)
$allowedRoot = [IO.Path]::GetFullPath("$env:LOCALAPPDATA\Poyi")
if (-not $resolvedInstall.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'InstallDir must remain under LocalAppData\Poyi.'
}
if (-not (Test-Path -LiteralPath (Join-Path $resolvedSource 'dist\index.html'))) {
    throw 'Build dist before installing the Journal PWA.'
}

$entryPoint = Join-Path $resolvedInstall 'pwa-server.mjs'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entryPoint) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

New-Item -ItemType Directory -Path $resolvedInstall -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $resolvedSource 'dist') -Destination $resolvedInstall -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'pwa-server.mjs') -Destination $entryPoint -Force

$node = (Get-Command node.exe -ErrorAction Stop).Source
$startupDir = [Environment]::GetFolderPath('Startup')
$startupShortcut = Join-Path $startupDir 'PoyiJournalPwa.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startupShortcut)
$shortcut.TargetPath = $node
$shortcut.Arguments = "`"$entryPoint`""
$shortcut.WorkingDirectory = $resolvedInstall
$shortcut.WindowStyle = 7
$shortcut.Description = 'Poyi Journal installed PWA loopback host'
$shortcut.Save()

Start-Process -FilePath $node -ArgumentList @($entryPoint) `
    -WorkingDirectory $resolvedInstall -WindowStyle Hidden

$deadline = (Get-Date).AddSeconds(20)
do {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8782/' -TimeoutSec 2
    } catch {
        $response = $null
    }
    if ($null -ne $response -and $response.StatusCode -eq 200) { break }
    Start-Sleep -Milliseconds 200
} until ((Get-Date) -ge $deadline)
if ($null -eq $response -or $response.StatusCode -ne 200) {
    throw 'Journal PWA loopback host did not start.'
}

Write-Host "Installed Journal PWA host in $resolvedInstall" -ForegroundColor Green
