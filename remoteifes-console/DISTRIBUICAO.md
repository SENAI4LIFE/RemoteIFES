# Console de Operações — runtime, empacotamento e atualização

Decisão de distribuição, escrita antes da implementação multiplataforma e mantida junto do
código. Complementa [ARQUITETURA.md](ARQUITETURA.md), que trata da fronteira de produto, da
identidade e do modelo de privilégio.

## 1. Runtime: Node do sistema, não runtime embutido

| Alternativa | Tamanho no Pi | Superfície de segurança | Executa código do checkout | Veredito |
|---|---|---|---|---|
| **Node do sistema (escolhida)** | 0 (já obrigatório) | um runtime para corrigir | sim, mesma semântica | **Escolhida** |
| Runtime Node privado embutido | +50–90 MiB por instalação | **dois** runtimes para corrigir a cada CVE | sim | Rejeitada |
| Node SEA (executável único) | ~80–110 MiB | um binário congelado, corrigido só por release nossa | **não** de forma confiável | Rejeitada |
| Shell nativo com webview | runtime de webview por plataforma | dependente da plataforma | sim | Rejeitada |

O argumento decisivo não é tamanho, é **pré-requisito já existente**: o console administra uma
instalação RemoteIFES *no mesmo host*, e `remoteifes-server` declara `node >= 22.13.0`. Um host
sem Node não tem o que o console administre. Embutir um segundo runtime acrescentaria dezenas de
MiB num Raspberry Pi 3 e, pior, um segundo interpretador para acompanhar em cada correção de
segurança — exatamente o contrário de "leve".

**Node SEA foi descartado por um motivo concreto, não por gosto.** Os executores do console
usam `process.execPath` para rodar arquivos `bin/*.js` reais, e `bin/backup.js`,
`bin/restaurar.js` e `bin/recuperar-conta.js` carregam módulos **do checkout administrado**
(`backupService`, `node:sqlite`, `bcryptjs`). Um binário SEA não é um `node` de uso geral: ele
resolve módulos e ativos pelas regras do próprio empacotamento. Os caminhos de backup,
restauração e recuperação de conta deixariam de funcionar ou exigiriam um `node` do sistema
assim mesmo — ou seja, o SEA pagaria o custo sem remover a dependência.

Consequência assumida: o instalador **verifica** o Node e recusa instalar com uma mensagem
precisa quando ele falta ou é antigo, em vez de instalar algo que não subiria.

### Horizonte ARMv7 / armhf (Raspberry Pi 3)

Um Pi 3 pode ter hardware de 64 bits, kernel de 64 bits e **userland de 32 bits** ao mesmo
tempo. Por isso o console classifica quatro coisas separadamente — hardware, kernel, userland e
runtime — e **nunca** decide por `uname -m` sozinho: a fonte primária é `process.arch` (a
arquitetura do runtime que de fato vai executar), complementada pela arquitetura do gerenciador
de pacotes quando existe (`dpkg --print-architecture`).

O Node 22 publica binários ARMv7 e é a última linha com esse suporte em nível normal; o Node 24
rebaixa ARMv7 a experimental. O Node 22 tem fim de suporte em **2027-04-30**. Portanto:

* um Pi 3 com Raspberry Pi OS de 32 bits continua suportado enquanto o Node 22 tiver suporte;
* a recomendação de longo prazo para produção é **migrar o Pi 3 para um sistema de 64 bits**
  (userland arm64), o que o mantém dentro das linhas atuais do Node depois de 2027-04-30;
* o console exibe essa classificação e o aviso de horizonte em vez de deixar o operador
  descobrir na atualização que quebrou.

## 2. Camada nativa: nenhuma, por decisão

A tentação era um pequeno componente nativo por plataforma (lançador Windows + host de serviço
SCM, ponte launchd). Foi rejeitada nesta passagem por um motivo de honestidade: **não há aqui
ambiente para compilar e validar esse componente**, e um host de serviço SCM não testado é
precisamente a "aproximação insegura ou enganosa" que não deve ser entregue.

O que substitui cada papel:

| Papel | Solução sem código nativo |
|---|---|
| Lançador Windows sem piscar console | atalho `.lnk` para `wscript.exe` executando `abrir-console.js` (WSH, subsistema GUI) |
| Serviço de segundo plano Windows | **partida sob demanda pelo lançador** + tarefa agendada opcional; nenhum processo residente |
| Ativação macOS | LaunchAgent por usuário com `RunAtLoad=false`, acionado pelo lançador; sem herança de fd |
| Ativação Linux | **preservada**: socket do systemd com `LISTEN_FDS`, que continua sendo a melhor solução ali |

O modelo Windows/macOS é **sob demanda**, não paridade com o systemd. Como não há serviço
permanente registrado, não existe gerenciador de serviços para interpretar a saída por
ociosidade como queda — o problema some por construção em vez de ser contornado.

Quando um host de serviço SCM de verdade for necessário, o limite arquitetural já está no
lugar: `src/plataforma/windows.js` isola tudo que dependeria dele.

## 3. Formatos de pacote: só os que a CI consegue construir **e** validar

| Plataforma | Artefato | Construído na CI | Instalação validada na CI |
|---|---|---|---|
| Linux (deb) | `remoteifes-console_<versão>_all.deb` | sim | **sim** — `dpkg -i` com provisionamento real (estado, segredo, unidades, auxiliar, regra de sudo, console respondendo pelo socket), `dpkg --verify`, `dpkg -r` e `dpkg -P` |
| Linux (portátil) | `.tar.gz` + `instalacao/instalar.js` | sim | **sim** — instala fora da árvore de código e roda o programa instalado |
| Windows | `.zip` + `instalar.ps1` | sim | **sim** — instala fora da árvore de código e roda o programa instalado |
| macOS | `.tar.gz` com bundle `.app` + `instalacao/instalar.js` | sim | **sim** — instala fora da árvore de código e roda o programa instalado |

MSI/WiX, NSIS e `.pkg` assinado foram deliberadamente deixados de fora: sem credenciais de
assinatura e sem ambiente de validação, entregariam um instalador não testado.

O job `pacotes` da CI roda em `ubuntu-latest`, `windows-latest` e `macos-latest` e faz, em cada
um: constrói o artefato; confere que a procedência se declara **não assinada** e que cada digest
do manifesto bate com o arquivo; descompacta o artefato **fora da árvore de código** e instala a
partir dele; confere o layout instalado e a coerência do ponteiro de versão; sobe o programa
instalado com um `PATH` **sem git, npm ou compilador** e verifica que o lançador reconhece o
console pela prova de identidade; e desinstala, confirmando que o estado sobrevive. Essa é a
diferença entre "empacotamos" e "a instalação funciona".

O `.tar.gz` é montado pelo próprio construtor, sem depender do `tar` do sistema: o Windows não
tem GNU tar, e a forma dos cabeçalhos precisa casar exatamente com o extrator do atualizador —
o que um teste verifica extraindo o artefato recém-construído com o extrator de produção. Pela
mesma razão o `.deb` é montado em Node (formato `ar` + dois `tar.gz`), e pode ser construído a
partir de qualquer um dos três sistemas.

## 4. Propriedade da atualização

Modelo escolhido: **payload versionado lado a lado, com camada estável de bootstrap**.

```
<raiz>/console-bootstrap.js      camada estável: resolve a versão ativa e a carrega
<raiz>/launcher-bootstrap.js     idem, para o lançador
<raiz>/estado-instalacao.json    ponteiro da versão ativa (+ anterior, + transação em curso)
<raiz>/versoes/2.0.0/            payload imutável, uma pasta por versão
<raiz>/versoes/2.1.0/
<raiz>/descargas/                área de estágio, limpa ao fim de cada transação
```

O ponteiro é um arquivo, não um link simbólico: o Windows exige privilégio para criar links
simbólicos, e um layout que dependesse deles seria um layout diferente por sistema.

Razões:

* o `.deb` é dono apenas da camada estável (`console-bootstrap.js`, `launcher-bootstrap.js`), da
  **primeira** versão em `versoes/` e da entrada de menu; as seguintes vão para `versoes/` sem
  sobrescrever arquivos de propriedade do dpkg, então o gerenciador de pacotes nunca fica
  inconsistente (`dpkg --verify` limpo). O ponteiro `estado-instalacao.json` **não** é arquivo do
  pacote, porque o atualizador o reescreve;
* os scripts do pacote delegam ao mesmo instalador da instalação manual, em modo `--pacote`: o
  `postinst` cria o ponteiro (sem nunca voltar para uma versão mais antiga que uma já instalada
  por autoatualização), o diretório de estado e o segredo de uso único (que **não** é impresso,
  porque o apt copia a saída para `/var/log/apt/term.log`) e, com o checkout conhecido
  (`CONSOLE_CHECKOUT_DIR` na instalação, ou já registrado), as unidades, o auxiliar e a regra de
  sudo, com o serviço rodando como o dono do checkout, nunca root. Sem checkout, ele imprime o
  único comando que conclui o provisionamento. O `prerm` remove a integração, encerra o console
  e apaga só o que o dpkg não possui (versões de autoatualização, o ponteiro); o estado sai
  apenas no `purge`;
* reverter é trocar o ponteiro, não reinstalar;
* no Windows, o executável em uso não precisa ser substituído no lugar;
* a unidade do systemd aponta para `console-bootstrap.js`, **nunca** para uma versão: atualizar
  o console não reescreve arquivo do systemd nem exige `daemon-reload`.

O alternativo — o atualizador baixar e instalar o próximo `.deb`/MSI pelo caminho privilegiado —
foi rejeitado porque exigiria elevação a cada atualização e acoplaria o console ao gerenciador
de pacotes de cada distribuição.

**Regra que os dois modelos não podem misturar:** a troca do ponteiro nunca toca em arquivo
registrado pelo gerenciador de pacotes. Um teste verifica isso.

### Desinstalação

`instalacao/desinstalar.js` remove integração de sistema, atalhos e o programa. Duas regras
governam o arquivo:

1. **nada é removido recursivamente sem prova de propriedade e contenção** — o diretório precisa
   exibir as marcas de uma instalação do console, não ser raiz de disco nem a home, ter
   profundidade mínima, pertencer a quem desinstala (uid em POSIX, permissão de escrita no
   Windows) e **não** estar dentro de um checkout do RemoteIFES;
2. **o estado fica por padrão** — operadores, auditoria e histórico sobrevivem; `--apagar-estado`
   é explícito, e `--simular` mostra exatamente o que sairia **sem chamar nada que mute** (nem o
   registro de inicialização, nem unidades, nem a regra de sudo);
3. **nada de processo órfão** — o console em execução é encerrado antes de o programa sair. O que
   autoriza encerrar não é o PID do contrato, que é reciclado, mas a prova de identidade: quem
   responde na porta demonstra possuir o segredo que só este console publicou. Falhando a prova,
   nada é encerrado e o operador é avisado.

Raiz, estado e escopo são **inferidos da instalação** de onde o desinstalador saiu, não presumidos
pelo sistema: uma instalação de usuário no Linux era tratada como de sistema, reclamava que
`/opt` não existia e deixava `~/.local/...` intacto.

As operações de versão — atualizar, importar offline, reverter — tomam uma **trava exclusiva** na
raiz da instalação. Sem ela, duas operações simultâneas podiam instalar versões diferentes e uma
podar a que a outra estava a ponto de ativar, deixando o ponteiro apontando para um diretório
inexistente. Uma trava de processo morto é recuperada e auditada.

O desinstalador mora dentro do que apaga, então ele se copia para um diretório temporário e
recomeça de lá. Sem isso, no Windows o arquivo em execução mantém um handle aberto e a raiz
ficava para trás com `EPERM` depois de todo o conteúdo já ter sido removido — o pior dos dois
mundos. Há regressão cobrindo esse caminho.

## 5. Confiança da atualização

A raiz de confiança é uma **chave pública Ed25519 embutida no código** do console
(`src/release.js`). Um release publicado é:

```
remoteifes-console-<versão>-<plataforma>-<arch>.tar.gz     (artefato)
manifesto.json                                             (metadados)
manifesto.json.sig                                         (assinatura Ed25519 do manifesto)
```

O manifesto declara versão, canal, alvos (SO/arquitetura/formato), SHA-256 e tamanho de cada
artefato, versão mínima que pode atualizar para esta, e validade (`expiraEm`) contra replay e
congelamento.

**Assinado não é o mesmo que correto.** O console impõe tetos próprios que o manifesto não pode
ampliar: bytes comprimidos, bytes descomprimidos e quantidade de arquivos. Um erro de publicação
que declare um tamanho absurdo, ou um artefato pequeno que expanda para centenas de MiB, é
recusado antes de qualquer escrita — num Raspberry Pi de 1 GiB isso é a diferença entre uma
atualização recusada e um host derrubado. Um `minimoParaAtualizar` presente mas malformado
também é recusado, em vez de desligar o portão de compatibilidade em silêncio. A verificação é **fechada por padrão**: assinatura inválida, manifesto expirado,
alvo ausente, digest divergente ou downgrade não autorizado interrompem a atualização antes de
qualquer escrita no diretório ativo.

Um SHA-256 vindo da mesma origem não confiável do artefato não prova autenticidade — por isso o
digest só vale **depois** da assinatura do manifesto conferir. Assinatura de código do SO e
proveniência do GitHub são camadas complementares, não substitutas.

Credenciais nunca acompanham redirecionamento: o download descarta o cabeçalho `Authorization`
ao sair do host da API.

Rotação de chave: o manifesto pode declarar `proximaChave`, assinada pela chave atual, e o
console a aceita para o release seguinte. Downgrade só acontece por ação explícita de reversão,
que usa a cópia local já verificada em `versoes/` e não a rede.

### Host sem Internet

Um Pi atrás de uma rede fechada recebe os três arquivos à mão (pendrive, `scp`) e instala com:

```bash
node bin/atualizar-console.js --importar manifesto.json manifesto.json.sig <artefato>.tar.gz
```

O caminho é o mesmo do release baixado — assinatura do manifesto, alvo, digest, política de
versão, instalação lado a lado, troca de ponteiro — e a **única** diferença é a origem do
arquivo. A metade que instala é uma função só (`instalarArtefatoVerificado`), compartilhada
pelos dois caminhos: duplicá-la seria duplicar o risco de divergirem justamente nas conferências
que impedem uma instalação ruim.

## 6. O que continua sem suporte, e por quê

| Capacidade | Estado | Bloqueio exato |
|---|---|---|
| Assinatura Windows / notarização macOS | **implementado, sem credenciais** | não há certificado nem conta de desenvolvedor; a CI rotula os artefatos como `nao-assinado` |
| Host de serviço SCM no Windows | **não suportado** (usa partida sob demanda) | exige componente nativo compilado e validado; ausente aqui |
| Terminal Expert | **indisponível por padrão** nas três plataformas | `node-pty` é módulo nativo; não é distribuído aqui porque não há build por plataforma/arquitetura validado na CI. O console informa o requisito e o comando exatos **daquele** sistema (ConPTY no Windows, ferramentas do Xcode no macOS, `build-essential` no Linux) e não oferece nenhum substituto |
| Publicação de APK de produção | inalterado, fora do host | exige Android SDK |
