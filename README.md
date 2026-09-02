# RemoteIFES

Sistema de controle remoto de ar-condicionado para as salas do IFES: painel web acessível, agendamento diário, integração ESP32 por MAC ou credencial por dispositivo (com atualização de firmware por OTA), monitoramento operacional local e um servidor central em Node.js.

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
- [Limites de Temperatura e Turbo](#limites-de-temperatura-e-turbo)
- [Notificações](#notificações)
- [Relatos de Problema](#relatos-de-problema)
- [Sessões e Tempo de Inatividade](#sessões-e-tempo-de-inatividade)
- [Auditoria (Logs, Dispositivos e Acessos)](#auditoria-logs-dispositivos-e-acessos)
- [Energia Estimada](#energia-estimada)
- [Restrição de Rede](#restrição-de-rede)
- [Segurança](#segurança)
- [Tempo Real (WebSocket)](#tempo-real-websocket)
- [Interface Local do ESP32 e Painel Avançado (Admin > ESP32)](#interface-local-do-esp32-e-painel-avançado-admin--esp32)
- [Atualização de Firmware por OTA (ESP32)](#atualização-de-firmware-por-ota-esp32)
- [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração)
- [Monitoramento Operacional](#monitoramento-operacional)
- [Mapa de Calor Operacional](#mapa-de-calor-operacional)
- [Acessibilidade](#acessibilidade)
- [Ajuda e Manual no App](#ajuda-e-manual-no-app)
- [Requisitos](#requisitos)
- [Instalação Rápida](#instalação-rápida)
- [Inicialização e implantação (referência canônica)](#inicialização-e-implantação-referência-canônica)
- [Configuração](#configuração)
- [Deploy](#deploy)
- [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi)
- [Domínio Próprio e HTTPS](#domínio-próprio-e-https)
- [Empacotamento como PWA e Aplicativo Nativo (Cordova)](#empacotamento-como-pwa-e-aplicativo-nativo-cordova)
- [Scripts Auxiliares](#scripts-auxiliares)
- [Testes e Integração Contínua](#testes-e-integração-contínua)
- [Uso da API do GitHub](#uso-da-api-do-github)
- [Estrutura de Pastas](#estrutura-de-pastas)
- [Solução de Problemas](#solução-de-problemas)

## Visão Geral

O projeto é dividido em quatro partes independentes:

```
remoteifes-web/      Frontend estático (HTML/CSS/JS puro, sem build), publicado no GitHub Pages,
                     também instalável como PWA
remoteifes-cordova/  Empacotamento do mesmo frontend como app nativo Android/iOS via Apache Cordova
remoteifes-server/   API central (Node.js + Express + SQLite), roda em um servidor/host próprio
remoteifes-esp32/    Firmware Arduino/ESP32 instalado em cada sala, ao lado do ar-condicionado
```

Fluxo geral:

1. Cada sala possui um **ESP32** com receptor/emissor de infravermelho (e, opcionalmente, um sensor de temperatura DHT), conectado à rede Wi-Fi local. O ESP32 aprende o protocolo IR do ar-condicionado (ou usa a biblioteca de protocolos conhecidos), envia comandos e reporta seu estado (ligado/desligado, temperatura, MAC, IP) ao servidor central via HTTP ou HTTPS, identificado pelo MAC ou por uma credencial exclusiva de dispositivo (veja [Segurança](#segurança)).

2. O **servidor central** (`remoteifes-server`) mantém o banco de dados (SQLite), a lógica de autenticação, permissões, agendamentos, limites de temperatura, notificações e configurações globais. Ele expõe uma API REST usada tanto pelo frontend web quanto pelos ESP32, além de canais WebSocket para atualização de status e comandos em tempo real.

3. O **frontend** (`remoteifes-web`) é um site estático (sem framework de build) que fala com o servidor central via `fetch` e WebSocket. É hospedado no GitHub Pages e pode ser servido em um domínio próprio.

## Papéis e Permissões

O sistema tem três níveis de usuário:

| Nível | Papel | Pode |
|---|---|---|
| 1 | Usuário comum | Ligar/desligar e ajustar a temperatura das salas liberadas para controle; enviar relatos de problema pelo ícone de inseto no topo |
| 2 | Administrador (`admin`) | Tudo do nível 1, além de gerenciar agendamentos, grade de horários, notificações de dispositivos, sessões, logs, dispositivos e usuários comuns |
| 3 | Superadministrador (`superadmin`) | Tudo do nível 2, além de alterar configurações globais, limites globais e por sala, função extra do Turbo, redes autorizadas, modo de teste, cadastro de ESP32 por MAC, o painel avançado de cada ESP32 (`Admin > ESP32`) e a gestão dos relatos de problema enviados pelos usuários — inclusive a exclusão permanente de um relato — em `Admin > Relatos de problemas` |

A conta padrão do nível 3 usa o login `superadmin` (nome exibido "Superadministrador"). Instalações anteriores que usavam o login `admin` são migradas automaticamente para `superadmin` no primeiro boot após a atualização, preservando id, hash de senha, nível e permissões; o identificador interno do papel continua sendo `superadmin`.

Além dos três níveis, existe uma permissão pontual, independente de nível: um usuário comum pode ser tornado **proprietário** de uma ou mais salas específicas, o que lhe permite conceder e revogar o acesso de controle de outros usuários apenas àquelas salas, sem se tornar administrador (veja [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala)).

Todas as permissões são impostas no backend (não apenas escondidas na interface): rotas administrativas exigem `exigirAdmin`, rotas/campos críticos exigem `exigirSuperAdmin`, e as rotas de proprietário de sala exigem que o usuário conste como dono daquela sala específica.

## Navegação e Seleção de Salas

### Início (hub)

Após o login o aplicativo abre no **Início** (`#/inicio`, também a aba "Início" e o logotipo no topo): um painel visual que reúne as ações principais em cartões, na ordem de uso mais comum — selecionar sala, planta baixa, agenda e grade (administrador), notificações (administrador), relatar um problema, ajuda/manual e aplicativo móvel. Os cartões respeitam o papel do usuário e apenas abrem telas já existentes (nenhuma função é duplicada). Abaixo das ações operacionais, administradores veem atalhos para as sub-abas de **Administração**; o superadministrador vê ainda uma faixa curta com o estado do banco, do armazenamento, dos ESP32 e dos backups, com link para o Monitoramento. No celular o hub vira uma lista de cartões de toque em coluna única. O hub não altera o roteamento: todos os endereços e o comportamento de refresh/histórico continuam iguais.

### Formas de chegar a uma sala

O sistema oferece três formas de chegar até uma sala, todas equivalentes em funcionalidade:

- **Assistente simples**: três passos guiados por ícones grandes — bloco, andar e sala — pensados para toque em celular. É a navegação padrão de salas.
- **Planta baixa**: exibe a planta baixa real do campus (Bloco A e Bloco B, térreo/2º/3º pavimentos), com abas para alternar entre os seis setores e suporte a zoom. Cada sala com ar-condicionado controlado pelo sistema aparece destacada e colorida conforme seu estado:
  - cinza: offline (sem ESP32 reportando)
  - azul: online, desligado
  - verde: online, ligado
  - contorno amarelo: com agendamento ativo no momento
- **Lista tradicional** (`Bloco → Andar → Sala`): navegação simples em lista, sem elementos gráficos.

Qualquer usuário autenticado pode visualizar o estado de todas as salas — isso inclui salas às quais o usuário não tem permissão de controle, que aparecem marcadas como "visualização" e cujos controles ficam desabilitados no painel. Os três modos de navegação têm botões cruzados para alternar entre si a qualquer momento.

### Endereço, refresh e histórico

O frontend reflete a tela atual no endereço da página como um **fragmento** (`#/inicio`, `#/salas`, `#/sala/A-108`, `#/salas/planta/a-terreo`, `#/agenda`, `#/admin`, `#/admin/esp32`, `#/admin/monitoramento`, `#/admin/relatos`, `#/relatos`, `#/ajuda`, `#/ajuda/ota`…). Um endereço vazio equivale a `#/inicio`. Isso dá o comportamento de um site tradicional:

- recarregar a página mantém onde você estava (aba, subtela, sub-aba de Administração, sala aberta, seção do mapa);
- **voltar/avançar do navegador** percorrem as seções visitadas (cada navegação entre seções gera uma entrada de histórico; trocar apenas um filtro — sala ou data na Grade/Agenda — não gera);
- qualquer seção pode ser aberta direto pela URL, e links do sistema e da documentação podem apontar para uma seção específica (o botão **Abrir no manual** de cada ajuda e o `Ver no app` do manual usam esse mesmo endereçamento). Apelidos curtos de seção do manual são resolvidos (`#/ajuda/ota` → `#/ajuda/ota-credenciais`).

A estratégia é **hash routing** (fragmento), não History API, por ser a única que funciona igual — e sem nenhuma regra de reescrita por implantação — no servidor Node local, atrás de proxy reverso, na PWA, no GitHub Pages usado para demonstração e no app Cordova (`file://`), inclusive **offline** (o app-shell e o manual vêm do cache do service worker). Um caminho real (`/admin/esp32`) exigiria um _catch-all_ no Express, regras no proxy, um truque de `404.html` no GitHub Pages e não sobreviveria a um reload em `file://`.

A versão canônica do frontend fica em `remoteifes-web/version.json` e também é exposta pelo meta `remoteifes-version` e por `window.REMOTEIFES_FRONTEND_VERSION`. HTML, scripts, estilos e imagens usam essa versão na URL. O service worker instala o novo app-shell de forma atômica, usa rede primeiro para navegações, remove somente caches RemoteIFES obsoletos e mantém o shell novo para uso offline. Toda alteração publicada em `remoteifes-web` deve avançar essa versão nos pontos validados por `remoteifes-server/test/frontend-version.test.js`; o teste falha se HTML, manifesto, JavaScript ou worker ficarem desencontrados.

Ao restaurar uma rota, a aba/subtela só é aberta se a permissão do usuário alcança (deny-by-default): rota de Administração sem ser admin cai em Salas; sub-aba exclusiva do superadministrador sem esse nível cai em `Admin > Usuários`; sala inexistente cai em Salas. O endereço **nunca** concede acesso a uma função protegida — ele só escolhe a tela; cada operação continua autorizada no servidor. Nada além da localização de navegação (nenhuma senha, token, credencial de ESP32, conteúdo de formulário ou estado de permissão) é guardado no endereço; formulários e operações incompletas não são restaurados. Sair limpa o endereço.

As 86 salas cadastradas por padrão vêm diretamente da planta baixa fornecida (`remoteifes-server/src/db/salasCampus.js`); ajuste esse arquivo se a planta do campus mudar (novas salas, renomeações, etc.) antes da primeira execução do servidor — o seed só roda quando o banco está vazio. Um código de sala pode representar duas salas físicas controladas pelo mesmo ESP32 (ex.: `B-105-B-106`); nesse caso a interface exibe as duas etiquetas empilhadas no mesmo bloco do mapa.

## Controle de Acesso e Proprietários de Sala

Além da permissão geral "pode controlar" (nível de usuário), existem dois mecanismos para restringir e delegar o controle de salas individuais:

### Acesso restrito por sala

Em `Admin > ESP32 / MACs` (ou em `Admin > Proprietários de sala`), o superadministrador pode marcar uma sala como **acesso restrito**:

1. Isso impede que qualquer usuário comum a controle, mesmo com a permissão geral ativa — exceto os usuários explicitamente autorizados para aquela sala.
2. Usuários autorizados são concedidos/revogados individualmente, por sala.
3. Administradores (níveis 2 e 3) sempre podem controlar qualquer sala, independentemente de restrição.

A verificação é feita no backend (`aplicarComando`), então mesmo chamadas diretas à API respeitam a restrição — a interface apenas reflete o estado (desabilitando os controles e mostrando um aviso de "somente leitura") para dar feedback imediato ao usuário.

### Proprietários de sala

Qualquer administrador pode tornar um usuário comum **proprietário** de uma sala específica, em `Admin > Proprietários de sala`. Um proprietário:

- Ganha acesso a uma aba própria ("Config.", intitulada "Configurações de sala") onde vê apenas as salas das quais é dono.
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

## Limites de Temperatura e Turbo

O controlador possui somente as ações fixas necessárias: diminuir temperatura à esquerda, ligar/desligar ao centro, aumentar temperatura à direita e Turbo abaixo do botão de energia. A disposição não pode ser arrastada nem editada.

O superadministrador configura os limites globais de temperatura, inicialmente 23 °C e 25 °C. Cada sala pode substituir apenas o mínimo, apenas o máximo ou os dois em `Admin > ESP32 / MACs`; um campo deixado vazio herda seu valor global correspondente. Os limites efetivos são aplicados aos comandos manuais, agendamentos e testes de infravermelho. Ao estreitar um intervalo, temperaturas alvo e agendadas existentes são ajustadas para o novo intervalo.

O Turbo transmite o modo turbo suportado pelo protocolo IR da sala. Em `Admin > Configurações`, o superadministrador também pode configurar o Turbo para acionar simultaneamente a oscilação vertical, ou deixá-lo sem função adicional.

## Notificações

O topo da interface tem dois indicadores com significados distintos, cada um com seu rótulo acessível:

- **Sino** — notificações de dispositivos/ESP32, visível apenas a administradores. O sistema gera notificações automáticas quando um ESP32 que estava online fica offline (timeout de heartbeat), quando uma atualização de firmware por OTA conclui ou falha, e quando o [monitoramento operacional](#monitoramento-operacional) detecta uma condição de alerta (disco baixo, backup atrasado, ESP32 instável etc.), sem repetir o mesmo alerta dentro de 6 horas. O painel permite ver a lista mais recente com data/hora, marcar uma notificação como lida (ao clicar nela) e marcar todas de uma vez. O ponto vermelho no sino reflete a contagem de não lidas.
- **Inseto (bug)** — relatos de problema enviados pelos usuários (veja a seção abaixo).

## Relatos de Problema

Qualquer usuário autenticado pode abrir o painel do ícone de inseto no topo e enviar um **relato de problema**. O formulário estilizado (não usa `prompt()`/`alert()` do navegador) pede um título curto, uma categoria, opcionalmente a sala relacionada e uma descrição do que aconteceu. Junto do relato o servidor registra automaticamente apenas contexto não sensível: usuário que enviou, data/hora, página em uso, tamanho da tela, `User-Agent` e idioma do navegador. Senhas, tokens e segredos nunca são coletados; todo o conteúdo é validado, limitado em tamanho e sanitizado no backend, e cliques repetidos no botão de envio não geram relatos duplicados.

Cada relato guarda: id único, usuário (com nome/login preservados mesmo se a conta for removida depois), data de criação e de última atualização, categoria, sala/página, contexto técnico, status e a resposta/anotação da equipe.

**Envio e gestão são separados.** Qualquer usuário — inclusive o superadministrador — envia relatos pelo painel do ícone de inseto, que mostra também os **próprios** relatos e o status de cada um; esse painel nunca contém a fila de gestão. A gestão fica em **`Administração > Relatos de problemas`**, uma sub-aba exclusiva do superadministrador com contadores por situação, filtros (novos, abertos, em análise, resolvidos), abertura de cada relato com autor, horário e detalhes, e as ações de marcar em análise, resolver ou reabrir, com uma resposta opcional que fica visível ao autor. Abrir um relato ainda `novo` o marca automaticamente como `aberto`. Essa sub-aba trata apenas relatos **já enviados** pelos usuários; não há formulário de envio nela. Tanto o ícone de inseto quanto a própria sub-aba exibem um contador discreto com a quantidade de relatos novos ainda não vistos; o painel de envio do superadmin traz um atalho para essa sub-aba.

Dentro da janela de detalhe, o superadministrador pode ainda **excluir permanentemente** um relato. A exclusão fica atrás de uma confirmação em duas etapas dentro da própria janela (não usa `confirm()` do navegador), avisa que a ação não pode ser desfeita e remove a descrição, a resposta e o histórico de revisão. O backend expõe `DELETE /superadmin/relatos/:id` sob `exigirSuperAdmin` e registra apenas metadados no log (`relato-removido`: id, status anterior, quem removeu) — nunca o texto.

A lista global, os relatos de terceiros e a exclusão são bloqueados no backend (`exigirSuperAdmin`), não apenas escondidos na interface — um usuário comum recebe `403` ao tentar acessá-los diretamente.

A tabela `relatos` é criada automaticamente na inicialização do servidor (`CREATE TABLE IF NOT EXISTS`), tanto em instalações novas quanto nas já existentes; não é preciso rodar nenhuma migração manual.

## Sessões e Tempo de Inatividade

O servidor registra cada login como uma sessão (token, horário de início, último uso e, ao sair, horário de logout). Isso alimenta duas sub-abas em `Admin`:

- **Ativos**: usuários com uma sessão em aberto, com um cronômetro de tempo de sessão em tempo real e um status calculado a partir do último uso — `online` (dentro do limiar configurado), `inativo` (sessão aberta, mas sem uso recente) ou `offline`.
- **Sessões**: histórico de logins/logouts, com duração de cada sessão, filtrável por data e removível (por data ou por completo).

O servidor encerra sessões sem atividade e continua sendo a autoridade sobre o prazo, inclusive para REST e WebSocket. A interface mostra uma contagem regressiva junto às iniciais da conta, atualizada localmente a partir do prazo informado pelo servidor, sem consultas a cada segundo. Clique, mouse, tecla ou toque renovam o prazo pelo mecanismo de sessão existente; o aviso prévio permite continuar conectado. Atividade, logout e expiração são sincronizados entre abas. Os padrões são 60 minutos para usuários e 720 minutos para administradores e superadministrador. Além disso, **toda reinicialização do servidor encerra as sessões em aberto**: depois de um restart, os usuários precisam entrar novamente.

## Auditoria (Logs, Dispositivos e Acessos)

Em `Admin`, três sub-abas registram o histórico operacional do sistema, todas filtráveis por data e com opção de apagar registros (ação irreversível):

- **Logs**: cada comando de ligar, desligar ou ajustar temperatura enviado a uma sala, com o usuário responsável (ou `sistema`, quando veio de um agendamento) e a origem (`manual`, `agendamento` ou `esp32_local`, quando o comando parte da interface local do próprio dispositivo).
- **Dispositivos**: eventos de conexão — sempre que um ESP32 fica online ou offline, incluindo o desligamento automático de salas cujo ESP32 parou de responder (após 90 segundos sem heartbeat).
- **Acessos ESP32**: cada requisição feita à interface web local de um ESP32, com o IP de origem — útil para diagnosticar problemas de rede ou identificar acessos incomuns ao dispositivo.

O superadministrador dispõe ainda de **`Administração > Auditoria`**, uma visão paginada e filtrável de ações administrativas importantes, como criação, alteração e exclusão de contas, mudanças de papel e configuração e operações relevantes sobre ESP32. Os registros contêm apenas metadados concisos — nunca senhas, tokens ou segredos de dispositivo. A mesma área apresenta intervalos de indisponibilidade dos controladores, com uma única ocorrência aberta durante a queda e duração calculada quando há reconexão. Interface e APIs exigem `superadmin`; a retenção padrão é 7 dias, configurável entre 1 e 365 dias em Administração.

## Energia Estimada

**`Administração > Energia`** é uma área analítica exclusiva do superadministrador e separada do mapa operacional. A potência elétrica nominal de entrada, em watts, e o tipo do aparelho (`inverter` ou velocidade fixa) podem ser configurados opcionalmente por sala. Watts elétricos não representam capacidade térmica em BTU/h; sem essa configuração o RemoteIFES continua operando normalmente e não calcula consumo para a sala.

A tela compara carga e potência atuais estimadas, consumo estimado hoje/em 7/em 30 dias, tempo ligado e temperaturas disponíveis; períodos com observação insuficiente são marcados como estimativa parcial. O mapa da própria aba oferece somente modos energéticos e não adiciona essas métricas ao mapa operacional. O modelo é deliberadamente simples e limitado: `kWh estimado = kW nominal × horas ligadas × fator de carga estimado`; aparelhos fixos usam fator 1 enquanto ligados, e inverter usa um fator entre 0,35 e 1 baseado apenas na diferença entre temperatura ambiente e alvo. Sem temperatura recente, o fator conservador é 0,65 e a estimativa é marcada como parcial. Os valores são estimativas operacionais, nunca medições para faturamento.

Não há persistência por segundo nem nova coleta de temperatura: o servidor agrega o estado e a telemetria já existentes em resumos diários compactos por sala, mantidos por 45 dias além do dia corrente. A consulta ocorre ao abrir a aba e a consolidação periódica roda a cada 15 minutos, sem polling contínuo no navegador. Falhas do estimador são isoladas e não podem ligar/desligar aparelhos, alterar temperatura ou agendas nem interromper a comunicação com o ESP32.

### Manutenção automática do banco

O servidor roda uma rotina de retenção a cada 6 horas (e uma vez na inicialização) que remove linhas antigas das tabelas de histórico para o banco não crescer indefinidamente em uma operação de longo prazo (ex.: Raspberry Pi):

| Tabela | Retenção padrão | Ajuste |
|---|---|---|
| `comandos_log`, `esp_eventos`, `esp_acessos`, `notificacoes` (apenas lidas) | 180 dias | `RETENCAO_DIAS_LOGS` |
| `notificacoes` (qualquer, lida ou não) | 365 dias | `RETENCAO_DIAS_NOTIFICACOES` |
| `sessoes` (apenas já encerradas) | 90 dias | `RETENCAO_DIAS_SESSOES` |
| `agendamentos_execucoes` | 90 dias | `RETENCAO_DIAS_EXECUCOES` |
| `agendamentos` com data já passada (o agendamento é sempre do dia; após esse prazo já cumpriu seu efeito) e as execuções ligadas a eles | 90 dias | `RETENCAO_DIAS_AGENDAMENTOS` |
| `esp_detectados` sem vínculo com sala | 30 dias sem nova detecção | `RETENCAO_DIAS_DETECCOES` |
| `auditoria_eventos`, `esp_indisponibilidades` | 7 dias | Administração, de 1 a 365 dias |
| `energia_resumos_diarios` | 45 dias além do dia corrente | fixo; cobre as comparações de 30 dias com margem operacional |
| `relatos` **apenas com status `resolvido`** | desligado (`0`); defina para ativar | `RETENCAO_DIAS_RELATOS_RESOLVIDOS` |

Usuários, salas, agendamentos do dia atual, configurações e **relatos de problema não resolvidos nunca são removidos** por essa rotina — a retenção de relatos resolvidos vem **desligada** e só apaga relatos já marcados como `resolvido` quando `RETENCAO_DIAS_RELATOS_RESOLVIDOS` recebe um número de dias. Notificações não lidas sobrevivem a `RETENCAO_DIAS_NOTIFICACOES` (365 dias por padrão) antes de serem descartadas, para uma caixa esquecida não crescer sem limite. As tabelas de histórico têm índices por data/hora para que a limpeza e as consultas de faixa de tempo (monitoramento, listas administrativas) continuem baratas mesmo com o banco cheio. O espaço liberado dentro do arquivo principal do SQLite fica disponível para reutilização pelo próprio banco; após uma limpeza, o servidor também trunca o WAL para impedir que o arquivo auxiliar permaneça grande.

### Limites de crescimento e hardware mínimo

O servidor foi pensado para rodar por anos em hardware modesto (classe **Raspberry Pi 3**: 1 GB de RAM, quatro núcleos ARM, cartão SD). Os pontos que poderiam crescer sem limite estão contidos:

- **Banco**: todas as tabelas de histórico têm retenção por tempo (acima) e índices por data; a rotina de limpeza trunca o WAL ao final.
- **Agendamentos**: o agendador só carrega, a cada minuto, os agendamentos **do dia**, independentemente do tamanho da tabela; agendamentos passados são apagados pela retenção e há um teto por usuário (`AGENDAMENTOS_MAX_ATIVOS_POR_USUARIO`).
- **Notificações de ESP32 offline**: uma nova notificação para a mesma sala é suprimida se já existe uma não lida na última hora, evitando enxurrada por um dispositivo instável.
- **Estado de OTA em memória e em `estados-ota.json`**: entradas em fase terminal (`concluído`, `falhou`) são descartadas após 7 dias; só uma imagem de firmware `.bin` é mantida por vez.
- **Backups e pré-restaurações**: rotacionados por contagem (`BACKUP_RETENCAO`, 14; pré-restaurações, 5); temporários órfãos são varridos após 10 minutos.
- **APK de produção**: apenas o release publicado em `data/releases/mobile/` é servido; nada é acumulado.
- **Estado em memória**: mapas por sala (conexões de dispositivo, última reconexão, capturas de IR — no máximo 20 por sala) e por conexão WebSocket (`WeakMap`, limpos no `close`); o limitador de taxa expira entradas por janela. As listas administrativas usam `LIMIT` no servidor (300–500 linhas) e nunca devolvem a tabela inteira.
- **Transmissão para os navegadores**: a lista de salas só é retransmitida quando muda algo que ela mostra (uma sala fica online/offline, liga ou desliga). A telemetria periódica de temperatura vai apenas para quem está com aquela sala aberta, e o rebroadcast de segurança continua a cada 30 s. Sem esse cuidado, cada quadro de telemetria custaria uma retransmissão da lista inteira para todos os navegadores conectados, e o custo cresceria com o produto salas × navegadores.
- **Logs**: o servidor escreve em `stdout`/`stderr`; a rotação é do coletor (o `journald` do systemd, com seus próprios limites de tamanho, quando instalado via `install-service.sh`).

Para conferir o dimensionamento no seu próprio hardware, `npm run carga` sobe uma instância isolada (banco temporário, descartado ao final — nunca toca no banco de produção), conecta ESP32 simulados pelo protocolo real e relata memória, latência, tráfego por navegador e entrega de comandos: `npm run carga -- --salas 86 --minutos 2`. Use-o depois de mudanças no servidor para confirmar que a operação do campus continua cabendo no equipamento.

**Rodar o servidor em um ESP32-S3 não é viável e não faz parte da arquitetura.** O ESP32-S3 é o alvo do *firmware* (`remoteifes-esp32/`), não do servidor central. O servidor depende de Node.js + V8 (que não têm porte para o Xtensa LX7), do módulo nativo `node:sqlite`, de dois `WebSocketServer` simultâneos e de TLS por software para dezenas de conexões — cada uma dessas peças sozinha excede a RAM interna (~512 KB) e o armazenamento (8–16 MB de flash) do chip, sem contar que backups e a imagem de OTA já não caberiam. A fronteira correta já é a atual: dispositivo fino no ESP32, servidor em um host Linux pequeno. O piso prático abaixo do Pi 3 é algo como um Raspberry Pi Zero 2 W (mesma RAM, ainda roda Node); abaixo disso o servidor não cabe.

### Backup e restauração do banco

O banco inteiro fica em um único arquivo SQLite (`remoteifes-server/data/remoteifes.db`). O servidor sabe fazer cópias de segurança consistentes desse arquivo **sem parar** e sem risco de copiar um estado parcial: cada backup é gerado por `VACUUM INTO`, que produz um arquivo `.db` autônomo, compactado e transacionalmente íntegro (o conteúdo do WAL já entra na cópia; não há `-wal`/`-shm` ao lado). Logo depois de gravado, o arquivo é reaberto somente-leitura e validado com `PRAGMA integrity_check`, `PRAGMA foreign_key_check` e uma checagem das tabelas essenciais — um backup que não passa nessa verificação é descartado, nunca entra na rotação.

**Backup automático** (em produção, ligado por padrão): a cada `BACKUP_INTERVALO_HORAS` (24 por padrão) e uma vez logo após a inicialização, o servidor grava um novo backup em `BACKUP_DIR` (`data/backups/` por padrão) e mantém apenas os `BACKUP_RETENCAO` mais recentes (14 por padrão), removendo os excedentes. Fora de produção o backup automático começa desligado; ligue-o com `BACKUP_AUTOMATICO=true`. Como `data/` já está no `.gitignore`, os backups não são versionados.

**Backup manual:** dentro de `remoteifes-server`, `npm run backup` grava um backup imediato (verificado e já sujeito à rotação) e imprime o caminho. Aceita um rótulo opcional: `npm run backup -- pre-migracao`.

**Restauração:** com o servidor **parado**, `npm run restore` lista os backups disponíveis; `npm run restore -- <arquivo>` restaura o backup indicado (nome dentro de `BACKUP_DIR` ou caminho completo). Antes de sobrescrever, o script verifica o backup candidato, faz uma cópia de segurança consistente do banco atual (`pre-restauracao-<data>.db` em `BACKUP_DIR`) e, depois da troca, revalida o arquivo restaurado. Use `--sim` para pular a confirmação interativa em scripts. Reinicie o servidor após a restauração.

As credenciais dos ESP32 fazem parte do banco e entram normalmente no backup. Se a restauração voltar para antes de uma rotação, substituição ou revogação, a NVS do dispositivo e o banco podem ficar em versões diferentes; nesse caso, emita uma credencial de substituição e informe-a no portal de setup do controlador afetado.

| Variável | Padrão | Descrição |
|---|---|---|
| `BACKUP_AUTOMATICO` | `true` em produção, `false` nos demais | Liga/desliga o backup periódico do agendador |
| `BACKUP_INTERVALO_HORAS` | 24 | Intervalo entre backups automáticos (1 a 8760) |
| `BACKUP_RETENCAO` | 14 | Quantos backups manter; os mais antigos são apagados |
| `BACKUP_DIR` | `data/backups` | Pasta onde os backups são gravados |

## Restrição de Rede

Em produção (`NODE_ENV=production`), o acesso à API é restrito a faixas de IP autorizadas (rede do IFES), configuradas pelo superadministrador em CIDR (ex.: `10.0.0.0/8`). Existe um **modo de teste**, também configurável apenas pelo superadministrador, que permite acesso de fora da rede autorizada — útil durante testes e homologação, mas desativado por padrão em uma instalação nova de produção. Fora do ambiente de produção (`NODE_ENV=development`) essa restrição não é aplicada. A mesma restrição de rede e de modo de teste vale para as conexões WebSocket, não apenas para a API HTTP.

## Segurança

Resumo das principais medidas de segurança implementadas no servidor central (detalhes específicos já aparecem nas seções acima):

- **Senhas**: armazenadas como hash `bcrypt` (nunca em texto puro); mínimo de 8 caracteres.
- **Sessões**: o token de sessão retornado no login é aleatório (`crypto.randomBytes`), mas o valor gravado no banco (`sessoes.token`) é o hash SHA-256 do token, não o token em si — um vazamento do banco de dados não permite sequestrar sessões ativas diretamente. Sessões inativas por mais de 24h são encerradas automaticamente pelo servidor.
- **Autorização**: todos os papéis (usuário, administrador, superadministrador) e as permissões pontuais (proprietário de sala, acesso restrito) são checados no backend em cada rota, nunca apenas escondidos na interface.
- **Dispositivos (ESP32)**: a associação é feita pelo MAC. Um dispositivo ainda não vinculado só pode se registrar como detectado; depois que o superadministrador associa seu MAC a uma sala em `Admin > ESP32 / MACs`, heartbeat, WebSocket e registros dessa sala exigem exatamente o mesmo MAC. Cada sala pode ainda ter uma **credencial exclusiva de dispositivo** (`deviceId` + segredo de 256 bits, guardado só como hash SHA-256): quando provisionada, ela passa a ser exigida no lugar do MAC; uma opção global torna a credencial obrigatória para todos os ESP32. Rotação com tolerância de 24 h, revogação imediata e substituição para troca de placa (preservando a associação da sala). Veja [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração). Como endereços MAC podem ser imitados, mantenha o servidor e os dispositivos em uma rede administrada, prefira a credencial por dispositivo em produção e use HTTPS quando o tráfego sair da rede local.
- **Atualização de firmware (OTA)**: a imagem publicada no servidor é verificada por SHA-256 pelo ESP32 antes de ser instalada; a gravação usa um segundo slot de aplicação e o bootloader reverte sozinho se o novo firmware não passar no autoteste pós-boot. OTA concorrente para a mesma sala é recusada e a gravação por USB continua como caminho de recuperação. Veja [Atualização de Firmware por OTA (ESP32)](#atualização-de-firmware-por-ota-esp32).
- **Administração do ESP32**: os comandos de configuração, captura e reset são autorizados pela sessão do superadministrador no servidor. O dispositivo não guarda nem recebe uma senha administrativa própria.
- **Ponto de acesso de configuração**: a rede protegida `RemoteIFES-Setup` existe no primeiro provisionamento, depois de um reset explícito de Wi-Fi ou como recuperação após 2 minutos contínuos sem conexão. Cada dispositivo gera e preserva uma senha aleatória própria, exibida apenas no console serial físico. O firmware continua tentando reconectar em paralelo e fecha o ponto de acesso quando a rede volta. As rotas que exibem ou salvam o provisionamento só aceitam requisições recebidas pela interface desse ponto de acesso; pela rede operacional, a interface local permanece somente leitura.
- **Transporte ESP32 → servidor**: o firmware suporta HTTPS (com validação de certificado usando a cadeia pública da Let's Encrypt, ou sem validação para certificados autoassinados em redes locais) além do HTTP tradicional, configurável no portal de setup de cada dispositivo (modo "Conexão com o servidor"). Veja [Domínio Próprio e HTTPS](#domínio-próprio-e-https).
- **Rate limiting**: tentativas de login, chamadas dos dispositivos (`/dispositivo/*`), comandos manuais (`/comando`) e envio de relatos de problema (`/relatos`) têm limites por IP para reduzir força bruta, tempestades de comando e spam; conexões WebSocket autenticadas também têm um limite de mensagens por janela de tempo (encerrando a conexão em caso de flood) e um limite de tamanho por frame (8 KiB no canal dos navegadores, 256 KiB no canal dos dispositivos) — frames maiores são recusados antes de qualquer processamento. O firmware do ESP32 também aplica um intervalo mínimo entre comandos de ar-condicionado aceitos, para não sobrecarregar o compressor com toggles rápidos.
- **Relatos de problema**: o conteúdo enviado pelos usuários é validado, limitado em tamanho e tem caracteres de controle removidos no backend antes de gravar (consultas parametrizadas); na interface ele é sempre renderizado como texto (`textContent`), nunca como HTML, evitando XSS armazenado. As rotas de leitura e gestão da caixa global exigem `exigirSuperAdmin`; um usuário comum só alcança os próprios relatos. Os logs do servidor registram apenas metadados do relato (id, autor, categoria, status), nunca o texto do relato ou da resposta.
- **Cabeçalhos HTTP**: todas as respostas incluem `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy` e `Permissions-Policy`; em produção, `Strict-Transport-Security` também é enviado nas respostas HTTPS.
- **CORS**: em produção, a própria origem é aceita automaticamente; origens externas precisam ser listadas em `CORS_ORIGIN`.
- **Erros**: respostas de erro nunca incluem stack trace nem detalhes internos; exceções não tratadas são registradas apenas no log do servidor.
- **Restrição de rede** e **modo de teste**: veja a seção [Restrição de Rede](#restrição-de-rede) acima.

## Tempo Real (WebSocket)

O servidor expõe um endpoint WebSocket em `/ws`. Quando o cliente já está autenticado, o token de sessão é enviado pelo campo padrão `Sec-WebSocket-Protocol` do handshake (não por query string) — isso evita que o token fique registrado em logs de acesso de proxies reversos, que costumam gravar a URL completa da requisição. Ao conectar autenticado, o cliente recebe a lista de salas e pode "observar" uma sala específica para receber atualizações do seu status assim que qualquer mudança ocorrer (comando manual, agendamento ou heartbeat do ESP32), sem precisar recarregar a tela. A conexão é também retransmitida periodicamente (a cada 30 segundos) como reforço, e o frontend reconecta automaticamente com espera crescente caso a conexão caia. Um aparelho que suspende ou troca de rede pode deixar o socket aberto sem tráfego e sem evento de fechamento; por isso, ao voltar ao primeiro plano — e enquanto a tela estiver visível, se o reforço de 30 segundos não chegar — o frontend pede uma prova de vida pelo próprio canal e recicla a conexão quando ela não responde, em vez de seguir exibindo o último estado recebido como se fosse o atual. Esse canal alimenta o assistente simples, a lista de salas, o mapa da planta baixa e o painel de controle de cada sala.

O frontend mantém uma única conexão WebSocket por aba (compartilhada entre a tela de status do servidor e o canal de salas/status), em vez de abrir conexões redundantes. O servidor também limita a quantidade de mensagens que uma conexão autenticada pode enviar em uma janela de tempo curta, encerrando a conexão em caso de flood.

Se você configurar um proxy reverso manualmente, garanta que ele propague os cabeçalhos `Upgrade` e `Connection` do handshake WebSocket — sem isso, `/ws` não funciona atrás do proxy. `lan-setup.sh` e `https-setup.sh` já geram a configuração de Nginx correta para isso.

## Interface Local do ESP32 e Painel Avançado (Admin > ESP32)

O firmware do ESP32 tem dois modos de funcionamento bem separados, com uma transição explícita entre eles:

- **Operação** (`operation`): modo normal do dia a dia — o dispositivo lê o sensor, reporta telemetria e aguarda comandos, sem expor nenhuma função de captura/aprendizado de infravermelho.
- **Configuração** (`config_idle` / `config_clone`): é alcançada a partir da operação por um comando do superadministrador. Dentro da configuração, o modo **clonagem** (`config_clone`) é o único em que a captura de sinais infravermelhos fica habilitada; `exit_operation` devolve o dispositivo à operação normal.

Isso substitui a antiga interface web local completa do dispositivo. Hoje, o ESP32 expõe localmente apenas:

- Uma página de **status somente leitura**, mostrando sala, MAC, IP, servidor configurado e versão do firmware — para conferência visual direta no equipamento.
- O **portal de provisionamento** na rede aberta `RemoteIFES-Setup`, usado na configuração inicial, após um reset explícito de Wi-Fi ou na recuperação de uma indisponibilidade contínua da rede — veja [Segurança](#segurança).

Todas as funções antes exclusivas da interface local do dispositivo (entrar/sair do modo de configuração, ativar o modo clonagem, iniciar/parar captura de infravermelho, testar um sinal capturado, resetar o Wi-Fi remotamente) agora ficam em uma aba dedicada da aplicação principal, **`Admin > ESP32`**, visível apenas ao superadministrador:

- Para cada sala com MAC cadastrado, mostra separadamente se o dispositivo está **online na rede Wi-Fi** e se está **conectado ao servidor** (dois estados distintos e independentes — um ESP32 pode estar na rede sem conseguir manter o WebSocket com o servidor, e vice-versa por um curto período).
- Exibe a última leitura de temperatura e umidade, o sinal Wi-Fi (RSSI) e o **último comando infravermelho transmitido** pelo dispositivo (sinal bruto reenviado ou estado conhecido — temperatura/ligado/turbo/ventilação), tudo atualizado em tempo real.
- Permite entrar em modo de configuração, alternar entre modo config e modo clonagem, iniciar/parar a captura de IR e sair de volta para a operação normal.
- Sinais capturados em modo clonagem aparecem na hora nessa aba; cada um pode ser reenviado ("testar") e um protocolo de ar-condicionado compatível pode ser selecionado para a sala.
- Um botão de **reset de Wi-Fi** remoto apaga a rede e o endereço do servidor, preserva a credencial exclusiva do dispositivo e o reinicia em modo de ponto de acesso, sem precisar ir fisicamente até o equipamento.
- Mostra a **versão do firmware** instalada e a publicada, com um botão de **atualização por OTA** e barra de progresso (veja [Atualização de Firmware por OTA (ESP32)](#atualização-de-firmware-por-ota-esp32)).
- Gerencia a **credencial exclusiva do dispositivo** (provisionar, rotacionar, substituir, revogar), com o segredo exibido uma única vez (veja [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração)).

Essa comunicação usa um canal WebSocket dedicado (`/ws/dispositivo`, distinto do `/ws` usado pelos navegadores) pelo qual o próprio ESP32 se conecta ao servidor como cliente. A conexão é associada à sala pelo MAC cadastrado ou pela credencial do dispositivo e é reaproveitada para telemetria, comandos administrativos e OTA, sem abrir portas adicionais no dispositivo nem exigir que o servidor alcance o ESP32 diretamente. O ESP32 reconecta automaticamente caso a conexão caia, e o servidor reaplica o estado desejado depois da reconexão.

Em `Admin > ESP32 / MACs`, o botão "acessar interface do ESP32" continua disponível e abre, em uma nova aba, a página de status somente leitura do dispositivo no IP mais recente reportado — útil para conferência visual direta no equipamento, sem substituir as funções administrativas, que agora ficam em `Admin > ESP32`.

### Detecção automática de ESP32 na rede

Todo ESP32 consulta o servidor com seu MAC após entrar na rede. Mesmo sem vínculo com uma sala, ele é registrado automaticamente como detectado. Em `Admin > ESP32 / MACs`, a seção "ESP32 detectados na rede" lista esses dispositivos (MAC, IP, última vez visto) e permite vincular cada um a uma sala existente com um único clique. O dispositivo recebe a associação na próxima consulta, sem reconfiguração ou reinicialização. Um seletor de planta baixa com zoom e um campo de busca ajudam a localizar a sala.

## Acessibilidade

O frontend inclui um widget de acessibilidade (botão flutuante, disponível em todas as telas) com ajustes persistidos no navegador (`localStorage`) entre sessões: escala de fonte, tipo de fonte (incluindo uma fonte voltada para leitores com dislexia), espaçamento entre letras, altura de linha, largura máxima de parágrafo, alinhamento de texto, cor de fonte e de texto, destaque de links, alto contraste e opção de ocultar imagens.

## Ajuda e Manual no App

O ícone **?** ao lado do título de cada tela abre uma ajuda curta daquela página, com um atalho para a seção correspondente do manual. O botão **Precisa de ajuda?** (canto inferior) abre um menu rápido com a ajuda da página atual, o **manual completo do RemoteIFES**, a solução de problemas, o envio de relato e a página do aplicativo móvel. O menu da conta (avatar com iniciais) traz apenas ações de conta — **Aplicativo móvel** e **Sair**; ajuda e manual ficam exclusivamente na interface de ajuda dedicada. O manual é uma página de documentação dedicada, com sumário, busca, diagramas em SVG e links "Ver no app". A documentação comum fica no app-shell e funciona offline. Conteúdo administrativo é entregue por `/documentation` somente após validar a sessão no servidor: administrador recebe apenas operação administrativa e superadministrador recebe também ESP32, OTA, credenciais, monitoramento, backup, implantação e manutenção. A resposta usa `private, no-store`; esses textos não ficam nos assets públicos nem no cache compartilhado da PWA/Cordova.

A divisão entre os dois documentos é deliberada: este README é a referência de instalação, arquitetura, implantação e desenvolvimento; a **Ajuda no app** é o guia operacional de uso, escrito por papel e verificado contra a interface real. Procedimentos de terminal e infraestrutura aparecem na Ajuda apenas para o superadministrador, e sem repetir o conteúdo detalhado daqui.

## Requisitos

### Software

- Node.js 22.13 ou superior (usa o módulo `node:sqlite` nativo, ainda experimental) — em Linux (incluindo Raspberry Pi OS), `remoteifes-server/setup.sh` instala automaticamente a versão correta caso não esteja presente, sem depender do pacote do sistema
- [PlatformIO](https://platformio.org/) (Core CLI ou a extensão para VS Code), com a plataforma `espressif32`, para compilar e gravar o firmware — `remoteifes-esp32/flash.sh` automatiza a instalação do PlatformIO Core (prefere `pipx`, com fallback para `pip --user`) e chama `pio run` para compilar, gravar o sistema de arquivos `data/` (LittleFS) e o firmware
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

Abra **`http://localhost:8080`** no próprio servidor. De outro dispositivo na mesma rede, abra **`http://IP_DO_SERVIDOR:8080`**. Este é o fluxo normal integrado de desenvolvimento e teste: o Node/Express entrega o frontend do RemoteIFES, a API e o WebSocket juntos na porta 8080 e na mesma origem.

O VS Code Live Server **não é necessário** nesse fluxo. Ele cria outra origem e só deve ser usado intencionalmente no desenvolvimento isolado do frontend, conforme [Frontend em origem separada](#frontend-em-origem-separada-desenvolvimento-opcional). Produção não depende de `localhost` fixado no código: use a origem do servidor/proxy ou configure explicitamente a origem separada.

`npm run setup` verifica o Node.js instalado e, em Linux (x64, ARM64 ou ARMv7 — cobre qualquer Raspberry Pi) ou macOS (via Homebrew), instala automaticamente a versão 22.13+ quando necessário; em seguida instala as dependências e cria o arquivo `.env` a partir de `.env.example` (caso ainda não exista). Rodar `npm run setup` novamente não sobrescreve um `.env` já existente. Os fluxos definitivos de desenvolvimento, produção, `systemd`, proxy reverso e frontend separado ficam somente na [referência canônica de inicialização e implantação](#inicialização-e-implantação-referência-canônica).

**Windows (PowerShell/CMD):**

O script `npm run setup` usa `bash` e não roda no Windows. Nesse caso, faça manualmente:

```powershell
cd remoteifes-server
npm install
copy .env.example .env
npm start
```

**Em ambos os casos**, o banco de dados SQLite é criado e populado automaticamente na primeira execução do servidor (`npm start`), incluindo:

- 86 salas reais do campus, extraídas da planta baixa (Bloco A e B, todos os pavimentos), todas offline até que os ESP32 correspondentes comecem a reportar
- Um superadministrador inicial `superadmin` com senha `admin` quando `SENHA_ADMIN_INICIAL` não for definida. O acesso permanece funcional e um aviso persistente, visível somente ao superadministrador autenticado, leva à troca da senha
- Limites globais de temperatura de 23 °C a 25 °C e Turbo sem função adicional

## Inicialização e implantação (referência canônica)

Esta é a referência canônica de startup. Se a arquitetura de inicialização mudar, atualize esta seção; a [Instalação Rápida](#instalação-rápida), [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi) e [Deploy](#deploy) apenas resumem ou detalham operações posteriores.

### Desenvolvimento integrado

Primeira instalação (uma vez):

```bash
cd remoteifes-server
npm run setup
npm start
```

Startup normal (todas as vezes seguintes):

```bash
cd remoteifes-server
npm start
```

`npm run setup` só é necessário na primeira instalação ou quando as dependências mudam; não o rode antes de cada reinício. Com `SERVIR_FRONTEND=true` (padrão), abra `http://localhost:8080` ou `http://IP_DO_SERVIDOR:8080`. Express serve `remoteifes-web`, API e `/ws` na mesma origem. `npm run dev` oferece o mesmo conjunto integrado com reinício automático do processo ao alterar arquivos do servidor. O frontend não tem etapa de build.

Em macOS/Linux, `npm run setup` instala as dependências e copia `.env.example` para `.env` somente se o arquivo ainda não existir. No Windows, use os passos manuais da [Instalação Rápida](#instalação-rápida). Banco e migrações são aplicados automaticamente no primeiro startup; não há comando separado de migração.

### Produção

Antes do primeiro startup, revise `.env`, defina `NODE_ENV=production`, mantenha `SERVIR_FRONTEND=true`, defina `SENHA_ADMIN_INICIAL` e cadastre as redes autorizadas. Inicie manualmente com `npm start` apenas para validação ou operação supervisionada. A aplicação usa a URL pela qual foi aberta; portanto, uma implantação normal same-origin nunca depende de `localhost` hardcoded. Veja [Configuração](#configuração) e as rotinas operacionais em [Deploy](#deploy).

### Linux com systemd

```bash
cd remoteifes-server
npm run setup
sudo bash install-service.sh
```

Esse é o startup persistente canônico para Linux/Raspberry Pi: instala e habilita `remoteifes.service` e o watchdog. Gerencie-o com `sudo systemctl status|start|stop|restart remoteifes.service`; consulte logs com `sudo journalctl -u remoteifes.service -f` e saúde com `npm run health`. O instalador configura produção e pergunta as redes autorizadas. Os detalhes de atualização, backup e recuperação ficam em [Deploy](#deploy).

### Proxy reverso

Para LAN na porta 80, depois do serviço `systemd`, rode `sudo bash lan-setup.sh`. Para HTTPS com domínio, rode `sudo bash https-setup.sh <dominio> <email>`. Ambos mantêm frontend, API e WebSocket na mesma origem, encaminham o upgrade WebSocket e ajustam `TRUST_PROXY=1` e `BIND_ADDR=127.0.0.1`. Não exponha simultaneamente a porta interna 8080. Veja [Proxy reverso na porta 80](#proxy-reverso-na-porta-80-rede-local-sem-internet) e [HTTPS com domínio próprio](#https-com-domínio-próprio-opcional) para os efeitos operacionais dos scripts.

### Frontend em origem separada (desenvolvimento opcional)

O Live Server é suportado somente como modo intencional de desenvolvimento isolado. Primeiro mantenha a API/WebSocket em `http://localhost:8080`; depois sirva `remoteifes-web` pelo Live Server em `localhost`. Nesse caso `js/config.js` resolve explicitamente o backend local na porta 8080 e o CORS aberto de `NODE_ENV=development` aceita a origem do Live Server. Se o frontend separado não estiver em `localhost`, sua URL de servidor precisa ser configurada deliberadamente para o ambiente e, em produção, a origem exata precisa constar em `CORS_ORIGIN`. Não use Live Server para validar a implantação integrada, PWA de produção, proxy ou ESP32.

Para voltar ao modo normal, pare o Live Server e acesse `http://localhost:8080`. Não grave um `localhost` fixo para produção. O Cordova recebe a origem de produção por `REMOTEIFES_SERVER_URL` durante o build; não edite `js/config.js` manualmente para o fluxo integrado ou Cordova.

### Firmware ESP32

O firmware é um projeto [PlatformIO](https://platformio.org/) padrão (`remoteifes-esp32/platformio.ini`), com o código-fonte em `src/main.ino` e a interface local (status e provisionamento) em `data/*.html`, gravada separadamente no sistema de arquivos LittleFS do dispositivo.

**Automatizado (recomendado):**

```bash
cd remoteifes-esp32
bash flash.sh
```

`flash.sh` instala o PlatformIO Core caso esteja ausente (com `pipx`, recomendado no Ubuntu 24.04 e demais sistemas com Python gerenciado; se `pipx` não existir, usa `pip --user`), compila o firmware (`pio run`), grava o sistema de arquivos `data/` (`pio run --target uploadfs`) e depois o firmware (`pio run --target upload`) no ESP32 conectado por USB — sem precisar abrir a Arduino IDE ou a extensão do VS Code. A porta serial costuma ser detectada automaticamente pelo PlatformIO; se houver mais de um dispositivo serial conectado, informe a porta manualmente: `bash flash.sh /dev/ttyUSB0` (Linux/Raspberry Pi) ou `bash flash.sh /dev/cu.usbserial-XXXX` (macOS).

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

**Em ambos os casos**, o mesmo firmware serve para qualquer sala: nenhum dado é fixado em tempo de compilação. No primeiro boot, o ESP32 sobe o ponto de acesso aberto `RemoteIFES-Setup` para receber as credenciais da rede local, o endereço do servidor central e, se já provisionada, a credencial exclusiva do dispositivo. Depois de conectado, o servidor detecta o MAC e o superadministrador o vincula à sala em `Admin > ESP32 / MACs`. Em falhas de Wi-Fi, o firmware tenta reconectar sem bloquear o restante da operação; depois de 2 minutos contínuos sem conexão, também abre o ponto de acesso de recuperação e mantém as tentativas em paralelo. O ponto de acesso é fechado automaticamente quando a rede volta.

A versão do firmware é definida por `-DFW_VERSAO` em `platformio.ini` (atualmente `4.0.0`) e é reportada ao servidor na telemetria, no heartbeat e na página de status local. A partição do ESP32 usa o layout `min_spiffs.csv` (dois slots de aplicação de ~1,9 MB — o firmware atual ocupa ~63% de um slot), o que reserva um slot ocioso para a [atualização por OTA](#atualização-de-firmware-por-ota-esp32) com reversão automática. **A gravação por USB (`flash.sh` / `pio run --target upload`) continua sendo o caminho de recuperação**: ela regrava o slot ativo e não depende do estado do OTA.

## Configuração

### Servidor (`remoteifes-server/.env`)

| Variável | Descrição |
|---|---|
| `NODE_ENV` | `development` ou `production`. Em produção, ativa a restrição de rede, o CORS restrito e o serviço do frontend pelo próprio servidor |
| `PORTA` | Porta HTTP (e WebSocket, no mesmo servidor) do servidor (padrão 8080) |
| `SERVIR_FRONTEND` | Servir o `remoteifes-web` pelo próprio servidor, na mesma origem da API (operação same-origin). Padrão: ligado em desenvolvimento e produção. Desative apenas no desenvolvimento intencional do frontend em outra origem. Com o frontend servido assim, `CORS_ORIGIN` deixa de ser necessário |
| `FRONTEND_DIR` | Caminho da pasta do frontend a servir (padrão: `../remoteifes-web` relativo ao projeto do servidor) |
| `REMOTEIFES_DATA_DIR` | Diretório dos dados persistentes (banco, backups, imagem de firmware para OTA, versões e log de deploy). Padrão: `data/` dentro do projeto do servidor. Aponte para fora do checkout do Git (ex.: `/var/lib/remoteifes`) para que atualizações de código nunca toquem nos dados. `REMOTEIFES_DB_PATH`, `BACKUP_DIR` e `REMOTEIFES_FIRMWARE_DIR` continuam disponíveis para sobrescrever caminhos individuais |
| `CORS_ORIGIN` | Lista de origens permitidas, separadas por vírgula, quando `NODE_ENV=production` — necessária **apenas** quando o frontend é servido de outra origem (ex.: GitHub Pages). Vale tanto para a API HTTP quanto para as conexões WebSocket |
| `SENHA_ADMIN_INICIAL` | Opcional; define a senha do usuário `superadmin` criado no primeiro boot. Quando vazia, usa `admin` e mostra ao superadministrador um aviso persistente para alterá-la |
| `TRUST_PROXY` | Quantos "saltos" de proxy reverso confiar ao ler o IP real do cliente (cabeçalho `X-Forwarded-For`); **padrão `0`** (não confia em nenhum proxy). O `https-setup.sh` e o `lan-setup.sh` alteram este valor para `1` ao configurar o Nginx, que é o valor correto quando há exatamente um proxy reverso na frente. Só use um valor maior que `0` quando existir de fato um proxy confiável imediatamente à frente do servidor — confiar em saltos que não existem permite que um cliente falsifique o IP de origem via `X-Forwarded-For` e contorne o limite de tentativas de login e a restrição de rede |
| `RETENCAO_DIAS_LOGS` / `RETENCAO_DIAS_SESSOES` / `RETENCAO_DIAS_EXECUCOES` / `RETENCAO_DIAS_DETECCOES` | Opcionais. Dias de retenção das tabelas de histórico antes da limpeza automática (padrões: 180 / 90 / 90 / 30). Veja [Manutenção automática do banco](#manutenção-automática-do-banco) |
| `RETENCAO_DIAS_NOTIFICACOES` / `RETENCAO_DIAS_AGENDAMENTOS` | Opcionais. Dias até descartar qualquer notificação (mesmo não lida) e até apagar agendamentos com data já passada e suas execuções (padrões: 365 / 90) |
| `RETENCAO_DIAS_RELATOS_RESOLVIDOS` | Opcional. **Desligado por padrão (`0`).** Quando recebe um número de dias, a rotina apaga relatos **já resolvidos** mais antigos que esse prazo; relatos não resolvidos nunca são tocados |
| `AGENDAMENTOS_MAX_ATIVOS_POR_USUARIO` | Opcional. Teto de agendamentos ativos por usuário (padrão `300`); evita que um único autor infle a varredura do agendador |
| `BACKUP_AUTOMATICO` / `BACKUP_INTERVALO_HORAS` / `BACKUP_RETENCAO` / `BACKUP_DIR` | Opcionais. Backup periódico do banco SQLite (em produção, ligado por padrão). Veja [Backup e restauração do banco](#backup-e-restauração-do-banco) |

Para a operação de produção local (na rede da instituição), veja [Deploy](#deploy): o servidor entrega o frontend na mesma origem e um proxy reverso HTTP (`lan-setup.sh`) basta. HTTPS com domínio próprio (`https-setup.sh`) é necessário apenas para expor o sistema fora da rede local ou para o PWA/Cordova em domínio público, já que os aparelhos móveis exigem conteúdo servido por HTTPS.

### Configurações globais (banco de dados, via `Admin > Configurações`)

Estas configurações são armazenadas no banco (tabela `configuracoes`). A aba **Configurações** só é visível e acessível ao superadministrador — nenhum outro administrador pode ver ou alterar esses valores.

| Configuração | Padrão | Descrição |
|---|---|---|
| Limite de temperatura | 23 °C a 25 °C | Intervalo permitido para qualquer comando de temperatura, manual ou agendado (aceita de 16 a 30 °C) |
| Função adicional do Turbo | nenhuma | Opcionalmente ativa também a oscilação vertical enquanto o Turbo estiver ligado |
| Modo de teste | desativado em produção nova | Quando ativo, desliga a restrição de rede do IFES em produção, permitindo acessar o sistema de qualquer rede para fins de teste; deve permanecer desativado na operação definitiva |
| Redes autorizadas | vazia | Lista de faixas de IP em CIDR (ex.: `10.0.0.0/8`) liberadas quando o modo de teste está desativado |
| Tempo de inatividade de usuários | 60 minutos | Limite de inatividade aplicado pelo servidor a usuários normais |
| Tempo de inatividade administrativo | 720 minutos | Limite de inatividade aplicado a administradores e superadministrador |
| Aviso de logout automático | 60 segundos | Duração da contagem regressiva exibida antes do logout por inatividade |
| Limiar de presença online | 5 minutos | Minutos sem uso após os quais um usuário com sessão aberta passa de "online" para "inativo" na aba Ativos |
| Exigir credencial por dispositivo em todos os ESP32 | ativado em instalações normais novas | Nenhum ESP32 se conecta apenas pelo MAC enquanto esta opção estiver ativa — toda sala precisa de uma credencial provisionada. Para um controlador novo, provisione a credencial da sala no painel e informe `deviceId` e segredo junto com o Wi-Fi no portal `RemoteIFES-Setup`; em uma migração de controladores antigos, siga o fluxo gradual da seção [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração). O ambiente automatizado de testes começa com a opção desativada para exercitar também o modo legado. |

### ESP32 por MAC e limites por sala (via `Admin > ESP32 / MACs`)

O superadministrador cadastra o endereço MAC de cada ESP32 autorizado para uma sala — manualmente ou vinculando um dispositivo já detectado na rede (veja [Detecção automática de ESP32 na rede](#detecção-automática-de-esp32-na-rede)). Isso:

1. Associa a sala ao dispositivo sem salvar o código da sala no firmware.
2. Faz o servidor rejeitar comunicações que declarem a sala com outro MAC.
3. Permite definir um mínimo, um máximo ou ambos especificamente para a sala; cada campo vazio continua herdando o valor global correspondente.

Na mesma tela, o administrador também define se uma sala tem **acesso restrito** e quais usuários específicos podem controlá-la — veja [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala).

## Deploy

A operação de produção é **local, na rede da instituição, e não depende da Internet nem do GitHub Pages**. O caminho é:

```
Navegador/PWA → rede local → proxy reverso → remoteifes-web → API Node/Express + WebSocket → SQLite → ESP32
```

O próprio servidor Node entrega o `remoteifes-web` na **mesma origem** da API quando `NODE_ENV=production` (ou `SERVIR_FRONTEND=true`). Assim não há CORS entre frontend e backend, o WebSocket usa a mesma origem da página, e o `remoteifes-web` não precisa ser publicado em lugar nenhum.

### Servidor central

Faça a instalação pelo fluxo único de [Linux com systemd](#linux-com-systemd). Esta seção descreve os efeitos e a operação posterior, sem redefinir os comandos de startup.

`install-service.sh`:

- grava `NODE_ENV=production` no `.env` e cria o serviço `remoteifes.service` (`Restart=always`, `After=network-online.target`, início automático no boot, limite de reinícios contra loop de falha);
- instala um **watchdog** (`remoteifes-health.timer`) que checa o `/health` a cada 2 minutos e reinicia o serviço após 3 falhas seguidas;
- pergunta a(s) faixa(s) de IP da rede local a autorizar (veja abaixo).

Depois disso o sistema já responde em `http://<ip-do-servidor>:<PORTA>/` (padrão 8080) para os navegadores da rede local e em `/ws` e `/ws/dispositivo` para o tempo real e os ESP32 — tudo na mesma porta.

**Liberar o acesso da rede local.** Em produção, com o modo de teste desligado, o acesso é bloqueado até que as faixas de IP da rede local sejam cadastradas. Faça isso na máquina do servidor (sem precisar da interface):

```bash
npm run redes -- 10.10.0.0/16 192.168.0.0/16   # define as faixas autorizadas
npm run redes                                   # mostra o estado atual
sudo systemctl restart remoteifes.service
```

As rotas `/dispositivo/*` (usadas pelos ESP32) e o acesso por `localhost` (útil para um túnel SSH) nunca dependem dessa lista. Alternativamente, para uma rede local isolada e confiável, o modo de teste pode ser deixado ligado em `Admin > Configurações`, mas o cadastro das faixas é a opção recomendada.

### Proxy reverso na porta 80 (rede local, sem Internet)

Use o comando da referência canônica em [Proxy reverso](#proxy-reverso). `lan-setup.sh` coloca o Nginx na frente do servidor na porta 80, sem Certbot nem DNS.

Ele cria um site Nginx que encaminha tudo (inclusive `Upgrade`/`Connection` para `/ws` e `/ws/dispositivo`) para `127.0.0.1:<PORTA>`, grava `TRUST_PROXY=1` e `BIND_ADDR=127.0.0.1` no `.env` (assim o Node passa a escutar **só em localhost**, atrás do proxy — impede que alguém alcance a `PORTA` diretamente e falsifique `X-Forwarded-For`) e passa a atender em `http://<ip-do-servidor>/`. O Nginx precisa já estar instalado (ou o script o instala via `apt`, quando disponível). O script assume um host dedicado ao RemoteIFES (assume o site padrão do Nginx na porta 80).

### HTTPS com domínio próprio (opcional)

Quando houver um domínio público e acesso à Internet, use o comando canônico de [Proxy reverso](#proxy-reverso). `remoteifes-server/https-setup.sh` configura o proxy e emite um certificado Let's Encrypt com Certbot.

O script instala Nginx e Certbot se necessário, cria um site apontando para `127.0.0.1:<PORTA>`, emite o certificado, ativa a renovação automática (`certbot.timer`) e ajusta `TRUST_PROXY=1` e `BIND_ADDR=127.0.0.1` no `.env`. É o caminho para expor o sistema fora da rede local e para PWA/HTTPS em domínio próprio; a operação local não precisa dele.

### Atualização, versões e reversão

Todo o fluxo é feito por Git na própria máquina de produção — o GitHub continua sendo a origem do código, mas a atualização não depende de Actions nem do GitHub Pages.

```bash
cd remoteifes-server
bash deploy.sh               # busca e implanta a origin/main, com proteção
bash deploy.sh v3.1.0        # implanta uma versão marcada por tag
bash deploy.sh --offline     # sem rede: implanta um ref que já exista no clone (faça o git fetch antes, com rede)
```

O `deploy.sh` já faz o `git fetch` sozinho (exceto com `--offline`); não é preciso `git pull` antes.

`deploy.sh`, em ordem: recusa se houver alterações locais não commitadas (a menos de `--force`); **cria um backup verificado do banco** (`pre-update`) antes de mexer no código; resolve o ref alvo (`origin/main` por padrão, ou uma tag/commit); aplica o código (`git reset --hard` na `main`, ou checkout da tag); roda `npm ci --omit=dev` **apenas se `package.json`/`package-lock.json` mudaram** (compatível com `--offline`); reinicia o `remoteifes.service`; espera o `/health` ficar saudável; **se o `/health` não voltar, reverte sozinho** para a versão anterior, reinstala as dependências dela e reinicia. Em caso de sucesso, grava a versão anterior e a atual em `<REMOTEIFES_DATA_DIR>/previous-version` / `current-version` e registra a operação em `deploy.log`.

Reverter manualmente para a última versão boa conhecida (ou para um ref específico):

```bash
bash rollback.sh             # volta para o previous-version gravado pelo deploy
bash rollback.sh v3.0.0      # volta para uma versão específica
```

`rollback.sh` também faz um backup `pre-rollback` do banco antes de trocar o código, reinicia e verifica o `/health`. O rollback troca **apenas o código**. Se a atualização que está sendo revertida alterou o esquema do banco (as migrações em `src/db/schema.js` podem adicionar **e remover** colunas/tabelas), a versão anterior pode não funcionar com o banco já migrado — nesse caso restaure também o backup `pre-update` daquela atualização com `npm run restore`. É por isso que `deploy.sh` sempre grava esse backup antes de mexer no código.

Marcar uma versão (na máquina de desenvolvimento, a partir da `main` limpa):

```bash
cd remoteifes-server
bash release.sh 3.1.0        # ajusta a versão no package.json, cria o commit e a tag v3.1.0, e (com confirmação) faz o push
```

### Recuperação e verificação de saúde

- **`GET /health`** — estado do servidor central (banco e tempo de processo), sem autenticação. `200` com `{"ok":true,...}` quando o banco responde, `503` quando não. **Não depende de nenhum ESP32**: um dispositivo offline não afeta o resultado. Verifique pela linha de comando com `npm run health` (checa `127.0.0.1:<PORTA>/health`).
- **Reinício após queda** — o `remoteifes.service` tem `Restart=always`; o watchdog `remoteifes-health.timer` roda `health-watchdog.sh` (como o usuário do serviço) a cada 2 minutos e, após 3 falhas seguidas do `/health` (processo vivo mas travado), aciona o `remoteifes-recover.service`, uma unidade `root` cujo único comando é `systemctl restart remoteifes.service`. Nenhum script do checkout roda como root.
- **Reinício após reboot do host** — `install-service.sh` habilita o serviço (`systemctl enable`), que sobe sozinho no boot. Mantenha o `REMOTEIFES_DATA_DIR` em disco persistente.
- **Restauração do banco** — `npm run restore` lista os backups de `<REMOTEIFES_DATA_DIR>/backups/` e restaura um deles, criando antes uma cópia de segurança verificada do banco atual. Veja [Backup e restauração do banco](#backup-e-restauração-do-banco).

## Hospedagem em Raspberry Pi

Um Raspberry Pi (3, 4, 5 ou Zero 2 W, com Raspberry Pi OS de 32 ou 64 bits) é suficiente para rodar `remoteifes-server`: o `node:sqlite` usado pelo projeto é nativo do próprio Node.js, então não há dependências compiladas nem ferramentas de build a instalar no dispositivo.

Clone o repositório e siga somente [Linux com systemd](#linux-com-systemd); se quiser Nginx, continue em [Proxy reverso](#proxy-reverso). Cadastre redes adicionais depois com `npm run redes -- 10.10.0.0/16`.

- `npm run setup` detecta a arquitetura do Pi (ARM64 ou ARMv7) e instala automaticamente o Node.js 22.13+ direto dos binários oficiais quando a versão do sistema é insuficiente ou inexistente, sem depender do pacote (geralmente desatualizado) do repositório da distribuição.
- `sudo bash install-service.sh` grava `NODE_ENV=production` no `.env`, cria e habilita o serviço `systemd` `remoteifes.service` (início no boot, `Restart=always`) e o watchdog `remoteifes-health.timer` — dispensa `pm2` ou uma sessão de terminal aberta. O servidor passa a entregar o `remoteifes-web` na mesma origem da API.
- Para manter os dados fora do checkout do Git (recomendado), defina `REMOTEIFES_DATA_DIR=/var/lib/remoteifes` no `.env` **antes** do primeiro boot.

Depois de instalado, use os comandos padrão do `systemd` para gerenciar o serviço:

```bash
sudo systemctl status remoteifes.service
sudo journalctl -u remoteifes.service -f
sudo systemctl restart remoteifes.service
npm run health                        # checa o /health localmente
```

Reinicie o serviço (`systemctl restart`) sempre que editar `remoteifes-server/.env`. Atualizações e reversões seguem o fluxo de [Atualização, versões e reversão](#atualização-versões-e-reversão) (`bash deploy.sh` / `bash rollback.sh`), que funciona igual no Raspberry Pi, inclusive com `--offline`. Para expor o Pi fora da rede local com HTTPS em um domínio próprio (necessário para PWA/Cordova em domínio público), use `https-setup.sh` — ele funciona da mesma forma em um Raspberry Pi.

Cada sala continua com seu próprio ESP32 fazendo a ponte com o ar-condicionado (veja [Firmware ESP32](#firmware-esp32)); o Raspberry Pi hospeda apenas o servidor central que os agrega.

### Antes de deixar o Pi exposto sem supervisão

Uma Pi acessível pela internet e sem alguém observando ativamente é um alvo permanente. Confira estes pontos antes de deixá-la assim:

- **Defina `SENHA_ADMIN_INICIAL`** no `.env` antes de criar o banco, ou leia a senha aleatória no arquivo local indicado pelo primeiro boot e troque-a no diálogo obrigatório.
- **Mantenha o modo de teste desativado** (`Admin > Configurações > Modo de teste`) e cadastre as faixas de IP em `Redes autorizadas` para restringir o acesso à rede autorizada; em uma instalação nova de produção o modo de teste começa desativado.
- **Exponha apenas a porta do proxy** (80 no `lan-setup.sh`, 443 no `https-setup.sh`), nunca a porta do Node (`PORTA`, padrão 8080) diretamente — configure isso no firewall do roteador/Pi (`ufw allow 80` ou `ufw allow 443`, sem regra para a `PORTA` interna). Acessar a `PORTA` diretamente contorna o TLS e a checagem de `TRUST_PROXY`.
- **Mantenha o sistema operacional da Pi atualizado sozinho**: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades` aplica patches de segurança do Raspberry Pi OS automaticamente, sem depender de alguém logar para atualizar.
- **Troque a senha padrão do usuário do sistema operacional** (`pi`/`raspberry`, se ainda for a padrão) e prefira acesso SSH por chave pública em vez de senha.
- **Cadastre o MAC de cada ESP32 assim que possível** (`Admin > ESP32 / MACs`) e migre depois para a credencial exclusiva: as rotas `/dispositivo/*` não passam pela restrição de rede porque os controladores precisam alcançá-las. Sem vínculo, o dispositivo aparece apenas como detectado e não controla uma sala; com o MAC vinculado, as chamadas precisam corresponder ao cadastro; com credencial provisionada, o MAC sozinho deixa de autenticar aquela sala.
- **Confirme que os backups estão sendo gravados** em `<REMOTEIFES_DATA_DIR>/backups/` (`data/backups/` por padrão; em produção o backup automático já vem ligado, e `deploy.sh`/`rollback.sh` também geram um antes de cada troca de versão) e copie essa pasta para fora da Pi periodicamente. Teste a restauração ao menos uma vez com `npm run restore` num ambiente separado — um backup nunca verificado não é um backup. Veja [Backup e restauração do banco](#backup-e-restauração-do-banco).

### Frontend no GitHub Pages (opcional, para demonstração)

Na operação de produção descrita em [Deploy](#deploy) **o próprio servidor entrega o `remoteifes-web`** na mesma origem da API — o GitHub Pages não é necessário e a operação local não depende dele. A publicação no GitHub Pages é útil apenas como vitrine/demonstração pública e usa o workflow `.github/workflows/pages.yml`, porque a publicação direta a partir de uma branch aceita somente a raiz ou `/docs`, não a subpasta `/remoteifes-web`. Passo a passo:

1. Envie o projeto para um repositório no GitHub (`git push` para a branch `main`), caso ainda não tenha feito isso.
2. Como o GitHub Pages tem origem diferente do servidor central, edite `remoteifes-web/js/config.js` e defina `serverUrl` com a URL HTTPS do servidor central em produção.
3. Faça commit e push dessa alteração na branch `main`.
4. No repositório, vá em **Settings > Pages**.
5. Em "Build and deployment", campo "Source", selecione **GitHub Actions**.
6. Abra **Actions > Pages**, execute o workflow manualmente se necessário e acompanhe a implantação. Depois disso, cada push em `main` que alterar `remoteifes-web` ou o próprio workflow republica o site.
7. Quando a publicação terminar, o endereço público aparece em **Settings > Pages**, no formato `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`.

Esse é o link que você compartilha com os usuários para acessar o sistema pelo navegador. Sempre que `remoteifes-web` for alterado, faça commit e push — o workflow republica o site automaticamente.

## Domínio Próprio e HTTPS

Para servir o frontend em um domínio próprio (em vez do endereço `github.io` padrão) via GitHub Pages:

1. Crie um arquivo `remoteifes-web/CNAME` contendo apenas o domínio desejado (ex.: `remoteifes.ifes.edu.br`), ou configure o campo "Custom domain" em **Settings > Pages**.
2. Aponte um registro `CNAME` (ou `A`, se for domínio raiz) do seu DNS para o GitHub Pages, conforme a [documentação oficial do GitHub](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site).
3. Ative "Enforce HTTPS" em **Settings > Pages** assim que o certificado for emitido — isso é obrigatório para funcionar corretamente em navegadores móveis (iOS/Android bloqueiam conteúdo misto HTTP a partir de uma página HTTPS).
4. Garanta que o servidor central também esteja em HTTPS (com domínio ou IP fixo, via `https-setup.sh` ou configuração equivalente) e que `CORS_ORIGIN` inclua o domínio do frontend.

Com o frontend e o servidor central ambos em HTTPS e domínios próprios, o sistema funciona normalmente em navegadores de celular, incluindo ao adicionar a página como atalho na tela inicial. Como o WebSocket herda o esquema da página (`wss://` quando a página é `https://`), nenhuma configuração adicional é necessária para o tempo real funcionar sob HTTPS.

### HTTPS entre o ESP32 e o servidor

O firmware do ESP32 também pode se conectar ao servidor central via HTTPS, além do HTTP tradicional. Essa opção é escolhida no portal de configuração de cada dispositivo (a rede Wi-Fi `RemoteIFES-Setup`, exibida quando o ESP32 ainda não está configurado, após um reset de Wi-Fi ou durante a recuperação de uma indisponibilidade contínua da rede), no campo "Conexão com o servidor":

- **HTTPS com certificado válido (recomendado)**: valida o certificado do servidor contra a cadeia raiz pública da Let's Encrypt (embarcada no firmware); use quando o servidor estiver atrás do `https-setup.sh` (Nginx + Certbot) ou de qualquer outro certificado emitido por essa autoridade.
- **HTTPS sem validar certificado — desenvolvimento**: criptografa a conexão mas não confirma a identidade do servidor; use apenas de forma explícita em uma rede local controlada com certificado autoassinado.
- **HTTP sem criptografia — desenvolvimento**: comportamento mantido para compatibilidade e testes em LAN controlada; credenciais e OTA ficam expostos a um invasor presente na rede.

Configurações ausentes ou inválidas usam o modo CA validado; não há downgrade automático. Um modo inseguro previamente escolhido é preservado por compatibilidade e gera aviso no console serial até o dispositivo ser reconfigurado.

## Atualização de Firmware por OTA (ESP32)

O firmware do ESP32 pode ser atualizado pela rede, sem ir fisicamente até cada equipamento. O modelo é **A/B com reversão automática**: a partição `min_spiffs.csv` tem dois slots de aplicação; a imagem nova é gravada no slot ocioso e só passa a ser o slot de boot depois de gravada e verificada por hash. Após reiniciar, o novo firmware roda um autoteste (Wi-Fi conectado + WebSocket com o servidor) dentro de 90 s; se passar, ele se marca como válido, se não, o bootloader reverte sozinho para a versão anterior no próximo boot.

**Publicar uma imagem no servidor** (na máquina do servidor, dentro de `remoteifes-server`):

```bash
pio run -d ../remoteifes-esp32                         # gera .pio/build/esp32dev/firmware.bin
npm run firmware                                        # mostra a imagem publicada, se houver
npm run firmware -- ../remoteifes-esp32/.pio/build/esp32dev/firmware.bin 4.0.1 "nota opcional"
```

A imagem é validada (byte mágico `0xE9`, tamanho plausível), tem o SHA-256 calculado e é gravada em `<REMOTEIFES_DATA_DIR>/firmware/` junto de um `manifesto.json`. Só uma imagem fica publicada por vez; o número de versão deve casar com o `-DFW_VERSAO` compilado nela.

**Enviar a atualização a uma sala:** em `Admin > ESP32`, cada dispositivo online mostra a versão instalada, a versão publicada e um botão **Atualizar firmware (OTA)** com barra de progresso. Também é possível pela API: `POST /admin/esp32/:sala/ota` (apenas superadministrador).

O que o processo garante:

- **Validação antes de instalar:** o ESP32 baixa a imagem de `/dispositivo/firmware` (autenticada por MAC ou credencial), confere o SHA-256 e o tamanho contra a oferta e só então confirma a gravação. Hash divergente, download interrompido ou imagem maior que o slot abortam sem tocar no firmware em execução.
- **Sem OTA concorrente:** o servidor recusa uma segunda oferta para a mesma sala enquanto uma está em andamento e limita o total de atualizações simultâneas; o firmware ignora uma oferta se já estiver atualizando ou se estiver em modo de configuração.
- **Interrupções são seguras:** se a conexão cai durante a transferência, o servidor marca a OTA como falha (com tempo-limite de transferência e de reinício) e permite reofertar; o dispositivo continua na versão atual.
- **Reinício do servidor é recuperável:** o andamento é salvo em `<REMOTEIFES_DATA_DIR>/firmware/estados-ota.json`; depois que o backend volta, a reconexão e a versão reportada pelo ESP32 concluem ou registram a reversão, e estados sem retorno expiram pelo mesmo tempo-limite.
- **Reversão verificada:** se o dispositivo voltar reportando a versão anterior, a OTA é registrada como revertida e gera uma notificação; se voltar com a versão nova, é registrada como concluída.
- **Configuração preservada:** OTA grava apenas a aplicação — as credenciais de Wi-Fi/servidor/dispositivo na NVS e a associação da sala (feita no servidor) não são tocadas.
- **Recuperação:** a gravação por USB regrava o slot ativo e ignora o estado do OTA; é o caminho para um dispositivo que, por qualquer motivo, não aceite mais OTA.

O modelo atual evita adulteração acidental e publicação inconsistente por SHA-256, metadados restritos, autenticação do dispositivo e controle exclusivo do superadministrador. Assinatura assimétrica de firmware permanece uma opção de alta garantia para instalações que considerem comprometimento do próprio servidor de releases; ela não é obrigatória porque acrescentaria geração, proteção, rotação e recuperação de chaves ao fluxo normal de implantação.

## Credenciais por Dispositivo e Migração

Além da identificação por MAC, cada sala pode ter uma **credencial exclusiva** de dispositivo: um `deviceId` (`esp_…`) e um segredo aleatório de 256 bits. O servidor guarda apenas o hash SHA-256 do segredo; o valor em texto é exibido uma única vez, no momento em que é gerado, e nunca aparece em logs nem em respostas de estado.

Gestão em `Admin > ESP32` (apenas superadministrador), ou pela linha de comando na máquina do servidor:

```bash
npm run credencial -- A-101 --provisionar   # cria a credencial e imprime deviceId + segredo uma vez
npm run credencial -- A-101 --rotacionar    # novo segredo; o anterior ainda vale por 24 h
npm run credencial -- A-101 --substituir    # novo deviceId + segredo (troca de placa); preserva a associação da sala
npm run credencial -- A-101 --revogar       # invalida a credencial e derruba a conexão atual
npm run credencial -- A-101                 # mostra o estado (sem expor o segredo)
```

O ESP32 envia a credencial no cabeçalho (`X-Device-Id` / `X-Device-Secret`) no handshake do WebSocket e nas rotas `/dispositivo/*`. Ela pode ser informada no portal de setup (`RemoteIFES-Setup`) ou, para um dispositivo já conectado por MAC, **enviada pelo próprio servidor pela conexão existente** ao provisionar/rotacionar — o dispositivo grava na NVS e reconecta já autenticado, sem visita ao local. Resetar ou reconfigurar apenas Wi-Fi/servidor preserva essa credencial; deixar os dois campos de dispositivo vazios no portal também preserva o valor existente.

**Substituição de hardware é deliberadamente diferente:** a nova credencial nunca é enviada à conexão da placa antiga. O servidor invalida o `deviceId` anterior, encerra sua sessão e mostra o novo par uma vez para ser informado no portal da placa substituta.

**Migração dos controladores atuais (padrão: brando):**

1. Enquanto a opção global **Exigir credencial por dispositivo em todos os ESP32** (em `Admin > Configurações`) está desligada, uma sala **sem** credencial provisionada continua aceitando conexão só por MAC, exatamente como antes. Uma sala **com** credencial provisionada já passa a exigi-la.
2. Provisione a credencial de cada sala (o painel marca as que ainda estão "só MAC"; o resumo aparece também em `GET /admin/esp32/migracao` e no [Monitoramento](#monitoramento-operacional)).
3. Quando todas estiverem provisionadas e verdes, ligue a opção global para recusar conexões só por MAC em qualquer sala. A mudança é reversível.

Como endereços MAC podem ser imitados, a credencial por dispositivo é a forma recomendada em produção; mantenha o tráfego ESP32 ↔ servidor em rede administrada ou sob HTTPS.

## Monitoramento Operacional

`Admin > Monitoramento` (visível apenas ao superadministrador; `GET /admin/monitoramento` também exige nível de superadministrador) reúne, a partir de fontes **locais e baratas**, um retrato da saúde da instalação — sem serviços externos e sem afetar o `/health`, que mantém o mesmo contrato de antes. Cada bloco exibe um selo de estado (disponível, temporariamente indisponível, desativado por configuração ou falha):

- **Serviço:** ambiente, tempo no ar, memória (RSS), carga de 1 minuto, versão do Node e PID.
- **Banco de dados:** se responde e em quanto tempo, tamanho do arquivo e do WAL.
- **Armazenamento:** espaço livre e total no diretório de dados (`statfs`), com alerta abaixo de 10%.
- **Backups:** se o backup automático está ligado, quantos existem, o nome e a idade do último frente ao intervalo configurado.
- **ESP32:** quantos têm MAC cadastrado, quantos estão online, quantos com WebSocket ativo, quantos com MAC mas offline, reconexões na última hora (com alerta para salas que "piscam"), OTA em andamento e OTA com falha pendente.
- **Credenciais:** provisionadas, ainda só por MAC, revogadas, e se a exigência global está ligada.
- **Contadores de falha desde a inicialização** (em memória, zerados a cada reinício): persistência de telemetria, tarefas do agendador e execução de agendamentos, falhas de OTA, credenciais inválidas e reconexões anormais de dispositivo.

A cada 5 minutos o servidor reavalia esses indicadores e, para cada condição de alerta ativa, gera uma **notificação** (`tipo` `monitoramento`, no sino do administrador), sem repetir o mesmo alerta dentro de 6 horas. O endpoint bruto é `GET /admin/monitoramento`.

## Mapa de Calor Operacional

Dentro de `Admin > Monitoramento`, a seção recolhível **Mapa de calor operacional** compara as salas em uma métrica de operação sobre a mesma planta baixa usada no restante do sistema. É exclusiva do superadministrador (`GET /admin/heatmap` exige nível de superadministrador) e é analítica: não liga, desliga nem reconfigura nada. Consumo e energia estimada **não** entram aqui e continuam em [Energia Estimada](#energia-estimada).

**Métricas** (`metrica=`), todas derivadas de históricos que o sistema já retém, nunca de dados inventados:

| Métrica | Fonte | Sentido |
| --- | --- | --- |
| `disponibilidade` | `esp_indisponibilidades` | % do período com o dispositivo conectado (menor é pior) |
| `indisponibilidade` | `esp_indisponibilidades` | minutos offline acumulados |
| `quedas` | `esp_indisponibilidades` | número de desconexões |
| `comandos` | `comandos_log` | comandos registrados para a sala |
| `comandosOffline` | `comandos_log` × `esp_indisponibilidades` | comandos emitidos com o dispositivo fora do ar |
| `agendamentos` | `agendamentos` | agendamentos criados no período |
| `execucoes` | `agendamentos_execucoes` | acionamentos automáticos executados |
| `relatos` / `relatosPendentes` | `relatos` | relatos da sala, todos ou ainda sem resolução |

**Períodos** (`periodo=`): `24h`, `7d` e `30d`.

**Cálculo sob demanda.** Nada é agregado enquanto a seção está fechada: a consulta só roda quando o superadministrador abre a seção ou troca métrica/período. Cada consulta é uma agregação SQL sobre os índices por data/hora que já existem (`idx_esp_indisp_sala_offline`, `idx_comandos_log_criado`, `idx_ag_execucoes_executado`, `idx_relatos_criado`), devolve um resumo por sala (`{sala, nome, valor}` mais `quedas`/`minutosOffline` nas métricas de conectividade) e nunca envia o histórico bruto ao navegador. Um cache em memória de 60 segundos evita repetir a mesma consulta. O recurso **não cria tabelas, escritas nem retenção novas**; a proteção de crescimento do banco permanece exatamente a mesma.

**Leitura das cores.** A escala vai do frio ao quente (`azul → ciano → amarelo → laranja → vermelho`) e o quente é sempre o extremo pior. Em `disponibilidade`, onde maior é melhor, a inversão é aplicada: pouca disponibilidade fica vermelha. A cor nunca é o único canal — cada sala mostra o valor numérico, a legenda nomeia os extremos, o mapa expõe `aria-label`/tooltip por sala e a tabela abaixo repete tudo em texto, ordenada da pior para a melhor.

**`Sem dados`.** Sala sem fonte confiável para a métrica (por exemplo, sem MAC cadastrado em uma métrica de conectividade) aparece hachurada como `Sem dados`, nunca como zero. Como o histórico de indisponibilidade segue a retenção de auditoria, escolher um período maior que ela exibe um aviso na própria seção informando quanto do período está de fato coberto.

## Empacotamento como PWA e Aplicativo Nativo (Cordova)

Usuários autenticados podem abrir `#/aplicativo` pelo menu da conta ou pela Ajuda. A página detecta Android, explica a instalação nativa e a alternativa PWA, e consulta o servidor para obter versão, build, tamanho, SHA-256 e SHA-256 do certificado de assinatura. O APK só aparece quando existe uma publicação válida em `remoteifes-server/data/releases/mobile/release.json` **e** o `serverOrigin` gravado nesse arquivo coincide com a origem pela qual o servidor está sendo acessado; o download exige a sessão RemoteIFES e é servido pelo próprio servidor com `Cache-Control: private, no-store`.

Quando há um APK publicado, a página mostra um botão **Baixar APK** (com ícone de download), a versão e o build, a compatibilidade (Android 7.0 / API 24 ou posterior), o tamanho, o SHA-256 do arquivo e do certificado, e instruções de instalação, de atualização e da alternativa PWA. Ao baixar, o próprio navegador recalcula o SHA-256 dos bytes recebidos e **cancela o salvamento** se ele não bater com o hash anunciado — o arquivo só é entregue ao usuário depois de confirmada a integridade. Enquanto não há APK, a mensagem de "não publicado" aparece e o cartão da PWA é marcado como recomendado; o item continua visível no menu rápido de ajuda.

O servidor valida novamente o SHA-256 do arquivo antes de anunciar ou entregar a versão. Na ausência de um APK de produção assinado e de metadados coerentes, a interface informa que o download não foi publicado. APKs `debug`, não assinados ou copiados apenas de `platforms/android/app/build/outputs/` não devem ser colocados nesse diretório. Atrás de proxy reverso HTTPS, defina `TRUST_PROXY=1` para que a origem calculada (`https://…`) confira com o `serverOrigin` publicado.

Além do site publicado no GitHub Pages, o `remoteifes-web` pode ser instalado como **PWA** diretamente do navegador, e o mesmo frontend pode ser empacotado como **app nativo Android/iOS** pelo projeto `remoteifes-cordova/`. Nenhuma das duas formas exige reescrever ou duplicar a lógica da aplicação — ambas reaproveitam os arquivos de `remoteifes-web` como estão.

### PWA (Progressive Web App)

`remoteifes-web` já inclui os arquivos necessários:

| Arquivo | Função |
|---|---|
| `manifest.webmanifest` | Nome, ícones (`assets/icons/`), cor de tema (`#1c6b3c`), modo de exibição `standalone` e orientação `any` (retrato e paisagem) |
| `version.json` | Versão canônica do frontend, replicada no meta `remoteifes-version`, em `js/version.js`, nas URLs `?v=` dos ativos e em `sw.js` |
| `sw.js` | Service worker: instala o app-shell versionado de forma atômica, serve navegação com rede primeiro (cache como reserva offline), remove apenas caches `remoteifes-shell-*` antigos e assume o controle das abas abertas |

O `sw.js` só intercepta carregamentos de arquivos estáticos do próprio domínio — chamadas à API (`serverUrl`), inclusive em uma implantação same-origin, e a conexão WebSocket continuam exigindo rede normalmente. O registro do service worker acontece automaticamente no `index.html`, sem configuração adicional.

Requisito para o botão de instalação aparecer no navegador:

- Frontend servido por HTTPS (GitHub Pages já atende isso).

O servidor central também precisa usar HTTPS para o aplicativo instalado funcionar contra ele a partir de uma página HTTPS; caso contrário, o navegador bloqueia as chamadas como conteúdo misto. Veja [Domínio Próprio e HTTPS](#domínio-próprio-e-https).

No Chrome/Edge (Android ou desktop) aparece um ícone de instalação na barra de endereço; no Safari (iOS), o caminho é Compartilhar > Adicionar à Tela de Início.

Sempre que algum arquivo estático de `remoteifes-web` for alterado, avance a versão em `remoteifes-web/version.json` e nos pontos que a replicam (`index.html`, `js/version.js`, `manifest.webmanifest` e `sw.js`). O teste `remoteifes-server/test/frontend-version.test.js` falha se algum deles ficar desencontrado, evitando que HTML antigo se misture com JS/CSS novo. Com a versão avançada, a PWA instalada se atualiza sozinha na primeira abertura com rede: o novo app-shell é instalado, o service worker antigo é substituído, os caches `remoteifes-shell-*` obsoletos são removidos (caches de outras origens/aplicações não são tocados) e as abas abertas recarregam já na versão nova. Não é necessário desregistrar o service worker, limpar o armazenamento, usar janela anônima nem recarregar várias vezes.

### Cordova (Android/iOS)

O projeto `remoteifes-cordova/` empacota `remoteifes-web` como app nativo. A pasta `remoteifes-cordova/www/` nunca deve ser editada diretamente: ela é gerada a partir de `remoteifes-web` pelo script `sync-www.js`, chamado automaticamente pelos scripts de preparo, build, execução e validação.

#### Instalação do Cordova

```bash
cd remoteifes-cordova
npm ci
```

Isso instala as versões registradas em `package-lock.json` do Cordova CLI, das plataformas Android/iOS e do `cordova-plugin-statusbar`, sem instalação global. O splash screen é fornecido pelas próprias plataformas Cordova atuais; os antigos plugins `cordova-plugin-whitelist` e `cordova-plugin-splashscreen` não são usados.

#### Requisitos por plataforma

| Plataforma | Requisitos |
|---|---|
| Android | JDK 17; Android SDK Platform 36, Build Tools 36 e Platform Tools; Android Studio ou SDK Command-line Tools; `ANDROID_HOME` apontando para o SDK; Gradle 8.14.2 no `PATH` para criar o wrapper na primeira compilação |
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

`build-android-release` gera um APK de produção já assinado. O comando falha se a origem do servidor, o keystore, o alias ou qualquer senha de assinatura estiver ausente; os segredos entram num `build.json` temporário fora do repositório (modo `0600`) e são removidos ao final. Para iOS, `run-ios` abre o simulador; para dispositivo físico ou publicação na App Store, abra `platforms/ios/RemoteIFES.xcworkspace` no Xcode.

**Material de assinatura — nunca versionado.** O `.gitignore` bloqueia `remoteifes-cordova/.signing/`, `*.keystore`, `*.jks` e `build.json`. A convenção local é manter o keystore e um arquivo `signing.env` (com as variáveis abaixo, `chmod 600`) em `remoteifes-cordova/.signing/`, carregado com `set -a && . ./.signing/signing.env && set +a` antes do build. Como esse diretório fica fora do Git, **ele não é coberto por nenhum backup do repositório**: guarde uma cópia do keystore e das senhas num cofre de segredos da instituição ou em mídia offline cifrada. Se o keystore original for perdido, o Android recusa qualquer atualização assinada por outra chave — os aparelhos já instalados só conseguem migrar desinstalando e reinstalando (perdendo o endereço do servidor salvo e a sessão), e a rotação de chave do esquema de assinatura v3 ainda exige a chave antiga para autorizar a nova. Trate o backup do keystore como requisito de operação, não como opcional.

#### Ícone e splash screen

As imagens-fonte ficam em `remoteifes-cordova/resources/` (`icon.png` 1024×1024 e `splash.png` 2732×2732, geradas a partir de `remoteifes-web/assets/remoteifes-logo.png`). O Android usa `icon.png` também no splash screen nativo da plataforma; o iOS usa `splash.png`. As plataformas atuais geram os recursos necessários durante o preparo. Para gerar variantes personalizadas com `cordova-res`, instale essa ferramenta separadamente e execute:

```bash
cd remoteifes-cordova
npx cordova-res android --skip-config --copy
npx cordova-res ios --skip-config --copy
```

#### Apontando o app para o servidor

O app empacotado é carregado de `file://` (ou `https://localhost`), então não existe uma "origem" que sirva de endereço do servidor — diferente do site/PWA, que usa automaticamente o mesmo domínio de onde foi baixado. Há duas formas de definir o endereço no Cordova:

- **Configuração inicial de desenvolvimento:** somente um Cordova sem origem predefinida abre a tela dedicada **Conectar este aplicativo** antes do login e guarda o endereço no armazenamento local do app. Essa tela não aparece no site/PWA nem em uma perda temporária de conexão.
- **Fixo no build:** `build-android-release` grava `REMOTEIFES_SERVER_URL` somente na cópia gerada em `remoteifes-cordova/www/` (o fonte web em `remoteifes-web/` continua neutro, com `serverUrl` vazio no contexto empacotado). Esse é o fluxo obrigatório para um APK de produção.

Depois que existe uma origem, quedas HTTP ou WebSocket mostram apenas **Sem conexão com o servidor** e **Reconectando automaticamente…**. A tela de indisponibilidade não expõe contadores técnicos nem oferece edição de infraestrutura a usuários, administradores ou superadministradores; diagnósticos detalhados ficam no monitoramento do superadministrador. Overrides de `localStorage` continuam disponíveis para o harness e ferramentas de desenvolvimento, mas não são graváveis pela interface web/PWA.

O APK servido é **específico daquela instalação**: `harden-config.js` trava rede e navegação na origem do build e o servidor só anuncia o APK quando `release.json.serverOrigin` bate com a origem da requisição. Para outra implantação (outro IP de rede local, um domínio HTTPS), gere e publique um APK novo com o `REMOTEIFES_SERVER_URL` daquela implantação. Builds e publicações de produção recusam `localhost`, `127.0.0.1` e `::1`, pois esses endereços apontam para o próprio aparelho Android. O artefato local não versionado em `data/releases/mobile/` usa `http://localhost:8080` apenas como amostra validável pelo harness e não é anunciado pelo servidor fora de `NODE_ENV=test`.

#### Ajustando as permissões de rede

`remoteifes-cordova/config.xml` vem, por padrão, no modo de desenvolvimento: `<access origin="*" />`, `<allow-navigation href="*" />`, `<allow-intent>` para HTTP/HTTPS e tráfego HTTP local liberado no Android e iOS, para simplificar os testes contra qualquer `serverUrl`.

Para o build de produção, o script `harden-config.js` reescreve o `config.xml` restringindo rede e navegação a uma **única origem**:

```bash
cd remoteifes-cordova
npm run harden-config -- https://remoteifes.ifes.edu.br   # origem HTTPS: remove exceções de HTTP
npm run harden-config -- http://192.168.1.50:8080         # origem HTTP em rede local: mantém a exceção local (com aviso)
```

Ao usar os comandos manualmente, `npm run dev-config` devolve o arquivo ao modo de desenvolvimento depois do build. A operação é reversível e idempotente. O script `build-android-release` faz essa restauração automaticamente, inclusive se a compilação falhar.

O app suporta **retrato e paisagem** (`Orientation` = `default`); a interface acompanha a rotação sem recarregar nem perder o estado atual. Para evitar gerar um APK com permissões de rede curinga, `npm run build-android-release` exige `REMOTEIFES_SERVER_URL` e endurece o `config.xml` automaticamente antes do build:

```bash
REMOTEIFES_SERVER_URL=https://remoteifes.ifes.edu.br \
REMOTEIFES_ANDROID_KEYSTORE=/caminho/.signing/remoteifes-release.keystore \
REMOTEIFES_ANDROID_KEYSTORE_TYPE=pkcs12 \
REMOTEIFES_ANDROID_STORE_PASSWORD='...' \
REMOTEIFES_ANDROID_KEY_ALIAS=remoteifes \
REMOTEIFES_ANDROID_KEY_PASSWORD='...' \
npm run build-android-release
```

Variáveis de assinatura exigidas: `REMOTEIFES_ANDROID_KEYSTORE` (caminho do keystore), `REMOTEIFES_ANDROID_KEYSTORE_TYPE` (`pkcs12` ou `jks`; padrão `jks`), `REMOTEIFES_ANDROID_KEY_ALIAS`, `REMOTEIFES_ANDROID_STORE_PASSWORD` e `REMOTEIFES_ANDROID_KEY_PASSWORD`, além de `REMOTEIFES_SERVER_URL`. Mantenha-as em `remoteifes-cordova/.signing/signing.env` (fora do Git) e carregue-as no ambiente antes do build. O build precisa de JDK 17, do Android SDK (build-tools e plataforma da API 36) e de um `gradle` do sistema (a cordova-android 15 não usa o wrapper).

Antes de disponibilizar o APK pelo servidor, execute `npm run publish-android-release` com `REMOTEIFES_ANDROID_APK`, `REMOTEIFES_MOBILE_RELEASE_DIR` (aponta para o `MOBILE_APP_RELEASE_DIR` lido pelo servidor — por padrão `remoteifes-server/data/releases/mobile/`), `REMOTEIFES_ANDROID_VERSION`, `REMOTEIFES_ANDROID_BUILD`, `REMOTEIFES_SERVER_URL`, `ANDROID_APKSIGNER` e `ANDROID_APKANALYZER`. A publicação recusa nomes `debug`/`unsigned` e origens loopback, valida a assinatura, confirma `debuggable=false`, versão, build, `minSdk=24` e `targetSdk` atual (35 ou posterior), registra o SHA-256 do arquivo e do certificado, grava o `serverOrigin` e escreve `release.json` de forma atômica. Sem todos esses dados coerentes — ou se a origem da requisição não for igual ao `serverOrigin` —, `/mobile-app/android` responde 404 e a interface não oferece download. No Windows, o script chama `apksigner.bat`/`apkanalyzer.bat` via `cmd.exe /c`.

Para um servidor HTTP em rede local, informe a origem `http://192.168.1.50:8080`; o Android e o iOS manterão somente a exceção necessária para rede local.

**Verificação obrigatória em aparelho para servidor HTTP.** O WebView da cordova-android 15 carrega o app de `https://localhost`, um contexto seguro, enquanto o servidor de rede local usa `http://`/`ws://`. Instale o APK em um Android real e confirme que a lista de salas carrega e que o painel de uma sala atualiza em tempo real; se o app ficar preso em **Sem conexão com o servidor** e o `logcat` acusar bloqueio de conteúdo misto, acrescente `<preference name="scheme" value="http" />` à plataforma Android em `config.xml` (o app passa a carregar de `http://localhost`, que continua sendo contexto seguro) e gere o APK de novo. Um servidor HTTPS não precisa dessa verificação. Trocar o `scheme` muda a origem do WebView: instalações anteriores perdem o endereço do servidor e a sessão salvos, e precisam ser reconfiguradas.

## Scripts Auxiliares

Três scripts Python na raiz do projeto auxiliam o fluxo de trabalho com Git (executados a partir da raiz do repositório, com `git` instalado e disponível no `PATH`):

| Script | Função |
|---|---|
| `export.py` | Adiciona todas as alterações (`git add -A`), pede uma mensagem de commit (ou usa `update` como padrão) e envia (`git push origin main`) |
| `import.py` | Atualiza a cópia local a partir do remoto (`git pull origin main`) |
| `clear.py` | Recria o histórico do repositório do zero em um único commit (`checkout --orphan`) e, mediante confirmação explícita, sobrescreve o histórico remoto (`push -f`) — apaga permanentemente todo o histórico de commits anterior; use apenas se isso for intencional |

O repositório inclui um `.gitignore` na raiz que já ignora `remoteifes-server/.env` e `remoteifes-server/data/` (onde fica o banco SQLite), para não versionar segredos (como `SENHA_ADMIN_INICIAL`) nem o banco de dados — veja o aviso sobre esse cenário em [Solução de Problemas](#solução-de-problemas). Se você clonou uma cópia antiga do repositório em que esse arquivo não existia e chegou a commitar `.env` ou o banco, rode `git rm --cached` nesses arquivos antes de publicar o repositório.

## Testes e Integração Contínua

O repositório traz uma bateria de verificação de regressão. Todos os comandos rodam a partir da raiz do projeto, salvo indicação em contrário.

| Alvo | Comando | Observações |
|---|---|---|
| Servidor (API + banco) | `cd remoteifes-server && npm test` | `node:test` nativo; sem dependências extras. Cobre sessão/login, permissões, `/comando`, limites de temperatura, notificações, WebSocket, backup/restauração, o `/health`, a atualização de firmware por OTA (`test/ota.test.js`), as credenciais por dispositivo (`test/esp32-credenciais.test.js`) e o monitoramento operacional (`test/monitoramento.test.js`). |
| Frontend end-to-end | `cd e2e && npm install && npx playwright install chromium && npx playwright test` | A instalação do pacote npm não baixa o navegador automaticamente; `npx playwright install chromium` instala a versão compatível. Em uma imagem Ubuntu mínima que ainda não tenha as bibliotecas do Chromium, use uma vez `sudo npx playwright install-deps chromium`. Para usar um canal do sistema, defina `E2E_BROWSER_CHANNEL` (por exemplo, `chrome` ou `msedge`). Sobe a API real, um servidor estático do `remoteifes-web` e um ESP32 simulado; exercita layouts de celular, tablet, notebook, desktop e desktop largo, retrato e paisagem, autenticação, permissões, seleção de sala, operação do controlador, diálogo de troca de senha, relatos de problema, notificações do administrador, queda/retorno de WebSocket, navegação por endereço — reload, link direto, voltar/avançar, apelidos de rota, fallback de permissão, caminho estilo Cordova (`/index.html#/...`) e manual offline pelo cache do PWA (`navigation.spec.js`) —, o manual completo (`manual.spec.js`), o hub de início por papel com navegação e faixa de saúde (`inicio.spec.js`), o gate do Monitoramento por superadministrador e a planta baixa do cadastro de ESP32 sem rolagem horizontal em telas estreitas. |
| Configuração Cordova | `cd remoteifes-cordova && npm ci && npm run validate` | Não precisa do SDK do Android. Confere a estrutura do `config.xml`, a reversibilidade de `harden-config.js` (produção ↔ desenvolvimento, byte a byte) e a saída de `sync-www.js`. |
| Firmware ESP32 | `cd remoteifes-esp32 && pio run` | Compila o firmware com o PlatformIO (partição `min_spiffs.csv`, dois slots de aplicação para OTA). |
| ESP32 real (opcional) | `python3 remoteifes-esp32/tools/serial-smoke.py /dev/ttyUSB0` | Requer `pyserial` e uma placa conectada. Reinicia o ESP32 pela linha serial e confirma que o firmware inicializa (imprimindo a versão), entra na rotina de rede e, quando aplicável, conclui a autovalidação de OTA. Independe do servidor central estar no ar. |

### Health check do servidor central

`GET /health` responde o estado do servidor central (conexão com o banco e tempo de processo) sem exigir autenticação. Retorna `200` com `{"ok":true,"banco":"ok",...}` quando o banco responde e `503` quando não. **Não depende de nenhum ESP32**: um dispositivo offline não afeta o resultado.

### CI

`.github/workflows/ci.yml` roda em cada push e pull request para `main` (e sob demanda em **Actions > CI > Run workflow**) quatro jobs independentes: servidor (`npm test` + health check), frontend end-to-end (Playwright), validação de configuração Cordova e build do firmware ESP32. Nenhum token adicional é necessário.

## Uso da API do GitHub

Este projeto não depende da API do GitHub em tempo de execução — o uso do GitHub se limita à hospedagem do código-fonte, ao workflow opcional `.github/workflows/pages.yml` que publica `remoteifes-web` no GitHub Pages e ao workflow de CI descrito em [Testes e Integração Contínua](#testes-e-integração-contínua). A publicação usa apenas o `GITHUB_TOKEN` efêmero fornecido automaticamente ao workflow, com a permissão mínima `pages: write`/`id-token: write`.

## Estrutura de Pastas

```
remoteifes-server/
  setup.sh          instalação e configuração automatizadas (Node.js, dependências, .env)
  install-service.sh configura o serviço systemd + watchdog de saúde (auto-start no boot, ex.: Raspberry Pi)
  lan-setup.sh       proxy reverso Nginx na porta 80 para a rede local (sem Internet/Certbot)
  https-setup.sh     configuração automatizada de HTTPS (Nginx + Certbot) para domínio público
  deploy.sh          atualização protegida (backup pré-update, health check, auto-rollback) — npm run deploy
  rollback.sh        volta para a versão anterior ou uma tag, com backup do banco — npm run rollback
  release.sh         marca uma versão (package.json + commit + tag vX.Y.Z) — npm run release
  healthcheck.sh     checa o /health local — npm run health
  health-watchdog.sh usado pelo remoteifes-health.timer para reiniciar o serviço se o /health falhar
  redes-autorizadas.js  define/lista as faixas de IP autorizadas da rede local — npm run redes
  reset-admin-senha.js  redefine a senha do superadministrador sem apagar dados
  backup-db.js       gera um backup verificado do banco SQLite agora (npm run backup)
  restore-backup.js  lista e restaura backups, com verificação e cópia de segurança (npm run restore)
  firmware-esp32.js  publica/mostra a imagem de firmware do ESP32 para OTA (npm run firmware)
  credencial-esp32.js  provisiona/rotaciona/substitui/revoga a credencial de uma sala (npm run credencial)
  server.js          ponto de entrada: sobe o HTTP server, o WebSocket e o agendador
  data/              conteúdo de REMOTEIFES_DATA_DIR (padrão); ignorado pelo Git
    remoteifes.db    banco SQLite (criado na primeira execução)
    backups/         backups automáticos, manuais e de pré-atualização do banco
    firmware/        imagem publicada, manifesto.json e estados-ota.json do fluxo OTA
    previous-version / current-version / deploy.log   estado gravado por deploy.sh/rollback.sh
  src/
    app.js            monta o Express app e registra as rotas
    config/           conexão com o banco SQLite e caminhos de dados/backup (paths.js)
    db/                schema, seed e a lista de salas reais do campus (salasCampus.js)
    middlewares/       autenticação, permissões, restrição de rede
    routes/            rotas HTTP (login, documentação por papel, aplicativo móvel/APK, salas, comandos, agendamentos, admin, dispositivo, relatos)
    services/          regras de negócio (usuários, salas, agendamentos, configurações, notificações,
                        relatos de problema, sessões/tokens, status em tempo real, backup do banco,
                        OTA de firmware (otaService), credenciais de dispositivo (esp32CredenciaisService),
                        monitoramento operacional (monitoramentoService),
                        documentação administrativa por papel (documentationService))
    scheduler/         verificação periódica de agendamentos, timeouts de ESP32 e de OTA, sessões abandonadas, monitoramento e backup
    utils/             funções auxiliares (data/hora em fuso de Brasília, rate limiting, faixas de rede)
  test/               testes de regressão do servidor (node:test) — API, permissões, WebSocket, /health, backup, OTA, credenciais de dispositivo, monitoramento

remoteifes-web/
  manifest.webmanifest  manifesto da PWA (nome, ícones, cor de tema)
  sw.js                 service worker: cache do app shell para instalação/uso offline parcial
  assets/icons/         ícones gerados para PWA, favicon e tela inicial (iOS/Android)
  js/
    app.js             inicialização geral da página
    api.js             chamadas HTTP à API central
    config.js          resolve o endereço do servidor central (origem da PWA, override em localStorage ou valor fixo para o build empacotado)
    state.js           estado da sessão atual no navegador
    nav.js             troca de abas e telas
    router.js          roteador por fragmento (#/...): reflete a navegação no endereço e a restaura no reload, no link direto e no voltar/avançar, respeitando a permissão
    account-menu.js    menu da conta (avatar com iniciais): identificação, atalho para o aplicativo móvel, sair
    rtstatus.js        cliente WebSocket para status em tempo real
    idle-timer.js      timeout de inatividade e aviso de logout automático
    a11y.js            widget de acessibilidade (fonte, contraste, espaçamento etc.), persiste no localStorage
    ui-dialog.js       modais/diálogos estilizados do sistema (confirmação, texto, troca de senha) — substituem prompt()/confirm()/alert()
    ui-status.js       selo reutilizável de estado de função (disponível, temporariamente indisponível, desativado por configuração, falha etc.)
    floorplan.js        componente reutilizável de planta baixa com zoom (usado na tela de salas e no admin)
    help.js            ajuda contextual dos modais (parte comum embutida; textos de administração vêm de /documentation após validar a sessão), com atalho para a seção do manual
    manual-content.js  seções comuns do manual (papel "todos") e diagramas SVG, carregadas sob demanda; as seções de administração e do superadministrador são entregues por /documentation e não ficam nos assets públicos
    tempo.js           formatação de datas/horas no fuso de Brasília
    rooms-data.js       utilitário auxiliar de composição de código de sala
    screens/           lógica de cada tela:
                        inicio.js (hub de início: cartões das ações principais adaptados ao papel, faixa de saúde do sistema para o superadministrador),
                        simple.js (assistente simples), location.js e rooms.js (navegação tradicional),
                        floorplan.js (planta baixa), panel.js (painel de controle de uma sala),
                        schedule.js (agendamentos), grade.js (grade de horários),
                        propriedade.js (config. de salas para proprietários),
                        notifications.js (painel do sino, notificações de dispositivos),
                        relatos.js (ícone de inseto: envio de relatos e lista dos próprios; a gestão fica em admin.js, sub-aba Relatos de problemas),
                        login.js (portal e sessão),
                        portal-funcoes.js (vitrine de funcionalidades na tela inicial), admin.js (painel administrativo),
                        esp32-admin.js (painel avançado de cada ESP32 — status, config/clonagem IR, OTA e credenciais —
                        na aba "ESP32", restrito ao superadministrador),
                        monitoramento.js (aba "Monitoramento" do painel administrativo, restrita ao superadministrador),
                        energia.js (estimativas energéticas agregadas, mapa e tabela exclusivos do superadministrador),
                        manual.js (sobreposição do manual completo: sumário, busca, navegação e foco),
                        mobile-app.js (página #/aplicativo: instalação PWA/Android e download do APK de produção verificado pelo servidor)

remoteifes-esp32/         projeto PlatformIO (framework Arduino, placa esp32dev, partição min_spiffs.csv para OTA)
  platformio.ini           configuração do projeto, versão do firmware (-DFW_VERSAO) e dependências
  src/main.ino              firmware principal (Wi-Fi, modos operação/config/clonagem, IR, DHT,
                            WebSocket cliente com o servidor, portal de provisionamento, OTA A/B com
                            autovalidação e reversão, credencial por dispositivo)
  include/root_ca.h         certificado raiz (Let's Encrypt) usado quando o firmware se conecta ao servidor via HTTPS
  data/                     arquivos gravados no sistema de arquivos LittleFS do dispositivo
    setup.html               formulário do portal de provisionamento (rede e servidor)
    restart.html             página de confirmação exibida após salvar a configuração
    status.html               página local de status, somente leitura
  tools/serial-smoke.py     smoke test de hardware: reinicia o ESP32 pela serial e confere o boot e a rotina de rede
  flash.sh                  instala o PlatformIO Core (se necessário) e compila/grava firmware + sistema de arquivos

remoteifes-cordova/     empacotamento nativo Android/iOS (veja Empacotamento como PWA e Aplicativo Nativo)
  config.xml             configuração do app (id, nome, ícone, splash, permissões de rede) — modo de desenvolvimento por padrão
  harden-config.js       reescreve config.xml para produção (origem única) ou de volta para desenvolvimento (--dev)
  validate-config.js     valida config.xml, a reversibilidade de harden-config.js e a saída de sync-www.js (npm run validate)
  package.json            scripts de sync/build/run/harden-config e plugins Cordova do projeto
  sync-www.js             copia remoteifes-web para www/ antes de cada build (não editar www/ manualmente)
  resources/              imagens-fonte (icon.png, splash.png) usadas por cordova-res
  www/                    cópia gerada de remoteifes-web (gitignored fora de commits manuais, se preferir)

e2e/                     testes end-to-end de navegador (Playwright) — specs, harness (API + estático + ESP32 simulado)
.github/workflows/ci.yml workflow de CI: testes do servidor, end-to-end, validação Cordova e build do firmware
docs/                    material de apoio do projeto (imagens, documento acadêmico)
export.py / import.py / clear.py   scripts auxiliares de Git (veja Scripts Auxiliares)
```

## Solução de Problemas

- **`EADDRINUSE` / porta 8080 ocupada**: descubra o processo com `ss -ltnp 'sport = :8080'` (use `sudo ss -ltnp 'sport = :8080'` se o nome/PID não aparecer). Se já for uma instância do RemoteIFES, use-a ou pare-a pelo mesmo método com que foi iniciada; não abra uma segunda instância sobre o mesmo banco. Confirme depois com `curl -fsS http://localhost:8080/health` ou `npm run health`.
- **Servidor parece iniciado, mas a tela não abre**: `curl -fsS http://localhost:8080/health` deve retornar JSON com `"ok":true`, e `curl -I http://localhost:8080/` deve indicar conteúdo HTML. Confira também `ss -ltnp 'sport = :8080'`. Se `/health` funciona mas `/` não é HTML, confirme `SERVIR_FRONTEND=true` e reinicie o processo.
- **PWA mostra frontend antigo após uma alteração**: abra uma vez com a rede disponível e aguarde alguns segundos — o novo service worker instala o app-shell, assume o controle e recarrega a aba sozinho. Se a tela continuar antiga, a causa quase sempre é a versão não ter sido avançada na release: confirme que `remoteifes-web/version.json`, `index.html`, `js/version.js`, `manifest.webmanifest` e `sw.js` apontam para a mesma versão (`npm test` cobre isso) e que `/index.html`, `/sw.js` e `/version.json` são servidos com `Cache-Control: no-cache`. Desregistrar o worker ou limpar o armazenamento não faz parte do procedimento normal.
- **Perda temporária ou endereço incorreto**: uma queda momentânea mostra “Reconectando automaticamente…” e a interface recupera sozinha quando HTTP/WebSocket voltam. Falha persistente desde a abertura, `/health` inacessível pelo mesmo dispositivo ou acesso por um IP antigo indica endereço, porta, firewall, proxy ou rede autorizada incorretos. No fluxo integrado, abra novamente `http://IP_DO_SERVIDOR:8080`; não troque a configuração por causa de uma interrupção breve.
- **Live Server abre a interface, mas não representa a implantação**: ele é apenas o modo opcional de [frontend em origem separada](#frontend-em-origem-separada-desenvolvimento-opcional). Para teste integrado, pare-o e use `http://localhost:8080` ou `http://IP_DO_SERVIDOR:8080`.
- **Servidor não inicia por causa do `node:sqlite`**: confirme que o Node.js instalado é 22.13 ou superior (`node -v`); versões anteriores não têm o módulo nativo `node:sqlite` usado pelo projeto.
- **`pio run` falha ao baixar a plataforma `espressif32`**: o PlatformIO precisa de acesso à internet na primeira compilação (para baixar o toolchain do ESP32 e resolver as bibliotecas de `platformio.ini`); confirme a conexão e tente novamente — compilações seguintes reaproveitam o cache local (`~/.platformio`). No Ubuntu 24.04, não contorne a proteção de Python gerenciado com `pip --break-system-packages`: instale `pipx` pelo gerenciador de pacotes e rode `flash.sh` novamente.
- **ESP32 não aparece como online**: confirme que o dispositivo aparece em `Admin > ESP32 / MACs`, vincule seu MAC a uma sala e verifique se ele alcança o endereço/porta do servidor pela rede local. `pio device monitor -b 115200 -p /dev/ttyUSB0` mostra o estado de Wi-Fi, identificação e WebSocket em tempo real.
- **Botão "Iniciar captura IR" fica desabilitado em `Admin > ESP32`**: a captura só é permitida em modo clonagem; ative "Ativar modo clonagem" primeiro (o dispositivo precisa já estar em modo de configuração).
- **Aba "ESP32" não aparece no painel administrativo**: ela é restrita ao superadministrador, assim como `Admin > Configurações`.
- **Heartbeat rejeitado com erro de MAC**: a sala já tem um MAC diferente cadastrado em `Admin > ESP32 / MACs`; atualize o cadastro ou libere a sala novamente para o ESP32 correto.
- **ESP32 aparece em "ESP32 detectados na rede" mas nunca fica online**: vincule o MAC detectado a uma sala existente em `Admin > ESP32 / MACs`; o vínculo é recebido automaticamente na próxima consulta do dispositivo.
- **ESP32 perde conexão Wi-Fi e não volta sozinho**: o firmware tenta reconectar automaticamente a cada 30 segundos, sem reiniciar. Se o Wi-Fi continuar indisponível por mais de 2 minutos, ele também abre o ponto de acesso de recuperação `RemoteIFES-Setup` (mantendo as tentativas de reconexão em paralelo) para permitir a reconfiguração no local; assim que a rede volta, esse ponto de acesso é fechado sozinho. Se a falha persistir, verifique o sinal e as credenciais; use o reset de Wi-Fi somente quando elas realmente mudarem.
- **Usuário com "pode controlar" ativo não consegue controlar uma sala específica**: verifique se a sala está marcada como "acesso restrito" em `Admin > ESP32 / MACs` — nesse caso, o usuário precisa ser adicionado explicitamente à lista de acesso daquela sala (diretamente pelo admin, ou por um proprietário da sala).
- **Acesso bloqueado em produção mesmo dentro da rede do IFES**: confira as faixas CIDR em `redesAutorizadas` e, temporariamente, o `modoTeste` em `Admin > Configurações`; a mesma restrição vale para a conexão WebSocket.
- **Frontend não fala com o servidor depois do deploy**: na implantação same-origin, acesse a URL do próprio servidor/proxy e não configure `serverUrl` nem `CORS_ORIGIN`. Se o frontend estiver em outra origem (GitHub Pages ou Cordova), confirme `serverUrl` e inclua a origem dele em `CORS_ORIGIN`; isso também afeta a conexão WebSocket.
- **Status das salas não atualiza sozinho**: o painel depende da conexão WebSocket (`/ws`); se ela cair, o frontend reconecta automaticamente com espera crescente, e há uma retransmissão de reforço a cada 30 segundos. Depois de o celular voltar do segundo plano, a prova de vida da conexão pode levar alguns segundos até reconectar — uma falha persistente costuma indicar bloqueio de rede/proxy para conexões WebSocket ou a mesma causa do item anterior (CORS/rede autorizada).
- **Aba "Grade" ou "Agenda" não aparece**: essas abas só ficam visíveis para administradores; usuários comuns não têm acesso a elas.
- **Aba "Config." não aparece para um usuário comum**: ela só é exibida quando o usuário foi tornado proprietário de ao menos uma sala em `Admin > Proprietários de sala`.
- **Botão de instalar o PWA não aparece no navegador**: confirme que o frontend está em HTTPS e que o navegador atende aos demais critérios de instalação. O `serverUrl` também deve usar HTTPS para a API funcionar sem bloqueio de conteúdo misto, mas não é ele que determina se o navegador oferece a instalação.
- **`cordova build android` falha por SDK não encontrado**: confirme que `ANDROID_HOME` aponta para o Android SDK, que Platform 36/Build Tools 36 estão instalados, que o JDK 17 está em `JAVA_HOME`/`PATH` e que o Gradle 8.14.2 está no `PATH` para inicializar o wrapper; rode `npx cordova requirements android` dentro de `remoteifes-cordova` para diagnosticar o que falta.
- **`setup.sh` não consegue instalar o Node.js automaticamente**: confirme a conexão com a internet (o script baixa o binário oficial de `nodejs.org`); em arquiteturas fora de x64/ARM64/ARMv7, ou caso o download falhe, instale manualmente em https://nodejs.org/en/download e rode `npm run setup` novamente.
- **`install-service.sh` falha com "systemd não encontrado"**: o script só funciona em Linux com `systemd` (padrão no Raspberry Pi OS); em outras distribuições, use um gerenciador de processo alternativo como `pm2`.
- **Serviço `remoteifes.service` não inicia**: rode `sudo journalctl -u remoteifes.service -f` para ver o erro; confira se `remoteifes-server/.env` existe e está com as variáveis esperadas (veja [Configuração](#configuração)), e rode `sudo systemctl restart remoteifes.service` após qualquer correção.
- **`flash.sh` não encontra a porta serial do ESP32**: confirme que o cabo USB usado transmite dados (não é só de carga) e que os drivers do conversor USB-serial (CP210x ou CH340, conforme a placa) estão instalados; informe a porta manualmente, ex.: `bash flash.sh /dev/ttyUSB0`.
- **Restrição de rede ou limite de tentativas de login parecem não fazer efeito**: confira `TRUST_PROXY` no `.env` — o valor precisa corresponder ao número real de proxies reversos na frente do servidor (`1` para o Nginx de `https-setup.sh`, `0` se o Node estiver exposto diretamente); um valor maior que o real permite que o IP de origem seja falsificado via `X-Forwarded-For`, contornando as duas proteções.
- **App Cordova não fala com o servidor central**: em desenvolvimento, um app sem origem mostra **Conectar este aplicativo** na primeira abertura; limpe os dados/reinstale o app para refazer essa configuração inicial. Em produção, gere outro APK com o `REMOTEIFES_SERVER_URL` correto e confirme que a configuração endurecida libera exatamente essa origem — uma indisponibilidade temporária só tenta reconectar e não permite trocar a infraestrutura.
- **Não sei a senha do `superadmin` (ou o login não funciona) após clonar**: em um banco novo sem `SENHA_ADMIN_INICIAL`, use `superadmin` / `admin`; o sistema mostra somente a essa conta um aviso persistente com acesso direto à troca. Rode `npm run reset-admin -- umaSenhaEscolhida` para usar uma senha definida por você, ou `npm run reset-admin` para restaurar `admin`. A senha não é impressa no terminal.
