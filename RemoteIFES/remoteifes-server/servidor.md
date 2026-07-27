# RemoteIFES — Servidor

API + banco SQLite. Fica entre a interface web e os ESP32 de cada sala.

## Ferramentas necessárias

- **Node.js** 22.13 ou mais recente ([nodejs.org](https://nodejs.org))
  - Windows: instalador `.msi` do site oficial, ou `winget install OpenJS.NodeJS.LTS`
  - Linux (Ubuntu): `sudo apt install nodejs npm` ou [nodesource](https://github.com/nodesource/distributions)

O banco usa o módulo `node:sqlite`, nativo do Node — não há dependência
binária (`.node`) para compilar ou aprovar, o que evita bloqueios de
Application Control/AppLocker no Windows e problemas de compilação entre
plataformas.

## Instalar e rodar

```bash
cd remoteifes-server
npm install
npm start
```

Se aparecer `Servidor RemoteIFES rodando em http://localhost:8080`, deu certo.
Um aviso `ExperimentalWarning: SQLite...` no console é esperado e não impede
o funcionamento.
O banco (`data/remoteifes.db`) é criado automaticamente na primeira execução,
com o usuário administrador e 18 salas de exemplo (blocos `A`/`B`, andares
`1`–`3`, código `BlocoAndar0Numero`, ex: `A101`).

- **Login do administrador:** `admin` / `admin` (trocar após o primeiro acesso)
- O administrador cria os demais usuários e concede permissões de controle e
  agendamento a cada um.

## Rotas principais

| Rota | Método | Autenticação |
|---|---|---|
| `/login` | POST | — |
| `/salas` | GET | usuário |
| `/status?sala=A101` | GET | usuário |
| `/comando` | POST | usuário com permissão de controle |
| `/agendamentos` | GET/POST/PATCH/DELETE | usuário com permissão de agendar |
| `/admin/usuarios` | GET/POST/PATCH/DELETE | administrador |
| `/admin/logs` | GET | administrador |
| `/admin/sessoes` | GET | administrador |

Token retornado pelo `/login` deve ser enviado em `Authorization: Bearer <token>`.

Comandos aceitos em `/comando`: `ligar`, `desligar`, `temperatura` (16–30).

## Regra de agendamento e trava de sala

Enquanto um agendamento está ativo (dentro do dia/horário cadastrado), a sala
fica travada: só o usuário que criou o agendamento (ou um administrador) pode
enviar comandos manuais para ela. Isso evita que outra pessoa desligue um
ambiente que já está sendo controlado automaticamente.

## Scripts

- `npm start` — inicia o servidor
- `npm run dev` — inicia com reinício automático a cada alteração de arquivo

## Levando para a Raspberry Pi

1. Instalar Node.js na Pi
2. Copiar esta pasta (`git clone` ou `scp`)
3. `npm install && npm start`
4. Trocar `SERVER_URL` em `remoteifes-web/js/api.js` pelo IP da Pi

## Estrutura

```
src/
├── app.js               # monta o Express e registra as rotas
├── config/database.js   # conexão única com o SQLite
├── db/                  # schema.js (tabelas) e seed.js (dados iniciais)
├── middlewares/auth.js  # exigirLogin, exigirAdmin, exigirPermissao
├── services/             # regras de negócio (salas, agendamentos, usuários, tokens)
├── routes/               # rotas HTTP, cada arquivo já contém seus handlers
└── scheduler/            # verifica agendamentos ativos a cada minuto
```

Separar `services/` (lógica) de `routes/` (HTTP) permite adicionar novos
recursos ou trocar o transporte (ex: WebSocket) sem reescrever regras já
prontas.

## Pendências conhecidas

- Comunicação real com o ESP32 ainda não existe (`TODO` em `salasService.js`).
- Trocar token em memória por algo persistente (ex: JWT) antes de produção.
- Servir por HTTPS antes de sair do ambiente de testes.
