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
[![PWA](https://img.shields.io/badge/PWA-Installable-5A0FC8?logo=pwa)](#)
[![Cordova](https://img.shields.io/badge/Apache%20Cordova-Android%20%2F%20iOS-E8E8E8?logo=apachecordova&logoColor=black)](#)
[![Android](https://img.shields.io/badge/Android-App-3DDC84?logo=android&logoColor=white)](#)
[![iOS](https://img.shields.io/badge/iOS-App-000000?logo=apple)](#)
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
- [Segurança](#segurança)
- [Tempo Real (WebSocket)](#tempo-real-websocket)
- [Interface Local do ESP32 e Painel Avançado (Admin > ESP32)](#interface-local-do-esp32-e-painel-avançado-admin--esp32)
- [Acessibilidade](#acessibilidade)
- [Requisitos](#requisitos)
- [Instalação Rápida](#instalação-rápida)
- [Instalação Detalhada](#instalação-detalhada)
- [Configuração](#configuração)
- [Deploy](#deploy)
- [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi)
- [Domínio Próprio e HTTPS](#domínio-próprio-e-https)
- [Empacotamento como PWA e Aplicativo Nativo (Cordova)](#empacotamento-como-pwa-e-aplicativo-nativo-cordova)
- [Scripts Auxiliares](#scripts-auxiliares)
- [Uso da API do GitHub](#uso-da-api-do-github)
- [Estrutura de Pastas](#estrutura-de-pastas)
- [Solução de Problemas](#solução-de-problemas)

## Visão Geral

O projeto é dividido em três partes independentes:

```
remoteifes-web/      Frontend estático (HTML/CSS/JS puro, sem build), publicado no GitHub Pages,
                     também instalável como PWA
remoteifes-cordova/  Empacotamento do mesmo frontend como app nativo Android/iOS via Apache Cordova
remoteifes-server/   API central (Node.js + Express + SQLite), roda em um servidor/host próprio
remoteifes-esp32/    Firmware Arduino/ESP32 instalado em cada sala, ao lado do ar-condicionado
```

Fluxo geral:

1. Cada sala possui um **ESP32** com receptor/emissor de infravermelho (e, opcionalmente, um sensor de temperatura DHT), conectado à rede Wi-Fi local. O ESP32 aprende o protocolo IR do ar-condicionado (ou usa a biblioteca de protocolos conhecidos), envia comandos e reporta seu estado (ligado/desligado, temperatura, MAC, IP) ao servidor central via HTTP ou HTTPS, identificado pelo MAC do dispositivo (veja [Segurança](#segurança)).

2. O **servidor central** (`remoteifes-server`) mantém o banco de dados (SQLite), a lógica de autenticação, permissões, agendamentos, presets, notificações e configurações globais. Ele expõe uma API REST usada tanto pelo frontend web quanto pelos ESP32, além de um canal WebSocket (`/ws`) para atualização de status em tempo real no painel web.

3. O **frontend** (`remoteifes-web`) é um site estático (sem framework de build) que fala com o servidor central via `fetch` e WebSocket. É hospedado no GitHub Pages e pode ser servido em um domínio próprio.

## Papéis e Permissões

O sistema tem três níveis de usuário:

| Nível | Papel | Pode |
|---|---|---|
| 1 | Usuário comum | Ligar/desligar e ajustar a temperatura das salas liberadas para controle |
| 2 | Administrador | Tudo do nível 1, além de gerenciar agendamentos, grade de horários, notificações, sessões, logs, dispositivos e usuários comuns |
| 3 | Administrador principal (superadmin) | Tudo do nível 2, além de alterar configurações globais do sistema, limites de temperatura, redes autorizadas, modo de teste, cadastro de ESP32 por MAC, presets e o painel avançado de cada ESP32 (`Admin > ESP32`) |

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
- Presets e suas funções são criados, editados e removidos inteiramente pela interface web (`Admin > Presets`) — o administrador principal cria um preset, adiciona funções informando chave, rótulo, tipo (número, opção única, liga/desliga) e as respectivas opções, e remove funções individualmente quando não são mais necessárias. O ESP32 não participa mais desse cadastro.
- O administrador principal decide quais presets existem e escolhe qual preset cada sala/ESP32 utiliza (`Admin > ESP32 / MACs`).
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

## Segurança

Resumo das principais medidas de segurança implementadas no servidor central (detalhes específicos já aparecem nas seções acima):

- **Senhas**: armazenadas como hash `bcrypt` (nunca em texto puro); mínimo de 8 caracteres.
- **Sessões**: o token de sessão retornado no login é aleatório (`crypto.randomBytes`), mas o valor gravado no banco (`sessoes.token`) é o hash SHA-256 do token, não o token em si — um vazamento do banco de dados não permite sequestrar sessões ativas diretamente. Sessões inativas por mais de 24h são encerradas automaticamente pelo servidor.
- **Autorização**: todos os papéis (usuário, administrador, administrador principal) e as permissões pontuais (proprietário de sala, acesso restrito) são checados no backend em cada rota, nunca apenas escondidos na interface.
- **Dispositivos (ESP32)**: autenticação por endereço MAC. Enquanto uma sala não tem um MAC cadastrado (`Admin > ESP32 / MACs`), qualquer dispositivo que se identifique com o código dessa sala é aceito (permite a detecção/vinculação inicial do ESP32). Assim que o administrador principal cadastra o MAC do ESP32 físico da sala, o servidor passa a exigir que todas as chamadas dessa sala (heartbeat, WebSocket de dispositivo, comandos, acesso) venham exatamente daquele MAC — chamadas com um MAC diferente são rejeitadas, o que impede que outro dispositivo na mesma rede assuma a identidade da sala.
- **Senha de administração do ESP32**: obrigatória desde o provisionamento (mínimo 6 caracteres), armazenada no dispositivo apenas como hash SHA-256 — é exigida para sair do modo de operação e entrar em modo de configuração/clonagem, e nunca trafega nem fica salva em texto puro. Sem ela, ninguém consegue colocar um ESP32 em modo de aprendizado de infravermelho remotamente, mesmo tendo acesso à aba `Admin > ESP32`.
- **Ponto de acesso de configuração**: a rede `RemoteIFES-Setup`, aberta pelo ESP32 durante o provisionamento ou após um reset de Wi-Fi, é sempre protegida por senha (gerada aleatoriamente na primeira vez, persistida no dispositivo e exibida apenas no monitor serial) — nunca fica aberta.
- **Transporte ESP32 → servidor**: o firmware suporta HTTPS (com validação de certificado usando a cadeia pública da Let's Encrypt, ou sem validação para certificados autoassinados em redes locais) além do HTTP tradicional, configurável no portal de setup de cada dispositivo (modo "Conexão com o servidor"). Veja [Domínio Próprio e HTTPS](#domínio-próprio-e-https).
- **Rate limiting**: tentativas de login, chamadas dos dispositivos (`/dispositivo/*`) e comandos manuais (`/comando`) têm limites por IP para reduzir força bruta e tempestades de comando; conexões WebSocket autenticadas também têm um limite de mensagens por janela de tempo (encerrando a conexão em caso de flood). O firmware do ESP32 também aplica um intervalo mínimo entre comandos de ar-condicionado aceitos, para não sobrecarregar o compressor com toggles rápidos.
- **Cabeçalhos HTTP**: todas as respostas incluem `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy` e `Permissions-Policy`; em produção (`NODE_ENV=production`) também `Strict-Transport-Security`.
- **CORS**: em produção, restrito às origens listadas em `CORS_ORIGIN`.
- **Erros**: respostas de erro nunca incluem stack trace nem detalhes internos; exceções não tratadas são registradas apenas no log do servidor.
- **Restrição de rede** e **modo de teste**: veja a seção [Restrição de Rede](#restrição-de-rede) acima.

## Tempo Real (WebSocket)

O servidor expõe um endpoint WebSocket em `/ws`. Quando o cliente já está autenticado, o token de sessão é enviado pelo campo padrão `Sec-WebSocket-Protocol` do handshake (não por query string) — isso evita que o token fique registrado em logs de acesso de proxies reversos, que costumam gravar a URL completa da requisição. Ao conectar autenticado, o cliente recebe a lista de salas e pode "observar" uma sala específica para receber atualizações do seu status assim que qualquer mudança ocorrer (comando manual, agendamento ou heartbeat do ESP32), sem precisar recarregar a tela. A conexão é também retransmitida periodicamente (a cada 30 segundos) como reforço, e o frontend reconecta automaticamente com espera crescente caso a conexão caia. Esse canal alimenta o assistente simples, a lista de salas, o mapa da planta baixa e o painel de controle de cada sala.

O frontend mantém uma única conexão WebSocket por aba (compartilhada entre a tela de status do servidor e o canal de salas/status), em vez de abrir conexões redundantes. O servidor também limita a quantidade de mensagens que uma conexão autenticada pode enviar em uma janela de tempo curta, encerrando a conexão em caso de flood.

Se você configurar um proxy reverso manualmente (fora do `https-setup.sh`), garanta que ele propague os cabeçalhos `Upgrade` e `Connection` do handshake WebSocket — sem isso, `/ws` não funciona atrás do proxy. O `https-setup.sh` já gera a configuração de Nginx correta para isso.

## Interface Local do ESP32 e Painel Avançado (Admin > ESP32)

O firmware do ESP32 tem dois modos de funcionamento bem separados, com uma transição explícita entre eles:

- **Operação** (`operation`): modo normal do dia a dia — o dispositivo lê o sensor, reporta telemetria e aguarda comandos, sem expor nenhuma função de captura/aprendizado de infravermelho.
- **Configuração** (`config_idle` / `config_clone`): só é alcançado a partir da operação enviando `enter_config` com a **senha de administração do dispositivo** (definida obrigatoriamente durante o provisionamento, mínimo 6 caracteres, armazenada apenas como hash SHA-256 na memória não volátil do ESP32 — nunca em texto puro). Dentro da configuração, o modo **clonagem** (`config_clone`) é o único em que a captura de sinais infravermelhos fica habilitada; `exit_operation` devolve o dispositivo à operação normal a qualquer momento, sem exigir senha.

Isso substitui a antiga interface web local completa do dispositivo (que ficava acessível na rede sem senha e expunha aprendizado de IR, termostato e cadastro de presets a qualquer um na mesma rede Wi-Fi). Hoje, o ESP32 expõe localmente apenas:

- Uma página de **status somente leitura** (protegida por Basic Auth com a mesma senha de administração), mostrando sala, MAC, IP e servidor configurados — para conferência visual direta no equipamento.
- O **portal de provisionamento** (rede `RemoteIFES-Setup`), usado apenas na configuração inicial ou após um reset de Wi-Fi, sempre protegido por senha — veja [Segurança](#segurança).

Todas as funções antes exclusivas da interface local do dispositivo (entrar/sair do modo de configuração, ativar o modo clonagem, iniciar/parar captura de infravermelho, testar um sinal capturado, resetar o Wi-Fi remotamente) agora ficam em uma aba dedicada da aplicação principal, **`Admin > ESP32`**, visível apenas ao administrador principal:

- Para cada sala com MAC cadastrado, mostra separadamente se o dispositivo está **online na rede Wi-Fi** e se está **conectado ao servidor** (dois estados distintos e independentes — um ESP32 pode estar na rede sem conseguir manter o WebSocket com o servidor, e vice-versa por um curto período).
- Exibe a última leitura de temperatura e umidade, o sinal Wi-Fi (RSSI) e o **último comando infravermelho transmitido** pelo dispositivo (sinal bruto reenviado ou estado conhecido — temperatura/ligado/turbo/ventilação), tudo atualizado em tempo real.
- Permite entrar em modo de configuração (mediante a senha do dispositivo), alternar entre modo config e modo clonagem, iniciar/parar a captura de IR e sair de volta para a operação normal.
- Sinais capturados em modo clonagem aparecem na hora nessa aba; cada um pode ser reenviado ("testar") para confirmar que controla o aparelho corretamente antes de ser incorporado a um preset.
- Um botão de **reset de Wi-Fi** remoto apaga as credenciais salvas do dispositivo e o reinicia em modo de ponto de acesso, sem precisar ir fisicamente até o equipamento.

Essa comunicação usa um canal WebSocket dedicado (`/ws/dispositivo`, distinto do `/ws` usado pelos navegadores) pelo qual o próprio ESP32 se conecta ao servidor como cliente — a mesma conexão autenticada por token de dispositivo usada para telemetria é reaproveitada para os comandos administrativos, sem abrir portas adicionais no dispositivo nem exigir que o servidor alcance o ESP32 diretamente. O ESP32 reconecta automaticamente a esse canal a cada 5 segundos caso a conexão caia.

Em `Admin > ESP32 / MACs`, o botão "acessar interface do ESP32" continua disponível e abre, em uma nova aba, a página de status somente leitura do dispositivo no IP mais recente reportado — útil para conferência visual direta no equipamento, sem substituir as funções administrativas, que agora ficam em `Admin > ESP32`.

### Detecção automática de ESP32 na rede

Todo ESP32 que envia um heartbeat ao servidor — mesmo que a sala ainda não esteja vinculada a ele — é registrado automaticamente. Em `Admin > ESP32 / MACs`, a seção "ESP32 detectados na rede" lista esses dispositivos (MAC, IP, última vez visto) e permite vincular cada um a uma sala existente com um único clique, sem precisar digitar o MAC manualmente. Um seletor de planta baixa com zoom, no topo da mesma página, permite buscar e localizar rapidamente o cartão de configuração de qualquer sala clicando nela no mapa; um campo de busca por texto complementa essa navegação.

## Acessibilidade

O frontend inclui um widget de acessibilidade (botão flutuante, disponível em todas as telas) com ajustes persistidos no navegador (`localStorage`) entre sessões: escala de fonte, tipo de fonte (incluindo uma fonte voltada para leitores com dislexia), espaçamento entre letras, altura de linha, largura máxima de parágrafo, alinhamento de texto, cor de fonte e de texto, destaque de links, alto contraste e opção de ocultar imagens.

## Requisitos

### Software

- Node.js 22.13 ou superior (usa o módulo `node:sqlite` nativo, ainda experimental) — em Linux (incluindo Raspberry Pi OS), `remoteifes-server/setup.sh` instala automaticamente a versão correta caso não esteja presente, sem depender do pacote do sistema
- [PlatformIO](https://platformio.org/) (Core CLI ou a extensão para VS Code), com a plataforma `espressif32`, para compilar e gravar o firmware — `remoteifes-esp32/flash.sh` automatiza a instalação do PlatformIO Core (via `pip`) e chama `pio run` para compilar, gravar o sistema de arquivos `data/` (LittleFS) e o firmware
- Bibliotecas (resolvidas automaticamente pelo PlatformIO a partir de `remoteifes-esp32/platformio.ini`, sem instalação manual): [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266) (inclui os módulos `IRrecv`, `IRsend`, `IRutils` e `IRac`), `WebSockets` (Links2004), `ArduinoJson`, `DHT sensor library` e `Adafruit Unified Sensor` — `Preferences`/`DNSServer`/LittleFS já vêm inclusas no core ESP32 do PlatformIO

### Hardware

- Um servidor para rodar `remoteifes-server`, acessível pela rede do IFES e pelos ESP32 — de uma VM a um **Raspberry Pi** (3, 4, 5 ou Zero 2 W); como o `node:sqlite` é nativo do próprio Node.js, não há compilação de dependências nem ferramentas extras a instalar no Pi, veja [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi)
- Um ESP32 com receptor/emissor infravermelho por sala (ou por par de salas adjacentes, quando um único equipamento cobre as duas), com um sensor DHT opcional para leitura de temperatura

## Instalação Rápida

**macOS/Linux (inclui Raspberry Pi):**

```bash
cd remoteifes-server
npm run setup
npm start
```

`npm run setup` verifica o Node.js instalado e, em Linux (x64, ARM64 ou ARMv7 — cobre qualquer Raspberry Pi) ou macOS (via Homebrew), instala automaticamente a versão 22.13+ quando necessário; em seguida instala as dependências e cria o arquivo `.env` a partir de `.env.example` (caso ainda não exista). Rodar `npm run setup` novamente não sobrescreve um `.env` já existente. Para manter o servidor rodando permanentemente e reiniciando sozinho no boot (essencial em um Raspberry Pi dedicado), veja [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi).

**Windows (PowerShell/CMD):**

O script `npm run setup` usa `bash` e não roda no Windows. Nesse caso, faça manualmente:

```powershell
cd remoteifes-server
npm install
copy .env.example .env
npm start
```

**Em ambos os casos**, o banco de dados SQLite é criado e populado automaticamente na primeira execução do servidor (`npm start`), incluindo:

- 95 salas reais do campus, extraídas da planta baixa (Bloco A e B, todos os pavimentos), todas offline até que os ESP32 correspondentes comecem a reportar
- Um usuário `admin`, com senha definida via `SENHA_ADMIN_INICIAL` em `.env` (mínimo 8 caracteres) ou, na ausência dela, uma senha aleatória gerada automaticamente e impressa no console na primeira execução (`npm start`) — guarde-a dali, pois não fica salva em nenhum arquivo. Isso só acontece quando o `admin` ainda não existe no banco; se o banco já veio populado no clone, use `npm run reset-admin` (veja [Solução de Problemas](#solução-de-problemas))
- O preset padrão, com a função de temperatura configurada entre 23 °C e 25 °C

## Instalação Detalhada

### Servidor central

A [Instalação Rápida](#instalação-rápida) já cobre os comandos para colocar o servidor no ar. Esta seção detalha o que acontece por trás deles e as opções relevantes para produção.

Em macOS/Linux, `npm run setup` (usado na instalação rápida) equivale a `npm install` + `cp .env.example .env`. Rode esses passos manualmente em vez do script caso prefira não instalar o Node.js automaticamente ou queira revisar cada etapa. No Windows, onde `npm run setup` não roda, os passos manuais (`npm install`, copiar `.env.example` para `.env`) já são o único caminho, como descrito na instalação rápida.

Antes de colocar o servidor em produção, edite `.env` conforme a seção [Configuração](#configuração) — em especial `CORS_ORIGIN` quando `NODE_ENV=production`, e `SENHA_ADMIN_INICIAL` se quiser escolher a senha do `admin` em vez de usar a gerada automaticamente.

Durante o desenvolvimento, `npm run dev` inicia o servidor com reinício automático a cada alteração de arquivo (`node --watch`), no lugar de `npm start`.

### Frontend

`remoteifes-web` não tem etapa de build: é servido como está. Para desenvolvimento local, basta abrir `index.html` em um servidor HTTP estático (ex.: `npx serve remoteifes-web`) apontando `js/config.js` para o servidor central local.

### Firmware ESP32

O firmware é um projeto [PlatformIO](https://platformio.org/) padrão (`remoteifes-esp32/platformio.ini`), com o código-fonte em `src/main.ino` e a interface local (status e provisionamento) em `data/*.html`, gravada separadamente no sistema de arquivos LittleFS do dispositivo.

**Automatizado (recomendado):**

```bash
cd remoteifes-esp32
bash flash.sh
```

`flash.sh` instala o PlatformIO Core (caso ausente, via `pip`), compila o firmware (`pio run`), grava o sistema de arquivos `data/` (`pio run --target uploadfs`) e depois o firmware (`pio run --target upload`) no ESP32 conectado por USB — sem precisar abrir a Arduino IDE ou a extensão do VS Code. A porta serial costuma ser detectada automaticamente pelo PlatformIO; se houver mais de um dispositivo serial conectado, informe a porta manualmente: `bash flash.sh /dev/ttyUSB0` (Linux/Raspberry Pi) ou `bash flash.sh /dev/cu.usbserial-XXXX` (macOS).

**Manual (PlatformIO Core ou extensão do VS Code):**

```bash
cd remoteifes-esp32
pio run                       # compila o firmware
pio run --target uploadfs     # grava data/ (LittleFS) no dispositivo
pio run --target upload       # grava o firmware
pio device monitor -b 115200  # acompanha os logs de série do ESP32 (Ctrl+C para sair)
```

Ou abra a pasta `remoteifes-esp32/` no VS Code com a extensão PlatformIO instalada e use os alvos equivalentes na barra de tarefas do PlatformIO (Build, Upload Filesystem Image, Upload, Monitor).

`pio device monitor -b 115200` abre o monitor serial na mesma taxa configurada pelo firmware (`Serial.begin(115200)`), útil para acompanhar o boot, o IP obtido, o estado da conexão Wi-Fi/WebSocket com o servidor e mensagens de erro em tempo real. Se houver mais de uma porta serial conectada, informe-a explicitamente: `pio device monitor -b 115200 -p /dev/ttyUSB0` (Linux/Raspberry Pi) ou `pio device monitor -b 115200 -p /dev/cu.usbserial-XXXX` (macOS). Rode `pio device list` para listar as portas disponíveis.

**Em ambos os casos**, o mesmo firmware serve para qualquer sala: nenhum dado é fixado em tempo de compilação. No primeiro boot, o ESP32 sobe um ponto de acesso Wi-Fi próprio (`RemoteIFES-Setup`, sempre protegido por senha) para receber as credenciais da rede local, a sala, o endereço do servidor central e a senha de administração do dispositivo (obrigatória); depois disso, ele se conecta normalmente à rede da sala. Se a conexão Wi-Fi salva falhar, o mesmo ponto de acesso de configuração é reaberto automaticamente.

## Configuração

### Servidor (`remoteifes-server/.env`)

| Variável | Descrição |
|---|---|
| `NODE_ENV` | `development` ou `production`. Em produção, ativa a restrição de rede e o CORS restrito |
| `PORTA` | Porta HTTP (e WebSocket, no mesmo servidor) do servidor (padrão 8080) |
| `CORS_ORIGIN` | Lista de origens permitidas, separadas por vírgula, quando `NODE_ENV=production` — vale tanto para a API HTTP quanto para as conexões WebSocket |
| `SENHA_ADMIN_INICIAL` | Opcional (mínimo 8 caracteres); define a senha do usuário `admin` criado no primeiro boot. Se ausente ou muito curta, uma senha aleatória é gerada e impressa no console nesse primeiro boot |
| `TRUST_PROXY` | Quantos "saltos" de proxy reverso confiar ao ler o IP real do cliente (cabeçalho `X-Forwarded-For`); padrão `1`, correto para o proxy Nginx configurado por `https-setup.sh`. Use `0` se o servidor for exposto diretamente à internet sem proxy na frente — confiar em saltos que não existem permite falsificar o IP de origem e contornar o limite de tentativas de login e a restrição de rede |

Para produção, o servidor deve ficar atrás de HTTPS (proxy reverso como Nginx/Caddy, ou um serviço com TLS gerenciado), já que os aparelhos móveis e o GitHub Pages exigem conteúdo servido por HTTPS.

### Configurações globais (banco de dados, via `Admin > Configurações`)

Estas configurações são armazenadas no banco (tabela `configuracoes`). A aba **Configurações** só é visível e acessível ao administrador principal — nenhum outro administrador pode ver ou alterar esses valores.

| Configuração | Padrão | Descrição |
|---|---|---|
| Limite de temperatura | 23 °C a 25 °C | Intervalo permitido para qualquer comando de temperatura, manual ou agendado (aceita de 16 a 30 °C) |
| Modo de teste | ativado | Quando ativo, desliga a restrição de rede do IFES em produção, permitindo acessar o sistema de qualquer rede para fins de teste; deve ser desativado quando o sistema for para produção definitiva |
| Redes autorizadas | vazia | Lista de faixas de IP em CIDR (ex.: `10.0.0.0/8`) liberadas quando o modo de teste está desativado |
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

## Hospedagem em Raspberry Pi

Um Raspberry Pi (3, 4, 5 ou Zero 2 W, com Raspberry Pi OS de 32 ou 64 bits) é suficiente para rodar `remoteifes-server`: o `node:sqlite` usado pelo projeto é nativo do próprio Node.js, então não há dependências compiladas nem ferramentas de build a instalar no dispositivo.

```bash
git clone <url-do-repositorio>
cd RemoteIFES/remoteifes-server
npm run setup
sudo bash install-service.sh
```

- `npm run setup` detecta a arquitetura do Pi (ARM64 ou ARMv7) e instala automaticamente o Node.js 22.13+ direto dos binários oficiais quando a versão do sistema é insuficiente ou inexistente, sem depender do pacote (geralmente desatualizado) do repositório da distribuição.
- `sudo bash install-service.sh` cria e habilita um serviço `systemd` (`remoteifes.service`) que inicia o servidor no boot e o reinicia automaticamente em caso de falha — dispensa `pm2` ou uma sessão de terminal aberta.

Depois de instalado, use os comandos padrão do `systemd` para gerenciar o serviço:

```bash
sudo systemctl status remoteifes.service
sudo journalctl -u remoteifes.service -f
sudo systemctl restart remoteifes.service
```

Reinicie o serviço (`systemctl restart`) sempre que editar `remoteifes-server/.env`. Para expor o Pi com HTTPS em um domínio próprio (necessário para o frontend em produção e para o PWA/Cordova), siga normalmente `https-setup.sh` como descrito acima — ele funciona da mesma forma em um Raspberry Pi.

Cada sala continua com seu próprio ESP32 fazendo a ponte com o ar-condicionado (veja [Firmware ESP32](#firmware-esp32)); o Raspberry Pi hospeda apenas o servidor central que os agrega.

### Antes de deixar o Pi exposto sem supervisão

Uma Pi acessível pela internet e sem alguém observando ativamente é um alvo permanente. Confira estes pontos antes de deixá-la assim:

- **Anote a senha do `admin`** exibida no console no primeiro `npm start` (ou defina `SENHA_ADMIN_INICIAL` no `.env` antes disso) e troque-a pelo painel assim que possível — ela não é salva em nenhum arquivo nem reexibida depois.
- **Desative o modo de teste** (`Admin > Configurações > Modo de teste`) e cadastre as faixas de IP em `Redes autorizadas` se a intenção é restringir o acesso a uma rede específica; por padrão o modo de teste vem ativado (para facilitar testes) e desliga essa restrição mesmo em produção.
- **Garanta que só a porta 443 do Nginx fique exposta à internet**, nunca a porta do Node (`PORTA`, padrão 8080) diretamente — configure isso no firewall do roteador/Pi (`ufw allow 443`, sem regra para a `PORTA` interna). Acessar a `PORTA` diretamente contorna o HTTPS, o CORS e a checagem de `TRUST_PROXY`.
- **Mantenha o sistema operacional da Pi atualizado sozinho**: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades` aplica patches de segurança do Raspberry Pi OS automaticamente, sem depender de alguém logar para atualizar.
- **Troque a senha padrão do usuário do sistema operacional** (`pi`/`raspberry`, se ainda for a padrão) e prefira acesso SSH por chave pública em vez de senha.
- **Cadastre o MAC de cada ESP32 assim que possível** (`Admin > ESP32 / MACs`): as rotas `/dispositivo/*` não passam pela restrição de rede (os ESP32 precisam alcançá-las de qualquer rede), e enquanto o MAC de uma sala não está cadastrado, qualquer dispositivo que conheça o código dessa sala pode reportar estado falso para ela. Cadastrar o MAC fecha essa janela, exigindo que as chamadas venham exatamente do ESP32 físico da sala.

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

### HTTPS entre o ESP32 e o servidor

O firmware do ESP32 também pode se conectar ao servidor central via HTTPS, além do HTTP tradicional. Essa opção é escolhida no portal de configuração de cada dispositivo (a rede Wi-Fi `RemoteIFES-Setup`, exibida quando o ESP32 ainda não está configurado ou após um reset de Wi-Fi), no campo "Conexão com o servidor":

- **HTTPS com certificado válido (recomendado)**: valida o certificado do servidor contra a cadeia raiz pública da Let's Encrypt (embarcada no firmware); use quando o servidor estiver atrás do `https-setup.sh` (Nginx + Certbot) ou de qualquer outro certificado emitido por essa autoridade.
- **HTTPS sem validar certificado**: criptografa a conexão mas não confirma a identidade do servidor; use apenas em redes locais confiáveis com um certificado autoassinado (ex.: Raspberry Pi sem domínio público).
- **HTTP sem criptografia**: comportamento anterior, mantido para compatibilidade com implantações apenas em rede local confiável.

Dispositivos já configurados antes dessa opção existir continuam em HTTP até serem reconfigurados manualmente (reset de Wi-Fi e novo cadastro pelo portal) — a atualização do firmware sozinha não muda o modo de conexão de um dispositivo já em campo.

## Empacotamento como PWA e Aplicativo Nativo (Cordova)

Além do site publicado no GitHub Pages, o `remoteifes-web` pode ser instalado como **PWA** diretamente do navegador, e o mesmo frontend pode ser empacotado como **app nativo Android/iOS** pelo projeto `remoteifes-cordova/`. Nenhuma das duas formas exige reescrever ou duplicar a lógica da aplicação — ambas reaproveitam os arquivos de `remoteifes-web` como estão.

### PWA (Progressive Web App)

`remoteifes-web` já inclui os arquivos necessários:

| Arquivo | Função |
|---|---|
| `manifest.webmanifest` | Nome, ícones (`assets/icons/`), cor de tema (`#1c6b3c`) e modo de exibição `standalone` |
| `sw.js` | Service worker: cacheia o app shell (HTML/CSS/JS/ícones) para abrir mais rápido e funcionar parcialmente offline |

O `sw.js` só intercepta arquivos estáticos do próprio domínio — chamadas à API (`serverUrl`) e a conexão WebSocket continuam exigindo rede normalmente. O registro do service worker acontece automaticamente no `index.html`, sem configuração adicional.

Requisitos para o botão de instalação aparecer no navegador:

- Frontend servido por HTTPS (GitHub Pages já atende isso).
- `serverUrl` do servidor central também em HTTPS — a mesma exigência de [Domínio Próprio e HTTPS](#domínio-próprio-e-https).

No Chrome/Edge (Android ou desktop) aparece um ícone de instalação na barra de endereço; no Safari (iOS), o caminho é Compartilhar > Adicionar à Tela de Início.

Sempre que algum arquivo estático de `remoteifes-web` for alterado, incremente `CACHE_VERSION` no topo de `sw.js` — isso faz os apps já instalados buscarem a versão nova na próxima abertura.

### Cordova (Android/iOS)

O projeto `remoteifes-cordova/` empacota `remoteifes-web` como app nativo. A pasta `remoteifes-cordova/www/` nunca deve ser editada diretamente: ela é gerada a partir de `remoteifes-web` pelo script `sync-www.js`, chamado automaticamente por todos os scripts `npm run *` do projeto.

#### Instalação do Cordova

```bash
cd remoteifes-cordova
npm install
```

Isso instala o Cordova CLI e os plugins do projeto (`cordova-plugin-whitelist`, `cordova-plugin-statusbar`, `cordova-plugin-splashscreen`) localmente, sem precisar de instalação global.

Para usar o comando `cordova` diretamente no terminal:

```bash
npm install -g cordova
```

#### Requisitos por plataforma

| Plataforma | Requisitos |
|---|---|
| Android | JDK 17, Android Studio ou Android SDK Command-line Tools, variável de ambiente `ANDROID_SDK_ROOT` apontando para o SDK |
| iOS | macOS com Xcode e Xcode Command Line Tools, CocoaPods (`sudo gem install cocoapods`) |

#### Adicionar as plataformas

```bash
cd remoteifes-cordova
npm run prepare-android
```

```bash
cd remoteifes-cordova
npm run prepare-ios
```

Cada comando sincroniza `www/` a partir de `remoteifes-web`, roda `cordova platform add` e `cordova prepare` para a plataforma correspondente.

#### Build e execução

```bash
npm run build-android
```

```bash
npm run build-android-release
```

```bash
npm run run-android
```

```bash
npm run build-ios
```

```bash
npm run run-ios
```

`build-android-release` gera um APK/AAB sem assinatura em `platforms/android/app/build/outputs/`; assine-o com sua própria chave antes de publicar na Play Store. Para iOS, `run-ios` abre o simulador; para dispositivo físico ou publicação na App Store, abra `platforms/ios/RemoteIFES.xcworkspace` no Xcode.

#### Ícone e splash screen

As imagens-fonte ficam em `remoteifes-cordova/resources/` (`icon.png` 1024×1024 e `splash.png` 2732×2732, geradas a partir de `remoteifes-web/assets/remoteifes-logo.png`). Para gerar os tamanhos específicos de cada plataforma a partir dessas duas imagens:

```bash
cd remoteifes-cordova
npx cordova-res android --skip-config --copy
npx cordova-res ios --skip-config --copy
```

#### Apontando o app para o servidor de produção

Edite `remoteifes-web/js/config.js` (não `remoteifes-cordova/www/js/config.js`, que é sobrescrito a cada `sync`) com o `serverUrl` de produção antes de gerar o build — o app empacotado não tem acesso a `localhost` da máquina onde foi compilado.

#### Ajustando as permissões de rede

`remoteifes-cordova/config.xml` vem com `<access origin="*" />` e `<allow-navigation href="*" />` para simplificar o desenvolvimento contra qualquer `serverUrl`. Para produção, restrinja ambos ao domínio real do servidor central (ex.: `https://remoteifes.ifes.edu.br/*`) antes de gerar o build final. O mesmo arquivo já libera tráfego HTTP em texto claro no Android (`usesCleartextTraffic`) para facilitar testes locais; remova essa linha se o servidor de produção só aceitar HTTPS.

## Scripts Auxiliares

Três scripts Python na raiz do projeto auxiliam o fluxo de trabalho com Git (executados a partir da raiz do repositório, com `git` instalado e disponível no `PATH`):

| Script | Função |
|---|---|
| `export.py` | Adiciona todas as alterações (`git add -A`), pede uma mensagem de commit (ou usa `update` como padrão) e envia (`git push origin main`) |
| `import.py` | Atualiza a cópia local a partir do remoto (`git pull origin main`) |
| `clear.py` | Recria o histórico do repositório do zero em um único commit (`checkout --orphan`) e, mediante confirmação explícita, sobrescreve o histórico remoto (`push -f`) — apaga permanentemente todo o histórico de commits anterior; use apenas se isso for intencional |

O repositório inclui um `.gitignore` na raiz que já ignora `remoteifes-server/.env` e `remoteifes-server/data/` (onde fica o banco SQLite), para não versionar segredos (como `SENHA_ADMIN_INICIAL`) nem o banco de dados — veja o aviso sobre esse cenário em [Solução de Problemas](#solução-de-problemas). Se você clonou uma cópia antiga do repositório em que esse arquivo não existia e chegou a commitar `.env` ou o banco, rode `git rm --cached` nesses arquivos antes de publicar o repositório.

## Uso da API do GitHub

Este projeto não depende da API do GitHub em tempo de execução — o uso do GitHub se limita a hospedagem de código-fonte e à publicação estática do frontend via GitHub Pages, configurada manualmente em **Settings > Pages** (branch `main`, pasta `/remoteifes-web`). Não é necessário nenhum token ou workflow de Actions para isso.

## Estrutura de Pastas

```
remoteifes-server/
  setup.sh          instalação e configuração automatizadas (Node.js, dependências, .env)
  install-service.sh configura um serviço systemd para manter o servidor no ar (auto-start no boot, ex.: Raspberry Pi)
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
  manifest.webmanifest  manifesto da PWA (nome, ícones, cor de tema)
  sw.js                 service worker: cache do app shell para instalação/uso offline parcial
  assets/icons/         ícones gerados para PWA, favicon e tela inicial (iOS/Android)
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
                        portal-funcoes.js (vitrine de funcionalidades na tela inicial), admin.js (painel administrativo),
                        esp32-admin.js (painel avançado de cada ESP32, aba "ESP32", restrito ao administrador principal)

remoteifes-esp32/         projeto PlatformIO (framework Arduino, placa esp32dev)
  platformio.ini           configuração do projeto e dependências (bibliotecas resolvidas automaticamente)
  src/main.ino              firmware principal (Wi-Fi, modos operação/config/clonagem, IR, DHT,
                            WebSocket cliente com o servidor, portal de provisionamento)
  include/root_ca.h         certificado raiz (Let's Encrypt) usado quando o firmware se conecta ao servidor via HTTPS
  data/                     arquivos gravados no sistema de arquivos LittleFS do dispositivo
    setup.html               formulário do portal de provisionamento (rede, sala, servidor, senha de administração)
    restart.html             página de confirmação exibida após salvar a configuração
    status.html               página local de status, somente leitura, protegida por Basic Auth
  flash.sh                  instala o PlatformIO Core (se necessário) e compila/grava firmware + sistema de arquivos

remoteifes-cordova/     empacotamento nativo Android/iOS (veja Empacotamento como PWA e Aplicativo Nativo)
  config.xml             configuração do app (id, nome, ícone, splash, permissões de rede)
  package.json            scripts de sync/build/run e plugins Cordova do projeto
  sync-www.js             copia remoteifes-web para www/ antes de cada build (não editar www/ manualmente)
  resources/              imagens-fonte (icon.png, splash.png) usadas por cordova-res
  www/                    cópia gerada de remoteifes-web (gitignored fora de commits manuais, se preferir)

docs/                    material de apoio do projeto (imagens, documento acadêmico)
export.py / import.py / clear.py   scripts auxiliares de Git (veja Scripts Auxiliares)
```

## Solução de Problemas

- **Servidor não inicia por causa do `node:sqlite`**: confirme que o Node.js instalado é 22.13 ou superior (`node -v`); versões anteriores não têm o módulo nativo `node:sqlite` usado pelo projeto.
- **`pio run` falha ao baixar a plataforma `espressif32`**: o PlatformIO precisa de acesso à internet na primeira compilação (para baixar o toolchain do ESP32 e resolver as bibliotecas de `platformio.ini`); confirme a conexão e tente novamente — compilações seguintes reaproveitam o cache local (`~/.platformio`).
- **ESP32 não aparece como online**: verifique se o código da sala configurado no dispositivo corresponde a uma sala cadastrada no servidor, se o MAC cadastrado em `Admin > ESP32 / MACs` (quando houver um) é o mesmo do ESP32 físico, e se o dispositivo consegue alcançar o endereço/porta do servidor pela rede local. `pio device monitor -b 115200` (com o ESP32 conectado por USB) mostra o estado da conexão Wi-Fi/WebSocket e eventuais erros em tempo real.
- **"Entrar em modo de configuração" falha com senha inválida em `Admin > ESP32`**: a senha de administração é a definida no dispositivo durante o provisionamento (portal `RemoteIFES-Setup`), não a senha de nenhum usuário do sistema; se ela foi esquecida, resete o Wi-Fi do dispositivo (fisicamente, ou pelo botão "Resetar Wi-Fi" da mesma aba, se ele ainda estiver conectado) e refaça o provisionamento com uma nova senha.
- **Botão "Iniciar captura IR" fica desabilitado em `Admin > ESP32`**: a captura só é permitida em modo clonagem; ative "Ativar modo clonagem" primeiro (o dispositivo precisa já estar em modo de configuração).
- **Aba "ESP32" não aparece no painel administrativo**: ela é restrita ao administrador principal, assim como `Admin > Configurações`.
- **Heartbeat rejeitado com erro de MAC**: a sala já tem um MAC diferente cadastrado em `Admin > ESP32 / MACs`; atualize o cadastro ou libere a sala novamente para o ESP32 correto.
- **ESP32 aparece em "ESP32 detectados na rede" mas nunca fica online**: a sala reportada no heartbeat não existe (ou foi digitada errado) durante a configuração inicial do dispositivo; vincule o MAC detectado a uma sala existente em `Admin > ESP32 / MACs`, ou reconfigure o ESP32 com o código de sala correto.
- **ESP32 perde conexão Wi-Fi e não volta sozinho**: o firmware tenta reconectar automaticamente a cada 15s e reinicia sozinho após 5 minutos sem rede; se isso persistir, verifique o sinal Wi-Fi no local ou se o roteador/AP mudou de canal ou senha.
- **Usuário com "pode controlar" ativo não consegue controlar uma sala específica**: verifique se a sala está marcada como "acesso restrito" em `Admin > ESP32 / MACs` — nesse caso, o usuário precisa ser adicionado explicitamente à lista de acesso daquela sala (diretamente pelo admin, ou por um proprietário da sala).
- **Acesso bloqueado em produção mesmo dentro da rede do IFES**: confira as faixas CIDR em `redesAutorizadas` e, temporariamente, o `modoTeste` em `Admin > Configurações`; a mesma restrição vale para a conexão WebSocket.
- **Frontend não fala com o servidor depois do deploy**: confirme `serverUrl` em `remoteifes-web/js/config.js` e se `CORS_ORIGIN` no servidor inclui o domínio do frontend publicado (isso também afeta a conexão WebSocket).
- **Status das salas não atualiza sozinho**: o painel depende da conexão WebSocket (`/ws`); se ela cair, o frontend reconecta automaticamente com espera crescente, e há uma retransmissão de reforço a cada 30 segundos — uma falha persistente costuma indicar bloqueio de rede/proxy para conexões WebSocket ou a mesma causa do item anterior (CORS/rede autorizada).
- **Aba "Grade" ou "Agendamentos" não aparece**: essas abas só ficam visíveis para administradores; usuários comuns não têm acesso a elas.
- **Aba "Config. Salas" não aparece para um usuário comum**: ela só é exibida quando o usuário foi tornado proprietário de ao menos uma sala em `Admin > Proprietários de sala`.
- **Botão de instalar o PWA não aparece no navegador**: confirme que o frontend e o `serverUrl` estão ambos em HTTPS (veja [Domínio Próprio e HTTPS](#domínio-próprio-e-https)) — navegadores exigem HTTPS para registrar o service worker e oferecer a instalação.
- **App fica com versão antiga dos arquivos depois de atualizar o PWA**: incremente `CACHE_VERSION` em `remoteifes-web/sw.js`; sem isso, os clientes que já instalaram o app continuam servindo os arquivos do cache antigo.
- **`cordova build android` falha por SDK não encontrado**: confirme que `ANDROID_SDK_ROOT` (ou `ANDROID_HOME`) aponta para a instalação do Android SDK e que o JDK 17 está no `PATH`; rode `npx cordova requirements android` dentro de `remoteifes-cordova` para diagnosticar o que falta.
- **`setup.sh` não consegue instalar o Node.js automaticamente**: confirme a conexão com a internet (o script baixa o binário oficial de `nodejs.org`); em arquiteturas fora de x64/ARM64/ARMv7, ou caso o download falhe, instale manualmente em https://nodejs.org/en/download e rode `npm run setup` novamente.
- **`install-service.sh` falha com "systemd não encontrado"**: o script só funciona em Linux com `systemd` (padrão no Raspberry Pi OS); em outras distribuições, use um gerenciador de processo alternativo como `pm2`.
- **Serviço `remoteifes.service` não inicia**: rode `sudo journalctl -u remoteifes.service -f` para ver o erro; confira se `remoteifes-server/.env` existe e está com as variáveis esperadas (veja [Configuração](#configuração)), e rode `sudo systemctl restart remoteifes.service` após qualquer correção.
- **`flash.sh` não encontra a porta serial do ESP32**: confirme que o cabo USB usado transmite dados (não é só de carga) e que os drivers do conversor USB-serial (CP210x ou CH340, conforme a placa) estão instalados; informe a porta manualmente, ex.: `bash flash.sh /dev/ttyUSB0`.
- **Restrição de rede ou limite de tentativas de login parecem não fazer efeito**: confira `TRUST_PROXY` no `.env` — o valor precisa corresponder ao número real de proxies reversos na frente do servidor (`1` para o Nginx de `https-setup.sh`, `0` se o Node estiver exposto diretamente); um valor maior que o real permite que o IP de origem seja falsificado via `X-Forwarded-For`, contornando as duas proteções.
- **App Cordova não fala com o servidor central**: confirme que `remoteifes-web/js/config.js` (não a cópia em `remoteifes-cordova/www/`) aponta para o `serverUrl` de produção antes de gerar o build, e que `remoteifes-cordova/config.xml` libera o domínio do servidor em `access`/`allow-navigation`.
- **Não sei a senha do `admin` (ou o login não funciona) após clonar**: a senha do `admin` não tem valor fixo — ela é definida por `SENHA_ADMIN_INICIAL` no `.env` ou, na ausência dela, gerada aleatoriamente e impressa apenas uma vez no console, no primeiro `npm start` (procure a linha `Seed: usuário admin criado...` no log). Se você perdeu essa saída, ou se `remoteifes-server/data/remoteifes.db` já veio junto no clone (por exemplo, commitado antes de existir um `.gitignore`), o `admin` já existe e a criação é pulada silenciosamente — a senha do console não se aplica. Rode `npm run reset-admin` dentro de `remoteifes-server` para definir uma nova senha sem apagar salas, MACs ou presets já cadastrados; passe a senha desejada como argumento (`npm run reset-admin -- minhaSenhaForte`) ou deixe em branco para gerar uma aleatória.
