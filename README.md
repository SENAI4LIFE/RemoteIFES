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
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Demo-222222?logo=github)](#)
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

## Acesso rápido

| Preciso… | Vá para |
|---|---|
| instalar pela primeira vez | [Instalação Rápida](#instalação-rápida) e [Inicialização e implantação](#inicialização-e-implantação-referência-canônica) |
| operar em produção (serviço, proxy, redes autorizadas) | [Deploy](#deploy) e [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi) |
| manter o servidor, o host e a infraestrutura | [Console de Operações](#console-de-operações) |
| atualizar ou reverter uma versão | [Console de Operações](#console-de-operações) e [Atualização, versões e reversão](#atualização-versões-e-reversão) |
| fazer backup ou restaurar o banco | [Backup e restauração do banco](#backup-e-restauração-do-banco) |
| gravar, atualizar (OTA) ou autenticar um ESP32 | [Firmware ESP32](#firmware-esp32), [OTA](#atualização-de-firmware-por-ota-esp32) e [Credenciais por Dispositivo](#credenciais-por-dispositivo-e-migração) |
| diagnosticar um problema | [Solução de Problemas](#solução-de-problemas) e [Monitoramento Operacional](#monitoramento-operacional) |
| recuperar a senha do superadministrador | [Console de Operações](#console-de-operações) ou [Recuperação de emergência por terminal](#recuperação-de-emergência-por-terminal) |
| consertar com tudo fora do ar | [Recuperação de emergência por terminal](#recuperação-de-emergência-por-terminal) |
| entender o que o usuário vê | [Ajuda e Manual no App](#ajuda-e-manual-no-app) (guia por papel, dentro do próprio app) |

## Sumário

- [Visão Geral](#visão-geral)
- [Papéis e Permissões](#papéis-e-permissões)
- [Navegação e Seleção de Salas](#navegação-e-seleção-de-salas)
- [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala)
- [Agendamentos](#agendamentos)
- [Grade de Horários](#grade-de-horários)
- [Limites de Temperatura e Turbo](#limites-de-temperatura-e-turbo)
- [Desligamento Diário Automático](#desligamento-diário-automático)
- [Notificações](#notificações)
- [Relatos de Problema](#relatos-de-problema)
- [Sessões e Tempo de Inatividade](#sessões-e-tempo-de-inatividade)
- [Auditoria (Logs, Dispositivos e Acessos)](#auditoria-logs-dispositivos-e-acessos)
- [Restrição de Rede](#restrição-de-rede)
- [Segurança](#segurança)
- [Tempo Real (WebSocket)](#tempo-real-websocket)
- [Painel dos ESP32, Protocolos IR e Failsafe (Administração > Dispositivos)](#painel-dos-esp32-protocolos-ir-e-failsafe-administração--dispositivos)
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
- [Console de Operações](#console-de-operações)
- [Recuperação de emergência por terminal](#recuperação-de-emergência-por-terminal)
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
remoteifes-web/      Frontend estático (HTML/CSS/JS puro, sem build), entregue pelo próprio servidor
                     central na mesma origem da API; instalável como PWA (GitHub Pages só para demonstração)
remoteifes-cordova/  Empacotamento do mesmo frontend como app nativo Android/iOS via Apache Cordova
remoteifes-server/   API central (Node.js + Express + SQLite), roda em um servidor/host próprio
remoteifes-esp32/    Firmware Arduino/ESP32 instalado em cada sala, ao lado do ar-condicionado
```

Fluxo geral:

1. Cada sala possui um **ESP32 transmissor infravermelho** (e, opcionalmente, um sensor de temperatura DHT), conectado à rede Wi-Fi local. Uma única placa, escolhida pelo superadministrador e equipada com receptor IR, é o **clonador oficial**: ela aprende os sinais do controle original, que ficam guardados no servidor como uma biblioteca de protocolos e podem ser aplicados às demais salas. Cada ESP32 envia comandos ao ar-condicionado e reporta seu estado (ligado/desligado, temperatura, MAC, IP) ao servidor central via HTTP ou HTTPS, identificado pelo MAC ou por uma credencial exclusiva de dispositivo (veja [Segurança](#segurança)).

2. O **servidor central** (`remoteifes-server`) mantém o banco de dados (SQLite), a lógica de autenticação, permissões, agendamentos, limites de temperatura, notificações e configurações globais. Ele expõe uma API REST usada tanto pelo frontend web quanto pelos ESP32, além de canais WebSocket para atualização de status e comandos em tempo real.

3. O **frontend** (`remoteifes-web`) é um site estático (sem framework de build) que fala com o servidor central via `fetch` e WebSocket. Em produção ele é entregue pelo próprio Express, na mesma origem da API e do WebSocket (veja [Deploy](#deploy)); a publicação no GitHub Pages é opcional e serve só como demonstração pública (veja [Frontend no GitHub Pages](#frontend-no-github-pages-opcional-para-demonstração)).

## Papéis e Permissões

O sistema tem três níveis de usuário:

| Nível | Papel | Pode |
|---|---|---|
| 1 | Usuário comum | Ligar/desligar e ajustar a temperatura das salas liberadas para controle; enviar relatos de problema pelo ícone de inseto no topo |
| 2 | Administrador (`admin`) | Tudo do nível 1, além de agendamentos e grade de horários, contas de usuários comuns e proprietários de sala, os alertas dos ESP32 (`Dispositivos > Alertas`), os históricos de comandos, acessos, conexão dos ESP32 e sessões (`Sistema > Logs`, sem Auditoria) e `Sistema > Status` (Usuários ativos e Mapa, sem a aba Sistema) |
| 3 | Superadministrador (`superadmin`) | Tudo do nível 2, além de alterar configurações globais, limites globais e por sala, função extra do Turbo, Auto-ON, consulta das redes autorizadas e do modo de teste (que só mudam pelo [Console de Operações](#console-de-operações) ou pelo terminal do servidor), cadastro de ESP32 por MAC, o painel avançado de cada ESP32 (`Administração > Dispositivos > Firmware / OTA`), o clonador e a biblioteca de protocolos infravermelhos (`Administração > Dispositivos > Protocolos IR`) e a gestão dos relatos de problema enviados pelos usuários — inclusive a exclusão permanente de um relato — em `Administração > Gestão > Relatos de problemas` |

A conta padrão do nível 3 usa o login `superadmin` (nome exibido "Superadministrador"). Instalações anteriores que usavam o login `admin` são migradas automaticamente para `superadmin` no primeiro boot após a atualização, preservando id, hash de senha, nível e permissões; o identificador interno do papel continua sendo `superadmin`. A conta inicial só é criada quando o banco não tem **nenhuma** conta de nível 3: renomear o login do superadministrador (ou personalizá-lo de qualquer forma) nunca faz o servidor recriar `superadmin` com a senha padrão em um reinício. Uma instalação já estabelecida que, por qualquer motivo, fique sem conta de nível 3 não recebe uma credencial padrão silenciosa — o log mostra `seed-superadmin-ausente` e a saída é `npm run reset-admin`, que localiza a conta pelo nível, não pelo login.

Além dos três níveis, existe uma permissão pontual, independente de nível: um usuário comum pode ser tornado **proprietário** de uma ou mais salas específicas, o que lhe permite conceder e revogar o acesso de controle de outros usuários apenas àquelas salas, sem se tornar administrador (veja [Controle de Acesso e Proprietários de Sala](#controle-de-acesso-e-proprietários-de-sala)).

Todas as permissões são impostas no backend (não apenas escondidas na interface): rotas administrativas exigem `exigirAdmin`, rotas/campos críticos exigem `exigirSuperAdmin`, e as rotas de proprietário de sala exigem que o usuário conste como dono daquela sala específica.

## Navegação e Seleção de Salas

### Início (hub)

Após o login o aplicativo abre no **Início** (`#/inicio`, também a aba "Início" e o logotipo no topo): um painel visual que reúne as ações principais em cartões, na ordem de uso mais comum — selecionar sala, planta baixa, agenda e grade (administrador), notificações (administrador), relatar um problema, ajuda/manual e aplicativo móvel. Os cartões respeitam o papel do usuário e apenas abrem telas já existentes (nenhuma função é duplicada). Abaixo das ações operacionais, administradores veem um atalho para cada função de **Administração**, identificado pelo grupo a que pertence (`Dispositivos · Cadastro`, por exemplo); o superadministrador vê ainda uma faixa curta com o estado do banco, do armazenamento, dos ESP32 e dos backups, com link para `Sistema > Status > Sistema`. No celular o hub vira uma lista de cartões de toque em coluna única. O hub não altera o roteamento: todos os endereços e o comportamento de refresh/histórico continuam iguais.

### Organização da Administração

A aba **Admin** organiza suas funções em três grupos, sempre em dois níveis (`Administração > Grupo > Função`), na mesma barra de navegação lateral (ou rolável, em telas estreitas) usada antes. Cada grupo responde a uma pergunta diferente:

| Grupo | Conceito | Funções |
| --- | --- | --- |
| **Gestão** | quem são as pessoas e por quais salas respondem | Usuários, Relatos de problemas |
| **Dispositivos** | administração dos ESP32 e os avisos operacionais que eles geram | Cadastro, Firmware / OTA, Protocolos IR, Alertas |
| **Sistema** | o que está acontecendo agora, o que já aconteceu e como o sistema é configurado | Logs, Status, Configurações |

Dentro de **Sistema**, a separação é entre tempo presente e passado: **Status** concentra a informação **corrente/ao vivo** e **Logs** concentra a informação **persistida/histórica**. **Configurações** é a configuração do sistema.

Três funções se desdobram em **abas internas**, dentro da própria tela, sem criar mais um nível na navegação de Administração:

| Função | Abas internas |
| --- | --- |
| **Gestão > Usuários** | **Contas** (criar, alterar, desativar e excluir contas) · **Proprietários de sala** (atribuir e revogar a responsabilidade por uma sala) |
| **Sistema > Logs** | **Comandos** · **Acessos** · **Dispositivos** · **Sessões** · **Auditoria** |
| **Sistema > Status** | **Usuários ativos** · **Mapa** · **Sistema** |

O agrupamento é apenas de apresentação: cada função e cada aba interna mantêm a permissão que já tinham, e um grupo cujas funções estejam todas fora do nível do usuário não é exibido. `Alertas` é o mesmo painel de notificações de dispositivo do sino — só o rótulo visível mudou; a fila, os dados e as APIs são os mesmos.

A permissão vale **por aba interna**, não pela tela que a contém. **Status** é aberto a qualquer administrador por causa de *Usuários ativos* e *Mapa*, mas a aba *Sistema* (o diagnóstico técnico) continua exclusiva do superadministrador; do mesmo modo, **Logs** é aberto ao admin comum, mas a aba *Auditoria* não. As abas exclusivas nem aparecem para quem não tem nível, e o servidor recusa as chamadas correspondentes de qualquer forma. Para um administrador comum, **Dispositivos** mostra apenas Alertas (Cadastro, Firmware / OTA e Protocolos IR são do superadministrador) e **Sistema** mostra Logs (sem Auditoria) e Status (sem Sistema).

Os endereços acompanham a hierarquia: `#/admin/<função>` para a função e `#/admin/<função>/<aba>` para uma aba interna que não seja a primeira — `#/admin/usuarios/proprietarios`, `#/admin/logs/sessoes`, `#/admin/status/mapa`. Os endereços das funções que mudaram de lugar continuam válidos como apelidos e resolvem para o novo local, sem manter tela nem código duplicado: `#/admin/proprietarios`, `#/admin/sessoes`, `#/admin/dispositivos`, `#/admin/acessos`, `#/admin/ativos`, `#/admin/mapa`, `#/admin/auditoria` e `#/admin/monitoramento`.

### Formas de chegar a uma sala

O sistema oferece três formas de chegar até uma sala, todas equivalentes em funcionalidade:

- **Assistente simples**: três passos guiados por ícones grandes — bloco, andar e sala — pensados para toque em celular. É a navegação padrão de salas.
- **Planta baixa**: exibe a planta baixa real do campus (Bloco A e Bloco B, térreo/2º/3º pavimentos), com abas para alternar entre os seis setores e suporte a zoom. Cada sala com ar-condicionado controlado pelo sistema aparece destacada e colorida conforme seu estado:
  - cinza: offline (sem ESP32 reportando)
  - azul: online, desligado
  - verde: online, ligado
  - contorno amarelo: com agendamento ativo no momento

  "Online" é presença (a placa foi vista há pouco); "ligado/desligado" é o estado desejado guardado no servidor. A confirmação da placa aparece no painel da sala e em `Dispositivos > Firmware / OTA`; o efeito no aparelho não é medido (veja [Painel dos ESP32](#painel-dos-esp32-protocolos-ir-e-failsafe-administração--dispositivos)).
- **Lista tradicional** (`Bloco → Andar → Sala`): navegação simples em lista, sem elementos gráficos.

Qualquer usuário autenticado pode visualizar o estado de todas as salas — isso inclui salas às quais o usuário não tem permissão de controle, que aparecem marcadas como "visualização" e cujos controles ficam desabilitados no painel. Os três modos de navegação têm botões cruzados para alternar entre si a qualquer momento.

### Endereço, refresh e histórico

O frontend reflete a tela atual no endereço da página como um **fragmento** (`#/inicio`, `#/salas`, `#/sala/A-108`, `#/salas/planta/a-terreo`, `#/agenda`, `#/admin`, `#/admin/esp32`, `#/admin/logs/sessoes`, `#/admin/status/sistema`, `#/admin/relatos`, `#/relatos`, `#/ajuda`, `#/ajuda/ota`…). Um endereço vazio equivale a `#/inicio`. Isso dá o comportamento de um site tradicional:

- recarregar a página mantém onde você estava (aba, subtela, sub-aba de Administração, aba interna dessa sub-aba, sala aberta, seção do mapa);
- **voltar/avançar do navegador** percorrem as seções visitadas (cada navegação entre seções gera uma entrada de histórico; trocar apenas um filtro — sala ou data na Grade/Agenda — não gera);
- qualquer seção pode ser aberta direto pela URL, e links do sistema e da documentação podem apontar para uma seção específica (o botão **Abrir no manual** de cada ajuda e o `Ver no app` do manual usam esse mesmo endereçamento). Apelidos curtos de seção do manual são resolvidos (`#/ajuda/ota` → `#/ajuda/ota-credenciais`).

A estratégia é **hash routing** (fragmento), não History API, por ser a única que funciona igual — e sem nenhuma regra de reescrita por implantação — no servidor Node local, atrás de proxy reverso, na PWA, no GitHub Pages usado para demonstração e no app Cordova (`file://`), inclusive **offline** (o app-shell e o manual vêm do cache do service worker). Um caminho real (`/admin/esp32`) exigiria um _catch-all_ no Express, regras no proxy, um truque de `404.html` no GitHub Pages e não sobreviveria a um reload em `file://`.

A versão canônica do frontend fica em `remoteifes-web/version.json` e também é exposta pelo meta `remoteifes-version` e por `window.REMOTEIFES_FRONTEND_VERSION`. HTML, scripts, estilos e imagens usam essa versão na URL. O service worker instala o novo app-shell de forma atômica, usa rede primeiro para navegações, remove somente caches RemoteIFES obsoletos e mantém o shell novo para uso offline. Toda alteração publicada em `remoteifes-web` deve avançar essa versão nos pontos validados por `remoteifes-server/test/frontend-version.test.js`; o teste falha se HTML, manifesto, JavaScript ou worker ficarem desencontrados.

Ao restaurar uma rota, a aba/subtela só é aberta se a permissão do usuário alcança (deny-by-default): rota de Administração sem ser admin cai em Salas; sub-aba exclusiva do superadministrador sem esse nível cai em `Administração > Gestão > Usuários`, e aba interna exclusiva sem esse nível cai na primeira aba autorizada da mesma função; sala inexistente cai em Salas. O endereço **nunca** concede acesso a uma função protegida — ele só escolhe a tela; cada operação continua autorizada no servidor. Nada além da localização de navegação (nenhuma senha, token, credencial de ESP32, conteúdo de formulário ou estado de permissão) é guardado no endereço; formulários e operações incompletas não são restaurados. Sair limpa o endereço.

As 86 salas cadastradas por padrão vêm diretamente da planta baixa fornecida (`remoteifes-server/src/db/salasCampus.js`); ajuste esse arquivo se a planta do campus mudar (novas salas, renomeações, etc.) antes da primeira execução do servidor — o seed só roda quando o banco está vazio. Um código de sala pode representar duas salas físicas controladas pelo mesmo ESP32 (ex.: `B-105-B-106`); nesse caso a interface exibe as duas etiquetas empilhadas no mesmo bloco do mapa.

## Controle de Acesso e Proprietários de Sala

Além da permissão geral "pode controlar" (nível de usuário), existem dois mecanismos para restringir e delegar o controle de salas individuais:

### Acesso restrito por sala

Em `Administração > Dispositivos > Cadastro` (ou em `Administração > Gestão > Usuários > Proprietários de sala`), o superadministrador pode marcar uma sala como **acesso restrito**:

1. Isso impede que qualquer usuário comum a controle, mesmo com a permissão geral ativa — exceto os usuários explicitamente autorizados para aquela sala.
2. Usuários autorizados são concedidos/revogados individualmente, por sala.
3. Administradores (níveis 2 e 3) sempre podem controlar qualquer sala, independentemente de restrição.

A verificação é feita no backend (`aplicarComando`), então mesmo chamadas diretas à API respeitam a restrição — a interface apenas reflete o estado (desabilitando os controles e mostrando um aviso de "somente leitura") para dar feedback imediato ao usuário.

### Proprietários de sala

Qualquer administrador pode tornar um usuário comum **proprietário** de uma sala específica, em `Administração > Gestão > Usuários > Proprietários de sala`. Um proprietário:

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

O agendador do servidor verifica agendamentos ativos a cada minuto e não repete uma mesma ação (ligar/desligar) mais de uma vez no mesmo dia. O período é fechado no início e aberto no fim (`[horaInicio, horaFim)`): no minuto exato de `horaFim` a reserva já não vale e o desligamento agendado é aplicado — uma reserva seguinte que comece nesse minuto assume a sala sem intervalo. Criado ou reativado com o intervalo de ligar em andamento, o agendamento liga o ar-condicionado na próxima verificação (até 1 minuto) e o desliga no fim. O desligamento só é executado por um agendamento que ligou o ar-condicionado naquele dia; um agendamento que não chegou a ligá-lo (criado só depois de o intervalo de ligar terminar, ou perdido inteiro numa queda do servidor) não liga nem desliga nada — em particular, não desliga um aparelho ligado manualmente — e a reserva, enquanto vigente, continua bloqueando a sala. Um ajuste manual do autor (ou de um administrador) dentro do período não cancela o desligamento do fim. Um agendamento desativado permanece salvo, mas não é executado; o autor ou qualquer outro administrador pode ativá-lo, desativá-lo ou removê-lo. Usuários comuns não veem a Agenda nem a Grade: para eles a reserva aparece só como indicação na sala (contorno na lista e na planta, aviso no painel), e o servidor recusa seus comandos em uma sala reservada por outra pessoa. Desativar ou remover um agendamento em curso libera a reserva e cancela o desligamento que ele faria no fim; o ar-condicionado que ele já ligou **continua ligado** até um comando manual ou outro agendamento. Se o servidor parar depois de ligar e só voltar no dia seguinte, o desligamento que ficou pendente é aplicado uma única vez na primeira passagem do agendador, feita ao iniciar e antes de qualquer ESP32 reconectar (a reconexão recebe o OFF, não o "ligado" expirado) — a menos que uma intenção mais nova (comando manual, outro agendamento ou OFF local) tenha surgido depois da hora em que ele era devido; agendamentos desativados não são recuperados e uma execução já registrada nunca se repete.

A reativação é recusada se houver conflito com outra reserva ativa na mesma sala e data; o agendamento permanece desativado até que o conflito seja resolvido.

## Grade de Horários

A aba **Grade** (visível apenas para administradores) mostra, para uma sala e data escolhidas, uma grade com os períodos de aula fixos do campus (07:00 às 22:10, em blocos de aproximadamente 50 minutos), indicando para cada período se a sala está livre, apenas reservada ou com o ar-condicionado ligado, e por quem. É útil para identificar rapidamente conflitos de horário ou janelas livres antes de criar um novo agendamento.

## Limites de Temperatura e Turbo

O controlador possui somente as ações fixas necessárias: diminuir temperatura à esquerda, ligar/desligar ao centro, aumentar temperatura à direita e Turbo abaixo do botão de energia. A disposição não pode ser arrastada nem editada.

**Auto-ON** é uma opção global do sistema (`Administração > Sistema > Configurações`, exclusiva do superadministrador), **ativada por padrão** em instalações novas e preservada no banco entre reinícios e atualizações do servidor. Com Auto-ON ativo, um ajuste de temperatura em um aparelho desligado o liga já com o novo alvo, e ativar o Turbo em um aparelho desligado o liga com o Turbo; nenhum usuário precisa configurar nada. Com Auto-ON desativado, a temperatura alvo é apenas guardada (o aparelho continua desligado) e o Turbo só pode ser alterado com o aparelho ligado — o painel desabilita o botão nesse caso. Em qualquer configuração, desativar o Turbo (`turbo=false`) nunca liga um aparelho desligado, e o único comando que desliga continua sendo o Power. Quando o acionamento é automático, `Logs > Comandos` registra um `ligar` com valor `automatico` antes do ajuste; a mudança da opção é auditada como as demais configurações globais e os painéis abertos recebem o novo estado pelo WebSocket sem recarregar.

O superadministrador configura os limites globais de temperatura, inicialmente 23 °C e 25 °C. Cada sala pode substituir apenas o mínimo, apenas o máximo ou os dois em `Administração > Dispositivos > Cadastro`; um campo deixado vazio herda seu valor global correspondente. Os limites efetivos são aplicados aos comandos manuais, agendamentos e testes de infravermelho. Ao estreitar um intervalo, temperaturas alvo e agendadas existentes são ajustadas para o novo intervalo.

O Turbo transmite o modo turbo suportado pelo protocolo IR da sala. Em `Administração > Sistema > Configurações`, o superadministrador também pode configurar o Turbo para acionar simultaneamente a oscilação vertical, ou deixá-lo sem função adicional.

## Desligamento Diário Automático

O superadministrador pode configurar em `Administração > Sistema > Configurações` um **desligamento diário automático** (desativado por padrão): um horário do dia, no horário de Brasília (por exemplo `00:00`), e o escopo — **todas as salas** (inclusive as criadas depois) ou **salas selecionadas**. Nenhum outro papel vê ou altera essa opção.

É um único comando de desligar por dia, e não um toque de recolher:

- no horário configurado, cada sala do escopo que estiver ligada recebe a intenção de desligar (o estado desejado passa a desligado e a versão do estado avança); salas já desligadas não são tocadas;
- quem religar a sala depois do horário mantém o aparelho ligado até o desligamento do dia seguinte;
- se o servidor estava parado no horário, o desligamento perdido é aplicado **uma única vez** quando ele volta (o mais recente devido, do dia ou da véspera), e reinícios repetidos não o repetem;
- um comando manual, de agendamento ou de outro desligamento posterior ao horário vale mais que um desligamento aplicado com atraso: a sala é mantida como está;
- uma sala mantida ligada por um agendamento em curso no horário (o agendamento já ligou e ainda não desligou) é poupada — o desligamento do próprio agendamento encerra; agendamentos que começam depois do horário não são afetados;
- ativar a opção ou mudar horário ou salas vale a partir da próxima ocorrência do novo horário, nunca retroativamente;
- ESP32 offline no horário recebem o desligamento quando reconectam, pelo mesmo estado desejado que o servidor já guarda. Como em qualquer comando, a submissão ao socket não prova que o aparelho recebeu o infravermelho: a confirmação continua sendo o eco da placa.

Cada sala processada fica registrada com o resultado (desligada, já desligada, mantida por comando posterior ou mantida por agendamento) na mesma transação da mudança de estado, de modo que uma queda no meio não marca como feito o que não foi feito nem repete o que já foi. A execução gera um evento de auditoria (`desligamento_diario_executado`) com a contagem por resultado, e cada desligamento aparece em `Logs > Comandos` com origem `desligamento_diario`. A tela de Configurações mostra o próximo horário e o resumo da última execução.

## Notificações

O topo da interface tem dois indicadores com significados distintos, cada um com seu rótulo acessível:

- **Sino** — notificações de dispositivos/ESP32, visível apenas a administradores. O sistema gera notificações automáticas quando um ESP32 que estava online fica offline (timeout de heartbeat), quando uma atualização de firmware por OTA conclui ou falha, e quando o [monitoramento operacional](#monitoramento-operacional) detecta uma condição de alerta (disco baixo, backup atrasado, ESP32 instável etc.), sem repetir o mesmo alerta dentro de 6 horas. O painel permite ver a lista mais recente com data/hora, marcar uma notificação como lida (ao clicar nela) e marcar todas de uma vez. O ponto vermelho no sino reflete a contagem de não lidas. A mesma fila aparece em `Administração > Dispositivos > Alertas`.
- **Inseto (bug)** — relatos de problema enviados pelos usuários (veja a seção abaixo).

## Relatos de Problema

Qualquer usuário autenticado pode abrir o painel do ícone de inseto no topo e enviar um **relato de problema**. O formulário estilizado (não usa `prompt()`/`alert()` do navegador) pede um título curto, uma categoria, opcionalmente a sala relacionada e uma descrição do que aconteceu. Junto do relato o servidor registra automaticamente apenas contexto não sensível: usuário que enviou, data/hora, página em uso, tamanho da tela, `User-Agent` e idioma do navegador. Senhas, tokens e segredos nunca são coletados; todo o conteúdo é validado, limitado em tamanho e sanitizado no backend, e cliques repetidos no botão de envio não geram relatos duplicados.

Cada relato guarda: id único, usuário (com nome/login preservados mesmo se a conta for removida depois), data de criação e de última atualização, categoria, sala/página, contexto técnico, status e a resposta/anotação da equipe.

**Envio e gestão são separados.** Qualquer usuário — inclusive o superadministrador — envia relatos pelo painel do ícone de inseto, que mostra também os **próprios** relatos e o status de cada um; esse painel nunca contém a fila de gestão. A gestão fica em **`Administração > Gestão > Relatos de problemas`**, uma sub-aba exclusiva do superadministrador com contadores por situação, filtros (novos, abertos, em análise, resolvidos), abertura de cada relato com autor, horário e detalhes, e as ações de marcar em análise, resolver ou reabrir, com uma resposta opcional que fica visível ao autor. Abrir um relato ainda `novo` o marca automaticamente como `aberto`. Essa sub-aba trata apenas relatos **já enviados** pelos usuários; não há formulário de envio nela. Tanto o ícone de inseto quanto a própria sub-aba exibem um contador discreto com a quantidade de relatos novos ainda não vistos; o painel de envio do superadmin traz um atalho para essa sub-aba.

Dentro da janela de detalhe, o superadministrador pode ainda **excluir permanentemente** um relato. A exclusão fica atrás de uma confirmação em duas etapas dentro da própria janela (não usa `confirm()` do navegador), avisa que a ação não pode ser desfeita e remove a descrição, a resposta e o histórico de revisão. O backend expõe `DELETE /superadmin/relatos/:id` sob `exigirSuperAdmin` e registra apenas metadados no log (`relato-removido`: id, status anterior, quem removeu) — nunca o texto.

A lista global, os relatos de terceiros e a exclusão são bloqueados no backend (`exigirSuperAdmin`), não apenas escondidos na interface — um usuário comum recebe `403` ao tentar acessá-los diretamente.

A tabela `relatos` é criada automaticamente na inicialização do servidor (`CREATE TABLE IF NOT EXISTS`), tanto em instalações novas quanto nas já existentes; não é preciso rodar nenhuma migração manual.

## Sessões e Tempo de Inatividade

O servidor registra cada login como uma sessão (token, horário de início, último uso e, ao sair, horário de logout). Isso alimenta duas funções da Administração:

- **`Administração > Sistema > Status > Usuários ativos`**: usuários com uma sessão em aberto, com um cronômetro de tempo de sessão em tempo real e um status calculado a partir do último uso — `online` (dentro do limiar configurado), `inativo` (sessão aberta, mas sem uso recente) ou `offline`.
- **`Administração > Sistema > Logs > Sessões`**: histórico de logins/logouts, com duração de cada sessão, filtrável por data e removível (por data ou por completo).

O servidor encerra sessões sem atividade e continua sendo a autoridade sobre o prazo, inclusive para REST e WebSocket. A interface mostra uma contagem regressiva junto às iniciais da conta, atualizada localmente a partir do prazo informado pelo servidor, sem consultas a cada segundo. Clique, mouse, tecla ou toque renovam o prazo pelo mecanismo de sessão existente; o aviso prévio permite continuar conectado. Atividade, logout e expiração são sincronizados entre abas. Os padrões são 60 minutos para usuários e 720 minutos para administradores e superadministrador. Além disso, **toda reinicialização do servidor encerra as sessões em aberto**: depois de um restart, os usuários precisam entrar novamente.

## Auditoria (Logs, Dispositivos e Acessos)

O histórico operacional do sistema fica reunido nas abas internas de **`Administração > Sistema > Logs`**, todas filtráveis por data; **Comandos**, **Acessos** e **Sessões** oferecem ainda a exclusão de registros (ação irreversível), enquanto **Dispositivos** é somente consulta. Os registros são gravados em UTC, mas exibidos, filtrados e excluídos pelo **dia de Brasília**: um registro mostrado às 22:30 de um dia pertence a esse dia no filtro e em "excluir data", não ao dia UTC seguinte (o mesmo vale para a auditoria e a conectividade em `Administração > Sistema > Status`):

- **`Administração > Sistema > Logs > Comandos`**: cada comando de ligar, desligar ou ajustar temperatura enviado a uma sala, com o usuário responsável (ou `sistema`, quando não houve uma conta por trás: agendamento ou registro da própria placa) e a origem (`manual`, `agendamento` ou `esp32_local`, quando o registro parte do próprio dispositivo — por exemplo, o failsafe OFF disparado pelo switch físico ou a abertura do ponto de acesso pelo switch).
- **`Administração > Sistema > Logs > Dispositivos`**: eventos de conexão — sempre que um ESP32 fica online ou offline. O fechamento do WebSocket do dispositivo é a informação autoritativa: a sala é marcada offline **na hora**, sem esperar prazo nenhum. Uma perda silenciosa (o aparelho some sem fechar a conexão) é detectada pelo ping/pong do servidor a cada 15 segundos e derruba a conexão em até 30 segundos, o que dispara a mesma transição imediata. O prazo de 90 segundos sem heartbeat continua valendo apenas como rede de segurança para dispositivos que estejam usando o heartbeat HTTP em vez do WebSocket.
- **`Administração > Sistema > Logs > Acessos`**: registros de acesso à antiga interface web local dos ESP32, com o IP de origem. O firmware atual não serve página local em operação, então a aba preserva apenas o histórico já gravado e continua aceitando registros de placas com firmware anterior.
- **`Administração > Sistema > Logs > Sessões`**: o histórico de login/logout descrito em [Sessões e Tempo de Inatividade](#sessões-e-tempo-de-inatividade).

O superadministrador dispõe ainda de **`Administração > Sistema > Logs > Auditoria`**, uma visão paginada e filtrável de ações administrativas importantes, como criação, alteração e exclusão de contas, mudanças de papel e configuração (inclusive Auto-ON) e operações relevantes sobre ESP32 — definição do clonador, entrada e saída do modo clone, criação, renomeação, exclusão, transmissão e aplicação de protocolos IR e configuração ou remoção do failsafe OFF. Os registros contêm apenas metadados concisos — nunca senhas, tokens ou segredos de dispositivo. A mesma área apresenta intervalos de indisponibilidade dos controladores, com uma única ocorrência aberta durante a queda e duração calculada quando há reconexão. Interface e APIs exigem `superadmin`; a retenção padrão é 7 dias, configurável entre 1 e 365 dias em Administração.

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
| `relatos` **apenas com status `resolvido`** | desligado (`0`); defina para ativar | `RETENCAO_DIAS_RELATOS_RESOLVIDOS` |

O histórico de monitoramento segue a mesma rotina: `monitoramento_amostras` guarda 48 horas (limite de 6 000 linhas) e `monitoramento_horas` 30 dias (limite de 1 000 linhas), sempre consolidando as horas fechadas antes de apagar amostras. Usuários, salas, agendamentos do dia atual, configurações e **relatos de problema não resolvidos nunca são removidos** por essa rotina — a retenção de relatos resolvidos vem **desligada** e só apaga relatos já marcados como `resolvido` quando `RETENCAO_DIAS_RELATOS_RESOLVIDOS` recebe um número de dias. Notificações não lidas sobrevivem a `RETENCAO_DIAS_NOTIFICACOES` (365 dias por padrão) antes de serem descartadas, para uma caixa esquecida não crescer sem limite. As tabelas de histórico têm índices por data/hora para que a limpeza e as consultas de faixa de tempo (monitoramento, listas administrativas) continuem baratas mesmo com o banco cheio. O espaço liberado dentro do arquivo principal do SQLite fica disponível para reutilização pelo próprio banco; após uma limpeza, o servidor também trunca o WAL para impedir que o arquivo auxiliar permaneça grande.

### Limites de crescimento e hardware mínimo

O servidor foi pensado para rodar por anos em hardware modesto (classe **Raspberry Pi 3**: 1 GB de RAM, quatro núcleos ARM, cartão SD). Os pontos que poderiam crescer sem limite estão contidos:

- **Banco**: todas as tabelas de histórico têm retenção por tempo (acima) e índices por data; a rotina de limpeza trunca o WAL ao final.
- **Agendamentos**: o agendador só carrega, a cada minuto, os agendamentos **do dia**, independentemente do tamanho da tabela; agendamentos passados são apagados pela retenção e há um teto por usuário (`AGENDAMENTOS_MAX_ATIVOS_POR_USUARIO`).
- **Notificações de ESP32 offline**: uma nova notificação para a mesma sala é suprimida se já existe uma não lida na última hora, evitando enxurrada por um dispositivo instável.
- **Estado de OTA em memória e em `estados-ota.json`**: entradas em fase terminal (`concluído`, `falhou`) são descartadas após 7 dias; só uma imagem de firmware `.bin` é mantida por vez.
- **Backups e pré-restaurações**: rotacionados por contagem (`BACKUP_RETENCAO`, 14; pré-restaurações, 5); temporários órfãos são varridos após 10 minutos.
- **APK de produção**: apenas o release publicado em `data/releases/mobile/` é servido; a publicação remove os APKs superados e nada é acumulado.
- **Estado em memória**: mapas por sala (conexões de dispositivo, última reconexão, capturas de IR — no máximo 20 por sala) e por conexão WebSocket (`WeakMap`, limpos no `close`); o limitador de taxa expira entradas por janela. As listas administrativas usam `LIMIT` no servidor (300–500 linhas) e nunca devolvem a tabela inteira.
- **Transmissão para os navegadores**: a lista de salas só é retransmitida quando muda algo que ela mostra (uma sala fica online/offline, liga ou desliga). A telemetria periódica de temperatura vai apenas para quem está com aquela sala aberta, e o rebroadcast de segurança continua a cada 30 s. Sem esse cuidado, cada quadro de telemetria custaria uma retransmissão da lista inteira para todos os navegadores conectados, e o custo cresceria com o produto salas × navegadores.
- **Logs**: o servidor escreve em `stdout`/`stderr`; a rotação é do coletor (o `journald` do systemd, com seus próprios limites de tamanho, quando instalado via `install-service.sh`).

Para conferir o dimensionamento no seu próprio hardware, `npm run carga` sobe uma instância isolada (banco temporário, descartado ao final — nunca toca no banco de produção), conecta ESP32 simulados pelo protocolo real e relata memória, latência, tráfego por navegador e entrega de comandos: `npm run carga -- --salas 86 --minutos 2`. Use-o depois de mudanças no servidor para confirmar que a operação do campus continua cabendo no equipamento.

**Rodar o servidor em um ESP32-S3 não é viável e não faz parte da arquitetura.** O ESP32-S3 é o alvo do *firmware* (`remoteifes-esp32/`), não do servidor central. O servidor depende de Node.js + V8 (que não têm porte para o Xtensa LX7), do módulo nativo `node:sqlite`, de dois `WebSocketServer` simultâneos e de TLS por software para dezenas de conexões — cada uma dessas peças sozinha excede a RAM interna (~512 KB) e o armazenamento (8–16 MB de flash) do chip, sem contar que backups e a imagem de OTA já não caberiam. A fronteira correta já é a atual: dispositivo fino no ESP32, servidor em um host Linux pequeno. O piso prático abaixo do Pi 3 é algo como um Raspberry Pi Zero 2 W (mesma RAM, ainda roda Node); abaixo disso o servidor não cabe.

### Backup e restauração do banco

O banco inteiro fica em um único arquivo SQLite (`remoteifes-server/data/remoteifes.db`). O servidor sabe fazer cópias de segurança consistentes desse arquivo **sem parar** e sem risco de copiar um estado parcial: cada backup é gerado por `VACUUM INTO`, que produz um arquivo `.db` autônomo, compactado e transacionalmente íntegro (o conteúdo do WAL já entra na cópia; não há `-wal`/`-shm` ao lado). Logo depois de gravado, o arquivo é reaberto somente-leitura e validado com `PRAGMA integrity_check`, `PRAGMA foreign_key_check` e uma checagem das tabelas essenciais — um backup que não passa nessa verificação é descartado, nunca entra na rotação.

**Backup automático** (em produção, ligado por padrão): a cada `BACKUP_INTERVALO_HORAS` (24 por padrão) e uma vez logo após a inicialização, o servidor grava um novo backup em `BACKUP_DIR` (`data/backups/` por padrão) e mantém apenas os `BACKUP_RETENCAO` mais recentes (14 por padrão), removendo os excedentes. Fora de produção o backup automático começa desligado; ligue-o com `BACKUP_AUTOMATICO=true`. Como `data/` já está no `.gitignore`, os backups não são versionados.

**Backup manual:** dentro de `remoteifes-server`, `npm run backup` grava um backup imediato (verificado e já sujeito à rotação) e imprime o caminho. Aceita um rótulo opcional: `npm run backup -- pre-migracao`.

**Restauração:** com o servidor **parado**, `npm run restore` lista os backups disponíveis; `npm run restore -- <arquivo>` restaura o backup indicado (nome dentro de `BACKUP_DIR` ou caminho completo). Antes de sobrescrever, o script verifica o backup candidato, diagnostica o banco atual em modo somente-leitura, faz uma cópia de segurança consistente dele (`pre-restauracao-<data>.db` em `BACKUP_DIR`) e, depois da troca, revalida o arquivo restaurado. Use `--sim` para pular a confirmação interativa em scripts. Reinicie o servidor após a restauração. Durante a troca, a restauração (pelo terminal ou pelo Console de Operações) grava ao lado do banco o aviso `remoteifes.db.restauracao` com o número do seu processo: enquanto esse processo existir, **nenhum processo do RemoteIFES abre o banco** — um servidor iniciado nesse intervalo termina com "restauração do banco em andamento" e o serviço volta sozinho depois. Um aviso deixado por uma restauração interrompida (processo inexistente, ou com mais de 30 minutos) é ignorado. Pelo console, a restauração ainda prova com o lock exclusivo do SQLite que nenhum escritor está aberto antes da troca.

**Banco atual corrompido:** se o arquivo em uso não passa em `PRAGMA integrity_check`, a restauração normal é recusada sem tocar em nada (não existe cópia de segurança verificável de um banco danificado). Use `npm run restore -- <arquivo> --recuperar-corrompido`: o banco danificado e seus `-wal`/`-shm` são **renomeados** para `remoteifes.db.corrompido-<data>-<id>` (nunca apagados, para análise posterior), o backup verificado é instalado atomicamente e revalidado com `integrity_check` e `foreign_key_check`. Um banco íntegro nunca vai para quarentena, mesmo com a opção ligada.

As credenciais dos ESP32 fazem parte do banco e entram normalmente no backup. Se a restauração voltar para antes de uma rotação, substituição ou revogação, a NVS do dispositivo e o banco podem ficar em versões diferentes; nesse caso, emita uma credencial de substituição e informe-a no portal de setup do controlador afetado.

| Variável | Padrão | Descrição |
|---|---|---|
| `BACKUP_AUTOMATICO` | `true` em produção, `false` nos demais | Liga/desliga o backup periódico do agendador |
| `BACKUP_INTERVALO_HORAS` | 24 | Intervalo entre backups automáticos (1 a 8760) |
| `BACKUP_RETENCAO` | 14 | Quantos backups manter; os mais antigos são apagados |
| `BACKUP_DIR` | `data/backups` | Pasta onde os backups são gravados |

## Restrição de Rede

Em produção (`NODE_ENV=production`), o acesso à API é restrito a faixas de IP autorizadas (rede do IFES), em CIDR IPv4 (ex.: `10.0.0.0/8`). Existe um **modo de teste** que permite acesso de fora da rede autorizada — útil durante testes e homologação, mas desativado por padrão em uma instalação nova de produção. Fora do ambiente de produção (`NODE_ENV=development`) essa restrição não é aplicada. A mesma restrição de rede e de modo de teste vale para as conexões WebSocket, não apenas para a API HTTP.

**Onde se altera.** As faixas e o modo de teste decidem quem alcança o site, por isso são configuração de infraestrutura e **não são mais editados pelo site**:

- **[Console de Operações](#console-de-operações) › Rede e domínio › Acesso à aplicação** — operação que exige reautenticação, é serializada com implantação e restauração, grava as duas chaves e o evento de auditoria numa única transação e confere o resultado relendo o banco. O evento aparece na auditoria da aplicação como `configuracao_alterada`, com o autor `console:<operador>`. O console não passa pela restrição de rede da aplicação, então continua disponível para desfazer uma faixa errada;
- **terminal do servidor** — `npm run redes` (veja [Recuperação de emergência por terminal](#recuperação-de-emergência-por-terminal)), para quando o console não estiver instalado.

Em `Administração > Sistema > Configurações` o superadministrador apenas **consulta** os valores vigentes. O servidor recusa com `403` qualquer requisição do site que tente mudá-los; um frontend antigo em cache que reenvie os valores atuais continua salvando as demais configurações normalmente. A mudança vale na requisição seguinte, sem reiniciar o serviço.

## Segurança

Resumo das principais medidas de segurança implementadas no servidor central (detalhes específicos já aparecem nas seções acima):

- **Senhas**: armazenadas como hash `bcrypt` (nunca em texto puro); mínimo de 8 caracteres.
- **Sessões**: o token de sessão retornado no login é aleatório (`crypto.randomBytes`), mas o valor gravado no banco (`sessoes.token`) é o hash SHA-256 do token, não o token em si — um vazamento do banco de dados não permite sequestrar sessões ativas diretamente. Sessões inativas por mais de 24h são encerradas automaticamente pelo servidor.
- **Autorização**: todos os papéis (usuário, administrador, superadministrador) e as permissões pontuais (proprietário de sala, acesso restrito) são checados no backend em cada rota, nunca apenas escondidos na interface.
- **Dispositivos (ESP32)**: a associação é feita pelo MAC. Um dispositivo ainda não vinculado só pode se registrar como detectado; depois que o superadministrador associa seu MAC a uma sala em `Administração > Dispositivos > Cadastro`, heartbeat, WebSocket e registros dessa sala exigem exatamente o mesmo MAC. Cada sala pode ainda ter uma **credencial exclusiva de dispositivo** (`deviceId` + segredo de 256 bits, guardado só como hash SHA-256): quando provisionada, ela passa a ser exigida no lugar do MAC; uma opção global torna a credencial obrigatória para todos os ESP32. Rotação em duas fases (o segredo novo só é ativado quando a placa prova possuí-lo; o anterior entra então em tolerância de 24 h), revogação imediata e substituição para troca de placa (preservando a associação da sala). Veja [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração). Como endereços MAC podem ser imitados, mantenha o servidor e os dispositivos em uma rede administrada, prefira a credencial por dispositivo em produção e use HTTPS quando o tráfego sair da rede local.
- **Atualização de firmware (OTA)**: a imagem publicada no servidor é verificada por SHA-256 pelo ESP32 antes de ser instalada; a gravação usa um segundo slot de aplicação e o bootloader reverte sozinho se o novo firmware não passar no autoteste pós-boot. OTA concorrente para a mesma sala é recusada e a gravação por USB continua como caminho de recuperação. Veja [Atualização de Firmware por OTA (ESP32)](#atualização-de-firmware-por-ota-esp32).
- **Administração do ESP32**: os comandos de configuração, captura e reset são autorizados pela sessão do superadministrador no servidor. O dispositivo não guarda nem recebe uma senha administrativa própria. O papel de **clonador** também é decidido pelo servidor e vinculado ao MAC e à credencial da placa no momento da definição: o firmware não persiste esse papel, ignora ordens de captura quando não é o clonador, e o servidor descarta capturas vindas de qualquer outra placa, de uma placa fora do modo clone ou de um ESP32 que tenha sido trocado ou tido a credencial substituída depois da definição.
- **Ponto de acesso de configuração**: a rede `RemoteIFES-Setup` é criada apenas no modo AP de provisionamento — quando o ESP32 não tem configuração válida de Wi-Fi e servidor, depois de um **Resetar Wi-Fi** ou por até dez minutos após um **clique curto no switch físico** (GPIO 26). Após salvar e reiniciar, o ESP32 opera em modo STA, encerra o AP e não serve frontend local durante a operação normal; no AP aberto pelo switch, a conexão com o servidor é mantida (AP+STA) e o ponto de acesso fecha sozinho se nada for salvo. A exigência de senha é decidida pela opção global **Exigir senha na rede de configuração dos ESP32** em `Administração > Sistema > Configurações`: **desativada por padrão**, deixando a rede de configuração aberta enquanto existir; quando ativada, o ponto de acesso passa a usar a senha padrão do firmware, `remoteifes`, também exibida no console serial físico. As rotas que exibem ou salvam o provisionamento só aceitam requisições recebidas pela interface desse ponto de acesso. Com a rede aberta, qualquer pessoa ao alcance do rádio pode abrir o portal e reprovisionar o dispositivo: ative a exigência de senha onde o acesso físico à área não for controlado.
- **Transporte ESP32 → servidor**: o firmware suporta HTTPS (com validação de certificado usando a cadeia pública da Let's Encrypt, ou sem validação para certificados autoassinados em redes locais) além do HTTP tradicional, configurável no portal de setup de cada dispositivo (modo "Conexão com o servidor"). Veja [Domínio Próprio e HTTPS](#domínio-próprio-e-https).
- **Rate limiting**: comandos manuais (`/comando`), envio de relatos (`/relatos`) e chamadas dos dispositivos (`/dispositivo/*`) são limitados **por usuário ou dispositivo autenticado** (60 comandos/min por usuário, 120 chamadas/min por dispositivo, 15 relatos/10 min por usuário), com um teto adicional por IP vinte vezes maior que protege contra abuso vindo de um único endereço sem que um campus inteiro atrás de um NAT esgote um orçamento pequeno; o login mantém a proteção contra força bruta por IP (20 falhas em 15 min), mas logins bem-sucedidos não consomem esse orçamento; conexões WebSocket autenticadas também têm um limite de mensagens por janela de tempo (encerrando a conexão em caso de flood) e um limite de tamanho por frame (8 KiB no canal dos navegadores, 256 KiB no canal dos dispositivos) — frames maiores são recusados antes de qualquer processamento. O firmware do ESP32 também aplica um intervalo mínimo entre comandos de ar-condicionado aceitos, para não sobrecarregar o compressor com toggles rápidos.
- **Relatos de problema**: o conteúdo enviado pelos usuários é validado, limitado em tamanho e tem caracteres de controle removidos no backend antes de gravar (consultas parametrizadas); na interface ele é sempre renderizado como texto (`textContent`), nunca como HTML, evitando XSS armazenado. As rotas de leitura e gestão da caixa global exigem `exigirSuperAdmin`; um usuário comum só alcança os próprios relatos. Os logs do servidor registram apenas metadados do relato (id, autor, categoria, status), nunca o texto do relato ou da resposta.
- **Cabeçalhos HTTP**: todas as respostas incluem `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Content-Security-Policy` e `Permissions-Policy`; em produção, `Strict-Transport-Security` também é enviado nas respostas HTTPS.
- **CORS**: em produção, a própria origem é aceita automaticamente; origens externas precisam ser listadas em `CORS_ORIGIN`.
- **Erros**: respostas de erro nunca incluem stack trace nem detalhes internos; exceções não tratadas são registradas apenas no log do servidor.
- **Restrição de rede** e **modo de teste**: veja a seção [Restrição de Rede](#restrição-de-rede) acima.

## Tempo Real (WebSocket)

O servidor expõe um endpoint WebSocket em `/ws`. Quando o cliente já está autenticado, o token de sessão é enviado pelo campo padrão `Sec-WebSocket-Protocol` do handshake (não por query string) — isso evita que o token fique registrado em logs de acesso de proxies reversos, que costumam gravar a URL completa da requisição. Ao conectar autenticado, o cliente recebe a lista de salas e pode "observar" uma sala específica para receber atualizações do seu status assim que qualquer mudança ocorrer (comando manual, agendamento ou heartbeat do ESP32), sem precisar recarregar a tela. A conexão é também retransmitida periodicamente (a cada 30 segundos) como reforço, e o frontend reconecta automaticamente com espera crescente caso a conexão caia. Um aparelho que suspende ou troca de rede pode deixar o socket aberto sem tráfego e sem evento de fechamento; por isso, ao voltar ao primeiro plano — e enquanto a tela estiver visível, se o reforço de 30 segundos não chegar — o frontend pede uma prova de vida pelo próprio canal e recicla a conexão quando ela não responde, em vez de seguir exibindo o último estado recebido como se fosse o atual. Esse canal alimenta o assistente simples, a lista de salas, o mapa da planta baixa e o painel de controle de cada sala.

Esse mesmo canal transporta as mudanças administrativas que precisam ser vistas na hora: ao gravar o vínculo de um MAC com uma sala, o servidor emite o estado autoritativo daquele cadastro para as sessões de nível administrativo conectadas, e `Administração > Dispositivos > Cadastro` se atualiza sem recarregar, em qualquer sessão aberta. O broadcast parte sempre do estado já persistido no servidor, nunca de uma suposição do navegador.

Toda chamada REST do frontend (`js/api.js`, compartilhado com o app Cordova) tem prazo de **15 s** do envio até o corpo da resposta lido (o download do APK, 120 s); sem isso, uma conexão que emudece deixava a tela presa em "enviando". Uma consulta sem resposta é apenas uma falha de leitura, mas uma mutação (comando, agendamento, alteração administrativa) sem resposta tem **desfecho desconhecido**: a mensagem diz que o pedido pode ter sido aplicado e pede para conferir antes de repetir, e o painel da sala refaz a consulta do estado autoritativo em vez de repetir o comando ou dá-lo como não feito; se nem a consulta responder, os botões voltam a ficar utilizáveis. O mesmo vale quando os cabeçalhos chegam mas o corpo se perde ou não é JSON (`respostaIncompleta`): uma mutação aceita (2xx) ou barrada por um intermediário (5xx) continua com desfecho desconhecido — só um 4xx do próprio servidor é tratado como recusa. Nenhuma mutação é repetida automaticamente. O tratamento de sessão expirada (401) e de manutenção (503) não muda.

O frontend mantém uma única conexão WebSocket por aba (compartilhada entre a tela de status do servidor e o canal de salas/status), em vez de abrir conexões redundantes. O servidor também limita a quantidade de mensagens que uma conexão autenticada pode enviar em uma janela de tempo curta, encerrando a conexão em caso de flood.

Se você configurar um proxy reverso manualmente, garanta que ele propague os cabeçalhos `Upgrade` e `Connection` do handshake WebSocket — sem isso, `/ws` não funciona atrás do proxy. `lan-setup.sh` e `https-setup.sh` já geram a configuração de Nginx correta para isso.

## Painel dos ESP32, Protocolos IR e Failsafe (Administração > Dispositivos)

O firmware separa o **provisionamento local** (portal `RemoteIFES-Setup`, só no modo AP) da **administração operacional**, feita inteiramente pelo servidor. Cada placa tem um **papel** decidido pelo servidor e enviado pelo WebSocket a cada conexão:

| Papel | Quem | O que faz |
|---|---|---|
| **Transmissor IR** (`transmitter`) | todo ESP32 de sala | envia comandos pelo LED infravermelho (GPIO 4), reporta telemetria e guarda o failsafe OFF na NVS; nunca captura sinais |
| **Clonador IR** (`cloner`) | a única placa com receptor infravermelho (GPIO 15), definida pelo superadministrador em `Administração > Dispositivos > Protocolos IR` | além de transmitir, entra no **modo clone** (`config_clone`) para capturar em tempo real os sinais do controle original |

O tipo da placa não é escolhido no `RemoteIFES-Setup` nem gravado no firmware. Só existe **um clonador oficial ativo por vez**; o servidor guarda, junto com a sala, o MAC e a credencial da placa no momento da definição e recusa capturas de qualquer outra sala, de uma placa fora do modo clone ou de um ESP32 que tenha sido substituído (novo MAC em `Cadastro`, credencial substituída ou revogada) — nesse caso a tela avisa e o superadministrador precisa confirmar a clonadora novamente.

### Administração > Dispositivos > Firmware / OTA

Painel operacional de cada ESP32 com MAC cadastrado, visível apenas ao superadministrador:

- Mostra separadamente se o dispositivo está **online na rede Wi-Fi** e se está **conectado ao servidor** (dois estados distintos e independentes), o papel atual (transmissor ou clonador), o modo (`operation`, `config_idle`, `config_clone`), a última leitura de temperatura e umidade, o sinal Wi-Fi (RSSI), o protocolo IR da sala (com o registro da biblioteca, quando aplicado a partir dela), se há **failsafe OFF gravado na NVS** da placa e o **último comando infravermelho transmitido** (estado conhecido, sinal bruto ou failsafe local pelo switch), tudo em tempo real.
- Um botão de **reset de Wi-Fi** remoto apaga a rede e o endereço do servidor, preserva a credencial exclusiva e o failsafe gravado, e reinicia a placa no ponto de acesso `RemoteIFES-Setup` para reprovisionamento no local.
- Mostra a **versão do firmware** instalada e a publicada, com **atualização por OTA** e a **distribuição em etapas** para vários ESP32 (veja [Atualização de Firmware por OTA (ESP32)](#atualização-de-firmware-por-ota-esp32)).
- Gerencia a **credencial exclusiva do dispositivo** (provisionar, rotacionar, substituir, revogar), com o segredo exibido uma única vez (veja [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração)).

Essa aba não tem controles de captura: o modo clone é controlado exclusivamente em Protocolos IR.

### Administração > Dispositivos > Protocolos IR

Biblioteca central de sinais infravermelhos, persistida na tabela `protocolos_ir` do SQLite e exclusiva do superadministrador:

- **Clonador oficial**: escolha a ESP32 equipada com receptor IR e salve. O servidor passa a tratá-la como clonadora (e todas as demais como transmissoras) e envia o papel à placa na hora. A definição, a troca e a remoção do clonador são auditadas.
- **Modo clone**: um único botão entra e sai do modo. Ao entrar, o receptor IR fica em captura contínua; a placa recusa OTA enquanto estiver nesse modo. Ao sair, volta à operação normal. Firmware anterior a 4.1.0 recebe a sequência compatível de comandos, mas só a versão atual entende o papel enviado pelo servidor.
- **Captura em tempo real**: cada sinal recebido pela clonadora aparece em "Última captura" com o protocolo reconhecido pela biblioteca `IRremoteESP8266` (ou como sinal RAW genérico), o código hexadecimal, o número de pulsos e a portadora. A captura pode ser **testada** pela ESP32 de destino antes de ser guardada. O servidor mantém um histórico limitado (20) das capturas recentes da clonadora, que sobrevive a uma reconexão da placa; ao salvar, o navegador referencia a captura pelo identificador desse histórico, nunca envia o RAW.
- **Salvar com nome**: o label tem de 2 a 80 caracteres, é normalizado (espaços repetidos, Unicode NFKC) e é único sem diferenciar maiúsculas de minúsculas. O RAW aceita de 1 a 1024 pulsos com valores de 0 a 65535 e portadora entre 20 e 60 kHz (padrão 38 kHz). Sinais RAW genéricos também são guardados e podem ser testados e retransmitidos, mas não viram protocolo operacional de sala.
- **Lista**: para cada protocolo, **transmitir** pela ESP32 de destino (`send_raw`), **aplicar** como protocolo operacional de uma sala (somente protocolos reconhecidos: grava `irProtocolo` e o registro da biblioteca na sala, reenvia o estado desejado e sincroniza o failsafe), **configurar/recapturar o failsafe OFF**, **remover o failsafe**, **renomear** e **excluir**. Excluir um protocolo mantém o protocolo operacional já gravado nas salas, mas apaga o failsafe vinculado dos ESP32.
- **Failsafe OFF (opcional)**: com a clonadora em modo clone, use "configurar failsafe OFF" no protocolo e transmita ao receptor **somente o botão de desligar** do controle original; a próxima captura fica anexada ao protocolo como RAW de desligamento em vez de virar um novo protocolo. Quando o protocolo é aplicado a uma sala, o servidor envia `failsafe_raw_set` ao ESP32 transmissor, que grava o RAW na NVS (chaves `fsRaw`, `fsLen`, `fsHz`, `fsProto`) e confirma com `failsafe_status`. A sincronização é refeita **a cada reconexão** da placa, ao definir ou remover o failsafe do protocolo e ao excluí-lo; aplicar um protocolo sem failsafe, ou trocar o protocolo da sala por um que não veio da biblioteca, envia `failsafe_raw_clear` para que um código de outro equipamento não fique na placa. O firmware compara o RAW recebido com o gravado e só regrava a NVS quando há diferença.

Essa comunicação usa um canal WebSocket dedicado (`/ws/dispositivo`, distinto do `/ws` usado pelos navegadores) pelo qual o próprio ESP32 se conecta ao servidor como cliente. A conexão é associada à sala pelo MAC cadastrado ou pela credencial do dispositivo e é reaproveitada para telemetria, comandos administrativos, papel, failsafe e OTA, sem abrir portas adicionais no dispositivo nem exigir que o servidor alcance o ESP32 diretamente. O ESP32 reconecta automaticamente caso a conexão caia, e o servidor reaplica o papel, o failsafe e o estado desejado depois da reconexão.

Não existe mais frontend local do ESP32 em operação nem a ação "acessar interface do ESP32" em `Cadastro`: a informação de conferência (sala, MAC, IP, servidor, versão, papel, failsafe) está no painel central, e a recuperação continua garantida pelo monitor serial, pelo clique no switch físico (abre o `RemoteIFES-Setup` sem derrubar a operação), por **Resetar Wi-Fi** no painel e pela gravação USB.

### Switch físico e buzzer

Cada placa usa um único botão momentâneo normalmente aberto ligado entre o **GPIO 26** e o **GND**. O firmware configura o GPIO 26 como `INPUT_PULLUP` (ativo em nível baixo), portanto não é preciso resistor externo e o botão não deve receber 3,3 V ou 5 V; em um push-button tátil de quatro terminais, use um terminal de cada lado oposto. O debounce é de 40 ms e o botão é lido em todo ciclo do `loop()`, inclusive no modo AP e durante o modo clone.

| Ação | Efeito |
|---|---|
| **Clique curto** (solto antes de 5 s) | abre o `RemoteIFES-Setup` por dez minutos, mantendo a conexão com o servidor (AP+STA); um novo clique prorroga a janela e o AP fecha sozinho se nada for salvo. Em uma placa sem configuração o AP já está no ar e o clique não faz nada. |
| **Manter pressionado por 5 s** | transmite **uma única vez** o failsafe OFF gravado na NVS, sem depender de servidor, Internet ou Wi-Fi; soltar o botão depois disso **não** abre o AP. Para um novo disparo é preciso soltar e pressionar de novo. Sem failsafe gravado, a pressão é reconhecida mas nada é transmitido. |

O failsafe OFF fica na NVS como **um único registro versionado** (cabeçalho com magia, versão, quantidade de pulsos, portadora, id do protocolo e CRC32, seguido do RAW), gravado em uma única operação: uma queda de energia durante a atualização deixa o registro anterior ou o novo, nunca metadados de um com o RAW do outro, e um registro com CRC inválido é ignorado até o servidor reenviar. Placas com o formato anterior (quatro chaves separadas) migram sozinhas no primeiro boot do firmware 4.2.0. A duração total de qualquer RAW (failsafe ou `send_raw`) é limitada a 2 s; o servidor aplica o mesmo limite ao salvar protocolos.

O disparo local também grava uma **trava** na NVS: até um comando explícito do servidor (`send_known_state` ou `send_raw`) chegar, a placa continua reportando `ligado=false` e `failsafeLatched=true` mesmo depois de reiniciar, e o servidor **não** reenvia o estado "ligado" que ainda guardava ao reconectá-la — ele adota o desligamento local (registrado como `failsafe_off_local` de origem `esp32_local`, com valor `mantido_na_reconexao`) e avisa os painéis. O cartão do dispositivo em `Firmware / OTA` mostra "OFF local em vigor até o próximo comando". Qualquer comando de controle limpa a trava, então a placa nunca fica presa nesse estado. Firmware anterior (4.1.0) não reporta a trava e continua recebendo o estado do servidor logo após se apresentar, como antes. Durante um download de OTA o botão e o buzzer continuam sendo atendidos a cada bloco recebido.

O estado reaplicado na reconexão vai marcado como `restauracao: true`. A partir do firmware **4.3.0** a placa não trata essa restauração como comando explícito: se estiver travada em OFF local, ignora-a, não limpa a trava e responde com `failsafe_status`, que o servidor adota como desligamento local (`adotado_em_operacao`) — mesmo quando o `info` chega depois da espera de 3 s. No servidor, uma sincronização por tempo esgotado só ocorre depois de processar qualquer `info` já recebido no socket, para que uma pausa longa do event loop não a antecipe. O firmware 4.2.0 não distingue a restauração de um comando: nele, um `info` que chegue depois da espera de 3 s ainda recebe o estado guardado; atualize a frota por OTA para fechar essa janela.

**Presença, canal de comandos, estado desejado, envio e confirmação são coisas distintas.** `online` no status de uma sala é **presença**: a placa foi vista há pouco, pelo WebSocket ou apenas pelo heartbeat HTTP (que o firmware usa enquanto o WebSocket está caído); ele não diz que a sala é controlável. `canalComandos` diz se há um socket de comandos aberto para a sala — só por ele um comando chega à placa. `POST /comando` responde `ok: true` quando o estado desejado foi **persistido** (e `enviadoAoDispositivo` diz se a mensagem foi **submetida ao socket** da placa — não se ela a executou; a resposta repete `canalComandos` para dizer por que nada foi submetido). Uma sala `online` sem canal aparece no painel como "online, sem comandos", e um comando enviado nessa condição recebe um aviso de que **não foi entregue** — o estado fica salvo e é restaurado quando a placa reconectar. Cada mudança de intenção avança `salas.estadoVersao`, enviado como `versao` em todo `send_known_state`; o firmware 4.3.0 ecoa essa versão em `info`, `telemetria` e `failsafe_status`, e o `status` da sala (`dispositivoConfirmou`: `true`, `false` ou `null` sem placa/protocolo) diz se a placa conectada já **reportou** o estado vigente. Um relato da placa que ecoa uma versão anterior — ou, no firmware 4.2.0, cujo último comando IR relatado não bate com a intenção — é tratado como atrasado e nunca sobrescreve a intenção: o `ligado` reportado na telemetria e no heartbeat é apenas o eco do último comando processado, não é gravado como estado desejado. A trava reportada em operação só é adotada quando o relato comprovadamente reflete a intenção vigente (versão ecoada igual à atual ou, sem eco, depois que a mesma conexão confirmou a intenção). Um comando explícito enviado logo após a conexão, antes de o `info` inicial chegar, prevalece: esse `info` descreve a placa de antes do comando, não adota a trava, não apaga a intenção nova e dispensa a restauração. Os testes IR administrativos (`teste/estado`, `teste/raw` e transmitir um protocolo da biblioteca) não alteram a intenção nem a versão, mas invalidam a confirmação — o eco da versão anterior ao teste deixa de contar — até uma intenção nova ser enviada. Alterações de configuração que mudam o estado IR (limites globais de temperatura, função extra do turbo) e os limites por sala avançam a versão na mesma transação que ajusta o alvo, e nada é submetido à placa antes do commit. O painel mostra reticências no estado até a confirmação e avisa se ela passar de 12 s; nem a confirmação da placa prova que o ar-condicionado recebeu o sinal infravermelho. O agendador grava a execução de um agendamento na mesma transação da mudança de estado, então uma falha entre os dois nunca repete o comando no minuto seguinte.

Um **buzzer ativo** no **GPIO 27** soa a cada transmissão infravermelha (comando do servidor, teste, retransmissão ou failsafe): ele é ligado imediatamente antes do envio e desligado pelo `loop()` após um mínimo de 60 ms, sem nenhum `delay()` adicional antes do sinal.

### Detecção automática de ESP32 na rede

Todo ESP32 consulta o servidor com seu MAC após entrar na rede. Mesmo sem vínculo com uma sala, ele é registrado automaticamente como detectado. Em `Administração > Dispositivos > Cadastro`, a seção "ESP32 detectados na rede" lista esses dispositivos (MAC, IP, última vez visto) — os 100 vistos mais recentemente; uma placa ainda sem sala se reapresenta a cada 15 s, então está sempre entre eles — e permite vincular cada um a uma sala existente com um único clique. O dispositivo recebe a associação na próxima consulta, sem reconfiguração ou reinicialização. Um seletor de planta baixa com zoom e um campo de busca ajudam a localizar a sala.

Assim que o servidor grava o vínculo, ele avisa pelo próprio WebSocket todas as sessões administrativas conectadas: o cadastro passa a constar imediatamente em `Administração > Dispositivos > Cadastro` — inclusive em uma segunda sessão autorizada aberta ao mesmo tempo — **sem recarregar a página nem reabrir a aba**. Um cadastro que o servidor recusa não aparece. Cadastrado e online continuam sendo estados distintos: cada sala mostra um selo de cadastro e outro de conexão, e um ESP32 recém-cadastrado costuma aparecer offline até estabelecer sua própria conexão.

## Acessibilidade

O frontend inclui um widget de acessibilidade (botão flutuante, disponível em todas as telas) com ajustes persistidos no navegador (`localStorage`) entre sessões: escala de fonte, tipo de fonte (incluindo uma fonte voltada para leitores com dislexia), espaçamento entre letras, altura de linha, largura máxima de parágrafo, alinhamento de texto, cor de fonte e de texto, destaque de links, alto contraste e opção de ocultar imagens.

Os ícones da interface vêm de um sprite SVG único (`index.html`) e são pintados por `currentColor`, sem emoji, fonte de ícones ou biblioteca externa. A cor de cada glifo diz a **função** do ícone, não o decora: verde para operação (salas, controles, mapas, saúde), azul para informação e referência (ajuda, manual, aplicativo), âmbar para agenda, alertas e manutenção, vermelho para problemas e ações críticas, roxo para gestão, sistema e configuração, e azul-petróleo para os dispositivos ESP32 (cadastro, firmware, IR). As classes `tom-*` e as variáveis `--icone-*` de `css/style.css` são o único ponto de ajuste; o alto contraste troca a paleta por tons claros, exceto nas superfícies que continuam claras (opções do portal e selos das dicas de login). Ficam fora do sistema de tons os ícones da barra superior (na cor do texto sobre o verde, `--texto-sobre-destaque`: branca no tema claro, preta no alto contraste), os selos de estado (`ui-status.js`, que já carregam semântica própria) e os glifos sobre fundos coloridos de estado, como o botão Power e os blocos do assistente simples. `e2e/specs/icons-audit.spec.js` verifica o contraste de cada glifo colorido nos dois modos.

## Ajuda e Manual no App

O ícone **?** ao lado do título de cada tela abre uma ajuda curta daquela página, com um atalho para a seção correspondente do manual. O botão **Precisa de ajuda?** (canto inferior) abre um menu rápido com a ajuda da página atual, o **manual completo do RemoteIFES**, a solução de problemas, o envio de relato e a página do aplicativo móvel. O menu da conta (avatar com iniciais) traz apenas ações de conta — **Aplicativo móvel** e **Sair**; ajuda e manual ficam exclusivamente na interface de ajuda dedicada. O manual é uma página de documentação dedicada, com sumário por assunto, busca, fluxos ilustrados e links "Ver no app"; reabrir o manual sempre parte do sumário completo com a busca limpa, e um tópico aberto por link ou ajuda contextual fica marcado no sumário. A documentação comum fica no app-shell e funciona offline. Conteúdo administrativo é entregue por `/documentation` somente após validar a sessão no servidor: administrador recebe apenas operação administrativa e superadministrador recebe também ESP32, OTA, credenciais, monitoramento, backup, implantação e manutenção. A resposta usa `private, no-store`; esses textos não ficam nos assets públicos nem no cache compartilhado da PWA/Cordova.

A divisão entre os dois documentos é deliberada: este README é a referência de instalação, arquitetura, implantação e desenvolvimento; a **Ajuda no app** é o guia operacional de uso, escrito por papel e verificado contra a interface real. Procedimentos de terminal e infraestrutura aparecem na Ajuda apenas para o superadministrador, e sem repetir o conteúdo detalhado daqui.

## Requisitos

### Software

- Navegador ou WebView com Chromium 108+, Safari 15.4+ (iOS 15.4+) ou Firefox 121+ para o frontend (site, PWA e aplicativo Cordova); abaixo disso a página mostra **Navegador desatualizado** em vez de carregar — veja [Cordova (Android/iOS)](#cordova-androidios)
- Node.js 22.13 ou superior (usa o módulo `node:sqlite` nativo, ainda experimental) — em Linux (incluindo Raspberry Pi OS), `remoteifes-server/setup.sh` instala automaticamente a versão correta caso não esteja presente, sem depender do pacote do sistema
- [PlatformIO](https://platformio.org/) (Core CLI ou a extensão para VS Code), com a plataforma `espressif32`, para compilar e gravar o firmware — `remoteifes-esp32/flash.sh` automatiza a instalação do PlatformIO Core (prefere `pipx`, com fallback para `pip --user`) e chama `pio run` para compilar, gravar o sistema de arquivos `data/` (LittleFS) e o firmware
- Bibliotecas (resolvidas automaticamente pelo PlatformIO a partir de `remoteifes-esp32/platformio.ini`, sem instalação manual, com as versões fixadas nas que foram testadas: plataforma `espressif32@7.0.1`, [IRremoteESP8266](https://github.com/crankyoldgit/IRremoteESP8266) 2.9.0 (inclui os módulos `IRrecv`, `IRsend`, `IRutils` e `IRac`), `WebSockets` (Links2004) 2.7.3, `ArduinoJson` 7.4.3, `DHT sensor library` 1.4.7 e `Adafruit Unified Sensor` 1.1.15; o servidor só aceita atribuir a uma sala os identificadores numéricos de protocolo que o `IRac` dessa versão sabe transmitir, e uma captura reconhecida pela placa com um identificador fora dessa lista é guardada como sinal RAW genérico) — `Preferences`/`DNSServer`/LittleFS já vêm inclusas no core ESP32 do PlatformIO

### Hardware

- Um servidor para rodar `remoteifes-server`, acessível pela rede do IFES e pelos ESP32 — de uma VM a um **Raspberry Pi** (3, 4, 5 ou Zero 2 W); como o `node:sqlite` é nativo do próprio Node.js, não há compilação de dependências nem ferramentas extras a instalar no Pi, veja [Hospedagem em Raspberry Pi](#hospedagem-em-raspberry-pi)
- Um ESP32 com emissor infravermelho (GPIO 4) por sala (ou por par de salas adjacentes, quando um único equipamento cobre as duas), um switch momentâneo no GPIO 26, um buzzer ativo no GPIO 27 e um sensor DHT opcional (GPIO 14) para leitura de temperatura
- Uma única placa adicional (ou uma das placas de sala) com **receptor infravermelho no GPIO 15**, definida como clonador oficial em `Administração > Dispositivos > Protocolos IR`

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

O que `npm run setup` faz (e a alternativa manual no Windows) está em [Instalação Rápida](#instalação-rápida). Banco e migrações são aplicados automaticamente no primeiro startup; não há comando separado de migração. `npm start` e `npm run dev` são alternativas, não uma sequência: não deixe os dois rodando sobre o mesmo banco.

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

Apagar toda a flash é uma operação **à parte e destrutiva** — remove Wi-Fi, servidor, credencial do dispositivo e failsafe gravados na NVS, e a placa volta ao `RemoteIFES-Setup`. Só a use de propósito, com os dados de reprovisionamento em mãos, antes da sequência acima:

```bash
cd remoteifes-esp32
pio run --target erase        # apaga completamente a flash (NVS inclusive); depois grave firmware e data/ de novo
```

Ou abra a pasta `remoteifes-esp32/` no VS Code com a extensão PlatformIO instalada e use os alvos equivalentes na barra de tarefas do PlatformIO (Build, Upload Filesystem Image, Upload, Monitor).

`pio device monitor -b 115200` abre o monitor serial na mesma taxa configurada pelo firmware (`Serial.begin(115200)`), útil para acompanhar o boot, o IP obtido, o estado da conexão Wi-Fi/WebSocket com o servidor e mensagens de erro em tempo real. Se houver mais de uma porta serial conectada, informe-a explicitamente: `pio device monitor -b 115200 -p /dev/ttyUSB0` (Linux/Raspberry Pi) ou `pio device monitor -b 115200 -p /dev/cu.usbserial-XXXX` (macOS). Rode `pio device list` para listar as portas disponíveis.

**Em ambos os casos**, o mesmo firmware serve para qualquer sala e para o clonador: nenhum dado é fixado em tempo de compilação. Sem configuração válida, o ESP32 sobe o ponto de acesso `RemoteIFES-Setup` e serve o portal em `192.168.4.1` para receber as credenciais da rede, o endereço do servidor central e, se já provisionada, a credencial exclusiva do dispositivo. Depois de salvar, ele reinicia em modo STA, encerra o AP e o portal local e passa a ser administrado pelo servidor, que detecta o MAC para o superadministrador vinculá-lo à sala em `Administração > Dispositivos > Cadastro`. Em falhas de Wi-Fi, o firmware tenta reconectar a cada 30 segundos sem bloquear o restante da operação; para reprovisionar uma placa já configurada, use **Resetar Wi-Fi** no painel ou um clique curto no switch físico, que reabre o portal por dez minutos sem derrubar a operação.

A versão do firmware é definida por `-DFW_VERSAO` em `platformio.ini` (atualmente `4.3.0`) e é reportada ao servidor na telemetria e no heartbeat. A partição do ESP32 usa o layout `min_spiffs.csv` (dois slots de aplicação de ~1,9 MB — o firmware atual ocupa ~64% de um slot), o que reserva um slot ocioso para a [atualização por OTA](#atualização-de-firmware-por-ota-esp32) com reversão automática. **A gravação por USB (`flash.sh` / `pio run --target upload`) continua sendo o caminho de recuperação**: ela regrava o slot ativo e não depende do estado do OTA.

## Configuração

### Servidor (`remoteifes-server/.env`)

| Variável | Descrição |
|---|---|
| `NODE_ENV` | `development` ou `production`. Em produção, ativa a restrição de rede, o CORS restrito e o serviço do frontend pelo próprio servidor |
| `PORTA` | Porta HTTP (e WebSocket, no mesmo servidor) do servidor (padrão 8080) |
| `SERVIR_FRONTEND` | Servir o `remoteifes-web` pelo próprio servidor, na mesma origem da API (operação same-origin). Padrão: ligado em desenvolvimento e produção. Desative apenas no desenvolvimento intencional do frontend em outra origem. Com o frontend servido assim, `CORS_ORIGIN` deixa de ser necessário |
| `FRONTEND_DIR` | Caminho da pasta do frontend a servir (padrão: `../remoteifes-web` relativo ao projeto do servidor) |
| `REMOTEIFES_DATA_DIR` | Diretório dos dados persistentes (banco, backups, imagem de firmware para OTA, versões e log de deploy). Padrão: `data/` dentro do projeto do servidor; `deploy.sh`, `rollback.sh` e `install-service.sh` resolvem o valor pelo mesmo `src/config/paths.js` do servidor. Aponte para fora do checkout do Git (ex.: `/var/lib/remoteifes`) para que atualizações de código nunca toquem nos dados. `REMOTEIFES_DB_PATH`, `BACKUP_DIR` e `REMOTEIFES_FIRMWARE_DIR` continuam disponíveis para sobrescrever caminhos individuais |
| `CORS_ORIGIN` | Lista de origens permitidas, separadas por vírgula, quando `NODE_ENV=production` — necessária **apenas** quando o frontend é servido de outra origem (ex.: GitHub Pages). Vale tanto para a API HTTP quanto para as conexões WebSocket |
| `SENHA_ADMIN_INICIAL` | Opcional; define a senha do usuário `superadmin` criado no primeiro boot. Quando vazia, usa `admin` e mostra ao superadministrador um aviso persistente para alterá-la |
| `TRUST_PROXY` | Quantos "saltos" de proxy reverso confiar ao ler o IP real do cliente (cabeçalho `X-Forwarded-For`); **padrão `0`** (não confia em nenhum proxy). O `https-setup.sh` e o `lan-setup.sh` alteram este valor para `1` ao configurar o Nginx, que é o valor correto quando há exatamente um proxy reverso na frente. Só use um valor maior que `0` quando existir de fato um proxy confiável imediatamente à frente do servidor — confiar em saltos que não existem permite que um cliente falsifique o IP de origem via `X-Forwarded-For` e contorne o limite de tentativas de login e a restrição de rede |
| `RETENCAO_DIAS_LOGS` / `RETENCAO_DIAS_SESSOES` / `RETENCAO_DIAS_EXECUCOES` / `RETENCAO_DIAS_DETECCOES` | Opcionais. Dias de retenção das tabelas de histórico antes da limpeza automática (padrões: 180 / 90 / 90 / 30). Veja [Manutenção automática do banco](#manutenção-automática-do-banco) |
| `RETENCAO_DIAS_NOTIFICACOES` / `RETENCAO_DIAS_AGENDAMENTOS` | Opcionais. Dias até descartar qualquer notificação (mesmo não lida) e até apagar agendamentos com data já passada e suas execuções (padrões: 365 / 90) |
| `RETENCAO_DIAS_RELATOS_RESOLVIDOS` | Opcional. **Desligado por padrão (`0`).** Quando recebe um número de dias, a rotina apaga relatos **já resolvidos** mais antigos que esse prazo; relatos não resolvidos nunca são tocados |
| `AGENDAMENTOS_MAX_ATIVOS_POR_USUARIO` | Opcional. Teto de agendamentos ativos por usuário (padrão `300`); evita que um único autor infle a varredura do agendador |
| `BACKUP_AUTOMATICO` / `BACKUP_INTERVALO_HORAS` / `BACKUP_RETENCAO` / `BACKUP_DIR` | Opcionais. Backup periódico do banco SQLite (em produção, ligado por padrão). Veja [Backup e restauração do banco](#backup-e-restauração-do-banco) |

Para a operação de produção local (na rede da instituição), veja [Deploy](#deploy): o servidor entrega o frontend na mesma origem e um proxy reverso HTTP (`lan-setup.sh`) basta. HTTPS com domínio próprio (`https-setup.sh`) é necessário apenas para expor o sistema fora da rede local ou para o PWA/Cordova em domínio público, já que os aparelhos móveis exigem conteúdo servido por HTTPS.

### Configurações globais (banco de dados, via `Administração > Sistema > Configurações`)

Estas configurações são armazenadas no banco (tabela `configuracoes`). A aba **Configurações** só é visível e acessível ao superadministrador — nenhum outro administrador pode ver ou alterar esses valores.

| Configuração | Padrão | Descrição |
|---|---|---|
| Limite de temperatura | 23 °C a 25 °C | Intervalo permitido para qualquer comando de temperatura, manual ou agendado (aceita de 16 a 30 °C) |
| Função adicional do Turbo | nenhuma | Opcionalmente ativa também a oscilação vertical enquanto o Turbo estiver ligado |
| Desligamento diário automático | **desativado** | Horário diário (Brasília) e escopo (todas as salas ou salas selecionadas) em que o servidor desliga uma vez os aparelhos ainda ligados; religar depois do horário vale até o dia seguinte (veja [Desligamento Diário Automático](#desligamento-diário-automático)) |
| Auto-ON | **ativado** | Ajustar a temperatura ou ativar o Turbo em um aparelho desligado o liga e aplica o ajuste. Desativado, a temperatura alvo é apenas guardada e o Turbo só pode ser alterado com o aparelho ligado. Desativar o Turbo nunca liga o aparelho. O valor é gravado no banco e sobrevive a reinícios e atualizações; instalações existentes que ainda não têm a chave assumem o padrão ativado (veja [Limites de Temperatura e Turbo](#limites-de-temperatura-e-turbo)) |
| Modo de teste | desativado em produção nova | Quando ativo, desliga a restrição de rede do IFES em produção, permitindo acessar o sistema de qualquer rede para fins de teste; deve permanecer desativado na operação definitiva. **Somente leitura no site**: altere no Console de Operações ou pelo terminal (veja [Restrição de Rede](#restrição-de-rede)) |
| Redes autorizadas | vazia | Lista de faixas de IP em CIDR (ex.: `10.0.0.0/8`) liberadas quando o modo de teste está desativado. **Somente leitura no site**: altere no Console de Operações ou com `npm run redes` |
| Tempo de inatividade de usuários | 60 minutos | Limite de inatividade aplicado pelo servidor a usuários normais |
| Tempo de inatividade administrativo | 720 minutos | Limite de inatividade aplicado a administradores e superadministrador |
| Aviso de logout automático | 60 segundos | Duração da contagem regressiva exibida antes do logout por inatividade |
| Limiar de presença online | 5 minutos | Minutos sem uso após os quais um usuário com sessão aberta passa de "online" para "inativo" na aba Ativos |
| Exigir senha na rede de configuração dos ESP32 | **desativado** | Controla apenas a rede Wi-Fi local `RemoteIFES-Setup` **enquanto o ponto de acesso de configuração estiver ativo** (placa sem configuração, após Resetar Wi-Fi ou após o clique no switch); em operação normal o AP fica desligado. Desativado, a rede de configuração é aberta; ativado, passa a exigir a senha padrão do firmware (`remoteifes`). A mudança é propagada pelo WebSocket aos ESP32 conectados e aplicada quando o portal voltar a ser aberto. **Não tem relação com a autenticação do ESP32 no servidor**, que é a opção seguinte. |
| Exigir credencial por dispositivo em todos os ESP32 | ativado em instalações normais novas | Nenhum ESP32 se conecta apenas pelo MAC enquanto esta opção estiver ativa — toda sala precisa de uma credencial provisionada. Para um controlador novo, provisione a credencial da sala no painel e informe `deviceId` e segredo junto com o Wi-Fi no portal `RemoteIFES-Setup`; em uma migração de controladores antigos, siga o fluxo gradual da seção [Credenciais por Dispositivo e Migração](#credenciais-por-dispositivo-e-migração). O ambiente automatizado de testes começa com a opção desativada para exercitar também o modo legado. |

### ESP32 por MAC e limites por sala (via `Administração > Dispositivos > Cadastro`)

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

As rotas `/dispositivo/*` (usadas pelos ESP32) e o acesso por `localhost` (útil para um túnel SSH) nunca dependem dessa lista. Com o Console de Operações instalado, o mesmo cadastro é feito em `Rede e domínio › Acesso à aplicação`. Alternativamente, para uma rede local isolada e confiável, o modo de teste pode ser deixado ligado nessa mesma tela, mas o cadastro das faixas é a opção recomendada.

### Proxy reverso na porta 80 (rede local, sem Internet)

Use o comando da referência canônica em [Proxy reverso](#proxy-reverso). `lan-setup.sh` coloca o Nginx na frente do servidor na porta 80, sem Certbot nem DNS.

Ele cria um site Nginx que encaminha tudo (inclusive `Upgrade`/`Connection` para `/ws` e `/ws/dispositivo`) para `127.0.0.1:<PORTA>`, grava `TRUST_PROXY=1` e `BIND_ADDR=127.0.0.1` no `.env` (assim o Node passa a escutar **só em localhost**, atrás do proxy — impede que alguém alcance a `PORTA` diretamente e falsifique `X-Forwarded-For`) e passa a atender em `http://<ip-do-servidor>/`. O Nginx precisa já estar instalado (ou o script o instala via `apt`, quando disponível). O script assume um host dedicado ao RemoteIFES (assume o site padrão do Nginx na porta 80).

### HTTPS com domínio próprio (opcional)

Quando houver um domínio público e acesso à Internet, use o comando canônico de [Proxy reverso](#proxy-reverso). `remoteifes-server/https-setup.sh` configura o proxy e emite um certificado Let's Encrypt com Certbot.

O script instala Nginx e Certbot se necessário, cria um site apontando para `127.0.0.1:<PORTA>`, emite o certificado, ativa a renovação automática (`certbot.timer`) e ajusta `TRUST_PROXY=1` e `BIND_ADDR=127.0.0.1` no `.env`. É o caminho para expor o sistema fora da rede local e para PWA/HTTPS em domínio próprio; a operação local não precisa dele.

### Atualização, versões e reversão

A atualização de rotina é feita pelo **[Console de Operações](#console-de-operações) › Atualizações**, no próprio host. O GitHub continua sendo a origem do código, mas a atualização não depende de Actions nem do GitHub Pages. Os comandos equivalentes de terminal estão em [Recuperação de emergência por terminal](#recuperação-de-emergência-por-terminal) e continuam válidos quando o console não estiver disponível.

O console mostra, separadamente, cinco coisas que um único "número de versão" esconde: o **commit do processo em execução** (lido do `/health`, não do disco), o **HEAD do checkout** e se há alterações locais, o **ramo e o upstream**, o **último `origin/main` observado** com a hora da observação, e a **última implantação verificada** registrada em `deploy.log`.

O que a implantação garante, seja acionada pelo console ou pelo terminal — os dois usam os mesmos `deploy.sh` / `rollback.sh` e a mesma trava `.deploy-lock`:

- recusa prosseguir se houver alterações locais não commitadas; o console **nunca** usa `--force`;
- resolve o diretório de dados e o caminho do banco com o mesmo `src/config/paths.js` que o servidor usa;
- **cria um backup verificado do banco** (`pre-update`) antes de mexer no código;
- aplica o código e roda `npm ci --omit=dev` **apenas se `package.json` ou `package-lock.json` mudaram**; se o `npm ci` falhar, a atualização é considerada inválida e revertida, mesmo havendo um `node_modules` antigo ou parcial;
- reinicia o serviço e exige que o `/health` fique saudável **e informe, em `commit`, exatamente o commit implantado**. Um `/health` saudável de um processo antigo que sobreviveu a um `systemctl restart` que falhou não conta como sucesso;
- **se isso não acontecer em 40 s, reverte sozinho** para a versão anterior, reinstala as dependências dela e exige a mesma confirmação;
- grava `previous-version` e `current-version` em `<REMOTEIFES_DATA_DIR>` e registra a operação, com sucesso ou falha, em `deploy.log`.

A verificação é a mesma nos dois scripts (`verificar-versao.sh`). Uma versão alvo **anterior ao campo `commit`** do `/health` (a árvore dela não tem `src/config/release.js`) não consegue confirmar a própria identidade: ela só é aceita quando o `/health` saudável mostra, em `uptimeSegundos`, um processo que subiu **depois** do `systemctl restart` — um processo antigo sem identidade que sobreviveu a um reinício falho tem tempo de vida maior que o decorrido e é recusado —, e o registro em `deploy.log` diz explicitamente `identidade não confirmada`. Um processo que não informa o commit nunca é aceito como uma versão alvo que o informaria. **HEAD igual ao alvo não é conclusão**: se o código já está na versão pedida (atualização interrompida, `git pull` manual, `--no-restart` anterior), o processo em execução é consultado antes de responder "nada a fazer".

A interrupção é curta, mas existe: **as sessões dos usuários são encerradas** (o servidor encerra as sessões ativas na partida) e os ESP32 precisam reconectar. Não é implantação sem indisponibilidade.

Reverter troca **apenas o código**. Se a atualização revertida alterou o esquema do banco (as migrações em `src/db/schema.js` podem adicionar **e remover** colunas e tabelas), a versão anterior pode não funcionar com o banco já migrado — nesse caso, restaurar o backup `pre-update` é uma **decisão separada e explícita**, nunca automática. É por isso que a atualização sempre grava esse backup antes de mexer no código.

Marcar uma versão continua sendo trabalho da máquina de desenvolvimento, não do host de produção: é autoria de versão, não implantação.

```bash
cd remoteifes-server
bash release.sh 3.1.0        # ajusta a versão no package.json, cria o commit e a tag v3.1.0, e (com confirmação) faz o push
```

### Recuperação e verificação de saúde

- **`GET /health`** — estado do servidor central (banco, tempo de processo e o commit que o processo carregou), sem autenticação. `200` com `{"ok":true,...}` quando o banco responde, `503` quando não. O campo `commit` é lido do `.git` uma única vez ao iniciar o processo (`src/config/release.js`), por isso identifica o código realmente em execução mesmo depois de o checkout ter sido trocado por um deploy; é `null` quando o repositório não está disponível. **Não depende de nenhum ESP32**: um dispositivo offline não afeta o resultado. Verifique pela linha de comando com `npm run health` (checa `127.0.0.1:<PORTA>/health`).
- **Reinício após queda** — o `remoteifes.service` tem `Restart=always`; o watchdog `remoteifes-health.timer` roda `health-watchdog.sh` (como o usuário do serviço) a cada 2 minutos e, após 3 falhas seguidas do `/health` (processo vivo mas travado), aciona o `remoteifes-recover.service`, uma unidade `root` cujo único comando é `systemctl restart remoteifes.service`. Nenhum script do checkout roda como root.
- **Reinício após reboot do host** — `install-service.sh` habilita o serviço (`systemctl enable`), que sobe sozinho no boot. Mantenha o `REMOTEIFES_DATA_DIR` em disco persistente.
- **Restauração do banco** — `npm run restore` lista os backups de `<REMOTEIFES_DATA_DIR>/backups/` e restaura um deles, criando antes uma cópia de segurança verificada do banco atual. Veja [Backup e restauração do banco](#backup-e-restauração-do-banco).

## Console de Operações

O **Console de Operações** (`remoteifes-console/`) é um serviço local, separado do RemoteIFES, para manutenção do servidor, do host e da infraestrutura. A operação do prédio — salas, agendamentos, contas, ESP32, protocolos IR e configurações da aplicação — continua **no próprio RemoteIFES**; o console resume a saúde dessas áreas e leva até elas, sem duplicar seus editores. A exceção é a política de acesso de rede (modo de teste e faixas autorizadas): ela decide quem alcança o site, então é editada só aqui e no terminal do servidor (veja [Restrição de Rede](#restrição-de-rede)).

### Por que é um serviço separado

A aplicação encerra todas as sessões a cada reinício, a autenticação dela vive no SQLite e o banco pode ser justamente o que quebrou. Uma ferramenta de recuperação embutida na aplicação não estaria disponível quando fosse necessária. Além disso, administrar a aplicação **não pode** conceder acesso irrestrito ao host.

No Linux o console é ativado por socket do systemd: enquanto ninguém o usa, **nenhum processo dele fica residente** — o systemd apenas mantém a porta. Na primeira conexão o serviço sobe e, depois de `CONSOLE_OCIOSIDADE_S` (padrão 900 s) sem uso, ele sai sozinho. Num Raspberry Pi 3 de 1 GiB, isso troca RAM ociosa permanente por uma partida de processo na primeira requisição. No Windows e no macOS não há socket de sistema equivalente, e o modelo é o mesmo por outro caminho: o lançador sobe o console sob demanda e o processo sai sozinho ao ficar ocioso.

### Sistemas e arquiteturas suportados

| Sistema | Arquitetura | Controle do serviço da aplicação | Partida em segundo plano | Registros do sistema |
|---|---|---|---|---|
| Linux com systemd (Raspberry Pi OS, Debian, Ubuntu) | arm64, armv7, x64 | `systemctl` pelo auxiliar privilegiado | socket do systemd | `journalctl` |
| Linux sem systemd | arm64, armv7, x64 | **não aplicável**, com o motivo exibido | lançador sob demanda | não aplicável |
| Windows 10/11, Server 2019+ | x64, arm64 | SCM, quando o serviço `RemoteIFES` existir | lançador sob demanda (+ tarefa `ONLOGON` opcional) | `Get-WinEvent` |
| macOS 12+ | arm64, x64 | `launchctl`, quando o agente existir | `LaunchAgent` com `RunAtLoad=false` | `log show` |

Onde uma capacidade não existe, o console diz **por quê** — "não instalado", "sem permissão", "indisponível", "não se aplica" e "não suportado aqui" são estados distintos, visíveis na aba **Programa**, e o servidor recusa a operação de verdade: botão desabilitado não é controle de acesso.

A arquitetura não é decidida por `uname -m`. Um Raspberry Pi 3 pode ter hardware e kernel de 64 bits com **userland de 32 bits**; quem decide o artefato é `process.arch`, a arquitetura do runtime que de fato vai executar. O console classifica hardware, kernel, userland e runtime separadamente e mostra os quatro. Um Pi 3 com sistema de 32 bits (armv7/armhf) segue suportado enquanto o **Node 22** tiver suporte — fim em **2027-04-30**; depois disso a recomendação é migrar o Pi para um sistema de 64 bits, e o console exibe esse horizonte em vez de deixar a surpresa para a atualização que quebrar.

O programa instalado fica **fora do checkout** — `deploy.sh` e `rollback.sh` trocam o checkout inteiro, e um rollback para uma revisão anterior ao console apagaria o diretório de onde ele estaria rodando. O layout é o mesmo nos três sistemas:

```
<raiz>/console-bootstrap.js      camada estável (o pacote é dono dela; nenhuma atualização a reescreve)
<raiz>/estado-instalacao.json    ponteiro da versão ativa
<raiz>/versoes/<versao>/         payload imutável
```

| Sistema | Programa | Estado |
|---|---|---|
| Linux (sistema) | `/opt/remoteifes-console` | `/var/lib/remoteifes-console` |
| Linux (usuário) | `~/.local/share/remoteifes-console` | `~/.local/state/remoteifes-console` |
| Windows (usuário) | `%LOCALAPPDATA%\Programs\RemoteIFES Console` | `%APPDATA%\RemoteIFES Console` |
| macOS (usuário) | `~/Applications/RemoteIFES Console.app/Contents/Resources` | `~/Library/Application Support/RemoteIFES Console` |

### Instalar

O instalador é o mesmo nos três sistemas e **não** exige compilador, SDK nem pacote npm global — só o Node 22.13+ que o RemoteIFES já requer.

```bash
cd remoteifes-console
sudo node instalacao/instalar.js --escopo sistema     # Linux com systemd
node instalacao/instalar.js                           # macOS, ou Linux por usuário
```

```powershell
# Windows, na pasta descompactada do .zip
.\instalar.ps1
```

No Linux com `--escopo sistema`, o instalador grava o auxiliar privilegiado como `root:root`, uma regra de `sudo` restrita a ele (validada com `visudo`) e as unidades `remoteifes-console.socket`/`.service`. Em qualquer sistema ele cria o atalho de aplicativo e gera um segredo de instalação de uso único, gravado em `bootstrap-token` no diretório de estado, legível só por quem administra o host.

**Pelo pacote `.deb`**, informe o checkout que o console administra na própria instalação; o pacote provisiona estado, segredo, unidades, auxiliar e regra de sudo pelo mesmo instalador, com o serviço rodando como o dono do checkout:

```bash
sudo CONSOLE_CHECKOUT_DIR=/home/pi/RemoteIFES apt install ./remoteifes-console_<versão>_all.deb
```

Sem o checkout, a instalação prepara estado e segredo e imprime o único comando que conclui o provisionamento. `apt remove` retira a integração e preserva operadores e auditoria; `apt purge` apaga também o estado.

**Primeiro operador.** Nenhum segredo precisa ser copiado à mão:

- **com interface gráfica**, abra o console pelo atalho do sistema, com a conta que administra o host: o lançador lê o segredo, troca-o por um convite de uso único válido por 10 minutos e abre o navegador direto no formulário de primeiro acesso. O convite chega por uma página privada (arquivo legível só por você), nunca por argumento de processo, e sai da barra de endereço e do histórico antes de ser usado;
- **sem interface gráfica** (Pi por SSH), crie o operador no próprio host — nome e senha são pedidos no terminal, nunca passados como argumento:

  ```bash
  sudo node /opt/remoteifes-console/launcher-bootstrap.js --criar-operador
  ```

- a tela de primeiro acesso ainda aceita o segredo digitado, lido de `bootstrap-token`.

Criado o operador, o segredo e qualquer convite pendente deixam de valer. Reparar ou reinstalar preserva os operadores existentes. A instalação manual (fora do pacote) ainda exibe o segredo uma vez no terminal.

Para remover: `node instalacao/desinstalar.js --simular` mostra exatamente o que sairia, sem chamar nada que mute; sem `--apagar-estado`, operadores, auditoria e histórico são preservados. A remoção encerra o console em execução antes de apagar o programa — e o que autoriza encerrar é a prova de identidade, não o PID, que é reciclado. Ela recusa qualquer caminho que não prove ser uma instalação do console, e nunca toca no checkout do RemoteIFES. Raiz, estado e escopo são inferidos da instalação, então o comando funciona sem argumentos.

### Acessar

Abra pelo atalho do sistema, ou pelo lançador:

```bash
node <raiz>/launcher-bootstrap.js            # abre o console no navegador padrão
node <raiz>/launcher-bootstrap.js --iniciar  # sobe o console e sai, sem abrir navegador
node <raiz>/launcher-bootstrap.js --status   # estado do console, da aplicação e da versão do programa
```

`--iniciar` é o que serve um host sem interface gráfica, e é o caminho que a CI exercita para
provar que o lançador instalado sobe o **console** — não outra cópia de si mesmo.

Antes de abrir o navegador, o lançador **confere a identidade** de quem responde na porta esperada: envia um desafio e exige a resposta HMAC derivada do segredo que só o console em execução conhece. Se outro processo tiver tomado a porta, o navegador não é aberto. Nenhuma credencial reutilizável viaja em URL, argumento de processo ou atalho.

Num host **sem interface gráfica** — o caso normal de um Raspberry Pi — não há navegador para abrir, e nada disso é necessário: o socket do systemd já sobe o console na primeira conexão, então basta o túnel SSH acima. O primeiro operador é criado no próprio host com `--criar-operador` (veja [Instalar](#instalar)); o segredo de instalação fica em `bootstrap-token` no diretório de estado.

O console escuta apenas em `127.0.0.1`. De outra máquina, use um túnel SSH — o `localhost` do seu computador **não** é o do Pi:

```bash
ssh -L 8099:127.0.0.1:8099 <usuario>@<host-do-pi>
```

e então abra `http://127.0.0.1:8099` no seu navegador.

### Atualizar o programa

A versão do **console** é independente do commit do RemoteIFES implantado. Atualizar o console baixa um artefato de release, confere a **assinatura Ed25519** do manifesto e o SHA-256 do artefato, instala a versão nova ao lado da atual e troca o ponteiro; reverter é trocar o ponteiro de volta, **sem rede**. Não usa `git`, não copia o checkout e não consome o `origin/main` da aplicação. Enquanto nenhuma chave pública de publicação estiver provisionada, o console diz isso na aba **Programa** e recusa qualquer release — atualizar passa a ser reinstalar o pacote.

**Versão nova que falha depois de subir.** Uma versão que nem carrega é descartada na hora: a camada estável cai para a anterior. Uma versão que carrega e depois cai (por exemplo, ao atender a primeira requisição) fica **em observação** até confirmar que se manteve no ar por 20 s; se ela iniciar **duas vezes** sem confirmar, a terceira partida volta sozinha para a versão anterior e a aba **Programa** mostra "Atualização revertida automaticamente". O limite é deliberado e não é uma ativação em duas fases: uma versão saudável interrompida duas vezes antes de confirmar (reinícios seguidos do host) também seria revertida, e depois da confirmação uma falha é relatada, não revertida. A contagem vive na camada estável, que a autoatualização não reescreve: instalações anteriores passam a tê-la ao reinstalar ou atualizar o pacote.

**Estado da assinatura, sem rodeios:** o caminho de verificação está implementado e é fechado por padrão, mas **não há credencial de publicação neste repositório** — nenhuma chave privada Ed25519, nenhum certificado de assinatura de código do Windows, nenhuma conta de desenvolvedor Apple para notarização. Os artefatos que a CI constrói são de desenvolvimento e validação: eles se declaram `assinado: false` em `proveniencia.json`, e um passo da própria CI falha se essa declaração for outra. Para publicar releases de produção é preciso gerar o par de chaves com `node empacotar/assinar-manifesto.js --gerar-chave <dir>`, guardar a privada fora do repositório, embutir a pública em `src/release.js` (ou provisioná-la por `CONSOLE_CHAVE_RELEASE`) e assinar o manifesto numa etapa credenciada, separada do build e inacessível a código de pull request. Enquanto isso não for feito, o console **recusa** qualquer release em vez de aceitar artefatos não assinados.

Os detalhes de empacotamento, assinatura e matriz de sistemas estão em [`remoteifes-console/DISTRIBUICAO.md`](remoteifes-console/DISTRIBUICAO.md).

### O que o console faz

| Área | Operações |
|---|---|
| **Visão geral** | estado da aplicação, do serviço, do watchdog e do host, com o que exige atenção em primeiro lugar |
| **Serviço** | reiniciar, parar (desligando o watchdog junto) e iniciar o RemoteIFES; ler o journal das unidades |
| **Atualizações** | comparar versão em execução, checkout e `origin`; implantar um commit revisado; reverter |
| **Dados e recuperação** | backup verificado, restauração com o serviço parado e senha do superadministrador |
| **Aplicativo e CI** | versões de servidor, PWA, Cordova e Android, APK publicado e execuções do GitHub Actions |
| **Rede e domínio** | acesso à aplicação (modo de teste e faixas autorizadas, único editor desses valores); interfaces, rotas, resolvedor, portas em escuta, proxy, DNS e validade do certificado |
| **Programa** | versão do próprio console, atualização e reversão do programa, capacidades da plataforma com o motivo de cada indisponibilidade, e onde a instalação mora |
| **Avançado** | elevação, auditoria do console, histórico de operações e Terminal Expert |

Antes de qualquer operação que interrompa o serviço, o console avalia o impacto: bloqueia quando há **OTA em andamento** (todas as fases ativas, inclusive `validando`), rollout ativo, outra manutenção em curso ou disco insuficiente; e avisa, em vez de assumir zero, quando a atividade dos ESP32 **não pode ser observada**. A avaliação é refeita no instante da execução.

Operações longas não dependem do navegador nem do próprio processo do console: cada uma roda sob um **supervisor** próprio, em grupo de processos separado, que guarda a saída em arquivo, aplica o prazo máximo da operação, mantém a trava de manutenção em seu nome e grava o desfecho (código de saída) ao terminar. Se o console cair, sair por ociosidade, for atualizado ou reiniciado no meio de uma restauração ou implantação, a operação continua (a unidade do systemd usa `KillMode=process`); o console seguinte acompanha o supervisor ainda vivo até o fim ou lê o desfecho gravado. Uma operação que terminou sem ninguém acompanhando aparece com o código de saída real e com o aviso de que **o efeito não foi verificado automaticamente**. Só um trabalho cujo supervisor desapareceu sem gravar desfecho fica registrado como **desfecho desconhecido** — nunca como sucesso presumido.

### Modelo de segurança do console

- **Identidade própria**, com senha `scrypt` guardada em `/var/lib/remoteifes-console/operadores.json`. Nunca reutiliza `SENHA_ADMIN_INICIAL` nem `superadmin/admin`.
- **Sessão** em cookie `HttpOnly`, `SameSite=Strict`, com prazo absoluto e de ociosidade. Operações sensíveis exigem **reautenticação**, válida por poucos minutos e revogada no logout e na troca de senha.
- **CSRF** por token em cabeçalho próprio, `Origin` exato e `Host` conferido contra lista fechada (fecha DNS rebinding). CORS não é tratado como defesa. Portas não isolam cookies: por isso a sessão não vale nada sem o cabeçalho.
- **Privilégio** por um único auxiliar `root` em `/usr/local/lib/remoteifes/console-helper.sh`, com **verbos fixos e alvo fixo** — sem git, npm, shell, unidade, caminho ou ambiente arbitrários. O auxiliar recusa executar se ele ou qualquer diretório acima dele for gravável por quem não é root. Não existe endpoint genérico de comando.
- **Segredos** (token do GitHub, senhas) nunca voltam por API, log, auditoria ou diagnóstico: o console informa presença e validade, jamais o valor.
- O serviço do console **não** usa `NoNewPrivileges=yes`, ao contrário de `remoteifes.service`: isso quebraria o `sudo` do auxiliar. O endurecimento aplicado está no arquivo de unidade e é explícito sobre esse ponto.

Um operador autorizado que use `sudo` tem o alcance que o host lhe der, inclusive alterar o próprio console, seus registros e o sistema. Software na mesma máquina não consegue se tornar imutável diante do root: o objetivo do desenho é impedir **acesso não autorizado e uso acidental**.

### Terminal Expert

O terminal do console tem destravamento explícito, reautenticação, autorização de curta duração, relock automático, limite de sessões simultâneas, limpeza da árvore de processos e auditoria **sem transcrição** (metadados apenas).

O pseudoterminal em si depende do módulo nativo `node-pty`, que **não é instalado por padrão**. Sem ele o console declara o terminal indisponível e mostra como habilitá-lo; **nenhum substituto é oferecido**, porque um terminal sem PTY real quebra silenciosamente em `vim`, `less` e `htop`, e um campo de texto ligado a um endpoint genérico de execução seria risco disfarçado de recurso. Enquanto o módulo não estiver instalado, o acesso a shell continua sendo por SSH — o que **não** é a mesma coisa, e o console diz isso.

A saída do terminal **não** é filtrada em busca de segredos: se o operador abrir um arquivo com credenciais, elas aparecem na tela. A proteção de segredos do console vale para suas próprias APIs e registros, não para o que um shell autorizado decide exibir.

### Custo de recursos

Meça, não presuma:

```bash
cd remoteifes-console
npm run medir            # ou: node test/measure-resources.js --json
```

O script mede, no host onde roda, a partida do processo, o RSS, o custo de uma atualização de status, de uma leitura de registros e de uma manutenção representativa — e diz explicitamente quando **não** está num Raspberry Pi, em vez de extrapolar.

### Testes do console

```bash
cd remoteifes-console
npm test
```

## Recuperação de emergência por terminal

Referência **única** para quando o console, a aplicação, a autenticação, a rede ou o banco estiverem quebrados. Funciona sem console e sem login na aplicação; exige apenas acesso ao host.

**Serviço e diagnóstico**

```bash
sudo systemctl status remoteifes.service
sudo journalctl -u remoteifes.service -f
npm run health
```

```bash
sudo systemctl start remoteifes.service
sudo systemctl stop remoteifes.service
sudo systemctl restart remoteifes.service
```

Ao parar o serviço por mais de alguns minutos, pare também o watchdog (`sudo systemctl stop remoteifes-health.timer`), senão ele reinicia a aplicação após 3 falhas seguidas do `/health`. Religue-o ao terminar.

**Backup e restauração** — execute em `remoteifes-server`; a restauração exige o servidor **parado**

```bash
npm run backup
npm run backup -- pre-migracao
```

```bash
npm run restore
npm run restore -- <arquivo>
```

**Atualização e reversão** — execute em `remoteifes-server`

```bash
bash deploy.sh
bash deploy.sh v3.1.0
bash deploy.sh --offline
```

```bash
bash rollback.sh
bash rollback.sh v3.0.0
```

`deploy.sh` já faz o `git fetch` sozinho (exceto com `--offline`); não é preciso `git pull` antes. Se uma trava `.deploy-lock` ficou de um processo que não existe mais, o console a reconcilia sozinho; ela **não** deve ser apagada à mão enquanto o PID registrado estiver vivo, por mais antiga que a trava pareça.

**Conta do superadministrador**

```bash
npm run reset-admin -- umaSenhaEscolhida
npm run reset-admin
```

Sem argumento, a senha volta a um valor público e fraco: entre imediatamente e troque-a. O caminho equivalente no console não tem esse fallback e recebe a senha por entrada padrão, sem passar pela linha de comando.

**Redes autorizadas**, quando uma faixa errada bloqueou o próprio acesso

```bash
npm run redes -- 10.10.0.0/16 192.168.0.0/16
npm run redes
sudo systemctl restart remoteifes.service
```

As rotas `/dispositivo/*` e o acesso por `localhost` — útil justamente para um túnel SSH — nunca dependem dessa lista. O caminho gerenciado equivalente é `Rede e domínio › Acesso à aplicação`, no Console de Operações, que também liga e desliga o modo de teste.

**Reparo do console**

```bash
sudo systemctl status remoteifes-console.socket
sudo journalctl -u remoteifes-console.service -e
sudo node /opt/remoteifes-console/versoes/<versao>/instalacao/instalar.js --escopo sistema --forcar
```

Reinstalar o console não toca no `remoteifes.service` nem no banco. Para removê-lo sem afetar o RemoteIFES: `sudo node /opt/remoteifes-console/versoes/<versao>/instalacao/desinstalar.js --sim` — o estado em `/var/lib/remoteifes-console` é preservado.

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
- **Mantenha o modo de teste desativado** (Console de Operações › `Rede e domínio › Acesso à aplicação`) e cadastre as faixas de IP autorizadas para restringir o acesso à rede autorizada; em uma instalação nova de produção o modo de teste começa desativado.
- **Exponha apenas a porta do proxy** (80 no `lan-setup.sh`, 443 no `https-setup.sh`), nunca a porta do Node (`PORTA`, padrão 8080) diretamente — configure isso no firewall do roteador/Pi (`ufw allow 80` ou `ufw allow 443`, sem regra para a `PORTA` interna). Acessar a `PORTA` diretamente contorna o TLS e a checagem de `TRUST_PROXY`.
- **Mantenha o sistema operacional da Pi atualizado sozinho**: `sudo apt install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades` aplica patches de segurança do Raspberry Pi OS automaticamente, sem depender de alguém logar para atualizar.
- **Troque a senha padrão do usuário do sistema operacional** (`pi`/`raspberry`, se ainda for a padrão) e prefira acesso SSH por chave pública em vez de senha.
- **Cadastre o MAC de cada ESP32 assim que possível** (`Administração > Dispositivos > Cadastro`) e migre depois para a credencial exclusiva: as rotas `/dispositivo/*` não passam pela restrição de rede porque os controladores precisam alcançá-las. Sem vínculo, o dispositivo aparece apenas como detectado e não controla uma sala; com o MAC vinculado, as chamadas precisam corresponder ao cadastro; com credencial provisionada, o MAC sozinho deixa de autenticar aquela sala.
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

O firmware do ESP32 também pode se conectar ao servidor central via HTTPS, além do HTTP tradicional. Essa opção é escolhida no portal de configuração de cada dispositivo (a rede Wi-Fi `RemoteIFES-Setup`, disponível apenas enquanto o ponto de acesso de configuração estiver ativo), no campo "Conexão com o servidor":

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

A imagem é validada (byte mágico `0xE9`, tamanho plausível), tem o SHA-256 calculado e é gravada em `<REMOTEIFES_DATA_DIR>/firmware/` junto de um `manifesto.json`. Só uma imagem fica publicada por vez; o número de versão deve casar com o `-DFW_VERSAO` compilado nela. Uma oferta já enviada continua apontando para a imagem que foi ofertada: publicar outra versão enquanto uma placa ainda está baixando não troca o que ela recebe em `/dispositivo/firmware` (o download resolve pela oferta ativa da sala, com o mesmo SHA-256), e o binário anterior só é removido do disco quando nenhuma oferta em transferência o referencia mais (na publicação seguinte ou na varredura periódica). Republicar o **mesmo** número de versão com outro conteúdo é recusado enquanto uma oferta dessa versão estiver em andamento.

**Enviar a atualização a uma sala:** em `Administração > Dispositivos > Firmware / OTA`, cada dispositivo online mostra a versão instalada, a versão publicada e um botão **Atualizar firmware (OTA)** com barra de progresso. Também é possível pela API: `POST /admin/esp32/:sala/ota` (apenas superadministrador).

O que o processo garante:

- **Validação antes de instalar:** o ESP32 baixa a imagem de `/dispositivo/firmware` (autenticada por MAC ou credencial), confere o SHA-256 e o tamanho contra a oferta e só então confirma a gravação. Hash divergente, download interrompido ou imagem maior que o slot abortam sem tocar no firmware em execução. O servidor entrega a essa rota exatamente a imagem da oferta ativa da sala; se ela tiver sumido do disco, responde 409 em vez de servir outro firmware.
- **Sem OTA concorrente:** o servidor recusa uma segunda oferta para a mesma sala enquanto uma está em andamento e limita o total de atualizações simultâneas; o firmware ignora uma oferta se já estiver atualizando ou se estiver em modo de configuração.
- **Interrupções são seguras:** se a conexão cai durante a transferência, o servidor marca a OTA como falha (com tempo-limite de transferência e de reinício) e permite reofertar; o dispositivo continua na versão atual.
- **Reinício do servidor é recuperável:** o andamento é salvo em `<REMOTEIFES_DATA_DIR>/firmware/estados-ota.json`; depois que o backend volta, a reconexão e a versão reportada pelo ESP32 concluem ou registram a reversão, e estados sem retorno expiram pelo mesmo tempo-limite.
- **Validação de boot comprovada (firmware 4.2.0+):** a oferta carrega um identificador de tentativa que a placa guarda na NVS ao gravar a imagem. Depois de reiniciar, reportar a versão nova coloca a OTA em `validando`; ela só passa a `concluida` quando a placa, após o autoteste (`esp_ota_mark_app_valid_cancel_rollback`), envia `ota_validado` com a mesma tentativa, o SHA-256 da imagem e a versão — relatórios repetidos são confirmados de novo (`ota_validacao_ok`) para a placa apagar a evidência, relatórios de outra tentativa ou de um dispositivo substituído são ignorados, e sem evidência em 4 minutos a tentativa falha (`validacao`). Se a placa voltar com a versão anterior durante a validação ou mesmo depois de concluída, isso é registrado como reversão comprovada. Firmware anterior a 4.2.0 não envia essa evidência: para ele a versão reportada continua concluindo a OTA, como antes.
- **Configuração preservada:** OTA grava apenas a aplicação — as credenciais de Wi-Fi/servidor/dispositivo na NVS e a associação da sala (feita no servidor) não são tocadas.
- **Recuperação:** a gravação por USB regrava o slot ativo e ignora o estado do OTA; é o caminho para um dispositivo que, por qualquer motivo, não aceite mais OTA.

### Distribuição em etapas para vários ESP32

Atualizar uma sala por vez continua sendo o caminho simples e não mudou. Para atualizar um conjunto de dispositivos, o mesmo painel `Administração > Dispositivos > Firmware / OTA` traz **Distribuição em etapas**, também exclusiva do superadministrador. Ela orquestra a OTA que já existia em vez de duplicá-la: cada sala passa exatamente pela mesma oferta, download autenticado, conferência de SHA-256, gravação no slot ocioso e validação por reconexão.

O fluxo é: seleção → verificação de compatibilidade → canário → lotes controlados → conclusão.

- **Verificação de compatibilidade:** antes de começar, cada sala selecionada é avaliada com o que o dispositivo já reporta. Quem está na versão publicada ou reporta uma versão maior (downgrade) entra como *não atualizado*, com o motivo registrado. Quem está apenas desconectado, em modo de configuração ou com uma OTA avulsa em andamento continua na fila e é reavaliado na sua vez.
- **Canário:** um único dispositivo é atualizado primeiro — por padrão o primeiro apto da seleção, e o superadministrador pode escolher outro. Os lotes só começam depois que o canário volta **validado** — com firmware 4.2.0+ isso exige a evidência de validação de boot, não apenas reconectar reportando a versão nova. Canário que falha, reverte, não volta ou que não pôde ser atualizado interrompe a distribuição; uma reversão comprovada em qualquer dispositivo, mesmo já validado, também interrompe a distribuição em andamento, e uma reversão depois de a distribuição terminar fica registrada nela (`reversoesTardias`) em vez de deixá-la marcada como sucesso.
- **Lotes:** os demais dispositivos são divididos em lotes de 1 a 5 (padrão 2). Um lote só começa quando o anterior terminou por completo e, dentro do lote, vale o mesmo teto de duas atualizações simultâneas do OTA avulso — a distribuição não cria paralelismo extra.
- **Parada automática:** qualquer falha real em um lote (falhou, reverteu ou ficou sem confirmação) interrompe a distribuição, e o restante da frota permanece na versão anterior.
- **Um dispositivo que continua offline** quando chega a sua vez espera dois minutos e então é registrado como *não atualizado*, nunca como atualizado.

**Pausar, retomar e cancelar:**

- **Pausar** impede que novos dispositivos comecem; quem já está baixando ou gravando segue até o fim, porque interromper uma gravação é o que mais arrisca o equipamento.
- **Retomar** continua do ponto em que parou, no lote seguinte.
- **Cancelar** marca como cancelado apenas o que ainda não começou; o que estiver em andamento é acompanhado até o desfecho e registrado normalmente.

**Estado de cada dispositivo:** `na fila`, `atualizando`, `reiniciando para validar`, `validando o boot` (firmware 4.2.0+ reportou a versão nova e ainda não confirmou o autoteste), `validado`, `falhou` (erro reportado, conexão perdida ou timeout durante a transferência), `revertido` (a placa voltou comprovadamente à versão anterior), `sem confirmação` (retorno ausente, versão inesperada em firmware sem evidência de boot, prazo de validação esgotado ou registro da tentativa indisponível), `não atualizado` (inapto, offline além da espera) e `cancelado`. Só `validado` conta como sucesso: download concluído ou gravação confirmada não bastam, e em firmware 4.2.0+ nem a versão reportada basta sem a evidência de boot.

**Compatibilidade:** a distribuição não altera o protocolo do ESP32 e não exige firmware novo. Ela usa as mensagens que o firmware em campo já entende (`ota_oferta`, `ota_progresso`, `ota_resultado`) e a versão que o dispositivo já reporta em `telemetria`/`info`. Um servidor atualizado continua operando a frota existente sem regravar nada, e a OTA avulsa permanece como caminho de exceção.

**Reinício do servidor:** o andamento fica em `<REMOTEIFES_DATA_DIR>/firmware/rollout-ota.json`, ao lado do estado por dispositivo. Ao voltar, o servidor reconcilia cada dispositivo pelo estado de OTA persistido em vez de repetir a oferta: quem estava gravando ou reiniciando continua sendo acompanhado pelos mesmos tempos-limite; quem ainda não tinha recebido a oferta volta para a fila; quem já a recebeu e não deixou registro do desfecho fica como `sem confirmação`, para conferência manual. Nenhum dispositivo recebe uma segunda oferta apenas porque a memória do processo foi perdida.

**O que a reversão garante e o que não garante:** a reversão é feita pelo próprio ESP32, pelo esquema A/B descrito acima. O servidor não guarda a imagem anterior e não consegue reinstalá-la — o que ele garante é detectar e registrar o desfecho de cada dispositivo, distinguindo falha antes de gravar, reversão confirmada e retorno indeterminado, e parar a distribuição antes de espalhar uma imagem ruim. Uma versão publicada com defeito não é desfeita pelo servidor: corrija, publique uma versão maior e rode uma nova distribuição, ou regrave por USB os dispositivos que não voltarem.

Pela API, apenas para o superadministrador:

```text
GET  /admin/esp32/rollout                 estado atual, limites e aptidão de cada dispositivo
POST /admin/esp32/rollout                 {"salas":["A-101","A-102"],"canario":"A-101","tamanhoLote":2}
POST /admin/esp32/rollout/pausar
POST /admin/esp32/rollout/retomar
POST /admin/esp32/rollout/cancelar
```

O modelo atual evita adulteração acidental e publicação inconsistente por SHA-256, metadados restritos, autenticação do dispositivo e controle exclusivo do superadministrador. Assinatura assimétrica de firmware permanece uma opção de alta garantia para instalações que considerem comprometimento do próprio servidor de releases; ela não é obrigatória porque acrescentaria geração, proteção, rotação e recuperação de chaves ao fluxo normal de implantação.

## Credenciais por Dispositivo e Migração

Além da identificação por MAC, cada sala pode ter uma **credencial exclusiva** de dispositivo: um `deviceId` (`esp_…`) e um segredo aleatório de 256 bits. O servidor guarda apenas o hash SHA-256 do segredo; o valor em texto é exibido uma única vez, no momento em que é gerado, e nunca aparece em logs nem em respostas de estado.

Gestão em `Administração > Dispositivos > Firmware / OTA` (apenas superadministrador), ou pela linha de comando na máquina do servidor:

```bash
npm run credencial -- A-101 --provisionar   # cria a credencial e imprime deviceId + segredo uma vez
npm run credencial -- A-101 --rotacionar    # novo segredo pendente; o atual segue valendo até a placa provar o novo
npm run credencial -- A-101 --substituir    # novo deviceId + segredo (troca de placa); preserva a associação da sala
npm run credencial -- A-101 --revogar       # invalida a credencial e derruba a conexão atual
npm run credencial -- A-101                 # mostra o estado (sem expor o segredo)
```

O ESP32 envia a credencial no cabeçalho (`X-Device-Id` / `X-Device-Secret`) no handshake do WebSocket e nas rotas `/dispositivo/*`. Ela pode ser informada no portal de setup (`RemoteIFES-Setup`) ou, para um dispositivo já conectado por MAC, **enviada pelo próprio servidor pela conexão existente** ao provisionar/rotacionar — o dispositivo grava na NVS e reconecta já autenticado, sem visita ao local. Resetar ou reconfigurar apenas Wi-Fi/servidor preserva essa credencial; deixar os dois campos de dispositivo vazios no portal também preserva o valor existente.

**A rotação acontece em duas fases.** Rotacionar cria uma geração **pendente** enquanto o segredo atual continua plenamente válido, sem prazo. O novo segredo é entregue à placa conectada ou, se ela estiver offline, guardado apenas em memória e entregue quando ela reconectar com a credencial atual (o painel mostra "rotação pendente: será entregue quando a placa conectar"). A geração nova só é **ativada** quando a placa prova possuí-la — conectando pelo WebSocket ou fazendo um heartbeat com o novo segredo; nesse momento o segredo anterior entra na tolerância de 24 h e, ao fim dela, qualquer conexão ainda autenticada com ele é encerrada. Uma placa que perdeu a entrega nunca fica inacessível: sua credencial atual vale até a nova ser provada. O segredo pendente nunca é persistido em texto, então depois de um reinício do servidor ele não pode mais ser reentregue — o painel avisa e uma nova rotação o substitui. Substituir ou revogar descartam a geração pendente. O firmware 4.1.0 já grava o segredo recebido e reconecta com ele, portanto o mecanismo não exige atualização de firmware.

**Ativar significa que a placa apresentou o novo segredo, não que ele sobreviveu a um reinício.** A partir do firmware 4.3.0 a placa só troca a credencial em uso — e só reconecta com ela — depois de gravar as duas chaves na NVS e relê-las com o valor esperado; uma gravação recusada ou parcial é desfeita, a credencial atual continua em uso e a placa reporta `credencial=falha_nvs` (visível em `Auditoria > Logs`, origem `esp32_local`), de modo que a geração pendente permanece pendente e reentregável. Para cobrir firmware anterior e a perda de energia entre a gravação e o próximo boot, o servidor guarda em memória o segredo já ativado enquanto a geração anterior está na tolerância: uma placa que reconecta com a credencial anterior recebe o segredo atual de novo pela própria conexão (`atualReentregavel` no estado da credencial). Depois de um reinício do servidor essa reentrega deixa de ser possível e vale o comportamento anterior — rotacione de novo com a placa conectada. A durabilidade real da NVS em queda de energia não é verificada por software.

Revogar mantém a exigência de credencial na sala, mesmo com a opção global desligada: o MAC sozinho não recupera o acesso. Para reconectar, provisione ou substitua a credencial e informe o novo valor no setup do dispositivo.

**Substituição de hardware é deliberadamente diferente:** a nova credencial nunca é enviada à conexão da placa antiga. O servidor invalida o `deviceId` anterior, encerra sua sessão e mostra o novo par uma vez para ser informado no portal da placa substituta.

**Migração dos controladores atuais (padrão: brando):**

1. Enquanto a opção global **Exigir credencial por dispositivo em todos os ESP32** (em `Administração > Sistema > Configurações`) está desligada, uma sala **sem** credencial provisionada continua aceitando conexão só por MAC, exatamente como antes. Uma sala **com** credencial provisionada já passa a exigi-la.
2. Provisione a credencial de cada sala (o painel marca as que ainda estão "só MAC"; o resumo aparece também em `GET /admin/esp32/migracao` e no [Status](#monitoramento-operacional)).
3. Quando todas estiverem provisionadas e verdes, ligue a opção global para recusar conexões só por MAC em qualquer sala. A mudança é reversível.

Como endereços MAC podem ser imitados, a credencial por dispositivo é a forma recomendada em produção; mantenha o tráfego ESP32 ↔ servidor em rede administrada ou sob HTTPS.

## Monitoramento Operacional

`Administração > Sistema > Status > Sistema` (visível apenas ao superadministrador; `GET /admin/monitoramento` também exige nível de superadministrador) reúne, a partir de fontes **locais e baratas**, um retrato da saúde da instalação — sem serviços externos e sem afetar o `/health`, que mantém o mesmo contrato de antes. Cada bloco exibe um selo de estado (disponível, temporariamente indisponível, desativado por configuração ou falha):

- **Serviço:** ambiente, tempo no ar, memória (RSS), carga de 1 minuto, versão do Node e PID.
- **Banco de dados:** se responde e em quanto tempo, tamanho do arquivo e do WAL.
- **Armazenamento:** espaço livre e total do sistema de arquivos que contém o **banco de dados** (`statfs` no diretório de `REMOTEIFES_DB_PATH`), com alerta abaixo de 10%; quando `BACKUP_DIR` está em outro dispositivo, o volume dos backups é medido e rotulado separadamente, com alerta próprio.
- **Backups:** se o backup automático está ligado, quantos existem, o nome e a idade do último frente ao intervalo configurado.
- **ESP32:** quantos têm MAC cadastrado, quantos estão online, quantos com WebSocket ativo, quantos com MAC mas offline, reconexões na última hora (com alerta para salas que "piscam"), OTA em andamento e OTA com falha pendente.
- **Credenciais:** provisionadas, ainda só por MAC, revogadas, e se a exigência global está ligada.
- **Contadores de falha desde a inicialização** (em memória, zerados a cada reinício): comandos **não entregues ao ESP32** (`comandoNaoEntregue`: o servidor não conseguiu entregar o estado ao socket do dispositivo, por ele estar desconectado ou por falha de envio), persistência de telemetria, tarefas do agendador e execução de agendamentos, falhas de OTA, credenciais inválidas e reconexões anormais de dispositivo. Entrega ao ESP32 **não** significa execução no ar-condicionado: `HTTP ok` e `ws.send()` bem-sucedido comprovam apenas que o comando chegou ao socket da placa; não há confirmação fim a fim de que o sinal infravermelho foi emitido e aceito pelo aparelho.

A cada 5 minutos o servidor reavalia esses indicadores e, para cada condição de alerta ativa, gera uma **notificação** (`tipo` `monitoramento`, no sino do administrador), sem repetir o mesmo alerta dentro de 6 horas. O endpoint bruto é `GET /admin/monitoramento`; o payload traz ainda `esp32.otaPorFase` (contagem por fase de OTA) e `servico.pm2`.

Quando o servidor roda sob **PM2**, o cartão *Serviço* mostra nome, id, modo e contagem de reinícios informados pelo gerenciador — lidos das variáveis de ambiente que o próprio PM2 injeta ao iniciar o processo (`pm_id`, `name`, `exec_mode`, `restart_time`, `unstable_restarts`, `pm_uptime`), sem dependência nem chamada ao PM2. Fora do PM2 o campo é `null` e nada é exibido; os gráficos não dependem dele.

### Histórico e gráficos

Abaixo dos cartões, a seção recolhível **Histórico e gráficos** transforma o status em um painel operacional leve. Os cartões continuam sendo a leitura exata (atualizada a cada 20 s); os gráficos mostram a evolução e são desenhados em SVG pelo próprio frontend (`js/charts.js`, sem biblioteca externa nem CDN, incluído no shell da PWA e no Cordova). A preferência de manter a seção recolhida fica no navegador e, recolhida, nada é consultado nem desenhado.

| Gráfico | Forma | Fonte |
| --- | --- | --- |
| ESP32 conectados (com MAC, online, WebSocket) | linhas/área | amostras |
| Reconexões e quedas de ESP32 | colunas agrupadas por intervalo | `esp_eventos` (já persistido) |
| Falhas por período (telemetria, credencial, agendador, banco, OTA) | colunas empilhadas | deltas amostrados por intervalo + notificações `esp32_ota_falha` |
| Comandos por período (manual, agendamento, ESP32 local, outros) | colunas empilhadas | `comandos_log` (já persistido) |
| Memória RSS, CPU do processo, latência do banco | área da média + linha de pico | amostras |
| Arquivo do banco e WAL, disco livre | linhas/área | amostras |
| ESP32 online × offline, credenciais de dispositivo, OTA por fase | roscas (composição atual) | payload corrente de `/admin/monitoramento` |
| Uso dos históricos com limite | barras horizontais | payload corrente (`banco.tabelas`) |

**Amostragem e retenção.** O agendador grava **uma amostra por minuto** (`monitoramento_amostras`: RSS, CPU do processo em % de um núcleo, carga, latência e tamanho do banco/WAL, disco livre/total, ESP32 com MAC/online/WebSocket e os **deltas** dos contadores de telemetria, credencial, agendador e banco no intervalo), sempre fora do caminho de comandos, telemetria e WebSocket e sem operações caras de integridade do SQLite. A cada minuto as horas fechadas são consolidadas em `monitoramento_horas` (média, pico/mínimo, somas e reinícios por hora). A retenção mantém **48 h de amostras brutas** e **30 dias de horas consolidadas** (limites de 6 000 e 1 000 linhas), integrada à rotina de retenção existente, que consolida antes de apagar; o crescimento das duas tabelas aparece no cartão *Históricos com limite* e no gráfico de uso. Em disco isso fica abaixo de 1 MB.

**Faixas.** `GET /admin/monitoramento/historico?faixa=3h|24h|7d|30d` (superadministrador; `faixa` inválida responde 400) devolve séries já agregadas no servidor em uma grade completa: 3 h com 3 min por ponto e 24 h com 15 min vêm das amostras; 7 dias com 1 h e 30 dias com 6 h vêm das horas consolidadas mais a hora corrente crua. Nunca mais de 168 pontos por faixa, com cache de 30 s por faixa. Intervalos sem amostra chegam como `null` e ficam em branco no gráfico (sem interpolação); contagens de eventos persistidos chegam como zero. Cada início de processo dentro da janela vem em `reinicios` (instante exato nas faixas curtas, aproximado à hora nas longas) e vira um marcador; `cobertura` informa desde quando há histórico e se a janela está completa, e a tela avisa quando o período pedido começa antes da primeira amostra.

**Leitura acessível.** Toda figura tem título, legenda para mais de uma série, resumo em texto (último, mínimo, máximo ou totais), leitura por teclado (setas, Home, End, Esc), por toque e por ponteiro (região `role="status"`), e uma tabela de valores sob demanda; o alto contraste troca a paleta das séries. Os gráficos são responsivos (coluna única no celular, duas colunas no desktop com os gráficos principais em largura total), respeitam a fonte máxima de acessibilidade, agrupam intervalos quando as colunas ficariam mais estreitas do que o legível e não redesenham no refresh de 20 s dos cartões: só quando a faixa muda, ao pedir *Atualizar* ou quando a composição atual realmente muda.

## Mapa de Calor Operacional

Dentro de `Administração > Sistema > Status > Sistema`, a seção recolhível **Mapa de calor operacional** compara as salas em uma métrica de operação sobre a mesma planta baixa usada no restante do sistema. É exclusiva do superadministrador (`GET /admin/heatmap` exige nível de superadministrador) e é analítica: não liga, desliga nem reconfigura nada. Consumo e energia estimada **não** fazem parte do sistema.

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

Usuários autenticados podem abrir `#/aplicativo` pelo menu da conta ou pela Ajuda. A página é escrita para quem nunca instalou um aplicativo fora da loja: ela abre com um **cartão de estado** que responde "o que eu preciso fazer agora", seguido do botão de instalação, do passo a passo e do que é preciso para o aplicativo funcionar. O APK só aparece quando existe uma publicação válida em `remoteifes-server/data/releases/mobile/release.json` **e** o `serverOrigin` gravado nesse arquivo coincide com a origem pela qual o servidor está sendo acessado; o download exige a sessão RemoteIFES e é servido pelo próprio servidor com `Cache-Control: private, no-store`.

O cartão de estado tem quatro situações, e só o **aplicativo empacotado** afirma o que está instalado — a versão instalada é gravada no bundle pelo mesmo build que gera o APK, sem plugin nenhum:

| Situação | Quando aparece | O que a página diz |
| --- | --- | --- |
| **Atualizado** | app instalado com o mesmo `versionCode` publicado | nada a fazer |
| **Atualização disponível** | app instalado com `versionCode` menor | versão instalada, versão publicada e botão **Baixar atualização** |
| **Versão instalada indisponível** | app empacotado sem a versão gravada | oferece instalar por cima, sem afirmar o que está instalado |
| **Versão disponível** | site ou PWA no navegador | mostra a versão publicada e diz explicitamente que não dá para saber a instalada |

Quando há um APK publicado, a página mostra o botão **Baixar aplicativo** (ou **Baixar atualização**), a versão, a data de publicação, o tamanho, as novidades da versão, o passo a passo de instalação — incluindo como liberar **Permitir desta fonte** só para o aplicativo que abre o arquivo — e um bloco recolhido de **Problemas comuns**. O SHA-256 do arquivo e do certificado, a compatibilidade e a origem do servidor ficam em **Detalhes técnicos**, recolhidos, fora do fluxo de quem só quer instalar. Ao baixar, o próprio navegador recalcula o SHA-256 dos bytes recebidos e **cancela o salvamento** se ele não bater com o hash anunciado — o arquivo só é entregue ao usuário depois de confirmada a integridade. Enquanto não há APK, a mensagem de "não publicado" aparece e o cartão da PWA é marcado como recomendado; o item continua visível no menu rápido de ajuda.

Nada é instalado em segundo plano: a atualização é sempre um download que o usuário confirma no instalador do Android, e a página só a considera concluída quando o sistema instala o pacote. A versão publicada é relida ao abrir a página e quando o aparelho volta ao primeiro plano com ela aberta — não há sondagem periódica —, e `/mobile-app/info` responde com `Cache-Control: no-store`, então nenhum cache de navegador esconde uma versão nova.

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

O fonte é `remoteifes-web/`. `sync-www.js` recria `remoteifes-cordova/www/`, exclui `sw.js`, `manifest.webmanifest` e `.nojekyll`, e insere `cordova.js`. Cordova prepara a plataforma a partir de `config.xml`; Gradle compila o manifesto, os recursos, o plugin StatusBar e os assets dentro do APK. A WebView instalada carrega esses assets e usa API e WebSocket do servidor configurado no build.

`www/`, `platforms/`, `plugins/`, `build/`, APKs, keystores e `.signing/` são locais e ignorados pelo Git. Não edite a plataforma gerada nem copie um frontend antigo para ela.

#### Pré-requisitos

- Node compatível com o Cordova travado em `package-lock.json` (CI: Node 22).
- JDK 17, com `JAVA_HOME` ou `CORDOVA_JAVA_HOME` apontando para ele.
- Android SDK: Platform 36, Build Tools 36.0.0, Platform Tools/ADB, Command-line Tools (`apkanalyzer`) e Emulator.
- Gradle 8.14.2 no `PATH` para inicializar o wrapper gerado pelo Cordova.
- `ANDROID_HOME` apontando para o SDK. Não grave caminhos da máquina no repositório.
- Emuladores/dispositivos de teste preparados separadamente. O doctor não instala componentes, aceita licenças nem modifica o sistema.

Referência: [guia oficial Cordova Android](https://cordova.apache.org/docs/en/latest/guide/platforms/android/). A plataforma Cordova Android 15 declara Android 7.0/API 24 a Android 16/API 36. Isso é o intervalo de SDK suportado; não significa que toda a matriz de execução já foi aprovada.

O WebView instalado também precisa atender ao mínimo do frontend: **Android System WebView (Chromium) 108 ou mais recente** — o mesmo limite vale para Chrome 108+, Safari 15.4+ e Firefox 121+ no site e na PWA. O limite vem do próprio código, não do `minSdk`: a sintaxe ES2020 (`?.`/`??`), `Element.replaceChildren`, o seletor CSS `:has()` (Chromium 105) e as unidades `dvh` (Chromium 108) do layout. A validação de setembro/2026 mediu isso com o mesmo frontend: os WebViews de fábrica das imagens API 24 (53) e API 29 (74) falham com erros de sintaxe; Chromium 86 e 104 executam o JavaScript, mas perdem as regras de largura com `:has()`; Chromium 105–107 perdem as alturas em `dvh` (14 testes de layout falham); Chromium 108 passa a bateria de layout completa, e API 34/WebView 113 e API 36/WebView 133 passam no smoke nativo e nos testes de interface.

Abaixo desse mínimo o `index.html` não deixa o app carregar pela metade: um script inicial (escrito em ES5, para ser interpretado por qualquer motor) detecta esses recursos e, se algum faltar, mostra a tela **Navegador desatualizado** — com a orientação de atualizar o Android System WebView/Chrome pela Play Store ou o navegador — e impede a execução do restante da página. O usuário nunca vê a página em branco nem a mensagem enganosa de "sem conexão com o servidor" que um WebView antigo produzia. `minSdk=24` sozinho não garante compatibilidade do runtime: o aparelho precisa de um WebView atualizado pelos canais oficiais.

#### Fluxo curto

Execute em `remoteifes-cordova/` (Cordova e plataformas são instalados localmente pelo lockfile):

```sh
npm ci
npm run doctor
npm run prepare-android
npm run build-android
npm run inspect-apk -- platforms/android/app/build/outputs/apk/debug/app-debug.apk debug
```

`prepare-android` adiciona Android somente quando ausente e propaga qualquer erro, inclusive no Windows. Para desenvolvimento sem origem embutida, o aplicativo mostra a configuração inicial do servidor. `http://localhost` dentro da WebView é a origem dos assets, não o servidor central. No emulador padrão, `10.0.2.2` acessa o host.

Para release, carregue no ambiente, a partir do mecanismo seguro da equipe:

| Variável | Uso |
|---|---|
| `REMOTEIFES_SERVER_URL` | Somente a origem HTTP/HTTPS da implantação, sem caminho, usuário ou senha |
| `REMOTEIFES_ANDROID_KEYSTORE` | Keystore de produção existente |
| `REMOTEIFES_ANDROID_KEYSTORE_TYPE` | `jks` (padrão) ou `pkcs12` |
| `REMOTEIFES_ANDROID_KEY_ALIAS` | Alias da identidade de assinatura |
| `REMOTEIFES_ANDROID_STORE_PASSWORD` | Senha do keystore |
| `REMOTEIFES_ANDROID_KEY_PASSWORD` | Senha da chave |

Não coloque valores secretos na linha de comando, no Git ou em logs. Não use a chave temporária de validação para distribuição. Preserve e faça backup seguro da identidade de produção: mudar a assinatura impede a atualização normal.

```sh
npm run doctor -- --release
npm run build-android-release
```

Esse comando prepara a plataforma, sincroniza o frontend, injeta origem e versão somente no bundle, restringe a configuração nativa, faz um clean/build, verifica o APK e restaura o `config.xml` original e o bundle neutro. A configuração temporária de assinatura é removida no `finally`. Em encerramento forçado da máquina/processo, revise e remova sobras temporárias de assinatura antes de retomar.

Sem credenciais, `npm run build-android-release -- --unsigned` exercita o mesmo build de produção e a inspeção estática, mas gera um APK **não instalável/publicável** até ser assinado. A origem continua obrigatória. O CI usa uma origem de exemplo, nunca uma implantação real.

O verificador inspeciona manifesto e recursos do APK com `apkanalyzer`/`aapt2` e a assinatura com `apksigner`: pacote, versão, versionCode, SDKs, permissões, depuração, cleartext, origem embutida, versão no JavaScript e configuração de navegação. Ele resolve os nomes de recursos otimizados do release. Registra tamanho, SHA-256 e certificado. Não é um scanner completo de segredos nem uma prova de funcionamento em runtime.

Os executáveis são encontrados a partir de `ANDROID_HOME`. Para instalações diferentes, há overrides `ANDROID_APKANALYZER`, `ANDROID_APKSIGNER`, `ANDROID_AAPT2`, `ANDROID_ADB` e `ANDROID_EMULATOR`.

#### Origem e segurança

O build HTTPS usa `https://localhost` e bloqueia cleartext. HTTP usa `http://localhost` e permite cleartext para compatibilidade com a implantação local existente. A permissão Android de cleartext é global ao aplicativo; não é uma regra de domínio de `network_security_config`. A configuração Cordova restringe navegação/rede à origem informada. Nenhum bypass de certificado TLS é adicionado.

Para inspecionar a configuração manualmente (o release automatiza isso), use `npm run harden-config -- https://remoteifes.ifes.edu.br` ou `npm run harden-config -- http://192.168.1.50:8080`; depois restaure com `npm run dev-config`.

Servidor indisponível deve levar à recuperação de conexão, sem reconfiguração da infraestrutura pelo usuário normal. Mudanças HTTP ↔ HTTPS alteram a origem da WebView e podem separar o armazenamento/sessão anterior; trate isso como migração e teste antes de distribuir. Confira CORS para a origem efetiva da WebView e o handshake WebSocket no servidor.

#### Versão e publicação

- Pacote: `widget id` de `config.xml`.
- Versão/build: `android-release.json`, propagado para `config.xml` pelo comando abaixo.
- Origem: `REMOTEIFES_SERVER_URL`, usada no build e conferida contra os bytes na publicação.
- Assinatura: keystore/alias existentes; a publicação compara o certificado com `release.json` anterior.

O Android admite reinstalação da mesma versão com `adb install -r`; a política do RemoteIFES exige versionCode crescente para **um novo artefato publicado**. Republicar exatamente o mesmo SHA-256 é idempotente. O versionName pode permanecer igual quando `--rebuild` aumenta versionCode. Não edite manualmente os dois arquivos de versão.

```sh
npm run android-version                     # consultar
npm run android-version -- 1.1.0             # nova versão
npm run android-version -- --rebuild         # mesmo nome, novo versionCode
npm run android-version -- --verificar       # conferir consistência
```

Após validar o runtime, defina `REMOTEIFES_ANDROID_APK` e `REMOTEIFES_MOBILE_RELEASE_DIR`, mantenha a mesma origem do build e execute `npm run publish-android-release`. O script recusa inconsistências antes de copiar o APK. A publicação não executa automaticamente os testes de runtime. A primeira publicação requer conferência humana da identidade correta; assinatura criptograficamente válida não identifica, sozinha, a chave de produção.

O destino padrão do servidor é `remoteifes-server/data/releases/mobile/` (`MOBILE_APP_RELEASE_DIR`). O servidor só anuncia o APK quando `release.json.serverOrigin` corresponde à origem da requisição. Para outra implantação, gere outro APK com a origem correspondente. A versão Android é independente de `remoteifes-web/version.json`.

Exemplo Bash de publicação, com overrides opcionais de ferramentas:

```sh
REMOTEIFES_ANDROID_APK=platforms/android/app/build/outputs/apk/release/app-release.apk \
REMOTEIFES_MOBILE_RELEASE_DIR=../remoteifes-server/data/releases/mobile \
REMOTEIFES_SERVER_URL=https://remoteifes.ifes.edu.br \
ANDROID_APKSIGNER=$ANDROID_HOME/build-tools/36.0.0/apksigner \
ANDROID_APKANALYZER=$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer \
npm run publish-android-release
```

#### Smoke e repetição

Use um dispositivo dedicado. `test-android` exige `ANDROID_SERIAL`, instala com `-r`, faz cold start, rotações, background/resume e force-stop/restart. Não desinstala nem limpa dados automaticamente. Restaura as configurações de rotação; grava relatório JSON, meminfo por ciclo, logcat, hierarquia UI e screenshot em `build/android-test-*/`. Logs/screenshots podem conter dados da conta de teste; revise antes de compartilhar.

```sh
adb devices -l
# Bash; PowerShell: $env:ANDROID_SERIAL='emulator-5554'
export ANDROID_SERIAL=emulator-5554
export ANDROID_TEST_CYCLES=10
npm run test-android -- <caminho-do-apk-assinado>
```

Sem `--webview`, o teste comprova somente instalação/processo/lifecycle. Processo vivo não prova que a tela ou a rede estejam corretas.

Logo após o cold start, o teste lê a versão do WebView do aparelho e a hierarquia de UI. Em um WebView abaixo de 108 ele exige que a tela **Navegador desatualizado** esteja visível (e que sobreviva aos ciclos de lifecycle); em um WebView 108+ exige que ela **não** apareça. Qualquer combinação diferente falha com a causa explícita, em vez do antigo "WebView errors require review". O modo `--webview` só roda em WebView 108+.

No modo `--webview`, `ANDROID_TEST_SCREENS=0` permite repetir somente os ciclos; por padrão também são capturadas as telas em seis tamanhos e combinações de fontes/contraste. Alterações de densidade reiniciam a Activity nesse diagnóstico: as capturas não comprovam continuidade de estado durante a mudança.

Para diagnosticar o **debug APK realmente instalado**, instale também as dependências existentes de `e2e/` e `remoteifes-server/` com `npm ci`, inicie `node e2e/harness/api-server.js` na raiz em outro terminal e execute:

```sh
npm run test-android -- <apk-debug> --webview
```

Usa Playwright Android contra a WebView, sem navegador desktop. O harness tem banco temporário e dispositivo simulado; não opera o ESP32 real. Origem padrão: `http://10.0.2.2:8791`, conta de teste do harness. Overrides: `ANDROID_TEST_ORIGIN`, `ANDROID_TEST_USER`, `ANDROID_TEST_PASSWORD`. Não aponte esse modo para produção. Exercita login/logout, sala A-108, Admin/Status, Firmware, rotação, background/resume e interrupção/latência emulada por CDP. Registra requests cumulativos, sockets observados, heap JS, nós e listeners. Esses contadores não constituem, isoladamente, prova de vazamento. A instrumentação exige debug; não habilite depuração no release para fazê-la passar.

#### Matriz de aceitação manual

Registre APK/SHA-256, API, versão Android, ABI, WebView, resolução/densidade, escala de fonte, conta/servidor e duração em cada execução. Mínimo: APIs 24, 29, 34 e 36; aparelho real quando disponível. Nas imagens de emulador de fábrica, APIs 24 e 29 (WebView 53 e 74) só validam a tela de incompatibilidade; os fluxos abaixo exigem um WebView 108+ (imagens API 34+ ou aparelho atualizado).

| Grupo | Procedimento e critério |
|---|---|
| Instalação | Instalação limpa; `adb install -r` do mesmo artefato; upgrade com sessão ativa; reiniciar; assinatura diferente deve falhar; versão inferior deve ser rejeitada sem `-d`; desinstalar/reinstalar e `pm clear` somente no aparelho de teste |
| Estado | Upgrade com mesma assinatura/origem preserva configuração e sessão esperadas; force-stop/restart e morte do processo não exigem reinstalação |
| Fluxos | Login/logout, sala e controles, Admin, Firmware/OTA, Protocolos IR e monitoramento; Android Back retorna corretamente |
| Telas | 320/360, ~400, telefone grande, tablet e paisagem; sem overflow horizontal/controles cortados; barras do sistema não encobrem o conteúdo |
| Gráficos | Linhas/áreas, colunas/barras, pizza/donut, legendas e tabelas com dados representativos; rótulos legíveis e redraw após rotação/escala |
| Acessibilidade | Font scale e display scale Android, fonte máxima 2× no app, default/serif/sans/dislexia; temas/contraste disponíveis, diálogos e alvos de toque. TalkBack somente se efetivamente disponível e utilizado |
| Rede | Servidor ausente no startup e perdido durante uso; reinício do servidor; WebSocket interrompido; Wi-Fi off/on; latência e intermitência; HTTP, HTTPS válido e TLS inválido rejeitado |
| Lifecycle | Bloquear/desbloquear tela, repetir home/retorno, rotacionar, matar processo, sessão expirada; recuperação sem reset de dados |
| Soak | Repetir fluxo por duração suficiente; observar crashes/ANRs/renderer, sockets simultâneos, requests por ciclo, listeners/timers e memória após aquecimento |

`adb install -r` preserva dados conforme a [documentação Android](https://developer.android.com/tools/adb). Teste cada migração real; não assuma preservação se mudar pacote, assinatura ou origem WebView.

#### CI e regeneração

`ci.yml` mantém a validação Cordova e chama `android.yml` (build limpo, inspeção de APK e smoke nativo na API 36) sempre que o frontend ou o Cordova mudam. `android.yml` também pode ser disparado sozinho; `broad_matrix=true` (ou `android_broad_matrix` no **Run workflow** do CI) amplia para 24/29/34/36: nas imagens 24 e 29 o smoke valida a tela de incompatibilidade do WebView de fábrica; em 34 e 36, o app. Runners descartáveis provisionam o SDK; o doctor local não instala nada. Os artefatos do CI são de validação, não releases de produção. A matriz manual de UI/rede/acessibilidade continua necessária.

Para regeneração limpa, com o aplicativo de teste parado, remova **somente** `remoteifes-cordova/platforms/`, `plugins/` e `www/` após conferir os caminhos absolutos. Execute `npm ci`, `npm run prepare-android` e o build. Nunca remova `.signing/` junto com os gerados. Não versione APKs ou caminhos de SDK.

#### Diagnóstico

- Doctor falha: corrija o componente ou `PATH` indicado; ele não deve mascarar erro com `|| true`.
- `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: certificado diferente. Use a identidade correta; desinstalar perde dados e não é solução para upgrade de produção.
- `INSTALL_FAILED_VERSION_DOWNGRADE`: use versionCode maior. Não use `-d` para validar o fluxo normal.
- Tela sem servidor: confirme a origem **dentro do APK**, CORS/WebSocket e alcance de rede do Android; localhost do aparelho não alcança o servidor do host.
- TLS inválido: corrija certificado/cadeia/hostname no servidor; não desabilite validação.
- ANR de System UI ou timeout ADB: preserve logs e diferencie infraestrutura de falha do pacote. Não marque um teste interrompido como aprovado.
- Execução interrompida: confira `config.xml`, sincronize `www/`, remova arquivos temporários de assinatura e restaure eventuais overrides de `wm size/density` e `settings` no dispositivo de teste.

#### iOS e recursos visuais

No macOS, instale o Xcode (com os simuladores de iOS) e as Command Line Tools. `npm run prepare-ios` sincroniza o frontend, adiciona a plataforma iOS com o `cordova-ios` instalado pelo lockfile somente quando ela ainda não existe e propaga qualquer erro (o `|| true` anterior escondia falhas do `platform add`); em seguida `npm run build-ios -- --emulator` compila sem assinatura para o simulador, `npm run test-ios` instala o build em um iPhone simulado, abre o app, o encerra e reabre, tira capturas de tela e lê o log unificado do processo, e `npm run run-ios` abre o app interativamente. Para distribuição, abra `platforms/ios/App.xcworkspace` no Xcode.

`test-ios` comprova a casca nativa: instalação, cold start, sobrevivência ao terminate/relaunch, início do motor WKWebView pelo cordova-ios e ausência de falhas de carregamento e de relatórios de crash; as capturas ficam em `build/ios-test-*/` (o CI as publica como artefato). Ele **não** inspeciona o conteúdo da página — no iOS não há inspetor scriptável sem ferramentas externas. O caminho previsto para validar o frontend no WebKit do iOS (o mesmo motor da WKWebView) é o smoke do Safari no iOS Simulator (`cd e2e && SAFARI_PLATFORM=ios npm run test:safari`), mas nos runners hospedados ele ainda não passou do carregamento do portal — veja [Testes e Integração Contínua](#testes-e-integração-contínua). Até lá, a interface no iOS continua validada apenas manualmente, em um iPhone físico ou no Simulator.

O `deployment-target` do iOS em `config.xml` é 15.4 porque a WKWebView usa o WebKit do próprio sistema e o frontend exige Safari/WebKit 15.4 (veja [Cordova (Android/iOS)](#cordova-androidios)); um iOS anterior recusa a instalação em vez de instalar um app que só mostraria a tela de navegador desatualizado. Os fontes de ícone/splash ficam em `remoteifes-cordova/resources/` (`icon.png` 1024×1024 e `splash.png` 2732×2732); o preparo gera os recursos nativos. Variantes personalizadas podem ser copiadas com `cordova-res`, instalado separadamente.

## Scripts Auxiliares

Três scripts Python na raiz do projeto auxiliam o fluxo de trabalho com Git (executados a partir da raiz do repositório com Python 3, com `git` instalado e disponível no `PATH`):

| Comando | Função |
|---|---|
| `python3 export.py` | Adiciona todas as alterações (`git add -A`), pede uma mensagem de commit (ou usa `update` como padrão) e envia (`git push origin main`) |
| `python3 import.py` | Atualiza a cópia local a partir do remoto (`git pull origin main`) |
| `python3 clear.py` | Recria o histórico do repositório do zero em um único commit (`checkout --orphan`) e, mediante confirmação explícita, sobrescreve o histórico remoto (`push -f`) — apaga permanentemente todo o histórico de commits anterior; use apenas se isso for intencional. O ruleset de `main` no GitHub bloqueia push forçado, então esse `push -f` só passa se um administrador desativar temporariamente a regra em **Settings > Rules > Rulesets** |

O repositório inclui um `.gitignore` na raiz que já ignora `remoteifes-server/.env` e `remoteifes-server/data/` (onde fica o banco SQLite), para não versionar segredos (como `SENHA_ADMIN_INICIAL`) nem o banco de dados — veja o aviso sobre esse cenário em [Solução de Problemas](#solução-de-problemas). Se você clonou uma cópia antiga do repositório em que esse arquivo não existia e chegou a commitar `.env` ou o banco, rode `git rm --cached` nesses arquivos antes de publicar o repositório.

## Testes e Integração Contínua

O repositório traz uma bateria de verificação de regressão. Todos os comandos rodam a partir da raiz do projeto, salvo indicação em contrário.

| Alvo | Comando | Observações |
|---|---|---|
| Servidor (API + banco) | `cd remoteifes-server && npm test` | `node:test` nativo; sem dependências extras. Cobre sessão/login, permissões, `/comando`, limites de temperatura, notificações, WebSocket, backup/restauração, o `/health`, o desligamento diário automático (`test/daily-shutdown.test.js`), a atualização de firmware por OTA (`test/ota.test.js`), as credenciais por dispositivo (`test/esp32-credentials.test.js`), o monitoramento operacional (`test/monitoring.test.js`) e seu histórico de amostras, consolidação, retenção, faixas e reinícios (`test/monitoring-history.test.js`), a biblioteca de protocolos IR com clonador vinculado à identidade da placa, failsafe e reconexão (`test/ir-protocols-service.test.js`, `test/ir-protocols.test.js`), o Auto-ON global (`test/auto-on-control.test.js`), a recusa de mudanças do acesso de rede vindas do site (`test/network-access-ownership.test.js`), a migração do esquema (`test/schema-migration.test.js`) e o contrato do firmware — GPIOs, switch, buzzer, NVS, AP (`test/firmware-contract.test.js`). |
| Frontend end-to-end | `cd e2e && npm install && npx playwright install chromium && npx playwright test` | A instalação do pacote npm não baixa o navegador automaticamente; `npx playwright install chromium` instala a versão compatível. Em uma imagem Ubuntu mínima que ainda não tenha as bibliotecas do Chromium, use uma vez `sudo npx playwright install-deps chromium`. Para usar um canal do sistema, defina `E2E_BROWSER_CHANNEL` (por exemplo, `chrome` ou `msedge`). Por padrão roda só no Chromium; `E2E_BROWSERS=chromium,firefox,webkit` (após `npx playwright install firefox webkit`) repete a bateria nos motores Gecko e WebKit — no projeto WebKit o service worker fica bloqueado, porque nesse motor o Playwright não intercepta (`page.route`) as chamadas de uma página controlada pelo worker, e por isso os dois testes que dependem do cache da PWA são pulados ali. Sobe a API real, um servidor estático do `remoteifes-web` e um ESP32 simulado; exercita layouts de celular, tablet, notebook, desktop e desktop largo, retrato e paisagem, autenticação, permissões, seleção de sala, operação do controlador, diálogo de troca de senha, relatos de problema, notificações do administrador, queda/retorno de WebSocket, navegação por endereço — reload, link direto, voltar/avançar, apelidos de rota, fallback de permissão, caminho estilo Cordova (`/index.html#/...`) e manual offline pelo cache do PWA (`navigation.spec.js`) —, o manual completo (`manual.spec.js`), o hub de início por papel com navegação e faixa de saúde (`home.spec.js`), o gate do Status por superadministrador, a planta baixa do cadastro de ESP32 sem rolagem horizontal em telas estreitas, o clonador, a captura em tempo real, a biblioteca e o failsafe em `Protocolos IR` — inclusive em celular e com acessibilidade máxima (`ir-protocols.spec.js`) — e o Auto-ON no painel de controle e nas Configurações (`auto-on.spec.js`), e a tela **Navegador desatualizado** de um motor sem os recursos mínimos, sem executar o restante do app (`compat-guard.spec.js`). O ESP32 simulado responde a papel, modo clone, capturas, `send_raw` e failsafe. |
| Safari nativo (macOS) | `cd e2e && npm run test:safari` | Só no macOS, com `safaridriver --enable` feito uma vez (`sudo`). Sobe os servidores do harness se não estiverem no ar e dirige o Safari instalado pelo WebDriver: portal, login pela interface (`SAFARI_TEST_USER`/`SAFARI_TEST_PASSWORD`, padrão superadmin), sala A-108 com o ESP32 simulado online por WebSocket, ligar/desligar, `Administração > Status`, logout, sem rolagem horizontal e sem erros de JavaScript. `SAFARI_PLATFORM=ios` repete o fluxo no Safari de um iPhone do iOS Simulator: o script liga o simulador mais recente disponível (ou o nome dado em `SAFARI_IOS_DEVICE`), abre o Simulator.app e cria a sessão com até três tentativas. No simulador, o "Element Click" do safaridriver não chega à página e o "Element Send Keys" não digita, então os toques são feitos pela Actions API (toque, com o teclado dispensado antes) e os campos de login são preenchidos pelo DOM. Nos runners hospedados do GitHub esse modo foi intermitente (pareamento e toques) e nunca passou do portal; trate-o como diagnóstico para um Mac com o Simulator aberto, não como evidência de suporte ao iOS. Imprime um relatório JSON e sai com erro no primeiro passo que falhar. |
| App iOS no simulador | `cd remoteifes-cordova && npm run prepare-ios && npm run build-ios -- --emulator && npm run test-ios` | Só no macOS com Xcode. Veja [iOS e recursos visuais](#ios-e-recursos-visuais) para o escopo exato do que é comprovado. |
| Configuração Cordova | `cd remoteifes-cordova && npm ci && npm run validate` | Não precisa do SDK do Android. Confere a estrutura do `config.xml`, a coerência entre `config.xml` e `android-release.json`, a geração e a monotonia do `versionCode`, as recusas de publicação inconsistente, a reversibilidade de `harden-config.js` (produção ↔ desenvolvimento, byte a byte) e a saída de `sync-www.js`. |
| Firmware ESP32 | `cd remoteifes-esp32 && pio run` | Compila o firmware com o PlatformIO (partição `min_spiffs.csv`, dois slots de aplicação para OTA). |
| ESP32 real (opcional) | `python3 remoteifes-esp32/tools/serial-smoke.py /dev/ttyUSB0` | Requer `pyserial` e uma placa conectada. Reinicia o ESP32 pela linha serial e confirma que o firmware inicializa (imprimindo a versão), entra na rotina de rede e, quando aplicável, conclui a autovalidação de OTA. Independe do servidor central estar no ar. |

### Health check do servidor central

`GET /health` responde o estado do servidor central (conexão com o banco e tempo de processo) sem exigir autenticação. Retorna `200` com `{"ok":true,"banco":"ok",...}` quando o banco responde e `503` quando não. **Não depende de nenhum ESP32**: um dispositivo offline não afeta o resultado.

### CI

`.github/workflows/ci.yml` roda em cada pull request, em cada push para `main` e sob demanda em **Actions > CI > Run workflow**. O primeiro job (*Select checks*) compara os arquivos alterados pelo evento e escolhe o que precisa rodar; o último (*CI result*) sempre roda e só fica verde se todo job escolhido passou e todo job não escolhido foi de fato pulado, então é ele que deve ser exigido caso um status check obrigatório seja configurado. Há dois níveis:

- **Validação rápida** (pull requests): só os subsistemas afetados, com o end-to-end apenas no Chromium do Ubuntu, dividido em quatro shards paralelos;
- **Validação completa**: todos os navegadores e sistemas dos subsistemas afetados em cada push para `main` (que é o que vai para produção), e de **todos** os subsistemas no **Run workflow**. O campo opcional `expected_sha` faz a execução falhar se o ramo tiver avançado para outro commit, garantindo que o resultado vale exatamente para o SHA escolhido.

| Mudança em | Validação rápida | Validação completa acrescenta |
|---|---|---|
| `remoteifes-server/` | servidor em Ubuntu, Windows e macOS; Console de Operações; end-to-end Chromium | end-to-end em todos os navegadores; Safari nativo |
| `remoteifes-console/` | Console de Operações e instalação do pacote nos três sistemas | — |
| `remoteifes-web/` | contratos do frontend nos testes do servidor (Ubuntu); end-to-end Chromium; Cordova; builds Android e iOS | end-to-end em todos os navegadores; Safari nativo |
| `remoteifes-cordova/` | contratos do app nos testes do servidor; Cordova; builds Android e iOS | — |
| `remoteifes-esp32/` | build do firmware; contratos de dispositivo nos testes do servidor | — |
| `e2e/specs/` | end-to-end Chromium | end-to-end em todos os navegadores; Safari nativo |
| `e2e/` (harness, configuração, lockfile) | end-to-end em todos os navegadores; Safari nativo | — |
| `README.md`, `docs/`, scripts Git da raiz | testes de contrato da documentação (servidor, Ubuntu) | — |
| `.github/workflows/`, `.github/scripts/`, caminho não mapeado ou diff indeterminável | validação completa de tudo | — |

Arquivos renomeados contam pelo caminho antigo e pelo novo, e removidos também contam. As regras ficam em `.github/scripts/select-checks.js`, testadas por `select-checks.test.js` no próprio job de seleção. Uma execução nova no mesmo pull request ou ramo cancela a anterior; um **Run workflow** nunca é cancelado por um push posterior, e o deploy do GitHub Pages nunca é interrompido no meio.

O que cada job cobre:

- servidor (`npm test` + health check); os testes do servidor incluem os contratos do frontend, do app Cordova, do firmware e da documentação;
- Console de Operações (`npm test` + medição de recursos) e pacote instalável (build, procedência, instalação a partir do artefato, execução pelo lançador sem ferramentas de desenvolvimento no PATH, `.deb` no Linux, desinstalação preservando o estado) em Ubuntu, Windows e macOS;
- frontend end-to-end (Playwright) em Ubuntu com Chromium, Firefox e WebKit, em Windows com o Microsoft Edge do sistema (`E2E_BROWSER_CHANNEL=msedge`) e Firefox, e em macOS com o Google Chrome do sistema, cada combinação dividida em shards independentes (cada shard sobe seu próprio harness);
- Safari nativo: `e2e/harness/safari-smoke.js` dirige o Safari do macOS pelo `safaridriver` (WebDriver, sem dependência npm), contra os mesmos servidores do harness — portal, login pela interface, sala com ESP32 simulado por WebSocket, ligar/desligar, administração, logout, ausência de rolagem horizontal e de erros de JavaScript. O WebKit do Playwright não é usado como evidência de Safari. O mesmo smoke no Safari de um iPhone do iOS Simulator só roda sob demanda (**Run workflow** com `ios_safari`), porque nos runners hospedados o pareamento do `safaridriver` com o simulador e a entrega dos toques foram intermitentes; ele é um diagnóstico, não uma evidência exigida;
- validação de configuração Cordova em Ubuntu e Windows (o checkout com CRLF do Windows exercita a restauração byte a byte de `harden-config.js`);
- build do firmware ESP32;
- Android (`android.yml`) e iOS (`ios.yml`), chamados pelo CI como workflows reutilizáveis.

`.github/workflows/ios.yml` (macOS) prepara a plataforma iOS com o `cordova-ios` travado no lockfile, compila o app para o iOS Simulator com o Xcode do runner e executa `npm run test-ios`; veja [iOS e recursos visuais](#ios-e-recursos-visuais) para o que essa execução comprova. Nenhum token adicional é necessário.

A branch `main` é protegida por um ruleset do GitHub (**Settings > Rules > Rulesets**, regra `main`) que bloqueia a exclusão da branch e qualquer push que não seja fast-forward (`push -f`, rebase publicado), sem exceção para administradores. Pushes normais, `export.py` e `import.py` continuam iguais; um erro do tipo `non-fast-forward` ou `deletion` vindo do GitHub indica a regra, não um problema local. Como o fluxo do projeto é de push direto em `main`, a regra não exige pull request nem status checks — exigir checks bloquearia todo push direto.

Todas as actions dos workflows são referenciadas pelo SHA completo do commit (a versão correspondente fica em comentário ao lado), de modo que uma tag movida ou comprometida no repositório da action não altera o que o CI executa. O `.github/dependabot.yml` abre mensalmente um único pull request agrupado com as atualizações dessas actions dentro da mesma versão maior (o que as tags `@vN` anteriores já acompanhavam); ao aceitá-lo, o SHA e o comentário de versão avançam juntos. A troca de versão maior de uma action continua sendo uma decisão manual.

## Uso da API do GitHub

O **RemoteIFES** não depende da API do GitHub em tempo de execução: nenhuma operação do prédio — salas, agendamentos, contas, ESP32 — consulta a rede externa. O uso do GitHub no projeto se limita à hospedagem do código-fonte, ao workflow opcional `.github/workflows/pages.yml` que publica `remoteifes-web` no GitHub Pages e ao workflow de CI descrito em [Testes e Integração Contínua](#testes-e-integração-contínua). A publicação usa apenas o `GITHUB_TOKEN` efêmero fornecido automaticamente ao workflow, com a permissão mínima `pages: write`/`id-token: write`.

O **Console de Operações** é a exceção, e é uma exceção deliberada e sob demanda:

- a aba *Aplicativo e CI* consulta a API do GitHub **somente quando alguém clica**, para mostrar o estado das execuções de CI. A credencial fica no estado do console, nunca volta por API e não acompanha redirecionamento para outro host;
- a atualização do **programa console** busca o manifesto e o artefato de release por HTTPS, **sem enviar credencial alguma** em nenhum salto, e só aceita o que a assinatura Ed25519 e o digest confirmarem.

Nenhum dos dois é pré-requisito de operação: sem rede, o console continua administrando o host, e a aplicação continua operando o prédio.

## Estrutura de Pastas

```
remoteifes-server/
  setup.sh          instalação e configuração automatizadas (Node.js, dependências, .env)
  install-service.sh configura o serviço systemd + watchdog de saúde (auto-start no boot, ex.: Raspberry Pi)
  lan-setup.sh       proxy reverso Nginx na porta 80 para a rede local (sem Internet/Certbot)
  https-setup.sh     configuração automatizada de HTTPS (Nginx + Certbot) para domínio público
  deploy.sh          atualização protegida (backup pré-update, health check, auto-rollback) — npm run deploy
  rollback.sh        volta para a versão anterior ou uma tag, com backup do banco — npm run rollback
  verificar-versao.sh  verificação da versão em execução compartilhada por deploy.sh e rollback.sh
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
    routes/            rotas HTTP (login, documentação por papel, aplicativo móvel/APK, salas, comandos, agendamentos, admin, dispositivo,
                        painel dos ESP32 (esp32AdminRoutes), Protocolos IR (protocolosIrRoutes), relatos)
    services/          regras de negócio (usuários, salas, agendamentos, configurações, notificações,
                        relatos de problema, sessões/tokens, status em tempo real, backup do banco,
                        OTA de firmware (otaService) e sua distribuição em etapas (otaRolloutService),
                        biblioteca de protocolos IR, clonador oficial e failsafe (protocolosIrService),
                        credenciais de dispositivo (esp32CredenciaisService),
                        monitoramento operacional com amostragem e histórico consolidado por hora (monitoramentoService),
                        documentação administrativa por papel (documentationService))
    scheduler/         verificação periódica de agendamentos, timeouts de ESP32 e de OTA, sessões abandonadas, monitoramento, amostra de histórico a cada minuto e backup
    utils/             funções auxiliares (data/hora em fuso de Brasília, rate limiting, faixas de rede)
  test/               testes de regressão do servidor (node:test) — API, permissões, WebSocket, /health, backup, OTA, credenciais de dispositivo, monitoramento,
                        Protocolos IR e clonador (ir-protocols*.test.js), Auto-ON (auto-on-control.test.js), contrato do firmware (firmware-contract.test.js)

remoteifes-web/        frontend estático; em produção é servido pelo Express na mesma origem da API
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
    charts.js          gráficos SVG leves do monitoramento (linhas/área, colunas, barras horizontais e rosca) com leitura por teclado/toque, resumo e tabela
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
                        esp32-admin.js (painel avançado de cada ESP32 — status, papel, failsafe, OTA e credenciais —
                        em Dispositivos > Firmware / OTA, restrito ao superadministrador),
                        protocolos-ir-admin.js (clonador oficial, modo clone, capturas com nome, biblioteca e failsafe OFF —
                        em Dispositivos > Protocolos IR, restrito ao superadministrador),
                        monitoramento.js (aba "Status > Sistema" do painel administrativo, restrita ao superadministrador: cartões, histórico e gráficos),
                        manual.js (sobreposição do manual completo: sumário, busca, navegação e foco),
                        mobile-app.js (página #/aplicativo: estado da versão instalada, instalação guiada, atualização e download do APK verificado)

remoteifes-esp32/         projeto PlatformIO (framework Arduino, placa esp32dev, partição min_spiffs.csv para OTA)
  platformio.ini           configuração do projeto, versão do firmware (-DFW_VERSAO) e dependências
  src/main.ino              firmware principal (Wi-Fi, papel transmissor/clonador recebido do servidor, modo
                            operação/clone, IR, failsafe OFF na NVS, switch físico, buzzer, DHT, WebSocket cliente com o
                            servidor, portal AP de provisionamento, OTA A/B com autovalidação e reversão, credencial por dispositivo)
  include/root_ca.h         certificado raiz (Let's Encrypt) usado quando o firmware se conecta ao servidor via HTTPS
  data/                     arquivos gravados no sistema de arquivos LittleFS do dispositivo
    setup.html               formulário do portal de provisionamento (rede e servidor)
    restart.html             página de confirmação exibida após salvar a configuração
  tools/serial-smoke.py     smoke test de hardware: reinicia o ESP32 pela serial e confere o boot e a rotina de rede
  flash.sh                  instala o PlatformIO Core (se necessário) e compila/grava firmware + sistema de arquivos

remoteifes-cordova/     empacotamento nativo Android/iOS (veja Empacotamento como PWA e Aplicativo Nativo)
  config.xml             configuração do app (id, nome, ícone, splash, permissões de rede) — modo de desenvolvimento por padrão
  harden-config.js       reescreve config.xml para produção (origem única) ou de volta para desenvolvimento (--dev)
  validate-config.js     valida config.xml, a reversibilidade de harden-config.js e a saída de sync-www.js (npm run validate)
  android-release.json    fonte única da versão Android publicável (versionName, versionCode, data, notas)
  android-version.js      define a versão, avança o versionCode e propaga para o config.xml
  package.json            scripts de sync/build/run/harden-config/android-version e plugins Cordova do projeto
  sync-www.js             copia remoteifes-web para www/ antes de cada build (não editar www/ manualmente)
  resources/              imagens-fonte (icon.png, splash.png) usadas por cordova-res
  www/                    cópia gerada de remoteifes-web (gitignored fora de commits manuais, se preferir)

e2e/                     testes end-to-end de navegador (Playwright) — specs, harness (API + estático + ESP32 simulado)
.github/workflows/ci.yml workflow de CI: testes do servidor, end-to-end, validação Cordova e build do firmware
docs/                    material de apoio do projeto (imagens, documento acadêmico)
export.py / import.py / clear.py   scripts auxiliares de Git (veja Scripts Auxiliares)
```

## Solução de Problemas

Cada item segue a mesma leitura: **sintoma** (o que se vê) → o que **verificar** → o que isso **significa** → o que **fazer**. No fim de cada grupo está a **escalação**: para onde ir quando o item não resolve. Ao relatar um problema, informe a ação tentada, a mensagem exibida, a sala e o horário — nunca senhas, tokens ou segredos de ESP32.

### Servidor, rede e serviço

- **`EADDRINUSE` / porta 8080 ocupada**: descubra o processo com `ss -ltnp 'sport = :8080'` (use `sudo ss -ltnp 'sport = :8080'` se o nome/PID não aparecer). Se já for uma instância do RemoteIFES, use-a ou pare-a pelo mesmo método com que foi iniciada; não abra uma segunda instância sobre o mesmo banco. Confirme depois com `curl -fsS http://localhost:8080/health` ou `npm run health`.
- **Servidor parece iniciado, mas a tela não abre**: `curl -fsS http://localhost:8080/health` deve retornar JSON com `"ok":true`, e `curl -I http://localhost:8080/` deve indicar conteúdo HTML. Confira também `ss -ltnp 'sport = :8080'`. Se `/health` funciona mas `/` não é HTML, confirme `SERVIR_FRONTEND=true` e reinicie o processo.
- **Servidor não inicia por causa do `node:sqlite`**: confirme que o Node.js instalado é 22.13 ou superior (`node -v`); versões anteriores não têm o módulo nativo `node:sqlite` usado pelo projeto.
- **`setup.sh` não consegue instalar o Node.js automaticamente**: confirme a conexão com a internet (o script baixa o binário oficial de `nodejs.org`); em arquiteturas fora de x64/ARM64/ARMv7, ou caso o download falhe, instale manualmente em https://nodejs.org/en/download e rode `npm run setup` novamente.
- **`install-service.sh` falha com "systemd não encontrado"**: o script só funciona em Linux com `systemd` (padrão no Raspberry Pi OS); em outras distribuições, use um gerenciador de processo alternativo como `pm2`.
- **Serviço `remoteifes.service` não inicia**: rode `sudo journalctl -u remoteifes.service -f` para ver o erro; confira se `remoteifes-server/.env` existe e está com as variáveis esperadas (veja [Configuração](#configuração)), e rode `sudo systemctl restart remoteifes.service` após qualquer correção.
- **Perda temporária ou endereço incorreto**: uma queda momentânea mostra “Reconectando automaticamente…” e a interface recupera sozinha quando HTTP/WebSocket voltam. Falha persistente desde a abertura, `/health` inacessível pelo mesmo dispositivo ou acesso por um IP antigo indica endereço, porta, firewall, proxy ou rede autorizada incorretos. No fluxo integrado, abra novamente `http://IP_DO_SERVIDOR:8080`; não troque a configuração por causa de uma interrupção breve.
- **Acesso bloqueado em produção mesmo dentro da rede do IFES**: confira as faixas CIDR e, temporariamente, o modo de teste no Console de Operações (`Rede e domínio › Acesso à aplicação`) ou com `npm run redes` no servidor; o site só exibe esses valores. A mesma restrição vale para a conexão WebSocket.
- **Restrição de rede ou limite de tentativas de login parecem não fazer efeito**: confira `TRUST_PROXY` no `.env` — o valor precisa corresponder ao número real de proxies reversos na frente do servidor (`1` para o Nginx de `https-setup.sh`, `0` se o Node estiver exposto diretamente); um valor maior que o real permite que o IP de origem seja falsificado via `X-Forwarded-For`, contornando as duas proteções.
- **Frontend não fala com o servidor depois do deploy**: na implantação same-origin, acesse a URL do próprio servidor/proxy e não configure `serverUrl` nem `CORS_ORIGIN`. Se o frontend estiver em outra origem (GitHub Pages ou Cordova), confirme `serverUrl` e inclua a origem dele em `CORS_ORIGIN`; isso também afeta a conexão WebSocket.
- **Status das salas não atualiza sozinho**: o painel depende da conexão WebSocket (`/ws`); se ela cair, o frontend reconecta automaticamente com espera crescente, e há uma retransmissão de reforço a cada 30 segundos. Depois de o celular voltar do segundo plano, a prova de vida da conexão pode levar alguns segundos até reconectar — uma falha persistente costuma indicar bloqueio de rede/proxy para conexões WebSocket ou a mesma causa do item anterior (CORS/rede autorizada).
- **Live Server abre a interface, mas não representa a implantação**: ele é apenas o modo opcional de [frontend em origem separada](#frontend-em-origem-separada-desenvolvimento-opcional). Para teste integrado, pare-o e use `http://localhost:8080` ou `http://IP_DO_SERVIDOR:8080`.

Se persistir: `sudo journalctl -u remoteifes.service -f`, `npm run health`, `Administração > Sistema > Status > Sistema` (superadministrador) e, em último caso, [rollback](#atualização-versões-e-reversão) para a última versão boa.

### Interface, PWA e aplicativo

- **PWA mostra frontend antigo após uma alteração**: abra uma vez com a rede disponível e aguarde alguns segundos — o novo service worker instala o app-shell, assume o controle e recarrega a aba sozinho. Se a tela continuar antiga, a causa quase sempre é a versão não ter sido avançada na release: confirme que `remoteifes-web/version.json`, `index.html`, `js/version.js`, `manifest.webmanifest` e `sw.js` apontam para a mesma versão (`npm test` cobre isso) e que `/index.html`, `/sw.js` e `/version.json` são servidos com `Cache-Control: no-cache`. Desregistrar o worker ou limpar o armazenamento não faz parte do procedimento normal.
- **Botão de instalar o PWA não aparece no navegador**: confirme que o frontend está em HTTPS e que o navegador atende aos demais critérios de instalação. O `serverUrl` também deve usar HTTPS para a API funcionar sem bloqueio de conteúdo misto, mas não é ele que determina se o navegador oferece a instalação.
- **`cordova build android` falha por SDK não encontrado**: confirme que `ANDROID_HOME` aponta para o Android SDK, que Platform 36/Build Tools 36 estão instalados, que o JDK 17 está em `JAVA_HOME`/`PATH` e que o Gradle 8.14.2 está no `PATH` para inicializar o wrapper; rode `npx cordova requirements android` dentro de `remoteifes-cordova` para diagnosticar o que falta.
- **App Cordova não fala com o servidor central**: em desenvolvimento, um app sem origem mostra **Conectar este aplicativo** na primeira abertura; limpe os dados/reinstale o app para refazer essa configuração inicial. Em produção, gere outro APK com o `REMOTEIFES_SERVER_URL` correto e confirme que a configuração endurecida libera exatamente essa origem — uma indisponibilidade temporária só tenta reconectar e não permite trocar a infraestrutura.

Se persistir: confira a versão em `remoteifes-web/version.json` contra a que o navegador carregou (meta `remoteifes-version`) e a origem que o app usa; um relato pelo próprio app anexa página, navegador e viewport.

### ESP32, firmware e infravermelho

- **`pio run` falha ao baixar a plataforma `espressif32`**: o PlatformIO precisa de acesso à internet na primeira compilação (para baixar o toolchain do ESP32 e resolver as bibliotecas de `platformio.ini`); confirme a conexão e tente novamente — compilações seguintes reaproveitam o cache local (`~/.platformio`). No Ubuntu 24.04, não contorne a proteção de Python gerenciado com `pip --break-system-packages`: instale `pipx` pelo gerenciador de pacotes e rode `flash.sh` novamente.
- **`flash.sh` não encontra a porta serial do ESP32**: confirme que o cabo USB usado transmite dados (não é só de carga) e que os drivers do conversor USB-serial (CP210x ou CH340, conforme a placa) estão instalados; informe a porta manualmente, ex.: `bash flash.sh /dev/ttyUSB0`.
- **ESP32 não aparece como online**: confirme que o dispositivo aparece em `Administração > Dispositivos > Cadastro`, vincule seu MAC a uma sala e verifique se ele alcança o endereço/porta do servidor pela rede local. `pio device monitor -b 115200 -p /dev/ttyUSB0` mostra o estado de Wi-Fi, identificação e WebSocket em tempo real.
- **ESP32 aparece em "ESP32 detectados na rede" mas nunca fica online**: vincule o MAC detectado a uma sala existente em `Administração > Dispositivos > Cadastro`; o vínculo é recebido automaticamente na próxima consulta do dispositivo.
- **Heartbeat rejeitado com erro de MAC**: a sala já tem um MAC diferente cadastrado em `Administração > Dispositivos > Cadastro`; atualize o cadastro ou libere a sala novamente para o ESP32 correto.
- **ESP32 perde conexão Wi-Fi e não volta sozinho**: o firmware tenta reconectar automaticamente a cada 30 segundos, sem reiniciar. Durante a operação normal o AP `RemoteIFES-Setup` fica desligado; para reconfigurar no local, dê um clique curto no switch físico (abre o portal por dez minutos) ou use **Resetar Wi-Fi** no painel central. Se a falha persistir, verifique o sinal e as credenciais; use o reset de Wi-Fi somente quando elas realmente mudarem.
- **Não consigo capturar IR em `Administração > Dispositivos > Protocolos IR`**: confirme que a placa física com receptor foi salva como **clonador oficial** e está conectada; use **Entrar no modo clone** — esse único comando já ativa o receptor em captura contínua. O servidor descarta capturas de qualquer outra placa, de uma placa fora do modo clone ou de um ESP32 substituído: se a tela avisar que o vínculo mudou (MAC ou credencial), salve a clonadora novamente. O tipo do módulo não é escolhido no `RemoteIFES-Setup`.
- **Failsafe OFF não aparece como gravado na ESP32**: o failsafe é opcional e vem do protocolo. Em `Protocolos IR`, configure o failsafe do protocolo transmitindo somente o botão de desligar do controle original e aplique esse protocolo à sala; o RAW é enviado e gravado na NVS, e o campo **Failsafe OFF na NVS** em `Firmware / OTA` passa a mostrar "gravado" quando a placa confirma. Se ela estava offline, a sincronização acontece na reconexão. Aplicar um protocolo sem failsafe apaga um RAW antigo de propósito.
- **Switch físico**: um único botão no GPIO 26 (`INPUT_PULLUP`, ligado ao GND). Clique curto abre o `RemoteIFES-Setup` por dez minutos sem derrubar a operação; manter pressionado por 5 s transmite uma única vez o failsafe OFF gravado. Soltar depois dos 5 s não abre o AP, e sem failsafe gravado a pressão longa não transmite nada. O buzzer no GPIO 27 confirma cada transmissão IR.

Se persistir: o monitor serial (`pio device monitor -b 115200`) é a evidência primária; `Administração > Sistema > Logs > Dispositivos` mostra as quedas e retornos, e a [gravação por USB](#firmware-esp32) é a recuperação de referência. Lembre que "online" é presença e a confirmação da placa não prova que o aparelho recebeu o infravermelho.

### Contas, permissões e sessões

- **Não sei a senha do `superadmin` (ou o login não funciona) após clonar**: em um banco novo sem `SENHA_ADMIN_INICIAL`, use `superadmin` / `admin`; o sistema mostra somente a essa conta um aviso persistente com acesso direto à troca. Rode `npm run reset-admin -- umaSenhaEscolhida` para usar uma senha definida por você, ou `npm run reset-admin` para restaurar `admin`. A senha não é impressa no terminal.
- **Usuário com "pode controlar" ativo não consegue controlar uma sala específica**: verifique se a sala está marcada como "acesso restrito" em `Administração > Dispositivos > Cadastro` — nesse caso, o usuário precisa ser adicionado explicitamente à lista de acesso daquela sala (diretamente pelo admin, ou por um proprietário da sala).
- **Aba "Grade" ou "Agenda" não aparece**: essas abas só ficam visíveis para administradores; usuários comuns não têm acesso a elas.
- **Aba "Config." não aparece para um usuário comum**: ela só é exibida quando o usuário foi tornado proprietário de ao menos uma sala em `Administração > Gestão > Usuários > Proprietários de sala`.
- **`Dispositivos > Firmware / OTA` ou `Protocolos IR` não aparece no painel administrativo**: essas funções são restritas ao superadministrador, assim como `Dispositivos > Cadastro` e `Sistema > Configurações`; um grupo cujas funções estejam todas fora do seu nível nem chega a ser exibido.

Se persistir: um administrador confere a conta em `Administração > Gestão > Usuários` e a sala em `Dispositivos > Cadastro` (superadministrador); `Sistema > Logs > Sessões` e `Auditoria` mostram o que mudou e quando.
