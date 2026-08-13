# RemoteIFES

Controle remoto e agendamento de climatização. Campus Guarapari (Edital nº 16/2026).

```
RemoteIFES/
├── remoteifes-server/   # API + banco de dados (Node.js + SQLite)
├── remoteifes-web/      # Interface web de controle e administração (HTML/CSS/JS puro)
├── remoteifes-esp32/    # Firmware da ESP32 (clonagem/replicação de IR + webserver local)
└── docs/                # Documentação institucional do projeto
```

## Arquitetura

Cada sala tem uma ESP32 conectada ao ar-condicionado por infravermelho. Essa
ESP32 tem duas frentes ao mesmo tempo:

1. **Webserver local próprio.** Ao entrar na rede Wi-Fi da sala, a ESP32
   expõe uma página (servida por ela mesma, sem depender do servidor
   central) usada para aprender o controle físico do ar-condicionado por
   IR, calibrar protocolos desconhecidos e operar um termostato virtual
   (ligar/desligar, temperatura, turbo) por WebSocket. É a mesma tela usada
   no primeiro setup de Wi-Fi (modo ponto de acesso `RemoteIFES-Setup`) e,
   depois de configurada, no IP que a ESP32 recebe da rede local.
2. **Cliente HTTP do servidor central.** Em paralelo, a ESP32 se reporta ao
   `remoteifes-server`, autenticada por um token de dispositivo
   (`x-device-token`), em três frentes:
   - heartbeat periódico de status (sala, ligado, temperatura) em
     `POST /dispositivo/heartbeat`;
   - registro de acesso sempre que alguém abre a página local da ESP32, em
     `POST /dispositivo/acesso` (IP e User-Agent de quem acessou);
   - registro de cada comando emitido na página local (modo, captura de
     sinal IR, controle nativo/raw, reset de Wi-Fi), em
     `POST /dispositivo/comando`.

O `remoteifes-server` centraliza tudo em SQLite e expõe a API usada pela
`remoteifes-web`: cadastro de salas e usuários, agendamentos, o histórico de
comandos (`comandos_log`, agora populado tanto por comandos manuais/agenda
quanto pelos comandos emitidos localmente na ESP32) e o novo histórico de
acessos ao webserver de cada ESP32 (`esp_acessos`). A interface web
(`remoteifes-web`) é usada por professores/técnicos para controlar e
agendar salas, e pelo administrador para ver quem acessou o painel de cada
ESP32 e quais comandos foram emitidos, tudo pela mesma aba **Admin** já
existente (sub-abas **Logs** e **Acessos ESP32**).

```
Smartphone/PC (rede da sala)          Navegador (professor/técnico/admin)
        │  abre a página local da ESP32        │  usa a remoteifes-web
        ▼                                        ▼
   ┌─────────────┐   heartbeat / acesso   ┌──────────────────┐
   │   ESP32     │ ─────────────────────▶ │ remoteifes-server │◀── login/API
   │ (webserver  │        comando         │   (Node + SQLite) │
   │  local, IR) │ ─────────────────────▶ │                   │
   └─────────────┘                        └──────────────────┘
```

Ver também `docs/esboco-arquitetura.jpeg` e `docs/Projeto_AC.pdf` para o
contexto institucional completo do projeto.

### Banco de dados (tabelas principais)

| Tabela                     | Guarda                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `usuarios`                 | login, hash da senha (bcrypt), nível de permissão, flags `podeControlar`/`podeAgendar`     |
| `salas`                    | código, bloco, andar, estado online/ligado, temperatura, último heartbeat                  |
| `esp_eventos`              | histórico de online/offline reportado por cada ESP32                                       |
| `esp_acessos`              | quem (IP/User-Agent) acessou a página local de cada ESP32 e quando                         |
| `agendamentos` / `agendamentos_execucoes` | reservas por sala e execuções automáticas do agendador                      |
| `comandos_log`             | comandos manuais, automáticos (agenda) e locais (`origem: esp32_local`) por sala           |
| `sessoes`                  | tokens de sessão ativos/encerrados dos usuários da interface web                           |
| `configuracoes`            | parâmetros ajustáveis pelo admin (timeout, aviso de popup, limiar de "online")             |

### Permissões

- **1. usuário comum**: controla/agenda salas conforme suas flags.
- **2. administrador**: acesso às rotas `/admin/*` (usuários, logs, acessos
  às ESP32, sessões, configurações).
- **3. administrador principal (superadmin)**: único que concede/revoga
  admin e altera o próprio login/senha sem depender de outro admin.

### API (resumo)

Todas as rotas (exceto `/login` e as de `/dispositivo/*`) exigem
`Authorization: Bearer <token>` obtido em `/login`. As rotas de
`/dispositivo/*` exigem o cabeçalho `x-device-token`.

| Rota                                 | Método                 | Autenticação                     |
| ------------------------------------- | ----------------------- | --------------------------------- |
| `/login`, `/logout`, `/me`, `/ping`   | POST/GET                | usuário                           |
| `/salas`, `/status`                   | GET                      | usuário                           |
| `/comando`                            | POST                     | usuário com permissão de controle |
| `/agendamentos`                       | GET/POST/PATCH/DELETE   | usuário / autor / admin           |
| `/dispositivo/heartbeat`              | POST                     | dispositivo (`x-device-token`)    |
| `/dispositivo/acesso`                 | POST                     | dispositivo (`x-device-token`)    |
| `/dispositivo/comando`                | POST                     | dispositivo (`x-device-token`)    |
| `/admin/usuarios`, `/admin/logs`, `/admin/sessoes`, `/admin/dispositivos`, `/admin/acessos`, `/admin/configuracoes` | GET/POST/PATCH/DELETE | administrador |

## Setup

### 1. Requisitos

- **Node.js 22.13+** para o `remoteifes-server` (usa `node:sqlite`, sem
  dependência binária).
- **VS Code** com a extensão **Live Server** para servir a `remoteifes-web`.
- **Arduino IDE 1.8.x/2.x** (ou PlatformIO) com suporte a placas ESP32 e as
  bibliotecas: `WebSocketsServer`, `DHT sensor library`,
  `IRremoteESP8266` (inclui `IRrecv`, `IRsend`, `IRutils`, `IRac`).
  `WiFi`, `WebServer`, `DNSServer`, `Preferences` e `HTTPClient` já vêm no
  pacote da placa ESP32.

### 2. Servidor (`remoteifes-server`)

```bash
cd remoteifes-server
npm install
cp .env.example .env
```

Edite o `.env`:

| Variável              | Uso                                                            | Obrigatória                     |
| --------------------- | --------------------------------------------------------------- | -------------------------------- |
| `PORTA`               | porta HTTP do servidor (padrão `8080`)                          | não                              |
| `NODE_ENV`            | `production` ativa a restrição de CORS por `CORS_ORIGIN`        | não (padrão `development`)       |
| `CORS_ORIGIN`         | origens permitidas, separadas por vírgula                        | sim, em produção                 |
| `DEVICE_TOKEN`        | token que as ESP32 enviam em `x-device-token`                   | sim, para heartbeat/acesso/comando funcionarem |
| `SENHA_ADMIN_INICIAL` | fixa a senha do usuário `admin` no primeiro seed do banco        | não                              |

```bash
npm start
```

Na primeira execução o servidor cria `data/remoteifes.db`, popula salas de
exemplo e o usuário `admin` (senha impressa uma única vez no console, ou a
definida em `SENHA_ADMIN_INICIAL`). O código de cada sala (ex: `A101`)
cadastrado aqui é o mesmo que será digitado na configuração da ESP32
daquela sala.

### 3. Interface web (`remoteifes-web`)

Com o servidor já rodando, abra a pasta `remoteifes-web` (e não a raiz do
repositório) no VS Code e use **Open with Live Server** em `index.html`.
Para apontar a interface para outro servidor, edite `SERVER_URL` em
`remoteifes-web/js/api.js`.

### 4. Firmware da ESP32 (`remoteifes-esp32`)

1. No Arduino IDE, adicione a URL da placa ESP32 em
   `Arquivo > Preferências > URLs adicionais para gerenciadores de placas`:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`.
2. Em `Ferramentas > Placa > Gerenciador de Placas`, instale "ESP32 by
   Espressif Systems".
3. Instale as bibliotecas listadas em Requisitos via
   `Sketch > Incluir Biblioteca > Gerenciar Bibliotecas`.
4. Conecte a ESP32 por USB, selecione a placa (`ESP32 Dev Module`) e a
   porta corretas.
5. Abra `remoteifes-esp32/remoteifes_esp32.ino` e carregue o sketch
   (`Sketch > Carregar`). O arquivo `index_html.h` é usado automaticamente
   pelo sketch, não precisa ser aberto à parte.

### 5. Primeira configuração de cada ESP32

1. Ao ligar sem Wi-Fi configurado, a ESP32 cria a rede `RemoteIFES-Setup`.
   Conecte um celular/notebook a ela.
2. Acesse `http://192.168.4.1` e preencha: SSID e senha da rede Wi-Fi da
   sala, o **código da sala** já cadastrado no servidor (ex: `A101`), o
   **endereço** e a **porta** do `remoteifes-server`, e o **token do
   dispositivo** (o mesmo valor de `DEVICE_TOKEN` do `.env` do servidor).
3. Ao salvar, a ESP32 reinicia e conecta à rede Wi-Fi informada.
4. Com a ESP32 conectada, acesse o IP atribuído a ela pelo roteador local
   para abrir a página de aprendizado/controle do ar-condicionado daquela
   sala. Esse acesso já aparece no servidor.

### 6. Verificação

Na `remoteifes-web`, aba **Admin**: a sub-aba **Dispositivos** mostra a
sala ficando online após o primeiro heartbeat; **Acessos ESP32** mostra
quem abriu a página local da ESP32 (IP e horário); **Logs** mostra os
comandos emitidos na página local da ESP32 (`origem: esp32_local`) junto
com os comandos manuais e de agendamento.

## Produção (ex: Raspberry Pi)

1. Instale Node.js 22+ no dispositivo que vai hospedar o servidor.
2. Copie a pasta `remoteifes-server` para o dispositivo.
3. Configure `.env` com `NODE_ENV=production`, `CORS_ORIGIN` com o(s)
   domínio(s) da interface web, e um `DEVICE_TOKEN` forte e único.
4. `npm install && npm start`.
5. Atualize `SERVER_URL` em `remoteifes-web/js/api.js` e o host/porta
   configurados em cada ESP32 para o endereço de produção.
6. Sirva a interface web por HTTPS antes de sair do ambiente de testes.

## Solução de problemas

- **`Cannot find module 'express'`**: rode `npm install` em
  `remoteifes-server` antes de `npm start`.
- **Heartbeat/acesso/comando da ESP32 retornam `401`**: token de dispositivo
  divergente entre `.env` (`DEVICE_TOKEN`) e o campo salvo na ESP32.
- **Heartbeat/acesso/comando retornam `503`**: `DEVICE_TOKEN` não definido
  no `.env` do servidor.
- **`sala não encontrada`**: o código digitado na configuração da ESP32 não
  corresponde a nenhuma sala cadastrada no servidor.
- **Sessão cai sozinha ao usar Live Server**: abriu a raiz do repositório
  em vez da pasta `remoteifes-web` no VS Code.
- **Esqueci a senha do `admin`**: apague `remoteifes-server/data` (perde
  todos os dados) ou peça a outro administrador principal para trocá-la
  pela tela de Admin.
