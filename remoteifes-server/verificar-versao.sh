#!/usr/bin/env bash
# Verificação da versão em execução, compartilhada por deploy.sh e rollback.sh (carregada com ".").
# Espera SYSTEMCTL, ESPERA_SAUDE_TENTATIVAS e ESPERA_SAUDE_INTERVALO definidos pelo chamador.

# Descrição, para as mensagens, do que o processo em execução informa depois de ler_saude.
descrever_em_execucao() {
  if [ -n "$VERSAO_EM_EXECUCAO" ]; then
    echo "está em ${VERSAO_EM_EXECUCAO}"
  else
    echo "não a confirma (sem resposta do /health ou sem commit informado)"
  fi
}

# Lê o /health do processo em execução: SAUDE_CORPO recebe o corpo e VERSAO_EM_EXECUCAO o commit que
# ele informa (vazio se essa versão não o informa). Falha se o /health não responde saudável.
SAUDE_CORPO=""
VERSAO_EM_EXECUCAO=""
ler_saude() {
  VERSAO_EM_EXECUCAO=""
  SAUDE_CORPO=$(bash healthcheck.sh 2>/dev/null) || return 1
  VERSAO_EM_EXECUCAO=$(printf '%s' "$SAUDE_CORPO" | sed -n 's/.*"commit":"\([0-9a-f]\{40\}\)".*/\1/p')
  return 0
}

# Segundos de vida do processo reportados pelo último /health lido (vazio se ele não informa).
uptime_em_execucao() {
  printf '%s' "$SAUDE_CORPO" | sed -n 's/.*"uptimeSegundos":\([0-9]\{1,\}\).*/\1/p'
}

# A árvore do commit dado tem o módulo que põe o commit no /health? Uma versão sem ele nunca poderá
# confirmar a própria identidade; uma versão com ele, se não a informa, é outro processo.
versao_informa_commit() {
  git cat-file -e "${1}:./src/config/release.js" 2>/dev/null
}

REINICIO_EM=""
reiniciar_servico() {
  echo "Reiniciando remoteifes.service..."
  REINICIO_EM=$(date +%s)
  $SYSTEMCTL restart remoteifes.service || echo "aviso: 'systemctl restart' retornou erro; verificando qual versão está em execução mesmo assim."
}

# Um /health saudável não basta: um processo antigo que sobreviveu a um 'restart' que falhou responde
# igual. Só é sucesso quando o processo em execução informa exatamente o commit esperado. Se a versão
# esperada é anterior ao campo de commit no /health, a identidade não pode ser confirmada; nesse caso
# só se aceita um processo que comprovadamente subiu depois do reinício (uptimeSegundos menor que o
# tempo decorrido desde o 'restart'), e o registro diz que a identidade não foi confirmada.
# Resultado em VERSAO_EM_EXECUCAO, VERSAO_CONFIRMACAO/VERSAO_RESUMO (sucesso: para o registro e para a
# tela) e VERSAO_MOTIVO (falha). ROTULO_VERSAO nomeia a operação nas mensagens ("a nova versão", "a reversão").
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
