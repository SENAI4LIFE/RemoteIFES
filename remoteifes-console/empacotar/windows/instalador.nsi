; Operations Console installer for Windows.
;
; This is a front end for `instalacao\instalar.js`, the same portable installer used on Linux and
; macOS. It does not decide anything the portable installer already decides: the destination chosen
; here is passed as `--raiz`, so there is one answer to where the program goes. What this script adds
; is what only a Windows installer can add: a double-clickable executable, an entry in Programs and
; Features, an optional desktop shortcut, and a window that shows the installer's real progress.
;
; Built by `empacotar/construir.js` with makensis. The executable is NOT signed: without signing
; credentials it is a development/validation artifact and SmartScreen will warn about it.
;
; Defines expected from the build:
;   VERSAO   program version
;   PAYLOAD  directory holding the payload to install (the same tree as the .zip)
;   SHIM     absolute path of desinstalar-console.js
;   SAIDA    output file
;
; Switches (silent install): /S [/D=<dir>] [/ATALHO] [/CHECKOUT=<dir>]
;   /ATALHO    also create the desktop shortcut
;   /CHECKOUT  records the managed RemoteIFES checkout
; /D must be last and unquoted, as NSIS requires.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSAO
  !error "VERSAO não definida"
!endif
!ifndef PAYLOAD
  !error "PAYLOAD não definido"
!endif
!ifndef SHIM
  !error "SHIM não definido"
!endif
!ifndef SAIDA
  !error "SAIDA não definida"
!endif

!define NOME "Console de Operações RemoteIFES"
!define CHAVE_DESINSTALAR "Software\Microsoft\Windows\CurrentVersion\Uninstall\RemoteIFESConsole"

Name "${NOME}"
OutFile "${SAIDA}"
BrandingText "RemoteIFES"
; Per-user installation: no elevation, and the scheduled task that starts the Console on logon is
; registered for this user. A machine-wide installation is a separate, documented elevated path
; (instalar.ps1 -Escopo sistema), so this executable never asks for privilege it does not need.
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\RemoteIFES Console"
InstallDirRegKey HKCU "${CHAVE_DESINSTALAR}" "InstallLocation"

VIProductVersion "${VERSAO}.0"
VIAddVersionKey "ProductName" "${NOME}"
VIAddVersionKey "ProductVersion" "${VERSAO}"
VIAddVersionKey "FileVersion" "${VERSAO}"
VIAddVersionKey "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey "CompanyName" "RemoteIFES"
VIAddVersionKey "LegalCopyright" "RemoteIFES"

Var Node
Var Reparo
Var CriarAtalho
Var Checkout

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${NOME}"
!define MUI_WELCOMEPAGE_TEXT "Este instalador prepara o console que cuida do servidor RemoteIFES: serviço, configuração de infraestrutura, atualização, backup e diagnóstico do host.$\r$\n$\r$\nA operação do prédio (salas, agendamentos, usuários e ESP32) continua no aplicativo RemoteIFES.$\r$\n$\r$\nÉ necessário o Node.js 22.13 ou mais novo, o mesmo runtime que o RemoteIFES exige."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION AbrirConsole
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o console agora"
!define MUI_FINISHPAGE_TEXT "O console está instalado. Abra-o pelo Menu Iniciar sempre que precisar: ele não mantém processo em segundo plano e informar o estado do servidor não o inicia."
!define MUI_UNCONFIRMPAGE_TEXT_TOP "O programa será removido. Operadores, auditoria e backups do console são preservados, e o checkout do RemoteIFES não é tocado."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom PaginaOpcoes PaginaOpcoesSair
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "PortugueseBR"

; --- Finish page ------------------------------------------------------------------------------
; wscript.exe is a GUI-subsystem program, so opening the Console does not flash a console window.
Function AbrirConsole
  ${If} ${FileExists} "$INSTDIR\abrir-console.vbs"
    Exec '"wscript.exe" "$INSTDIR\abrir-console.vbs"'
  ${EndIf}
FunctionEnd

; --- Node -------------------------------------------------------------------------------------
; Same order as instalar.ps1: the Node on PATH, then the standard installation locations. A
; machine-wide Node is not always on the PATH of a freshly started process.
Function ResolverNode
  StrCpy $Node ""
  SearchPath $Node "node.exe"
  ${If} $Node != ""
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\nodejs\node.exe"
    StrCpy $Node "$PROGRAMFILES64\nodejs\node.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\nodejs\node.exe"
    StrCpy $Node "$PROGRAMFILES32\nodejs\node.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\nodejs\node.exe"
    StrCpy $Node "$LOCALAPPDATA\Programs\nodejs\node.exe"
  ${EndIf}
FunctionEnd

Function .onInit
  StrCpy $CriarAtalho "0"
  StrCpy $Checkout ""
  StrCpy $Reparo "0"
  ReadRegStr $0 HKCU "${CHAVE_DESINSTALAR}" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\console-bootstrap.js"
    StrCpy $Reparo "1"
  ${EndIf}

  ${GetParameters} $R0
  ${GetOptions} $R0 "/ATALHO" $R1
  ${IfNot} ${Errors}
    StrCpy $CriarAtalho "1"
  ${EndIf}
  ${GetOptions} $R0 "/CHECKOUT=" $R1
  ${IfNot} ${Errors}
    StrCpy $Checkout $R1
  ${EndIf}
FunctionEnd

; --- Options page -----------------------------------------------------------------------------
Var Dialogo
Var CaixaAtalho

Function PaginaOpcoes
  ${If} $Reparo == "1"
    !insertmacro MUI_HEADER_TEXT "Opções" "Uma instalação do console já existe neste computador e será reparada."
  ${Else}
    !insertmacro MUI_HEADER_TEXT "Opções" "Escolha o que mais deve ser criado."
  ${EndIf}
  nsDialogs::Create 1018
  Pop $Dialogo
  ${If} $Dialogo == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 10u 100% 12u "Criar atalho na área de trabalho"
  Pop $CaixaAtalho
  ${If} $CriarAtalho == "1"
    ${NSD_Check} $CaixaAtalho
  ${EndIf}
  ${If} $Reparo == "1"
    ${NSD_CreateLabel} 0 34u 100% 34u "O reparo reinstala o programa e refaz a integração com o sistema. Operadores, auditoria, backups e o checkout do RemoteIFES não são alterados."
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 34u 100% 34u "O atalho do Menu Iniciar e a partida do console na entrada do usuário são configurados sempre. O console não fica residente: ele é aberto quando você precisa."
    Pop $0
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function PaginaOpcoesSair
  ${NSD_GetState} $CaixaAtalho $CriarAtalho
FunctionEnd

; --- Install ----------------------------------------------------------------------------------
Section "Console" SecConsole
  SetDetailsPrint both
  Call ResolverNode
  ${If} $Node == ""
    DetailPrint "Node.js não encontrado."
    MessageBox MB_OK|MB_ICONSTOP "O Node.js 22.13 ou mais novo não foi encontrado.$\r$\n$\r$\nInstale-o de https://nodejs.org/ e execute este instalador novamente. O console usa o mesmo runtime que o RemoteIFES exige."
    Abort "Node.js não encontrado."
  ${EndIf}
  DetailPrint "Node encontrado: $Node"

  ; The payload is extracted to the temporary plugin directory, which NSIS removes on exit: the
  ; installed program is the copy that instalar.js places under the destination, exactly as it is
  ; when an operator extracts the .zip and runs the installer by hand.
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\pacote"
  SetOutPath "$PLUGINSDIR\pacote"
  SetDetailsPrint textonly
  DetailPrint "Preparando os arquivos do console..."
  ; `\*` and not `\*.*`: a payload file without an extension would be silently left out of the
  ; installer, and the operator would only find out when the installed program failed to load.
  File /r "${PAYLOAD}\*"
  SetDetailsPrint both

  StrCpy $R0 '"$Node" "$PLUGINSDIR\pacote\instalacao\instalar.js" --escopo usuario --raiz "$INSTDIR"'
  ${If} $Checkout != ""
    StrCpy $R0 '$R0 --checkout "$Checkout"'
  ${EndIf}
  ${If} $Reparo == "1"
    StrCpy $R0 '$R0 --forcar'
  ${EndIf}

  ; ExecToLog shows the installer's own weighted progress ("[ 45%] Programa instalado") in this
  ; window. No console window appears, and nothing here advances on a timer.
  DetailPrint "Instalando o console..."
  nsExec::ExecToLog $R0
  Pop $0
  ${If} $0 != 0
    DetailPrint "O instalador terminou com o código $0."
    MessageBox MB_OK|MB_ICONSTOP "A instalação não foi concluída (código $0). A janela de detalhes mostra o que falhou."
    Abort "Instalação não concluída."
  ${EndIf}

  SetOutPath "$INSTDIR"
  File "${SHIM}"
  WriteUninstaller "$INSTDIR\desinstalar.exe"

  ${If} $CriarAtalho == "1"
    ; wscript.exe is a GUI-subsystem program: the shortcut opens the Console without flashing a
    ; console window. abrir-console.vbs is written by instalar.js, which has just run.
    ${If} ${FileExists} "$INSTDIR\abrir-console.vbs"
      CreateShortcut "$DESKTOP\${NOME}.lnk" "wscript.exe" '"$INSTDIR\abrir-console.vbs"' "" "" SW_SHOWNORMAL "" "${NOME}"
      DetailPrint "Atalho criado na área de trabalho."
    ${Else}
      DetailPrint "Atalho da área de trabalho não criado: abrir-console.vbs ausente."
    ${EndIf}
  ${EndIf}

  ; Programs and Features. Repair is not offered as a button because it is this same executable run
  ; again, which detects the installation and repairs it.
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "DisplayName" "${NOME}"
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "DisplayVersion" "${VERSAO}"
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "Publisher" "RemoteIFES"
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "UninstallString" '"$INSTDIR\desinstalar.exe"'
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "QuietUninstallString" '"$INSTDIR\desinstalar.exe" /S'
  WriteRegStr   HKCU "${CHAVE_DESINSTALAR}" "DisplayIcon" "$INSTDIR\desinstalar.exe"
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "EstimatedSize" "$0"
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoModify" 1
  WriteRegDWORD HKCU "${CHAVE_DESINSTALAR}" "NoRepair" 1
SectionEnd

; --- Uninstall --------------------------------------------------------------------------------
Section "Uninstall"
  SetDetailsPrint both
  Call un.ResolverNode
  ${If} $Node == ""
    DetailPrint "Node.js não encontrado: o programa não pode ser removido com segurança."
    MessageBox MB_OK|MB_ICONSTOP "O Node.js não foi encontrado. Quem remove o programa é o desinstalador do próprio console, que precisa dele.$\r$\n$\r$\nInstale o Node.js e repita, ou remova pelo terminal com o comando da documentação."
    Abort "Node.js não encontrado."
  ${EndIf}

  ; The payload uninstaller does the removal: it stops a running Console, removes the scheduled
  ; task and the Start Menu shortcut, refuses any directory that does not prove to be a Console
  ; installation, keeps the state and never touches the RemoteIFES checkout.
  nsExec::ExecToLog '"$Node" "$INSTDIR\desinstalar-console.js" --sim --raiz "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "O desinstalador do console terminou com o código $0."
    MessageBox MB_OK|MB_ICONSTOP "A remoção não foi concluída (código $0). A janela de detalhes mostra o que falhou; o programa continua instalado."
    Abort "Remoção não concluída."
  ${EndIf}

  Delete "$DESKTOP\${NOME}.lnk"
  Delete "$INSTDIR\desinstalar-console.js"
  ; Programs and Features runs the uninstaller without `_?=`, so NSIS has copied it to the temporary
  ; directory and it can delete itself here. With `_?=` (used by the CI check, which needs to wait
  ; for the process) it is still running and these two lines simply do nothing.
  Delete "$INSTDIR\desinstalar.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${CHAVE_DESINSTALAR}"
SectionEnd

Function un.ResolverNode
  StrCpy $Node ""
  SearchPath $Node "node.exe"
  ${If} $Node != ""
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\nodejs\node.exe"
    StrCpy $Node "$PROGRAMFILES64\nodejs\node.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\nodejs\node.exe"
    StrCpy $Node "$PROGRAMFILES32\nodejs\node.exe"
    Return
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\nodejs\node.exe"
    StrCpy $Node "$LOCALAPPDATA\Programs\nodejs\node.exe"
  ${EndIf}
FunctionEnd
