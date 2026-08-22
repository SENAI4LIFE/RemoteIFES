# RemoteIFES

Sistema de controle remoto de ar-condicionado para as salas do IFES: painel web, agendamento diário, presets configuráveis por ESP32 e um servidor central em Node.js.

[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js)](#)
[![Express](https://img.shields.io/badge/Express-API-000000?logo=express)](#)
[![SQLite](https://img.shields.io/badge/SQLite-Database-003B57?logo=sqlite)](#)
[![ESP32](https://img.shields.io/badge/ESP32-Arduino-E7352C?logo=espressif)](#)
[![Arduino](https://img.shields.io/badge/Arduino-IDE-00979D?logo=arduino)](#)
[![PlatformIO](https://img.shields.io/badge/PlatformIO-ESP32-F5822A?logo=platformio)](#)
[![IRremoteESP8266](https://img.shields.io/badge/IRremoteESP8266-2.9.0-blue)](#)
[![WebSockets](https://img.shields.io/badge/WebSockets-Library-010101?logo=websockets)](#)
[![DHT](https://img.shields.io/badge/DHT-Temperature-green)](#)
[![HTML5](https://img.shields.io/badge/HTML5-Frontend-E34F26?logo=html5)](#)
[![CSS3](https://img.shields.io/badge/CSS3-Frontend-1572B6?logo=css3)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript)](#)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Hosting-222222?logo=github)](#)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?logo=github)](#)
[![HTTP](https://img.shields.io/badge/API-HTTP-005571?logo=http)](#)
[![REST](https://img.shields.io/badge/API-REST-0A66C2)](#)
[![HTTPS](https://img.shields.io/badge/Production-HTTPS-success?logo=letsencrypt)](#)
[![Nginx](https://img.shields.io/badge/Reverse%20Proxy-Nginx-009639?logo=nginx)](#)
[![Caddy](https://img.shields.io/badge/Reverse%20Proxy-Caddy-1F88C0?logo=caddy)](#)
[![PM2](https://img.shields.io/badge/Process%20Manager-PM2-2B037A?logo=pm2)](#)
[![Linux](https://img.shields.io/badge/Server-Linux-FCC624?logo=linux&logoColor=black)](#)
[![Windows](https://img.shields.io/badge/Server-Windows-0078D4?logo=windows)](#)
[![macOS](https://img.shields.io/badge/Server-macOS-000000?logo=apple)](#)
[![Git](https://img.shields.io/badge/Git-Version%20Control-F05032?logo=git)](#)

## Sumário

- [Visão Geral](#visão-geral)
- [Papéis e Permissões](#papéis-e-permissões)
- [Navegação e Seleção de Salas](#navegação-e-seleção-de-salas)
- [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala)
- [Agendamentos](#agendamentos)
- [Grade de Horários](#grade-de-horários)
- [Presets de Ar-Condicionado](#presets-de-ar-condicionado)
- [Notificações](#notificações)
- [Sessões e Tempo de Inatividade](#sessões-e-tempo-de-inatividade)
- [Auditoria (Logs, Dispositivos e Acessos)](#auditoria-logs-dispositivos-e-acessos)
- [Restrição de Rede](#restrição-de-rede)
- [Tempo Real (WebSocket)](#tempo-real-websocket)
- [Interface Web dos ESP32](#interface-web-dos-esp32)
- [Acessibilidade](#acessibilidade)
- [Requisitos](#requisitos)
- [Instalação Rápida](#instalação-rápida)
- [Instalação Detalhada](#instalação-detalhada)
- [Configuração](#configuração)
- [Deploy](#deploy)
- [Domínio Próprio e HTTPS](#domínio-próprio-e-https)
- [Scripts Auxiliares](#scripts-auxiliares)
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

1. Cada sala possui um **ESP32** com receptor/emissor de infravermelho (e, opcionalmente, um sensor de temperatura DHT), conectado à rede Wi-Fi local. O ESP32 aprende o protocolo IR do ar-condicionado (ou usa a biblioteca de protocolos conhecidos), envia comandos e reporta seu estado (ligado/desligado, temperatura, MAC, IP) ao servidor central via HTTP, autenticado por um token de dispositivo (`DEVICE_TOKEN`).

2. O **servidor central** (`remoteifes-server`) mantém o banco de dados (SQLite), a lógica de autenticação, permissões, agendamentos, presets, notificações e configurações globais. Ele expõe uma API REST usada tanto pelo frontend web quanto pelos ESP32, além de um canal WebSocket (`/ws`) para atualização de status em tempo real no painel web.

3. O **frontend** (`remoteifes-web`) é um site estático (sem framework de build) que fala com o servidor central via `fetch` e WebSocket. É hospedado no GitHub Pages e pode ser servido em um domínio próprio.

## Papéis e Permissões

O sistema tem três níveis de usuário:

| Nível | Papel | Pode |
|---|---|---|
| 1 | Usuário comum | Ligar/desligar e ajustar a temperatura das salas liberadas para controle |
| 2 | Administrador | Tudo do nível 1, além de gerenciar agendamentos, grade de horários, notificações, sessões, logs, dispositivos e usuários comuns |
| 3 | Administrador principal (superadmin) | Tudo do nível 2, além de alterar configurações globais do sistema, limites de temperatura, redes autorizadas, modo de teste, cadastro de ESP32 por MAC e presets |

Além dos três níveis, existe uma permissão pontual, independente de nível: um usuário comum pode ser tornado **proprietário** de uma ou mais salas específicas, o que lhe permite conceder e revogar o acesso de controle de outros usuários apenas àquelas salas, sem se tornar administrador (veja [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala)).

Todas as permissões são impostas no backend (não apenas escondidas na interface): rotas administrativas exigem `exigirAdmin`, rotas/campos críticos exigem `exigirSuperAdmin`, e as rotas de proprietário de sala exigem que o usuário conste como dono daquela sala específica.

## Navegação e Seleção de Salas

O sistema oferece três formas de chegar até uma sala, todas equivalentes em funcionalidade:

- **Assistente simples** (tela inicial após o login): três passos guiados por ícones grandes — bloco, andar e sala — pensados para toque em celular. É a navegação padrão.
- **Planta baixa**: exibe a planta baixa real do campus (Bloco A e Bloco B, térreo/2º/3º pavimentos), com abas para alternar entre os seis setores e suporte a zoom. Cada sala com ar-condicionado controlado pelo sistema aparece destacada e colorida conforme seu estado:
  - cinza: offline (sem ESP32 reportando)
  - azul: online, desligado
  - verde: online, ligado
  - contorno amarelo: com agendamento ativo no momento
- **Lista tradicional** (`Bloco → Andar → Sala`): navegação simples em lista, sem elementos gráficos.

Qualquer usuário autenticado pode visualizar o estado de todas as salas — isso inclui salas às quais o usuário não tem permissão de controle, que aparecem marcadas como "visualização" e cujos controles ficam desabilitados no painel. Os três modos de navegação têm botões cruzados para alternar entre si a qualquer momento.

As 95 salas cadastradas por padrão vêm diretamente da planta baixa fornecida (`remoteifes-server/src/db/salasCampus.js`); ajuste esse arquivo se a planta do campus mudar (novas salas, renomeações, etc.) antes da primeira execução do servidor — o seed só roda quando o banco está vazio. Um código de sala pode representar duas salas físicas controladas pelo mesmo ESP32 (ex.: `B-105-B-106`); nesse caso a interface exibe as duas etiquetas empilhadas no mesmo bloco do mapa.

## Controle de Acesso e Proprietários de Sala

Além da permissão geral "pode controlar" (nível de usuário), existem dois mecanismos para restringir e delegar o controle de salas individuais:

### Acesso restrito por sala

Em `Admin > ESP32 / MACs` (ou em `Admin > Proprietários de sala`), o administrador principal pode marcar uma sala como **acesso restrito**:

1. Isso impede que qualquer usuário comum a controle, mesmo com a permissão geral ativa — exceto os usuários explicitamente autorizados para aquela sala.
2. Usuários autorizados são concedidos/revogados individualmente, por sala.
3. Administradores (níveis 2 e 3) sempre podem controlar qualquer sala, independentemente de restrição.

A verificação é feita no backend (`aplicarComando`), então mesmo chamadas diretas à API respeitam a restrição — a interface apenas reflete o estado (desabilitando os controles e mostrando um aviso de "somente leitura") para dar feedback imediato ao usuário.

### Proprietários de sala

Qualquer administrador pode tornar um usuário comum **proprietário** de uma sala específica, em `Admin > Proprietários de sala`. Um proprietário:

- Ganha acesso a uma aba própria ("Config. Salas") onde vê apenas as salas das quais é dono.
- Pode, nessa aba, conceder e revogar o acesso de controle de outros usuários comuns à(s) sua(s) sala(s) — sem precisar de privilégios administrativos e sem enxergar o restante do painel de administração.
- Só tem efeito prático se a sala estiver marcada como **acesso restrito**; caso contrário, todos os usuários com permissão geral já controlam a sala normalmente e a tela do proprietário mostra um aviso lembrando disso.

Um administrador pode remover um proprietário a qualquer momento (o usuário perde o acesso imediatamente) e também pode revogar diretamente qualquer acesso concedido por ele. Administradores não podem ser tornados proprietários de sala, pois já têm acesso total.

## Agendamentos

Agendamentos são **diários**: cada agendamento vale para uma única data (sem recorrência semanal), sempre o dia atual no fuso horário de Brasília (`America/Sao_Paulo`), independentemente do fuso configurado no servidor. Apenas administradores podem criar, listar e gerenciar agendamentos — usuários comuns não têm acesso a essa funcionalidade, nem na interface nem na API.

Cada agendamento reserva a sala durante um período (`horaInicio`–`horaFim`) e pode ser criado em um de três modos:

| Modo | Comportamento |
|---|---|
| `reserva` | Apenas bloqueia a sala para outros usuários no período; não liga o ar-condicionado automaticamente |
| `ligar_completo` | Reserva a sala e liga o ar-condicionado durante todo o horário definido (padrão) |
| `ligar_intervalo` | Reserva a sala no período, mas o ar-condicionado só liga dentro de um intervalo menor, definido dentro do período reservado |

O agendador do servidor verifica agendamentos ativos a cada minuto e não repete uma mesma ação (ligar/desligar) mais de uma vez no mesmo dia. Um agendamento desativado permanece salvo, mas não é executado; o autor do agendamento ou um administrador podem ativá-lo, desativá-lo ou removê-lo — outros usuários comuns só podem visualizar.

## Grade de Horários

A aba **Grade** (visível apenas para administradores) mostra, para uma sala e data escolhidas, uma grade com os períodos de aula fixos do campus (07:00 às 22:10, em blocos de aproximadamente 50 minutos), indicando para cada período se a sala está livre, apenas reservada ou com o ar-condicionado ligado, e por quem. É útil para identificar rapidamente conflitos de horário ou janelas livres antes de criar um novo agendamento.

## Presets de Ar-Condicionado

Presets descrevem quais **funções** um ar-condicionado suporta (temperatura, velocidade do ventilador, oscilação, modo turbo, etc.). A estrutura é extensível: uma função é apenas uma linha na tabela `preset_funcoes` (chave, rótulo, tipo, opções), então novas funções não exigem alterar código — apenas cadastrar a função em um preset.

- O preset **padrão** possui somente a função de temperatura e não pode ser removido.
- Novas funções são criadas e associadas a um preset diretamente pela interface web do próprio ESP32 (aba "Presets" na página local do dispositivo), que sincroniza a definição com o servidor central.
- O administrador principal decide quais presets existem, edita/remove funções e escolhe qual preset cada sala/ESP32 utiliza (`Admin > ESP32 / MACs`).
- Remover um preset faz as salas que o utilizavam voltarem automaticamente ao preset padrão.

## Notificações

Administradores recebem notificações no sino exibido no topo da interface, atualizado por consulta periódica ao servidor. Atualmente o sistema gera notificações automaticamente quando um ESP32 que estava online fica offline (timeout de heartbeat). O painel permite:

- Ver a lista de notificações mais recentes, com data/hora.
- Marcar uma notificação individual como lida (ao clicar nela).
- Marcar todas como lidas de uma vez.

O indicador (ponto vermelho) no sino reflete a contagem de notificações não lidas.

## Sessões e Tempo de Inatividade

O servidor registra cada login como uma sessão (token, horário de início, último uso e, ao sair, horário de logout). Isso alimenta duas sub-abas em `Admin`:

- **Ativos**: usuários com uma sessão em aberto, com um cronômetro de tempo de sessão em tempo real e um status calculado a partir do último uso — `online` (dentro do limiar configurado), `inativo` (sessão aberta, mas sem uso recente) ou `offline`.
- **Sessões**: histórico de logins/logouts, com duração de cada sessão, filtrável por data e removível (por data ou por completo).

Sessões sem atividade por mais de 24 horas são encerradas automaticamente pelo servidor, mesmo sem logout explícito. No navegador, o **timeout de inatividade** (configurável em `Admin > Configurações`) desloga o usuário automaticamente após um período sem interação (clique, tecla ou toque), exibindo antes um aviso com contagem regressiva; o usuário pode optar por continuar conectado durante o aviso. Por padrão o timeout está desativado (sem prazo); quando ativado, pode ou não valer também para administradores, conforme configuração.

## Auditoria (Logs, Dispositivos e Acessos)

Em `Admin`, três sub-abas registram o histórico operacional do sistema, todas filtráveis por data e com opção de apagar registros (ação irreversível):

- **Logs**: cada comando de ligar, desligar ou ajustar temperatura enviado a uma sala, com o usuário responsável (ou `sistema`, quando veio de um agendamento) e a origem (`manual`, `agendamento` ou `esp32_local`, quando o comando parte da interface local do próprio dispositivo).
- **Dispositivos**: eventos de conexão — sempre que um ESP32 fica online ou offline, incluindo o desligamento automático de salas cujo ESP32 parou de responder (após 90 segundos sem heartbeat).
- **Acessos ESP32**: cada requisição feita à interface web local de um ESP32, com o IP de origem — útil para diagnosticar problemas de rede ou identificar acessos incomuns ao dispositivo.

## Restrição de Rede

Em produção (`NODE_ENV=production`), o acesso à API é restrito a faixas de IP autorizadas (rede do IFES), configuradas pelo administrador principal em CIDR (ex.: `10.0.0.0/8`). Existe um **modo de teste**, também configurável apenas pelo administrador principal, que permite acesso de fora da rede autorizada — útil durante testes e homologação, e ativo por padrão em uma instalação nova. Fora do ambiente de produção (`NODE_ENV=development`) essa restrição não é aplicada. A mesma restrição de rede e de modo de teste vale para as conexões WebSocket, não apenas para a API HTTP.

## Tempo Real (WebSocket)

O servidor expõe um endpoint WebSocket em `/ws`, autenticado pelo mesmo token de sessão usado na API HTTP (`?token=...`). Ao conectar, o cliente recebe a lista de salas e pode "observar" uma sala específica para receber atualizações do seu status assim que qualquer mudança ocorrer (comando manual, agendamento ou heartbeat do ESP32), sem precisar recarregar a tela. A conexão é também retransmitida periodicamente (a cada 30 segundos) como reforço, e o frontend reconecta automaticamente com espera crescente caso a conexão caia. Esse canal alimenta o assistente simples, a lista de salas, o mapa da planta baixa e o painel de controle de cada sala.

## Interface Web dos ESP32

Cada ESP32 expõe sua própria interface de configuração local (servida pelo próprio dispositivo, com WebSocket próprio na porta 81), incluindo:

- **Aprendizado de infravermelho**: captura o sinal bruto emitido por um controle remoto físico apontado para o ESP32 ("calibração"), para acionar aparelhos sem protocolo conhecido pela biblioteca.
- **Protocolos conhecidos**: alternativamente, o ESP32 pode controlar o ar-condicionado usando a biblioteca de protocolos universais (IRac), definindo temperatura, ligar/desligar, modo turbo, velocidade do ventilador e oscilação diretamente, sem precisar de aprendizado prévio, quando o protocolo do aparelho é suportado.
- **Sensor de temperatura (DHT)**: leitura periódica opcional, reportada ao servidor no heartbeat.
- **Presets**: cadastro e edição das funções suportadas pelo aparelho, sincronizadas com o servidor central.
- **Informações do Aparelho**: mostra a sala configurada, o endereço MAC e o IP atual do dispositivo — útil para conferência visual direta no equipamento.
- **Reset de Wi-Fi**: permite reconfigurar a rede e o servidor a partir da própria interface local, sem precisar regravar o firmware.

O administrador principal pode acessar essa interface a partir de uma subpágina própria em `Admin > ESP32 / MACs`, que mostra o IP mais recente reportado pelo dispositivo e abre a interface local em uma nova aba. Esse acesso é restrito ao administrador principal tanto na interface quanto no backend.

### Detecção automática de ESP32 na rede

Todo ESP32 que envia um heartbeat ao servidor — mesmo que a sala ainda não esteja vinculada a ele — é registrado automaticamente. Em `Admin > ESP32 / MACs`, a seção "ESP32 detectados na rede" lista esses dispositivos (MAC, IP, última vez visto) e permite vincular cada um a uma sala existente com um único clique, sem precisar digitar o MAC manualmente. Um seletor de planta baixa com zoom, no topo da mesma página, permite buscar e localizar rapidamente o cartão de configuração de qualquer sala clicando nela no mapa; um campo de busca por texto complementa essa navegação.

## Acessibilidade

O frontend inclui um widget de acessibilidade (botão flutuante, disponível em todas as telas) com ajustes persistidos no navegador (`localStorage`) entre sessões: escala de fonte, tipo de fonte (incluindo uma fonte voltada para leitores com dislexia), espaçamento entre letras, altura de linha, largura máxima de parágrafo, alinhamento de texto, cor de fonte e de texto, destaque de links, alto contraste e opção de ocultar imagens.

## Requisitos

### Software

- Node.js 22.13 ou superior (usa o módulo `node:sqlite` nativo, ainda experimental)
- Arduino IDE ou PlatformIO, com suporte à placa ESP32, para compilar o firmware
- Bibliotecas Arduino: [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266) (inclui os módulos `IRrecv`, `IRsend`, `IRutils` e `IRac`), `WebSockets` (Links2004), `DHT sensor library` (para leitura de temperatura) e `Preferences`/`DNSServer` (inclusas no core ESP32)

### Hardware

- Um servidor (VM, Raspberry Pi, etc.) para rodar `remoteifes-server`, acessível pela rede do IFES e pelos ESP32
- Um ESP32 com receptor/emissor infravermelho por sala (ou por par de salas adjacentes, quando um único equipamento cobre as duas), com um sensor DHT opcional para leitura de temperatura

## Instalação Rápida

> **Antes de executar o servidor:** é necessário ter o **Node.js 22.13 ou superior** instalado no computador. Baixe a versão oficial em https://nodejs.org/en/download.

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

- 95 salas reais do campus, extraídas da planta baixa (Bloco A e B, todos os pavimentos), todas offline até que os ESP32 correspondentes comecem a reportar
- Um usuário `admin` com senha padrão `admin` (ou definida via `SENHA_ADMIN_INICIAL` em `.env`) — isso só acontece quando o `admin` ainda não existe no banco; se o banco já veio populado no clone, use `npm run reset-admin` (veja [Solução de Problemas](#solução-de-problemas))
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

Durante o desenvolvimento, `npm run dev` inicia o servidor com reinício automático a cada alteração de arquivo (`node --watch`), no lugar de `npm start`.

### Frontend

`remoteifes-web` não tem etapa de build: é servido como está. Para desenvolvimento local, basta abrir `index.html` em um servidor HTTP estático (ex.: `npx serve remoteifes-web`) apontando `js/config.js` para o servidor central local.

### Firmware ESP32

Abra `remoteifes-esp32/remoteifes_esp32.ino` na Arduino IDE (ou PlatformIO) com a placa ESP32 selecionada e as bibliotecas listadas em [Requisitos](#requisitos) instaladas. No primeiro boot, o ESP32 sobe um ponto de acesso Wi-Fi próprio (`RemoteIFES-Setup`) para receber as credenciais da rede local, a sala e o endereço do servidor central; depois disso, ele se conecta normalmente à rede da sala. Se a conexão Wi-Fi salva falhar, o mesmo ponto de acesso de configuração é reaberto automaticamente.

## Configuração

### Servidor (`remoteifes-server/.env`)

| Variável | Descrição |
|---|---|
| `NODE_ENV` | `development` ou `production`. Em produção, ativa a restrição de rede e o CORS restrito |
| `PORTA` | Porta HTTP (e WebSocket, no mesmo servidor) do servidor (padrão 8080) |
| `CORS_ORIGIN` | Lista de origens permitidas, separadas por vírgula, quando `NODE_ENV=production` — vale tanto para a API HTTP quanto para as conexões WebSocket |
| `DEVICE_TOKEN` | Token secreto usado pelos ESP32 para autenticar chamadas ao servidor (`x-device-token`); gerado automaticamente por `npm run setup` |
| `SENHA_ADMIN_INICIAL` | Opcional; define a senha do usuário `admin` criado no primeiro boot (padrão: `admin`) |

Para produção, o servidor deve ficar atrás de HTTPS (proxy reverso como Nginx/Caddy, ou um serviço com TLS gerenciado), já que os aparelhos móveis e o GitHub Pages exigem conteúdo servido por HTTPS.

### Configurações globais (banco de dados, via `Admin > Configurações`)

Estas configurações são armazenadas no banco (tabela `configuracoes`). As marcadas como críticas só podem ser vistas e alteradas pelo administrador principal; as demais podem ser alteradas por qualquer administrador.

| Configuração | Padrão | Descrição |
|---|---|---|
| Limite de temperatura (crítica) | 23 °C a 25 °C | Intervalo permitido para qualquer comando de temperatura, manual ou agendado (aceita de 16 a 30 °C) |
| Modo de teste (crítica) | ativado | Quando ativo, desliga a restrição de rede do IFES em produção, permitindo acessar o sistema de qualquer rede para fins de teste; deve ser desativado quando o sistema for para produção definitiva |
| Redes autorizadas (crítica) | vazia | Lista de faixas de IP em CIDR (ex.: `10.0.0.0/8`) liberadas quando o modo de teste está desativado |
| Tempo de inatividade | indefinido (sem limite) | Minutos sem interação até deslogar automaticamente o usuário no navegador; em branco desativa o recurso |
| Admin sujeito ao tempo de inatividade | desativado | Define se o timeout de inatividade também se aplica a administradores |
| Aviso de logout automático | 60 segundos | Duração da contagem regressiva exibida antes do logout por inatividade |
| Limiar de presença online | 5 minutos | Minutos sem uso após os quais um usuário com sessão aberta passa de "online" para "inativo" na aba Ativos |

### ESP32 por MAC e presets (via `Admin > ESP32 / MACs`)

O administrador principal cadastra o endereço MAC de cada ESP32 autorizado para uma sala — manualmente ou vinculando um dispositivo já detectado na rede (veja [Detecção automática de ESP32 na rede](#detecção-automática-de-esp32-na-rede)). Isso faz duas coisas:

1. Impede que um ESP32 não autorizado assuma a identidade de uma sala: se a sala já tem um MAC cadastrado, o servidor rejeita heartbeats de qualquer outro MAC.
2. Permite escolher, por sala, qual preset de ar-condicionado está em uso.

Na mesma tela, o administrador também define se uma sala tem **acesso restrito** e quais usuários específicos podem controlá-la — veja [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala).

## Deploy

### Servidor central

O servidor central roda como um processo Node.js comum. Recomenda-se:

- Executá-lo com um gerenciador de processo (`pm2`, `systemd`) para reiniciar automaticamente em caso de falha.
- Colocá-lo atrás de um proxy reverso com HTTPS (Nginx, Caddy) apontando para a porta definida em `PORTA`.
- Definir `NODE_ENV=production`, `CORS_ORIGIN` com o domínio do frontend, e configurar as redes autorizadas antes de desativar o modo de teste.
- Garantir que o servidor esteja acessível tanto pela rede onde ficam os ESP32 (para heartbeats/comandos) quanto pela rede do IFES (para os usuários), incluindo a porta usada pelo WebSocket (mesma porta HTTP do servidor).

Para automatizar esse último ponto em um servidor Linux com Nginx, `remoteifes-server/https-setup.sh` configura um proxy reverso e emite um certificado com Certbot (Let's Encrypt):

```bash
sudo bash https-setup.sh <dominio> <email>
```

O script instala Nginx e Certbot se necessário, cria um site Nginx apontando para `127.0.0.1:<PORTA>` (lida do `.env`, com 8080 como padrão), emite o certificado e ativa a renovação automática (`certbot.timer`). Rode-o como root, com o domínio já apontando para o servidor via DNS.

### Frontend no GitHub Pages

A publicação do `remoteifes-web` no GitHub Pages é manual (não há workflow de Actions no repositório). Passo a passo para publicar:

1. Envie o projeto para um repositório no GitHub (`git push` para a branch `main`), caso ainda não tenha feito isso.
2. Edite `remoteifes-web/js/config.js` e defina `serverUrl` com a URL HTTPS do servidor central em produção (não use `localhost` aqui — esse endereço só funciona na sua própria máquina).
3. Faça commit e push dessa alteração na branch `main`.
4. No repositório, vá em **Settings > Pages**.
5. Em "Build and deployment", campo "Source", selecione **Deploy from a branch**.
6. Em "Branch", selecione `main` e a pasta `/remoteifes-web`, depois clique em **Save**.
7. Acompanhe o progresso na própria página de **Settings > Pages**. Quando a publicação terminar, o endereço público do site aparece no topo da página, no formato `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

Esse é o link que você compartilha com os usuários para acessar o sistema pelo navegador. Sempre que `remoteifes-web` for alterado, repita o passo 3 (commit/push) — o GitHub Pages republica automaticamente a partir da branch configurada a cada push, sem necessidade de repetir os passos 4–6.

## Domínio Próprio e HTTPS

Para servir o frontend em um domínio próprio (em vez do endereço `github.io` padrão) via GitHub Pages:

1. Crie um arquivo `remoteifes-web/CNAME` contendo apenas o domínio desejado (ex.: `remoteifes.ifes.edu.br`), ou configure o campo "Custom domain" em **Settings > Pages**.
2. Aponte um registro `CNAME` (ou `A`, se for domínio raiz) do seu DNS para o GitHub Pages, conforme a [documentação oficial do GitHub](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).
3. Ative "Enforce HTTPS" em **Settings > Pages** assim que o certificado for emitido — isso é obrigatório para funcionar corretamente em navegadores móveis (iOS/Android bloqueiam conteúdo misto HTTP a partir de uma página HTTPS).
4. Garanta que o servidor central também esteja em HTTPS (com domínio ou IP fixo, via `https-setup.sh` ou configuração equivalente) e que `CORS_ORIGIN` inclua o domínio do frontend.

Com o frontend e o servidor central ambos em HTTPS e domínios próprios, o sistema funciona normalmente em navegadores de celular, incluindo ao adicionar a página como atalho na tela inicial. Como o WebSocket herda o esquema da página (`wss://` quando a página é `https://`), nenhuma configuração adicional é necessária para o tempo real funcionar sob HTTPS.

## Scripts Auxiliares

Três scripts Python na raiz do projeto auxiliam o fluxo de trabalho com Git (executados a partir da raiz do repositório, com `git` instalado e disponível no `PATH`):

| Script | Função |
|---|---|
| `export.py` | Adiciona todas as alterações (`git add -A`), pede uma mensagem de commit (ou usa `update` como padrão) e envia (`git push origin main`) |
| `import.py` | Atualiza a cópia local a partir do remoto (`git pull origin main`) |
| `clear.py` | Recria o histórico do repositório do zero em um único commit (`checkout --orphan`) e, mediante confirmação explícita, sobrescreve o histórico remoto (`push -f`) — apaga permanentemente todo o histórico de commits anterior; use apenas se isso for intencional |

O repositório não inclui um arquivo `.gitignore`. Antes do primeiro commit, é recomendável ignorar ao menos `remoteifes-server/.env` e `remoteifes-server/data/` (onde fica o banco SQLite), para não versionar segredos (`DEVICE_TOKEN`) nem o banco de dados — veja o aviso sobre esse cenário em [Solução de Problemas](#solução-de-problemas).

## Uso da API do GitHub

Este projeto não depende da API do GitHub em tempo de execução — o uso do GitHub se limita a hospedagem de código-fonte e à publicação estática do frontend via GitHub Pages, configurada manualmente em **Settings > Pages** (branch `main`, pasta `/remoteifes-web`). Não é necessário nenhum token ou workflow de Actions para isso.

## Estrutura de Pastas

```
remoteifes-server/
  setup.sh          instalação e configuração automatizadas (dependências, .env, DEVICE_TOKEN)
  https-setup.sh     configuração automatizada de HTTPS (Nginx + Certbot)
  reset-admin-senha.js  redefine a senha do usuário admin sem apagar dados
  server.js          ponto de entrada: sobe o HTTP server, o WebSocket e o agendador
  src/
    app.js            monta o Express app e registra as rotas
    config/           conexão com o banco SQLite
    db/                schema, seed e a lista de salas reais do campus (salasCampus.js)
    middlewares/       autenticação, permissões, restrição de rede
    routes/            rotas HTTP (login, salas, comandos, agendamentos, admin, dispositivo)
    services/          regras de negócio (usuários, salas, agendamentos, presets,
                        configurações, notificações, sessões/tokens, status em tempo real)
    scheduler/         verificação periódica de agendamentos, timeouts de ESP32 e sessões abandonadas
    utils/             funções auxiliares (data/hora em fuso de Brasília, rate limiting, faixas de rede)

remoteifes-web/
  js/
    app.js             inicialização geral da página
    api.js             chamadas HTTP à API central
    config.js          endereço do servidor central (editar para cada ambiente/domínio)
    state.js           estado da sessão atual no navegador
    nav.js             troca de abas e telas
    rtstatus.js        cliente WebSocket para status em tempo real
    idle-timer.js      timeout de inatividade e aviso de logout automático
    a11y.js            widget de acessibilidade (fonte, contraste, espaçamento etc.), persiste no localStorage
    floorplan.js        componente reutilizável de planta baixa com zoom (usado na tela de salas e no admin)
    help.js            conteúdo dos modais de ajuda contextual espalhados pela interface
    tempo.js           formatação de datas/horas no fuso de Brasília
    rooms-data.js       utilitário auxiliar de composição de código de sala
    screens/           lógica de cada tela:
                        simple.js (assistente simples), location.js e rooms.js (navegação tradicional),
                        floorplan.js (planta baixa), panel.js (painel de controle de uma sala),
                        schedule.js (agendamentos), grade.js (grade de horários),
                        propriedade.js (config. de salas para proprietários),
                        notifications.js (painel de notificações), login.js (portal e sessão),
                        portal-funcoes.js (vitrine de funcionalidades na tela inicial), admin.js (painel administrativo)

remoteifes-esp32/
  remoteifes_esp32.ino   firmware principal (Wi-Fi, IR, DHT, WebSocket local, comunicação com o servidor)
  index_html.h            interface web local do dispositivo (aprendizado de IR, termostato, presets)

docs/                    material de apoio do projeto (imagens, documento acadêmico)
export.py / import.py / clear.py   scripts auxiliares de Git (veja Scripts Auxiliares)
```

## Solução de Problemas

- **Servidor não inicia por causa do `node:sqlite`**: confirme que o Node.js instalado é 22.13 ou superior (`node -v`); versões anteriores não têm o módulo nativo `node:sqlite` usado pelo projeto.
- **ESP32 não aparece como online**: verifique se o `DEVICE_TOKEN` configurado no firmware é idêntico ao do `.env` do servidor, e se o ESP32 consegue alcançar o endereço/porta do servidor pela rede local.
- **Heartbeat rejeitado com erro de MAC**: a sala já tem um MAC diferente cadastrado em `Admin > ESP32 / MACs`; atualize o cadastro ou libere a sala novamente para o ESP32 correto.
- **ESP32 aparece em "ESP32 detectados na rede" mas nunca fica online**: a sala reportada no heartbeat não existe (ou foi digitada errado) durante a configuração inicial do dispositivo; vincule o MAC detectado a uma sala existente em `Admin > ESP32 / MACs`, ou reconfigure o ESP32 com o código de sala correto.
- **ESP32 perde conexão Wi-Fi e não volta sozinho**: o firmware tenta reconectar automaticamente a cada 15s e reinicia sozinho após 5 minutos sem rede; se isso persistir, verifique o sinal Wi-Fi no local ou se o roteador/AP mudou de canal ou senha.
- **Usuário com "pode controlar" ativo não consegue controlar uma sala específica**: verifique se a sala está marcada como "acesso restrito" em `Admin > ESP32 / MACs` — nesse caso, o usuário precisa ser adicionado explicitamente à lista de acesso daquela sala (diretamente pelo admin, ou por um proprietário da sala).
- **Acesso bloqueado em produção mesmo dentro da rede do IFES**: confira as faixas CIDR em `redesAutorizadas` e, temporariamente, o `modoTeste` em `Admin > Configurações`; a mesma restrição vale para a conexão WebSocket.
- **Frontend não fala com o servidor depois do deploy**: confirme `serverUrl` em `remoteifes-web/js/config.js` e se `CORS_ORIGIN` no servidor inclui o domínio do frontend publicado (isso também afeta a conexão WebSocket).
- **Status das salas não atualiza sozinho**: o painel depende da conexão WebSocket (`/ws`); se ela cair, o frontend reconecta automaticamente com espera crescente, e há uma retransmissão de reforço a cada 30 segundos — uma falha persistente costuma indicar bloqueio de rede/proxy para conexões WebSocket ou a mesma causa do item anterior (CORS/rede autorizada).
- **Aba "Grade" ou "Agendamentos" não aparece**: essas abas só ficam visíveis para administradores; usuários comuns não têm acesso a elas.
- **Aba "Config. Salas" não aparece para um usuário comum**: ela só é exibida quando o usuário foi tornado proprietário de ao menos uma sala em `Admin > Proprietários de sala`.
- **Login com "admin" não funciona após clonar**: a senha padrão é `admin`, mas isso só se aplica quando o usuário `admin` é criado pela primeira vez no banco. Se `remoteifes-server/data/remoteifes.db` já veio junto no clone (por exemplo, commitado antes de existir um `.gitignore`), o `admin` já existe com outra senha e a criação é pulada silenciosamente. Rode `npm run reset-admin` dentro de `remoteifes-server` para definir uma nova senha sem apagar salas, MACs ou presets já cadastrados; passe a senha desejada como argumento (`npm run reset-admin -- minhaSenhaForte`) ou deixe em branco para gerar uma aleatória.
