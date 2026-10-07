$ErrorActionPreference = 'Stop'
$pythonExe = Join-Path $PSScriptRoot 'runtime\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    $command = Get-Command python, python3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        throw '未找到 Python。请完整解压便携项目，或安装 Python 3.11 及更新版本。'
    }
    $pythonExe = $command.Source
}
& $pythonExe (Join-Path $PSScriptRoot 'serve_local.py') --open
if ($LASTEXITCODE -ne 0) {
    throw '服务器启动失败，请查看上方错误信息。'
}
