param(
    [string]$InstallDir = "$env:ProgramFiles\Poyi\JournalMcp",
    [string]$DataDir = "$env:ProgramData\Poyi\JournalMcp"
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @(
        '-NoProfile',
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        '-InstallDir', "`"$InstallDir`"",
        '-DataDir', "`"$DataDir`""
    ) -join ' '
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments
    exit
}

$entry = Join-Path $InstallDir 'mcp\pairing-cli.mjs'
if (-not (Test-Path -LiteralPath $entry)) {
    throw '未找到拾光配对程序，请先重新安装 Journal 服务。'
}

& node.exe $entry --data-dir $DataDir
if ($LASTEXITCODE -ne 0) { throw '生成配对码失败。' }
