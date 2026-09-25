# Figuras do README

Figuras, fluxos e capturas usados no [README principal](../../README.md), com as fontes para editá-los. Cada conceito fica num arquivo próprio: trocar um módulo ou refazer uma figura não mexe nas outras.

| Arquivo | Seção do README | Formato | Fonte da verdade |
|---|---|---|---|
| `composed/architecture-overview-{light,dark}.png` | Visão Geral | PNG composto | `remoteifes-server/src/app.js`, `src/services/deviceHub.js`, `remoteifes-console/ARQUITETURA.md` |
| `composed/management-boundaries-{light,dark}.png` | Console de Operações | PNG composto | `remoteifes-console/ARQUITETURA.md` §1, `src/acoes.js`, `src/rede.js`, `web/index.html` |
| `composed/device-networking-{light,dark}.png` | Rede Mesh Opcional e Topologia | PNG composto | `remoteifes-esp32/MESH.md`, `remoteifes-server/src/services/meshService.js` |
| `flows/command-state-flow.svg` | Do pedido ao ar-condicionado | SVG | `remoteifes-server/src/services/salasService.js` (`aplicarComando`), `deviceHub.js` (`estadoConfirmado`), `MESH.md` |
| `flows/update-recovery.svg` | Atualização, versões e reversão | SVG | `remoteifes-server/deploy.sh`, `rollback.sh`, `verificar-versao.sh` |
| `screenshots/*.png` | topo, Atualização, Topologia | captura real | a própria interface |

Quando a fonte da verdade mudar, a figura muda junto. Uma figura desatualizada é um defeito da documentação.

## PNG compostos

Cada figura é uma página em `src/<nome>.html`: o layout é CSS, os rótulos são texto de verdade e os conectores são declarados em `window.CONECTORES` e desenhados por `src/conectores.js` entre elementos nomeados, depois do layout. Mudar um rótulo ou mover um cartão não exige recalcular coordenadas. `src/tema.css` guarda a paleta do app (`remoteifes-web/css/style.css`) e a versão escura, e os ícones pequenos vêm do sprite de `remoteifes-web/index.html`.

```bash
cd e2e && npm ci && cd ..                                   # uma vez: o Playwright vem das dependências do e2e
node docs/readme-assets/src/compor.js                       # todas as figuras
node docs/readme-assets/src/compor.js device-networking     # uma só
```

O script gera `-light.png` e `-dark.png` a 2× a largura exibida (800 px), escolhidas no README por `<picture>` conforme o tema do GitHub. Ele usa o Chromium do Playwright quando instalado e, senão, o Edge ou o Chrome do sistema. A fonte é a do sistema, então revise as imagens antes de commitar se gerar em outro sistema operacional.

## Módulos

`modules/*.png` são ilustrações de 256 px com fundo transparente: navegador, celular, servidor, banco, console, ESP32, ar-condicionado e ponto de acesso Wi-Fi. Gateway e nó mesh usam o mesmo módulo do ESP32, porque são o mesmo hardware e o mesmo firmware; o papel vem do rótulo. Um módulo novo segue o mesmo estilo: vista de três quartos, luz de cima à esquerda, paleta do app, sem texto, logotipo ou marca.

## Fluxos SVG

Os SVG são editados direto e servem aos dois temas com um arquivo só: todo texto fica sobre um cartão ou pílula opaca, e as linhas usam tons médios que mantêm contraste de 3:1 no branco e no fundo escuro do GitHub. Cada etapa é um `<g>` comentado.

## Capturas

As capturas vêm do harness de testes (`e2e/harness/api-server.js` e `static-server.js`): banco temporário, ESP32 simulado e contas de teste. Nunca use um ambiente de produção nem invente uma tela.

| Arquivo | Como foi capturado | Largura final |
|---|---|---|
| `home.png` | conta `e2e_admin`, `#/inicio`, janela de 1000 × 1100 a 2×, corte do topo com 760 px | 1160 px |
| `room-panel-mobile.png` | conta `e2e_user`, sala A-108 ligada por `POST /comando`, janela de 390 × 844 a 2× | 408 px |
| `topology.png` | superadmin com a senha padrão trocada no banco temporário; A-110 direta por credencial, gateway B-204 e nós B-206 e B-208 pelo protocolo real (`remoteifes-server/test/support/mesh-reference.js`); janela de 1280 px a 2×, B-206 selecionada, corte do diagrama e do painel | 1600 px |
| `console-updates.png` | console rodando do checkout com `CONSOLE_SEM_PRIVILEGIO=1` e estado temporário, apontado para um clone limpo com origin no GitHub, o harness na porta 8080 no papel da aplicação; aba Atualizações depois de **Verificar origin**; janela de 900 px a 2× | 1240 px |

O acabamento é o mesmo em todas: largura final de 2× a exibida, cantos de 10 px e borda de 1 px `#c8d1cb`. Antes de commitar, confira que não aparece senha, token, segredo, IP privado, nome de máquina ou caminho de usuário.

## Regras

- Toda imagem do README tem texto alternativo que descreve as relações, não os pixels.
- Cor nunca é o único canal: forma, rótulo e estilo de linha dizem a mesma coisa.
- Confira cada figura sobre `#ffffff` e sobre `#0d1117`.
- Mudanças só em `docs/` e no `README.md` não avançam a versão do frontend; o CI roda apenas os testes de documentação.
