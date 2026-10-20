<#
.SYNOPSIS
    Mede o custo de memoria e o arranque do Painel de Servidores.

.DESCRIPTION
    Sobe o executavel em dois cenarios e compara:
      - bandeja (--hidden): o app so no icone, sem WebView2;
      - janela: o painel aberto, com a WebView2 do sistema.

.EXAMPLE
    pwsh -File scripts/memoria.ps1
    pwsh -File scripts/memoria.ps1 -Exe "dist\PainelDeServidores\PainelDeServidores.exe"
#>
param(
    [string]$Exe = "dist\PainelDeServidores\PainelDeServidores.exe",
    [int]$EsperaSegundos = 18
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Exe)) {
    Write-Error "Executavel nao encontrado: $Exe"
    exit 1
}

$Exe = (Resolve-Path $Exe).Path


function Encerrar {
    Get-CimInstance Win32_Process -Filter "Name='PainelDeServidores.exe' OR Name='painel-servidores.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "PainelDeServidores|painel-servidores" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}


function Medir {
    param([string]$Modo)

    Encerrar
    $arguments = if ($Modo -eq "bandeja") { @("--hidden") } else { @() }

    $cronometro = [Diagnostics.Stopwatch]::StartNew()
    if ($arguments.Count -gt 0) {
        Start-Process -FilePath $Exe -ArgumentList $arguments -WorkingDirectory (Split-Path $Exe) -WindowStyle Hidden
    } else {
        Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe) -WindowStyle Hidden
    }

    $janela = $null
    for ($i = 0; $i -lt 100; $i++) {
        $p = Get-Process "PainelDeServidores", "painel-servidores" -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($p) { $janela = $p; break }
        Start-Sleep -Milliseconds 100
    }
    $arranque = if ($janela) { $cronometro.Elapsed.TotalSeconds } else { $null }

    Start-Sleep -Seconds $EsperaSegundos

    $rust = @(Get-Process "PainelDeServidores", "painel-servidores" -ErrorAction SilentlyContinue)
    $webview = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match "PainelDeServidores|painel-servidores" })

    $ramRust = ($rust | Measure-Object WorkingSet64 -Sum).Sum
    $ramWebview = 0
    foreach ($p in $webview) {
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc) { $ramWebview += $proc.WorkingSet64 }
    }

    [pscustomobject]@{
        Modo        = $Modo
        "RAM Rust"  = "{0:N0} MB" -f ($ramRust / 1MB)
        "WebView2"  = "{0:N0} MB ({1} proc)" -f ($ramWebview / 1MB), $webview.Count
        Total       = "{0:N0} MB" -f (($ramRust + $ramWebview) / 1MB)
        Arranque    = if ($arranque) { "{0:N1}s" -f $arranque } else { "nao abriu janela" }
    }
}


Write-Output ""
Write-Output "Painel de Servidores - custo de memoria"
Write-Output "========================================"
$medicoes = @(Medir -Modo "bandeja"; Medir -Modo "janela")
$medicoes | Format-Table -AutoSize
Write-Output "Executavel: $Exe"
Write-Output ("Tamanho:    {0:N2} MB" -f ((Get-Item $Exe).Length / 1MB))
Write-Output ""

Encerrar
