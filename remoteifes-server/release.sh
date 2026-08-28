#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

VERSAO="${1:-}"
if [ -z "$VERSAO" ]; then
  echo "Uso: bash release.sh <versao>    (ex.: bash release.sh 3.1.0)"
  echo "Cria o commit de versão, a tag v<versao> e envia para origin/main."
  ATUAL=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
  echo "Versão atual: $ATUAL"
  exit 1
fi

if ! echo "$VERSAO" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "versão inválida: use o formato X.Y.Z (ex.: 3.1.0)"
  exit 1
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "não é um repositório git."; exit 1; }
RAMO=$(git symbolic-ref --quiet --short HEAD || echo "")
[ "$RAMO" = "main" ] || { echo "faça o release a partir da branch main (atual: ${RAMO:-destacada})."; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "há alterações não commitadas; limpe a árvore antes do release."; git status --short; exit 1; }
git rev-parse --verify --quiet "refs/tags/v$VERSAO" >/dev/null && { echo "a tag v$VERSAO já existe."; exit 1; }

node -e "const f='package.json';const p=require('./'+f);p.version='$VERSAO';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n');"
git add package.json
git commit -m "Release v$VERSAO"
git tag -a "v$VERSAO" -m "Release v$VERSAO"

echo ""
echo "Commit e tag v$VERSAO criados localmente."
read -r -p "Enviar para origin/main agora (git push --follow-tags)? [s/N] " RESP || RESP=""
if [ "$RESP" = "s" ] || [ "$RESP" = "S" ]; then
  git push origin main --follow-tags
  echo "Enviado. Na máquina de produção: bash deploy.sh v$VERSAO"
else
  echo "Não enviado. Quando quiser: git push origin main --follow-tags"
fi
