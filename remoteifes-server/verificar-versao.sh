#!/usr/bin/env bash
# Running-version verification shared by deploy.sh and rollback.sh (sourced with "."). Expects
# SYSTEMCTL, ESPERA_SAUDE_TENTATIVAS and ESPERA_SAUDE_INTERVALO set by the caller.

# Description, for messages, of what the running process reports after ler_saude.
descrever_em_execucao() {
  if [ -n "$VERSAO_EM_EXECUCAO" ]; then
    echo "está em ${VERSAO_EM_EXECUCAO}"
  else
    echo "não a confirma (sem resposta do /health ou sem commit informado)"
  fi
}

# Reads the running process's /health: SAUDE_CORPO receives the body and VERSAO_EM_EXECUCAO the
# commit it reports (empty when that version does not report it). Fails when /health does not answer
# healthy.
SAUDE_CORPO=""
VERSAO_EM_EXECUCAO=""
ler_saude() {
  VERSAO_EM_EXECUCAO=""
  SAUDE_CORPO=$(bash healthcheck.sh 2>/dev/null) || return 1
  VERSAO_EM_EXECUCAO=$(printf '%s' "$SAUDE_CORPO" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')
  return 0
}

# Process uptime in seconds reported by the last /health read (empty when not reported).
uptime_em_execucao() {
  printf '%s' "$SAUDE_CORPO" | sed -n 's/.*"uptimeSegundos":\([0-9]\{1,\}\).*/\1/p'
}

# Does the given commit's tree contain the module that puts the commit in /health? A version without
# it can never confirm its own identity; a version with it that does not report it is another
# process.
versao_informa_commit() {
  git cat-file -e "${1}:./src/config/release.js" 2>/dev/null
}

REINICIO_EM=""
reiniciar_servico() {
  echo "Reiniciando remoteifes.service..."
  REINICIO_EM=$(date +%s)
  $SYSTEMCTL restart remoteifes.service || echo "aviso: 'systemctl restart' retornou erro; verificando qual versão está em execução mesmo assim."
}

# A healthy /health is not enough: an old process that survived a failed 'restart' answers the same.
# Success requires the running process to report exactly the expected commit. When the expected
# version predates the commit field in /health, identity cannot be confirmed; then only a process
# that provably started after the restart (uptimeSegundos lower than the time since 'restart') is
# accepted, and the record states that identity was not confirmed. Result in VERSAO_EM_EXECUCAO,
# VERSAO_CONFIRMACAO/VERSAO_RESUMO (success: for the record and the screen) and VERSAO_MOTIVO
# (failure). ROTULO_VERSAO names the operation in messages ("a nova versão", "a reversão").
aguardar_versao() {
  local esperado="$1" uptime decorrido legado=0
  VERSAO_EM_EXECUCAO=""
  VERSAO_CONFIRMACAO=""
  VERSAO_RESUMO=""
  VERSAO_MOTIVO=""
  versao_informa_commit "$esperado" || legado=1
  for _ in $(seq 1 "$ESPERA_SAUDE_TENTATIVAS"); do
    if ler_saude; then
      if [ "$VERSAO_EM_EXECUCAO" = "$esperado" ]; then
        VERSAO_CONFIRMACAO="processo em execução confirmou ${esperado}"
        VERSAO_RESUMO="confirmado pelo processo em execução"
        return 0
      fi
      if [ -n "$VERSAO_EM_EXECUCAO" ]; then
        VERSAO_MOTIVO="o processo em execução continua em ${VERSAO_EM_EXECUCAO}, não em ${esperado} (o reinício não aplicou ${ROTULO_VERSAO:-essa versão})"
      elif [ "$legado" -eq 0 ]; then
        VERSAO_MOTIVO="o processo em execução não informa o commit, mas ${esperado} informaria: é outra versão (o reinício não aplicou ${ROTULO_VERSAO:-essa versão})"
      else
        uptime=$(uptime_em_execucao)
        decorrido=$(( $(date +%s) - ${REINICIO_EM:-0} ))
        if [ -z "$uptime" ]; then
          VERSAO_MOTIVO="o processo em execução não informa commit nem tempo de vida: não é possível verificar se ${esperado} subiu"
        elif [ -n "$REINICIO_EM" ] && [ "$uptime" -le $((decorrido + 2)) ]; then
          echo "aviso: ${esperado} é anterior ao campo de commit no /health, então a identidade do processo não pôde ser confirmada; aceito porque um processo saudável subiu ${uptime}s atrás, depois do reinício."
          VERSAO_CONFIRMACAO="identidade não confirmada: ${esperado} não informa commit; processo saudável reiniciado há ${uptime}s"
          VERSAO_RESUMO="$VERSAO_CONFIRMACAO"
          return 0
        else
          VERSAO_MOTIVO="o processo em execução não informa o commit e está no ar há ${uptime}s, ou seja, sobreviveu ao reinício (o reinício não aplicou ${esperado})"
        fi
      fi
    else
      VERSAO_MOTIVO="o /health não respondeu saudável"
    fi
    sleep "$ESPERA_SAUDE_INTERVALO"
  done
  return 1
}
