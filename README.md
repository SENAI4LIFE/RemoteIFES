# RemoteIFES

Controle remoto e agendamento de climatização. Campus Guarapari (Edital nº 16/2026).

O sistema tem três partes:

```
RemoteIFES/
├── remoteifes-server/   # API + banco de dados (Node.js + SQLite)
├── remoteifes-web/      # Interface web (HTML/CSS/JS puro)
└── docs/                # Documentação institucional do projeto
```

Um ESP32 em cada sala liga/desliga o ar-condicionado e reporta status ao
servidor; a interface web é usada por professores/técnicos para controlar e
agendar as salas; o servidor guarda tudo em SQLite e aplica as regras de
permissão e agendamento.

## Requisitos

- **Node.js 22.13 ou mais recente**. O banco usa o módulo nativo
  `node:sqlite`, então não há dependência binária para compilar (evita
  bloqueios de Application Control/AppLocker no Windows e problemas de
  compilação entre plataformas).
  - Windows: instalador `.msi` em [nodejs.org](https://nodejs.org), ou
    `winget install OpenJS.NodeJS.LTS`.
  - Ubuntu/Debian: o `apt install nodejs` padrão costuma trazer uma versão
    antiga demais. Use o repositório da [NodeSource](https://github.com/nodesource/distributions):
    ```bash
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    ```
  - Alternativa multiplataforma (recomendada se for alternar entre versões do
    Node): [nvm](https://github.com/nvm-sh/nvm):
    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    nvm install 22
    nvm use 22
    ```
- **VS Code** com a extensão **Live Server** (Ritwick Dey) para rodar a
  interface web. Já sugerida em `.vscode/extensions.json`.

## Instalação e configuração

```bash
cd remoteifes-server
npm install
cp .env.example .env
```

Edite o `.env` conforme o ambiente antes de rodar o servidor pela primeira
vez:

| Variável              | Uso                                                           | Obrigatória                     |
| --------------------- | ------------------------------------------------------------- | ------------------------------- |
| `PORTA`               | porta HTTP do servidor (padrão `8080`)                        | não                             |
| `NODE_ENV`            | `production` ativa a restrição de CORS por `CORS_ORIGIN`      | não (padrão `development`)      |
| `CORS_ORIGIN`         | lista de origens permitidas, separadas por vírgula            | sim, em produção                |
| `DEVICE_TOKEN`        | token que os ESP32 devem enviar no cabeçalho `x-device-token` | sim, para o heartbeat funcionar |
| `SENHA_ADMIN_INICIAL` | fixa a senha do usuário `admin` no primeiro seed do banco     | não                             |

Sem `.env`, o servidor ainda sobe em modo desenvolvimento (CORS aberto), mas
o endpoint de heartbeat do ESP32 responde `503` até que `DEVICE_TOKEN` seja
definido.

## Rodando localmente

1. **Servidor** (obrigatório primeiro):

   ```bash
   cd remoteifes-server
   npm start
   ```

   Se aparecer `Servidor RemoteIFES rodando em http://localhost:8080`, deu
   certo. Um aviso `ExperimentalWarning: SQLite...` no console é esperado e
   não impede o funcionamento.

   Na primeira execução o servidor cria `data/remoteifes.db`, popula 18
   salas de exemplo (blocos `A`/`B`, andares `1`–`3`, código
   `BlocoAndar0Numero`, ex: `A101`) e o usuário `admin`. A senha do `admin` é
   gerada aleatoriamente e impressa **uma única vez** no console
   (`Seed: usuário admin criado (usuario: admin / senha: ...)`). Anote-a ou
   defina `SENHA_ADMIN_INICIAL` no `.env` antes de rodar. Troque a senha
   depois do primeiro acesso; o administrador cria os demais usuários e
   define o que cada um pode fazer.

2. **Interface web**: abra a pasta `remoteifes-web` no VS Code e, com o
   servidor já rodando, clique com o botão direito em `index.html` →
   **Open with Live Server**. Não precisa de `npm install`.

   > **Atenção:** abra a pasta `remoteifes-web` diretamente no VS Code, e não
   > a raiz do repositório. Se a raiz for aberta, o Live Server passa a
   > observar também `remoteifes-server/data/remoteifes.db`, que muda a
   > cada login, e recarrega a página sozinho, derrubando a sessão.

### Scripts do servidor

- `npm start` inicia o servidor lendo `.env` se existir
- `npm run dev` igual ao `start`, mas reinicia automaticamente a cada
  alteração de arquivo

## Navegação da interface web

- **Salas**. bloco → andar → lista de salas → painel (ligar/desligar,
  ajustar temperatura). Salas com agendamento ativo mostram o selo
  **agendada**; enquanto o agendamento estiver ativo, só quem criou (ou um
  administrador) pode controlar a sala manualmente.
- **Agendamentos**. criar/gerenciar horários de ligar/desligar por sala,
  semanais ou de data única.
- **Admin** (só aparece para administradores). criar usuários, conceder ou
  revogar permissões, ativar/desativar contas, trocar senha de outros
  usuários, ver sessões ativas/histórico e o log de comandos e eventos dos
  ESP32.

Para apontar a interface para outro servidor (ex: ao levar para produção),
edite `SERVER_URL` em `remoteifes-web/js/api.js`.

## API

Todas as rotas (exceto `/login` e `/dispositivo/heartbeat`) exigem o token
retornado pelo `/login`, enviado em `Authorization: Bearer <token>`.

| Rota                        | Método       | Autenticação                                 |
| --------------------------- | ------------ | -------------------------------------------- |
| `/login`                    | POST         |, (limitado a 10 tentativas / 15 min por IP) |
| `/logout`                   | POST         | usuário                                      |
| `/me`                       | GET          | usuário                                      |
| `/ping`                     | POST         | usuário (mantém a sessão ativa)              |
| `/salas`                    | GET          | usuário                                      |
| `/status?sala=A101`         | GET          | usuário                                      |
| `/comando`                  | POST         | usuário com permissão de controle            |
| `/agendamentos`             | GET          | usuário                                      |
| `/agendamentos`             | POST         | usuário com permissão de agendar             |
| `/agendamentos/:id`         | PATCH/DELETE | autor do agendamento ou administrador        |
| `/dispositivo/heartbeat`    | POST         | dispositivo (cabeçalho `x-device-token`)     |
| `/admin/usuarios`           | GET/POST     | administrador                                |
| `/admin/usuarios/:id`       | PATCH/DELETE | administrador                                |
| `/admin/usuarios/:id/login` | PATCH        | administrador                                |
| `/admin/usuarios/:id/senha` | PATCH        | administrador                                |
| `/admin/logs`               | GET/DELETE   | administrador                                |
| `/admin/sessoes`            | GET          | administrador                                |
| `/admin/sessoes/historico`  | GET/DELETE   | administrador                                |
| `/admin/dispositivos`       | GET          | administrador                                |
| `/admin/configuracoes`      | GET/PATCH    | administrador                                |

Comandos aceitos em `/comando`: `ligar`, `desligar`, `temperatura` (valor
entre `16` e `30`).

Parâmetros de data (`?data=`) usados em `/admin/logs`,
`/admin/sessoes/historico` e `/admin/dispositivos` devem estar no formato
`AAAA-MM-DD`.

## Banco de dados

SQLite via `node:sqlite`, arquivo em `remoteifes-server/data/remoteifes.db`
(criado e migrado automaticamente ao iniciar o servidor). Não precisa
instalar nem configurar um banco separado.

Tabelas principais:

| Tabela                   | Guarda                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `usuarios`               | login, hash da senha (bcrypt, nunca texto puro), nível de permissão, flags `podeControlar`/`podeAgendar`, status ativo |
| `salas`                  | código, bloco, andar, estado online/ligado, temperatura atual e alvo, último heartbeat                                  |
| `esp_eventos`            | histórico de online/offline reportado por cada ESP32                                                                    |
| `agendamentos`           | reservas por sala (dias da semana ou data única, horário, temperatura, modo)                                            |
| `agendamentos_execucoes` | registro de cada execução automática (liga/desliga), usado para tornar o agendador idempotente                          |
| `comandos_log`           | histórico de comandos manuais e automáticos aplicados a cada sala                                                       |
| `sessoes`                | tokens de sessão ativos/encerrados, usados para autenticação e telas de "usuários ativos"                               |
| `configuracoes`          | parâmetros ajustáveis pelo admin (timeout de inatividade, aviso de popup, limiar de "online")                           |

## Permissões

Cada usuário tem um `nivel`:

- **1. usuário comum**: acessa salas conforme as flags `podeControlar`
  (enviar comandos manuais) e `podeAgendar` (criar agendamentos).
- **2. administrador**: acesso total às rotas `/admin/*`, pode gerenciar
  usuários comuns, ver logs, sessões e configurações.
- **3. administrador principal (superadmin)**: único nível que pode
  conceder ou revogar privilégios de administrador a outra conta, e o único
  que pode alterar o próprio login/senha sem depender de outro admin. Não
  pode ser removido nem rebaixado.

## Agendamento e trava de sala

Enquanto um agendamento está ativo (dentro do dia/horário cadastrado), a sala
fica travada: só o usuário que criou o agendamento (ou um administrador) pode
enviar comandos manuais para ela. Isso evita que outra pessoa desligue um
ambiente que já está sendo controlado automaticamente.

O agendador roda a cada minuto no servidor e:

- **Alcança horários perdidos** (catch-up): se o servidor ficar fora do ar
  no minuto exato de ligar/desligar, ele aplica o comando assim que voltar,
  desde que ainda esteja dentro da janela do agendamento do dia.
- **É idempotente**: cada execução de "ligar" ou "desligar" fica registrada
  em `agendamentos_execucoes`; o agendador nunca repete o mesmo comando duas
  vezes no mesmo dia para o mesmo agendamento, mesmo que o processo reinicie.

Verificações automáticas do agendador:

- Agendamentos ativos. a cada 1 minuto
- Salas sem heartbeat do ESP32 (marcadas como offline). a cada 30 segundos
- Sessões abandonadas (sem uso há mais de 24h). a cada 15 minutos

## Integração com o ESP32

O dispositivo de cada sala envia um heartbeat periódico para
`POST /dispositivo/heartbeat`, autenticado por um token compartilhado (não
pelo login de um usuário):

```
POST /dispositivo/heartbeat
Content-Type: application/json
x-device-token: <valor de DEVICE_TOKEN no .env>

{ "sala": "A101", "ligado": true, "temperatura": 23.5 }
```

`ligado` e `temperatura` são opcionais. envie o que o dispositivo souber.
Sem heartbeat por 90 segundos, o servidor marca a sala como offline
automaticamente. O servidor não define o protocolo de rede entre si e o
ESP32 (Wi-Fi local, MQTT, etc.), apenas o contrato HTTP acima.

## Levando para produção (ex: Raspberry Pi)

1. Instale o Node.js 22+ no dispositivo que vai hospedar o servidor.
2. Copie a pasta `remoteifes-server` (`git clone` ou `scp`).
3. Configure o `.env` com `NODE_ENV=production`, `CORS_ORIGIN` com o(s)
   domínio(s) da interface web, e um `DEVICE_TOKEN` forte e único.
4. `npm install && npm start`.
5. Troque `SERVER_URL` em `remoteifes-web/js/api.js` pelo endereço do
   servidor em produção.
6. Sirva a interface web por HTTPS antes de sair do ambiente de testes.

## Estrutura do servidor

```
remoteifes-server/src/
├── app.js               # monta o Express, CORS e registra as rotas
├── config/database.js   # conexão única com o SQLite
├── db/                  # schema.js (tabelas e migrações) e seed.js (dados iniciais)
├── middlewares/auth.js  # exigirLogin, exigirAdmin, exigirPermissao
├── services/             # regras de negócio (salas, agendamentos, usuários, tokens, configurações)
├── routes/               # rotas HTTP, cada arquivo já contém seus handlers
├── scheduler/            # roda agendamentos, checa timeouts e sessões abandonadas
└── utils/                # limitador de tentativas de login, cálculo de horário
```

Separar `services/` (lógica) de `routes/` (HTTP) permite adicionar novos
recursos ou trocar o transporte (ex: WebSocket) sem reescrever regras já
prontas.

## Solução de problemas

- **`Cannot find module 'express'`**. rode `npm install` dentro de
  `remoteifes-server` antes de `npm start`.
- **`ExperimentalWarning: SQLite...`** no console. esperado, não é erro.
- **Sessão cai sozinha ao usar Live Server**. você provavelmente abriu a
  raiz do repositório no VS Code em vez da pasta `remoteifes-web`; veja o
  aviso na seção "Rodando localmente".
- **Login trava com** **`429`**. limite de tentativas de login atingido (10 a
  cada 15 minutos por IP); aguarde a janela expirar.
- **Heartbeat do ESP32 retorna** **`503`**. falta configurar `DEVICE_TOKEN` no
  `.env` do servidor.
- **Heartbeat ou chamada de outra origem retorna** **`403`**/erro de CORS em
  **produção**. adicione o domínio da interface web em `CORS_ORIGIN` no
  `.env` (obrigatório quando `NODE_ENV=production`).
- **Esqueci a senha do** **`admin`**. apague `remoteifes-server/data` (perde
  todos os dados) ou peça a outro administrador principal para trocar a
  senha pela tela de Admin; não há recuperação por e-mail.

## Documentação do projeto

`docs/Projeto_AC.pdf`, proposta submetida ao edital (contexto institucional,
metodologia, planos de trabalho).