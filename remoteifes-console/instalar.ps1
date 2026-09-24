<#
    Console de Operações RemoteIFES — instalação no Windows.

    Este script é só a porta de entrada do .zip: quem instala é `instalacao\instalar.js`, o mesmo
    instalador portátil usado no Linux e no macOS. Aqui só se resolve o Node e se repassam os
    argumentos, para que o comportamento instalado seja idêntico nos três sistemas.

    Uso (PowerShell, na pasta descompactada):

        .\instalar.ps1                          instalação de usuário (recomendada)
        .\instalar.ps1 -Escopo sistema          exige console elevado
        .\instalar.ps1 -Checkout C:\RemoteIFES  associa o checkout administrado
        .\instalar.ps1 -SemServico              não registra a partida em segundo plano

    Nada aqui exige compilador, SDK ou pacote npm global: o console não tem dependências.
#>

[CmdletBinding()]
param(
    [ValidateSet("usuario", "sistema")]
    [string]$Escopo,
    [string]$Raiz,
    [string]$Estado,
    [string]$Checkout,
    [switch]$SemServico,
    [switch]$Forcar
)

$ErrorActionPreference = "Stop"
$origem = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolver-Node {
    # Ordem: o Node do PATH; depois as instalações padrão do MSI. Um Node só de usuário costuma
    # estar no PATH; um de máquina nem sempre está, numa sessão elevada recém-aberta.
    #
    # Cada base é conferida ANTES do Join-Path: com $ErrorActionPreference = "Stop", montar um
    # caminho sobre uma variável de ambiente ausente derruba o instalador com um erro de binding
    # que não diz nada ao operador. ${env:ProgramFiles(x86)} não existe em toda instalação.
    $candidatos = @()
    $doCaminho = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $doCaminho) { $candidatos += $doCaminho.Source }

    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not [string]::IsNullOrWhiteSpace($base)) { $candidatos += (Join-Path $base "nodejs\node.exe") }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidatos += (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    }

    foreach ($c in $candidatos) {
        if (-not [string]::IsNullOrWhiteSpace($c) -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}

$node = Resolver-Node
if ($null -eq $node) {
    Write-Host ""
    Write-Host "  Node.js nao encontrado." -ForegroundColor Red
    Write-Host ""
    Write-Host "  O console usa o mesmo runtime que o RemoteIFES exige (Node 22.13 ou mais novo)."
    Write-Host "  Instale-o de https://nodejs.org/ e repita este script."
    Write-Host ""
    exit 1
}

$instalador = Join-Path $origem "instalacao\instalar.js"
if (-not (Test-Path -LiteralPath $instalador)) {
    Write-Host ""
    Write-Host "  Pacote incompleto: instalacao\instalar.js nao esta nesta pasta." -ForegroundColor Red
    Write-Host "  Descompacte o .zip inteiro e rode o script de dentro da pasta descompactada."
    Write-Host ""
    exit 1
}

# A verificação de versão, o escopo e a permissão são decididos pelo instalador portátil, que é
# quem conhece o contrato. Duplicar essas regras aqui só criaria duas respostas para a mesma
# pergunta.
$argumentos = @($instalador)
if ($Escopo)   { $argumentos += @("--escopo", $Escopo) }
if ($Raiz)     { $argumentos += @("--raiz", $Raiz) }
if ($Estado)   { $argumentos += @("--estado", $Estado) }
if ($Checkout) { $argumentos += @("--checkout", $Checkout) }
if ($SemServico) { $argumentos += "--sem-servico" }
if ($Forcar)     { $argumentos += "--forcar" }

& $node @argumentos
exit $LASTEXITCODE
