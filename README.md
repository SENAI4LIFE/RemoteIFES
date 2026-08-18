# RemoteIFES

Sistema de controle remoto de ar-condicionado para as salas do IFES: painel web, agendamento diário, presets configuráveis por ESP32 e um servidor central em Node.js.

## Sumário

- [Visão Geral](#visão-geral)
- [Papéis e Permissões](#papéis-e-permissões)
- [Plantas Baixas e Seleção de Salas](#plantas-baixas-e-seleção-de-salas)
- [Controle de Acesso por Sala](#controle-de-acesso-por-sala)
- [Agendamentos](#agendamentos)
- [Presets de Ar-Condicionado](#presets-de-ar-condicionado)
- [Restrição de Rede](#restrição-de-rede)
- [Interface Web dos ESP32](#interface-web-dos-esp32)
- [Requisitos](#requisitos)
- [Instalação Rápida](#instalação-rápida)
- [Instalação Detalhada](#instalação-detalhada)
- [Configuração](#configuração)
- [Deploy](#deploy)
- [Domínio Próprio e HTTPS](#domínio-próprio-e-https)
- [Uso da API do GitHub](#uso-da-api-do-github)
- [Estrutura de Pastas](#estrutura-de-pastas)
- [Solução de Problemas](#solução-de-problemas)

## Visão Geral

O projeto é dividido em três partes independentes:

```
remoteifes-web/      Frontend estático (HTML/CSS/JS puro, sem build), publicado no GitHub Pages
remoteifes-server/   API central (Node.js + Express + SQLite), roda em um servidor/host próprio
remoteifes-esp32/    Firmware Arduino/ESP32 instalado em cada sala, ao lado do ar-condicionado
```

Fluxo geral:

1. Cada sala possui um **ESP32** com receptor/emissor de infravermelho, conectado à rede Wi-Fi local. O ESP32 aprende o protocolo IR do ar-condicionado, envia comandos e reporta seu estado (ligado/desligado, temperatura, MAC, IP) ao servidor central via HTTP, autenticado por um token de dispositivo (`DEVICE_TOKEN`).
2. O **servidor central** (`remoteifes-server`) mantém o banco de dados (SQLite), a lógica de autenticação, permissões, agendamentos, presets e configurações globais. Ele expõe uma API REST usada tanto pelo frontend web quanto pelos ESP32.
3. O **frontend** (`remoteifes-web`) é um site estático (sem framework de build) que fala com o servidor central via `fetch`. É hospedado no GitHub Pages e pode ser servido em um domínio próprio.

## Papéis e Permissões

O sistema tem três níveis de usuário:

| Nível | Papel | Pode |
|---|---|---|
| 1 | Usuário comum | Ligar/desligar e ajustar a temperatura das salas liberadas para controle |
| 2 | Administrador | Tudo do nível 1, além de gerenciar agendamentos, visualizar salas/dispositivos e usuários comuns |
| 3 | Administrador principal (superadmin) | Tudo do nível 2, além de alterar configurações globais do sistema, limites de temperatura, redes autorizadas, modo de teste, cadastro de ESP32 por MAC, presets e permissões de outros administradores |

Todas as permissões são impostas no backend (não apenas escondidas na interface): rotas administrativas exigem `exigirAdmin`, e as rotas/campos críticos exigem `exigirSuperAdmin`.

## Plantas Baixas e Seleção de Salas

A aba **Salas** exibe por padrão a planta baixa real do campus (Bloco A e Bloco B, térreo/2º/3º pavimentos), com abas para alternar entre os seis setores. Cada sala com ar-condicionado controlado pelo sistema aparece destacada e colorida conforme seu estado:

- cinza: offline (sem ESP32 reportando)
- azul: online, desligado
- verde: online, ligado
- contorno amarelo: com agendamento ativo no momento

Qualquer usuário autenticado pode visualizar a planta e o estado de todas as salas — isso inclui salas às quais o usuário não tem permissão de controle, que aparecem marcadas como "visualização" e cujos controles ficam desabilitados no painel. Um botão "Ver como lista" alterna para a navegação tradicional por bloco/andar (`Bloco → Andar → Sala`), preservada para quem preferir esse fluxo.

As 70 salas cadastradas por padrão vêm diretamente da planta baixa fornecida (`remoteifes-server/src/db/salasCampus.js`); ajuste esse arquivo se a planta do campus mudar (novas salas, renomeações, etc.) antes da primeira execução do servidor — o seed só roda quando o banco está vazio.

## Controle de Acesso por Sala

Além da permissão geral "pode controlar" (nível de usuário), o administrador principal pode restringir salas individuais em `Admin > ESP32 / Salas`:

1. Marcar uma sala como **acesso restrito** impede que qualquer usuário comum a controle, mesmo com a permissão geral ativa — exceto os usuários explicitamente autorizados para aquela sala.
2. Usuários autorizados são concedidos/revogados individualmente, por sala, na mesma tela.
3. Administradores (níveis 2 e 3) sempre podem controlar qualquer sala, independentemente de restrição.

A verificação é feita no backend (`aplicarComando`), então mesmo chamadas diretas à API respeitam a restrição — a interface apenas reflete o estado (desabilitando os controles e mostrando um aviso de "somente leitura") para dar feedback imediato ao usuário.

## Agendamentos

Agendamentos são **diários**: cada agendamento vale para uma única data (sem recorrência semanal). Apenas administradores podem criar, listar e gerenciar agendamentos — usuários comuns não têm acesso a essa funcionalidade, nem na interface nem na API.

## Presets de Ar-Condicionado

Presets descrevem quais **funções** um ar-condicionado suporta (temperatura, velocidade do ventilador, oscilação, modo turbo, etc.). A estrutura é extensível: uma função é apenas uma linha na tabela `preset_funcoes` (chave, rótulo, tipo, opções), então novas funções não exigem alterar código — apenas cadastrar a função em um preset.

- O preset **padrão** possui somente a função de temperatura.
- Novas funções são criadas e associadas a um preset diretamente pela interface web do próprio ESP32 (aba "Presets" na página local do dispositivo), que sincroniza a definição com o servidor central.
- O administrador principal decide quais presets existem, edita/remove funções e escolhe qual preset cada sala/ESP32 utiliza (`Admin > ESP32 / MACs`).

## Restrição de Rede

Em produção (`NODE_ENV=production`), o acesso à API é restrito a faixas de IP autorizadas (rede do IFES), configuradas pelo administrador principal em CIDR (ex.: `10.0.0.0/8`). Existe um **modo de teste**, também configurável apenas pelo administrador principal, que permite acesso de fora da rede autorizada — útil durante testes e homologação. Fora do ambiente de produção (`NODE_ENV=development`) essa restrição não é aplicada.

## Interface Web dos ESP32

Cada ESP32 expõe sua própria interface de configuração local (aprendizado de IR, calibração, presets), incluindo uma seção "Informações do Aparelho" que mostra a sala configurada, o endereço MAC e o IP atual do dispositivo — útil para conferência visual direta no equipamento. O administrador principal pode acessar essa interface a partir de uma subpágina própria em `Admin > ESP32 / Salas`, que mostra o IP mais recente reportado pelo dispositivo e abre a interface local em uma nova aba. Esse acesso é restrito ao administrador principal tanto na interface quanto no backend.

### Detecção automática de ESP32 na rede

Todo ESP32 que envia um heartbeat ao servidor — mesmo que a sala ainda não esteja vinculada a ele — é registrado automaticamente. Em `Admin > ESP32 / Salas`, a seção "ESP32 detectados na rede" lista esses dispositivos (MAC, IP, última vez visto) e permite vincular cada um a uma sala existente com um único clique, sem precisar digitar o MAC manualmente. Um seletor de planta baixa no topo da mesma página permite localizar rapidamente o cartão de configuração de qualquer sala clicando nela no mapa.

## Requisitos

### Software

- Node.js 22.13 ou superior (usa o módulo `node:sqlite` nativo, ainda experimental)
- Arduino IDE ou PlatformIO, com suporte à placa ESP32, para compilar o firmware
- Bibliotecas Arduino: [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266), `WebSockets` (Links2004) e, se for usar leitura de temperatura, `DHT sensor library`

### Hardware

- Um servidor (VM, Raspberry Pi, etc.) para rodar `remoteifes-server`, acessível pela rede do IFES e pelos ESP32
- Um ESP32 com receptor/emissor infravermelho por sala, com um sensor DHT opcional para leitura de temperatura

## Instalação Rápida

**macOS/Linux:**

```bash
cd remoteifes-server
npm run setup
npm start
```

`npm run setup` instala as dependências, cria o arquivo `.env` a partir de `.env.example` (caso ainda não exista) e gera automaticamente um `DEVICE_TOKEN` aleatório. Rodar `npm run setup` novamente não sobrescreve um `.env` já existente.

**Windows (PowerShell/CMD):**

O script `npm run setup` usa `bash` e não roda no Windows. Nesse caso, faça manualmente:

```powershell
cd remoteifes-server
npm install
copy .env.example .env
npm start
```

Depois abra o arquivo `.env` gerado e defina um valor para `DEVICE_TOKEN` (qualquer string aleatória, ex.: `DEVICE_TOKEN=troque-por-um-valor-aleatorio`) — esse é o token usado pelos ESP32 para autenticar com o servidor, então precisa ficar igual no firmware de cada dispositivo.

**Em ambos os casos**, o banco de dados SQLite é criado e populado automaticamente na primeira execução do servidor (`npm start`), incluindo:

- 70 salas reais do campus, extraídas da planta baixa (Bloco A e B, todos os pavimentos), todas offline até que os ESP32 correspondentes comecem a reportar
- Um usuário `admin` com senha aleatória impressa no console (ou definida via `SENHA_ADMIN_INICIAL` em `.env`)
- O preset padrão, com a função de temperatura configurada entre 23 °C e 25 °C

## Instalação Detalhada

### Servidor central

**macOS/Linux:**

```bash
cd remoteifes-server
npm install
cp .env.example .env
npm start
```

**Windows (PowerShell/CMD):**

```powershell
cd remoteifes-server
npm install
copy .env.example .env
npm start
```

Edite `.env` conforme a seção [Configuração](#configuração) antes de colocar o servidor em produção — em especial `DEVICE_TOKEN` (gerado automaticamente pelo `npm run setup` no macOS/Linux; no Windows, defina manualmente como descrito acima) e, quando `NODE_ENV=production`, `CORS_ORIGIN`.

### Frontend

`remoteifes-web` não tem etapa de build: é servido como está. Para desenvolvimento local, basta abrir `index.html` em um servidor HTTP estático (ex.: `npx serve remoteifes-web`) apontando `js/config.js` para o servidor central local.

### Firmware ESP32

Abra `remoteifes-esp32/remoteifes_esp32.ino` na Arduino IDE (ou PlatformIO) com a placa ESP32 selecionada e as bibliotecas listadas em [Requisitos](#requisitos) instaladas. No primeiro boot, o ESP32 sobe um ponto de acesso Wi-Fi próprio para receber as credenciais da rede local e o endereço do servidor central; depois disso, ele se conecta normalmente à rede da sala.

## Configuração

### Servidor (`remoteifes-server/.env`)

| Variável | Descrição |
|---|---|
| `NODE_ENV` | `development` ou `production`. Em produção, ativa a restrição de rede e o CORS restrito |
| `PORTA` | Porta HTTP do servidor (padrão 8080) |
| `CORS_ORIGIN` | Lista de origens permitidas, separadas por vírgula, quando `NODE_ENV=production` |
| `DEVICE_TOKEN` | Token secreto usado pelos ESP32 para autenticar chamadas ao servidor (`x-device-token`); gerado automaticamente por `npm run setup` |
| `SENHA_ADMIN_INICIAL` | Opcional; define a senha do usuário `admin` criado no primeiro boot |

Para produção, o servidor deve ficar atrás de HTTPS (proxy reverso como Nginx/Caddy, ou um serviço com TLS gerenciado), já que os aparelhos móveis e o GitHub Pages exigem conteúdo servido por HTTPS.

### Configurações globais (banco de dados, via `Admin > Configurações`)

Estas configurações são armazenadas no banco (tabela `configuracoes`) e só podem ser alteradas pelo administrador principal:

- **Limite de temperatura** (`temperaturaMinima` / `temperaturaMaxima`): intervalo permitido para qualquer comando de temperatura, manual ou agendado. Padrão: 23 °C a 25 °C.
- **Modo de teste** (`modoTeste`): quando ativo, desliga a restrição de rede do IFES em produção, permitindo acessar o sistema de qualquer rede para fins de teste. Ativo por padrão em uma instalação nova (para não bloquear o primeiro acesso); deve ser desativado quando o sistema for para produção definitiva.
- **Redes autorizadas** (`redesAutorizadas`): lista de faixas de IP em CIDR (ex.: `10.0.0.0/8`) liberadas quando o modo de teste está desativado.
- Demais opções gerais: tempo de inatividade, aviso de logout automático, e o intervalo considerado para marcar um usuário como "online".

Administradores comuns podem visualizar essas configurações, mas não alterá-las.

### ESP32 por MAC e presets (via `Admin > ESP32 / Salas`)

O administrador principal cadastra o endereço MAC de cada ESP32 autorizado para uma sala — manualmente ou vinculando um dispositivo já detectado na rede (veja [Detecção automática de ESP32 na rede](#interface-web-dos-esp32)). Isso faz duas coisas:

1. Impede que um ESP32 não autorizado assuma a identidade de uma sala: se a sala já tem um MAC cadastrado, o servidor rejeita heartbeats de qualquer outro MAC.
2. Permite escolher, por sala, qual preset de ar-condicionado está em uso.

Na mesma tela, o administrador também define se uma sala tem **acesso restrito** e quais usuários específicos podem controlá-la — veja [Controle de Acesso por Sala](#controle-de-acesso-por-sala).

## Deploy

### Servidor central

O servidor central roda como um processo Node.js comum. Recomenda-se:

- Executá-lo com um gerenciador de processo (`pm2`, `systemd`) para reiniciar automaticamente em caso de falha.
- Colocá-lo atrás de um proxy reverso com HTTPS (Nginx, Caddy) apontando para a porta definida em `PORTA`.
- Definir `NODE_ENV=production`, `CORS_ORIGIN` com o domínio do frontend, e configurar as redes autorizadas antes de desativar o modo de teste.
- Garantir que o servidor esteja acessível tanto pela rede onde ficam os ESP32 (para heartbeats/comandos) quanto pela rede do IFES (para os usuários).

### Frontend no GitHub Pages

O repositório inclui um workflow (`.github/workflows/deploy-pages.yml`) que publica `remoteifes-web` no GitHub Pages a cada push na branch `main` que alterar essa pasta. Passo a passo para ativar:

1. Envie o projeto para um repositório no GitHub (`git push` para a branch `main`), caso ainda não tenha feito isso.
2. No repositório, vá em **Settings > Pages**.
3. Em "Build and deployment", campo "Source", selecione **GitHub Actions** (não "Deploy from a branch").
4. Edite `remoteifes-web/js/config.js` e defina `serverUrl` com a URL HTTPS do servidor central em produção (não use `localhost` aqui — esse endereço só funciona na sua própria máquina).
5. Faça commit e push dessa alteração na branch `main` — o workflow roda automaticamente e publica o site.
6. Acompanhe o progresso em **Actions**, na aba do workflow "Deploy Pages". Quando o job terminar com sucesso, volte em **Settings > Pages**: o endereço público do site aparece no topo da página, no formato `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

Esse é o link que você compartilha com os usuários para acessar o sistema pelo navegador.

## Domínio Próprio e HTTPS

Para servir o frontend em um domínio próprio (em vez do endereço `github.io` padrão) via GitHub Pages:

1. Crie um arquivo `remoteifes-web/CNAME` contendo apenas o domínio desejado (ex.: `remoteifes.ifes.edu.br`), ou configure o campo "Custom domain" em **Settings > Pages**.
2. Aponte um registro `CNAME` (ou `A`, se for domínio raiz) do seu DNS para o GitHub Pages, conforme a [documentação oficial do GitHub](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).
3. Ative "Enforce HTTPS" em **Settings > Pages** assim que o certificado for emitido — isso é obrigatório para funcionar corretamente em navegadores móveis (iOS/Android bloqueiam conteúdo misto HTTP a partir de uma página HTTPS).
4. Garanta que o servidor central também esteja em HTTPS (com domínio ou IP fixo) e que `CORS_ORIGIN` inclua o domínio do frontend.

Com o frontend e o servidor central ambos em HTTPS e domínios próprios, o sistema funciona normalmente em navegadores de celular, incluindo ao adicionar a página como atalho na tela inicial.

## Uso da API do GitHub

Este projeto não depende da API do GitHub em tempo de execução — o uso do GitHub se limita a hospedagem de código-fonte e à publicação estática do frontend via GitHub Pages, orquestrada pelo workflow de Actions (`actions/configure-pages`, `actions/upload-pages-artifact`, `actions/deploy-pages`). Não é necessário nenhum token de API do GitHub além do `GITHUB_TOKEN` padrão que o Actions já injeta automaticamente no workflow para publicar o Pages.

## Estrutura de Pastas

```
remoteifes-server/
  setup.sh        instalação e configuração automatizadas (dependências, .env, DEVICE_TOKEN)
  src/
    config/       conexão com o banco SQLite
    db/           schema, seed e a lista de salas reais do campus (salasCampus.js)
    middlewares/  autenticação, permissões, restrição de rede
    routes/       rotas HTTP (login, salas, comandos, agendamentos, admin, dispositivo)
    services/     regras de negócio (usuários, salas, agendamentos, presets, configurações)
    scheduler/    verificação periódica de agendamentos e timeouts
    utils/        funções auxiliares (data/hora, rate limiting, faixas de rede)

remoteifes-web/
  js/
    screens/      lógica de cada tela (login, salas, planta baixa, painel, agendamentos, grade, admin)
    floorplan.js  componente reutilizável de planta baixa (usado na tela de salas e no painel do admin)
    api.js        chamadas HTTP à API central
    config.js     endereço do servidor central (editar para cada ambiente/domínio)
    state.js      estado da sessão atual no navegador

remoteifes-esp32/
  remoteifes_esp32.ino   firmware principal (Wi-Fi, IR, WebSocket, comunicação com o servidor)
  index_html.h            interface web local do dispositivo (aprendizado de IR, termostato, presets)
```

## Solução de Problemas

- **Servidor não inicia por causa do `node:sqlite`**: confirme que o Node.js instalado é 22.13 ou superior (`node -v`); versões anteriores não têm o módulo nativo `node:sqlite` usado pelo projeto.
- **ESP32 não aparece como online**: verifique se o `DEVICE_TOKEN` configurado no firmware é idêntico ao do `.env` do servidor, e se o ESP32 consegue alcançar o endereço/porta do servidor pela rede local.
- **Heartbeat rejeitado com erro de MAC**: a sala já tem um MAC diferente cadastrado em `Admin > ESP32 / Salas`; atualize o cadastro ou libere a sala novamente para o ESP32 correto.
- **ESP32 aparece em "ESP32 detectados na rede" mas nunca fica online**: a sala reportada no heartbeat não existe (ou foi digitada errado) durante a configuração inicial do dispositivo; vincule o MAC detectado a uma sala existente em `Admin > ESP32 / Salas`, ou reconfigure o ESP32 com o código de sala correto.
- **ESP32 perde conexão Wi-Fi e não volta sozinho**: o firmware tenta reconectar automaticamente a cada 15s e reinicia sozinho após 5 minutos sem rede; se isso persistir, verifique o sinal Wi-Fi no local ou se o roteiro/AP mudou de canal ou senha.
- **Usuário com "pode controlar" ativo não consegue controlar uma sala específica**: verifique se a sala está marcada como "acesso restrito" em `Admin > ESP32 / Salas` — nesse caso, o usuário precisa ser adicionado explicitamente à lista de acesso daquela sala.
- **Acesso bloqueado em produção mesmo dentro da rede do IFES**: confira as faixas CIDR em `redesAutorizadas` e, temporariamente, o `modoTeste` em `Admin > Configurações`.
- **Frontend não fala com o servidor depois do deploy**: confirme `serverUrl` em `remoteifes-web/js/config.js` e se `CORS_ORIGIN` no servidor inclui o domínio do frontend publicado.
