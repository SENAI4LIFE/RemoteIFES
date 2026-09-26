# Figuras do README

Figuras, fluxos e capturas usados no [README principal](../../README.md), com as fontes para editá-los. Cada conceito fica num arquivo próprio: trocar um módulo ou refazer uma figura não mexe nas outras.

| Arquivo | Seção do README | Formato | Fonte da verdade |
|---|---|---|---|
| `composed/architecture-overview-{light,dark}.png` | Visão Geral | PNG composto | `remoteifes-server/src/app.js`, `src/services/deviceHub.js`, `remoteifes-console/ARQUITETURA.md` |
| `composed/management-boundaries-{light,dark}.png` | Console de Operações | PNG composto | `remoteifes-console/ARQUITETURA.md` §1, `src/acoes.js`, `src/rede.js`, `web/index.html` |
| `composed/device-networking-{light,dark}.png` | Rede Mesh Opcional e Topologia | PNG composto | `remoteifes-esp32/MESH.md`, `remoteifes-server/src/services/meshService.js` |
| `flows/command-state-flow.svg` | Do pedido ao ar-condicionado | SVG | `remoteifes-server/src/services/salasService.js` (`aplicarComando`), `deviceHub.js` (`estadoConfirmado`), `MESH.md` |
| `flows/update-recovery.svg` | Atualização, versões e reversão | SVG | `remoteifes-server/deploy.sh`, `rollback.sh`, `verificar-versao.sh` |
| `composed/esp32-hardware-{light,dark}.png` | Firmware ESP32 | PNG composto | `remoteifes-esp32/src/main.ino` (`DHTPIN`, `DHTTYPE`, `IR_SEND_PIN`, `IR_RECV_PIN`, `BUZZER_PIN`, `ACTION_SWITCH_PIN` com `INPUT_PULLUP`), `platformio.ini` (`board`) |
| `composed/ir-cloning-{light,dark}.png` | Protocolos IR | PNG composto | `remoteifes-server/src/routes/protocolosIrRoutes.js`, `services/protocolosIrService.js` (`isKnown`), `services/deviceHub.js` (`MAX_CAPTURAS_ARMAZENADAS`), `remoteifes-esp32/src/main.ino` (failsafe na NVS, botão de 5 s) |
| `composed/esp32-ota-{light,dark}.png` | Atualização de Firmware por OTA | PNG composto | `remoteifes-esp32/src/main.ino` (`iniciarOtaOferta`, `verificarValidacaoOta`, `OTA_SELFTEST_TIMEOUT_MS`), `remoteifes-server/src/services/otaService.js` (fases e `OTA_TIMEOUT_*`) |
| `composed/credential-rotation-{light,dark}.png` | Credenciais por Dispositivo | PNG composto | `remoteifes-server/src/services/esp32CredenciaisService.js` (`rotacionar`, `entregarPendente`, `verificar`, `GRACE_ROTACAO_MS`, `reentregarAtual`), `services/deviceHub.js`, `remoteifes-esp32/src/main.ino` (`aplicarCredencial`) |
| `screenshots/*.png` | topo, Navegação, Agendamentos, Dispositivos, Monitoramento, Atualização, Topologia | captura real | a própria interface |

Quando a fonte da verdade mudar, a figura muda junto. Uma figura desatualizada é um defeito da documentação. Uma figura técnica mostra só o que essas fontes estabelecem: a de hardware traz os pinos de sinal, e não alimentação, resistores ou o acionamento do LED, que o repositório não define.

## PNG compostos

Cada figura é uma página em `src/<nome>.html`: o layout é CSS, os rótulos são texto de verdade e os conectores são declarados em `window.CONECTORES` e desenhados por `src/conectores.js` entre elementos nomeados, depois do layout. Mudar um rótulo ou mover um cartão não exige recalcular coordenadas. `src/tema.css` guarda a paleta do app (`remoteifes-web/css/style.css`) e a versão escura, e os ícones pequenos vêm do sprite de `remoteifes-web/index.html`.

```bash
cd e2e && npm ci && cd ..                                   # uma vez: o Playwright vem das dependências do e2e
node docs/readme-assets/src/compor.js                       # todas as figuras
node docs/readme-assets/src/compor.js device-networking     # uma só
```

As figuras técnicas `esp32-hardware`, `ir-cloning`, `esp32-ota` e `credential-rotation` usam o mesmo esquema: módulos (`esp32`, `server`, `database`, `air-conditioner` e as peças abaixo) com cartões e conectores. Cada `src/<nome>.html` cita no topo os arquivos de onde tira os fatos.

O script gera `-light.png` e `-dark.png` a 2× a largura exibida (800 px), escolhidas no README por `<picture>` conforme o tema do GitHub. Ele usa o Chromium do Playwright quando instalado e, senão, o Edge ou o Chrome do sistema. A fonte é a do sistema, então revise as imagens antes de commitar se gerar em outro sistema operacional.

## Módulos

`modules/*.png` são ilustrações de 256 px com fundo transparente, cada uma com um único objeto:

- hardware real, desenhado de forma realista e simplificada: `server.png` é um Raspberry Pi, `esp32.png` é uma placa de desenvolvimento ESP32;
- `wifi-ap.png` é o mesmo `esp32.png`, menor, com o símbolo de Wi-Fi (três arcos e um ponto, `#2a78d4`) acima da placa, fora dela. Representa o ESP32 no papel de raiz da malha, usado no cartão do gateway. Ao trocar o `esp32.png`, refaça os dois juntos;
- peças da placa: `ir-led.png` (LED infravermelho de 5 mm), `ir-receiver.png` (receptor IR de três terminais), `push-button.png` (botão tátil), `buzzer.png`, `dht11.png` e `remote-control.png` (controle remoto do aparelho). Ilustram o tipo de peça, não um modelo ou fabricante: o firmware só fixa o DHT11 (`DHTTYPE`). Foram geradas juntas numa folha de 3 × 2 com fundo transparente, a partir de um pedido que listava só as peças que o firmware usa, e recortadas como os outros módulos, a 90 % de um quadro de 256 px;
- conceitos, no estilo de ícone de produto: navegador, celular, banco, console e ar-condicionado.

Direto, gateway e nó são o mesmo hardware e o mesmo firmware; o papel vem do rótulo e, no gateway, do símbolo de Wi-Fi. Credencial, cifra e limites ficam em selos e legendas da figura, nunca desenhados dentro do objeto. Um módulo novo mantém a vista de três quartos, a luz de cima à esquerda, a paleta do app e nenhum texto, logotipo ou marca.

## Fluxos SVG

Os SVG são editados direto e servem aos dois temas com um arquivo só: todo texto fica sobre um cartão ou pílula opaca, e as linhas usam tons médios que mantêm contraste de 3:1 no branco e no fundo escuro do GitHub. Cada etapa é um `<g>` comentado.

## Capturas

As capturas vêm do harness de testes (`e2e/harness/api-server.js` e `static-server.js`): banco temporário, ESP32 simulados e contas de teste. Nunca use um ambiente de produção nem invente uma tela.

As seis capturas mais novas são refeitas por `src/capturar.js`. Ele sobe o harness nas portas 8891 e 8890, prepara os dados pela API e pelas rotas de teste do próprio harness e grava o PNG já acabado. O harness roda o código real do servidor, por isso precisa também das dependências de `remoteifes-server`:

```bash
cd remoteifes-server && npm ci && cd ..                            # uma vez
cd e2e && npm ci && cd ..                                          # uma vez
node docs/readme-assets/src/capturar.js                            # todas
node docs/readme-assets/src/capturar.js floorplan                  # uma só
CAPTURA_SAIDA=/tmp/ensaio node docs/readme-assets/src/capturar.js  # ensaio fora do repositório
```

O estado preparado:

- superadmin com a senha padrão trocada por uma aleatória;
- A-110, A-109 e A-107 com credencial, A-106 e A-104 só por MAC, cada uma com uma placa simulada que fala o protocolo do firmware 4.3.0 (A-107 no 4.2.0);
- A-110, A-107 e A-106 ligadas, e uma reserva em curso em A-109;
- quatro agendamentos do dia em A-107, nos três modos;
- firmware 4.3.0 publicado;
- a placa do harness em A-108 como clonadora em modo clone, um protocolo COOLIX salvo com failsafe OFF e aplicado em A-107, e uma captura nova pendente;
- 26 horas de amostras de monitoramento (`/__e2e/monitoramento-historico`).

O navegador é o mesmo de `compor.js`. As duas portas precisam estar livres: ocupadas, o script para antes de preparar qualquer dado, porque senão prepararia o que estivesse respondendo nelas. Uma falha sai com código diferente de zero e ainda desliga as placas simuladas e o harness, que apaga o banco temporário.

A barra de abas e os botões flutuantes de acessibilidade e ajuda ficam ocultos no recorte: presos à janela, eles passariam por cima da área recortada. Datas e horas são as do dia em que o script roda.

| Arquivo | Tela e conta | Janela | Recorte | Largura final |
|---|---|---|---|---|
| `floorplan.png` | `#/salas/planta/a-terreo`, `e2e_admin` | 1100 × 1200 | legenda, abas, planta e zoom | 1600 px |
| `schedule.png` | `#/agenda/A-107`, `e2e_admin` | 620 × 2200 | lista de agendamentos | 790 px |
| `schedule-grid.png` | `#/grade/A-107/<hoje>`, `e2e_admin` | 620 × 1600 | legenda e grade | 790 px |
| `firmware-ota.png` | `#/admin/esp32`, superadmin | 1280 × 1400 | cartão de A-107 | 1600 px |
| `ir-protocols.png` | `#/admin/protocolos`, superadmin, destino A-107 | 1280 × 1400 | clonador, última captura e protocolos salvos | 1600 px |
| `system-monitoring.png` | `#/admin/status/sistema`, superadmin | 1280 × 1400 | Histórico e gráficos, 24 h, até o gráfico de falhas | 1600 px |

Os cartões de status acima dos gráficos ficam fora do recorte: mostram o disco e o caminho do banco temporário da máquina que roda o harness.

As quatro capturas anteriores foram feitas à mão, com o mesmo harness:

| Arquivo | Como foi capturado | Largura final |
|---|---|---|
| `home.png` | conta `e2e_admin`, `#/inicio`, janela de 1000 × 1100 a 2×, corte do topo com 760 px | 1160 px |
| `room-panel-mobile.png` | conta `e2e_user`, sala A-108 ligada por `POST /comando`, janela de 390 × 844 a 2× | 408 px |
| `topology.png` | superadmin com a senha padrão trocada no banco temporário; A-110 direta por credencial, gateway B-204 e nós B-206 e B-208 pelo protocolo real (`remoteifes-server/test/support/mesh-reference.js`); janela de 1280 px a 2×, B-206 selecionada, corte do diagrama e do painel | 1600 px |
| `console-updates.png` | console rodando do checkout com `CONSOLE_SEM_PRIVILEGIO=1` e estado temporário, apontado para um clone limpo com origin no GitHub, o harness na porta 8080 no papel da aplicação; aba Atualizações depois de **Verificar origin**; janela de 900 px a 2× | 1240 px |

O acabamento é o mesmo em todas: largura final de 2× a exibida, cantos de 10 px e borda de 1 px `#c8d1cb` na largura exibida. Antes de commitar, confira que não aparece senha, token, segredo, IP privado, nome de máquina ou caminho de usuário. Os MAC `AA:BB:CC:E2:E2:xx` e os `deviceId` que aparecem são das placas simuladas.

## Regras

- Toda imagem do README tem texto alternativo que descreve as relações, não os pixels.
- Cor nunca é o único canal: forma, rótulo e estilo de linha dizem a mesma coisa.
- Confira cada figura sobre `#ffffff` e sobre `#0d1117`.
- Mudanças só em `docs/` e no `README.md` não avançam a versão do frontend; o CI roda apenas os testes de documentação.
