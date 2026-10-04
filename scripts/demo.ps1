$ErrorActionPreference = "Stop"
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PENDULUM_DB = Join-Path (Resolve-Path ".") "data/demo.sqlite"
Remove-Item -Force -ErrorAction SilentlyContinue $env:PENDULUM_DB,$env:PENDULUM_DB-wal,$env:PENDULUM_DB-shm

Write-Host "== 静止最低点 =="
node dist/cli/index.js import --config examples/static.json | Out-Null

Write-Host "== 小角度摆动：分段推进，重开 CLI 后继续 =="
$runJson = node dist/cli/index.js import --config examples/small-angle.json | ConvertFrom-Json
$id = $runJson.id
node dist/cli/index.js advance $id 1000 | Out-Null
node dist/cli/index.js advance $id 1000
node dist/cli/index.js energy $id
node dist/cli/index.js step $id 2000

Write-Host "== 连续旋转 =="
$spinJson = node dist/cli/index.js import --config examples/rotation.json | ConvertFrom-Json
node dist/cli/index.js advance $spinJson.id 1000 | Select-Object -First 15

Write-Host "== 首步手算顺序 =="
node dist/cli/index.js handcheck --config examples/small-angle.json

Write-Host "演示数据库: $env:PENDULUM_DB"
