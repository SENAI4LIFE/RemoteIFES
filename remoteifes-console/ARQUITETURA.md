# Console de Operações RemoteIFES — decisão de arquitetura e modelo de ameaças

Documento curto e normativo. Registra *por que* o console é um serviço separado, o que ele pode
fazer, quem pode acioná-lo e o que continua fora dele. Escrito antes da implementação e mantido
junto do código.

## 1. Objetivo e fronteira de produto

O console opera **o RemoteIFES, o host, o ciclo de vida do software e a infraestrutura**.
O RemoteIFES continua operando o prédio.

| Fica no console | Fica no RemoteIFES (aplicação) |
|---|---|
| Serviço systemd, watchdog, logs do host | Salas, comandos, agendamentos, grade |
| Atualização, rollback, versões em execução | Usuários, permissões, propriedade de sala |
| Backup, restauração, quarentena de banco | Cadastro/OTA/credenciais/IR dos ESP32 |
| Rede, domínio, TLS, proxy (diagnóstico); política de acesso de rede da aplicação (modo de teste e CIDR autorizados) | Demais configurações da aplicação, relatos, auditoria |
| Mobile/CI: release publicado e execuções da CI, só consulta | Página Aplicativo e download do APK pelo usuário |
| Recuperação de conta e do próprio console | Monitoramento e mapas operacionais |

O console **resume** a saúde da aplicação e oferece links profundos; não recria editores que já
existem. Cada valor tem um único dono. O modo de manutenção continua na aplicação: o console lê e
aponta, não edita. Os **CIDR autorizados** e o **modo de teste** passaram para o console, porque
decidem quem alcança o site: gravados pelo site, uma faixa errada trancava do lado de fora o próprio
navegador que poderia desfazê-la. A ação `rede.acesso-aplicacao` exige elevação, é serializada com
implantação e restauração pela trava de manutenção, grava as duas chaves e o evento de auditoria da
aplicação (`configuracao_alterada`, autor `console:<operador>`) numa única transação `IMMEDIATE` e
confere o efeito relendo o banco. O servidor recusa com `403` qualquer mudança desses valores vinda
do site (reenviar o valor vigente é aceito, para frontends antigos em cache); o terminal
(`npm run redes`) continua como caminho de emergência sem o console.

## 2. Alternativas comparadas

| Alternativa | RAM ociosa | Independência de recuperação | Complexidade | Veredito |
|---|---|---|---|---|
| Integrar ao Express existente | 0 (mesmo processo) | **Nenhuma** — morre junto com a aplicação; `encerrarSessoesAtivasNoInicio()` invalida a sessão a cada restart gerenciado; a autenticação depende do SQLite que pode estar corrompido | Baixa | **Rejeitada** |
| Serviço Node separado sempre ativo | ~45–60 MiB RSS | Alta | Média | Base aceita, mas paga RAM 24 h/dia num host de 1 GiB |
| **Serviço Node separado com ativação por socket + saída por ociosidade** | **0 quando ninguém usa** | Alta | Média | **Escolhida** |
| Cockpit | `cockpit-ws` mais um `cockpit-bridge` por sessão, PAM e integração systemd própria; dezenas de MiB e um conjunto de dependências que não existe no host hoje | Alta | Alta para customizar: os fluxos RemoteIFES (`deploy.sh`, backup, OTA) continuariam precisando de um bridge próprio, e o login PAM concederia shell root — conflita com a secção 4 | Alta | **Rejeitada** para este Pi; registrada como referência de modelo sob demanda |

Referências consultadas: [systemd.socket](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.socket.xml)
(ativação por socket e passagem de descritores), [modelo de inicialização do Cockpit](https://docs.cockpit-project.org/cockpit-guide/latest/guide/startup.html)
(sob demanda e saída do processo), [systemd.exec](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.exec.xml)
(diretivas de endurecimento compatíveis com elevação).

### Decisão

Um serviço **`remoteifes-console.service`** ativado por **`remoteifes-console.socket`**:

* o systemd mantém o socket de escuta; **nenhum processo Node fica residente**;
* na primeira conexão o systemd inicia o serviço, que herda o descritor (`LISTEN_FDS=1`, fd 3);
* sem sessões ativas, sem trabalho em andamento e sem requisições por `CONSOLE_OCIOSIDADE_S`
  (padrão 900 s), o processo **sai sozinho**; o socket continua escutando;
* sem systemd (desenvolvimento, macOS/Windows) o mesmo programa escuta uma porta TCP local.

Custo: a primeira requisição paga a partida do Node. `npm run medir` mede esse custo no host; num
console de manutenção usado esporadicamente essa é a troca certa contra RAM ociosa permanente.

## 3. Instalação fora do checkout (programa instalado)

`deploy.sh` e `rollback.sh` trocam o checkout inteiro — inclusive `remoteifes-console/`, e um
rollback para revisão anterior ao console **apagaria** este diretório. Por isso o console é um
**programa instalado**, não um script do checkout. O layout está descrito em
[DISTRIBUICAO.md](DISTRIBUICAO.md); em resumo:

* o console roda de `<raiz>/versoes/<versao>` (payload imutável), nunca do checkout. A raiz
  pertence ao usuário do console, para que a atualização instale a versão nova ao lado e troque
  um ponteiro; o que dá acesso a root é o auxiliar em `/usr/local/lib/remoteifes`, root:root;
* a **camada estável** (`console-bootstrap.js`, `estado-instalacao.json`) é o que o pacote e as
  unidades do systemd conhecem: nenhuma atualização reescreve arquivo registrado pelo dpkg, e
  nenhuma unidade menciona uma versão;
* o estado fica em `/var/lib/remoteifes-console` (Linux, escopo de sistema), fora do checkout e
  fora do `data/` da aplicação;
* atualizar o console é uma **ação explícita** que baixa um artefato de release, confere a
  assinatura Ed25519 do manifesto e o digest, instala lado a lado e troca a versão ativa. Não
  usa git, não copia o checkout e não depende do `origin/main` da aplicação;
* reverter é trocar o ponteiro de volta para a versão anterior, já verificada, **sem rede**.

Trabalhos longos rodam sob um **supervisor** (`bin/supervisionar.js`) iniciado em grupo de processos
próprio, sem nenhum pipe ligado ao console. O supervisor é o dono do trabalho: lê a saída do
executor e a grava em arquivo limitado, aplica o prazo máximo da ação, mantém a trava de manutenção
(que passa a registrar o PID dele) e grava o desfecho em `<id>.fim.json` de forma atômica antes de
sair. A unidade do systemd usa `KillMode=process`, então parar, reiniciar ou atualizar o console não
atinge o supervisor. Antes, a saída passava por pipes do próprio console e a trava levava o PID do
console: uma queda do console matava o executor na escrita seguinte (EPIPE) e deixava a trava com
aparência de resíduo enquanto a restauração ainda corria.

Na partida o console reconcilia a partir de fatos: desfecho gravado, usa o código de saída real e
registra que o efeito **não foi verificado automaticamente** (a verificação de cada ação só roda no
processo que acompanhou o trabalho); supervisor vivo (PID e horário de início), acompanha até o fim;
supervisor morto sem desfecho, **desconhecido** — nunca sucesso presumido. A trava de um trabalho
concluído sem acompanhamento é liberada nessa reconciliação.

## 4. Identidade, autorização e privilégio

**Identidade própria do console**, não o superadministrador da aplicação:

* a aplicação autentica por token Bearer guardado em `localStorage`, com hash no SQLite; se o banco
  estiver corrompido ou a aplicação parada essa autenticação não existe — e recuperação é
  justamente quando o console precisa funcionar;
* administrar a aplicação **não pode** conceder root no host.

| Item | Decisão |
|---|---|
| Credencial | operador local, senha com `scrypt` (`node:crypto`), em `/var/lib/remoteifes-console/operadores.json` (0600) |
| Provisionamento | o instalador gera um segredo de uso único gravado em `bootstrap-token` (0600) — exibido uma vez na instalação manual, nunca pela do pacote (o apt registra a saída em log); nunca reaproveita `SENHA_ADMIN_INICIAL` nem `superadmin/admin`. Quem lê o arquivo (autorização local) cria o primeiro operador: pelo lançador, que troca o segredo por um convite de uso único de 10 minutos entregue ao navegador por uma página privada (fragmento da URL, removido do histórico antes do uso), ou por `--criar-operador` no terminal. Comparação em tempo constante, limite de tentativas; criado o operador, segredo e convites deixam de valer |
| Sessão | cookie `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` quando houver TLS; validade absoluta 8 h e ociosidade 30 min |
| Elevação | reautenticação por senha para operações sensíveis; validade 5 min, revogada no logout e no fim da sessão |
| CSRF | token por sessão exigido em cabeçalho próprio em **todo** método mutante, mais checagem exata de `Origin` e de `Host` (anti-DNS-rebinding). CORS não é considerado defesa |
| Exposição | `127.0.0.1` por padrão. Acesso remoto é túnel SSH (`ssh -L 8099:127.0.0.1:8099 pi@host`): o `localhost` do operador **não** é o do Pi. Não há modo de rede local: `CONSOLE_BIND` fora do loopback faz o console escutar em HTTP, sem TLS próprio nem filtro de faixas, protegido só pela lista de `Host` (`CONSOLE_HOSTS`) |
| Privilégio | o console roda como o usuário dono do checkout e dos dados; tudo que precisa de root passa por **um** auxiliar root (`/usr/local/lib/remoteifes/console-helper.sh`, root:root 0755, diretórios pais root) com verbos fixos e argumentos validados por lista |
| Endurecimento | o serviço do console **não** usa `NoNewPrivileges=yes`, que quebraria o `sudo` do auxiliar; usa `PrivateTmp`, `ProtectHome=read-only`, `ProtectKernelTunables`, `RestrictAddressFamilies` e `ReadWritePaths` explícitos |
| Segredos | tokens GitHub, chaves e senhas nunca voltam por API nem vão para log, auditoria ou diagnóstico: o console informa **presença e validade**, jamais o valor |

O auxiliar não aceita nome de unidade, caminho, ambiente nem comando arbitrários: cada verbo tem
alvo fixo. Não existe endpoint `/exec` genérico.

## 5. Modelo de ameaças (resumido)

| Ameaça | Mitigação |
|---|---|
| Navegador de outra origem dispara ação (CSRF) | `SameSite=Strict`, token em cabeçalho, `Origin` exato e recusa de efeito colateral em GET |
| DNS rebinding para `127.0.0.1:8099` | `Host` conferido contra lista exata; qualquer outro valor recebe 421 |
| Cookie vazando entre aplicação e console | portas **não** isolam cookies; por isso a sessão do console não vale nada sem o cabeçalho CSRF, e a aplicação não usa cookies |
| Service worker da aplicação capturando o console | origem distinta, o console não registra SW e envia `Clear-Site-Data` no logout |
| Injeção por argumento, opção ou caminho | sem shell: `execFile`/`spawn` com vetor de argumentos; cada ação declara esquema e valida opção por opção; caminhos resolvidos e conferidos contra raiz permitida (`realpath`, sem symlink para fora) |
| Conteúdo malicioso em log, Git ou nome de arquivo | render por `textContent`, nunca `innerHTML` com dado externo; sequências de controle filtradas |
| Escalada via auxiliar | executável e diretórios pais só graváveis por root; verbos fixos; sem repasse livre de argumentos; ambiente não herdado |
| Publicação acidental do console | `remoteifes-console/` fora do que o Pages publica e fora do `www` do Cordova, com asserção em teste |
| Operador root legítimo | **não é ameaça mitigável**: quem tem root altera console, logs e políticas. O objetivo é impedir acesso não autorizado e uso acidental, não tornar o software imutável contra root |

## 6. O que continua fora do console

* **Terminal Expert** é capacidade separada, com destravamento, reautenticação e relock.
* Builds Android/iOS pesados ficam na CI ou na máquina de desenvolvimento. O Pi não ganha SDK,
  JDK nem Gradle.
* `export.py`, `import.py` e `clear.py` são ferramentas de histórico Git do desenvolvedor.
  **Não** viram botões.
* `release.sh` cria commit e tag: é autoria de versão, não implantação. Fora do console nesta
  passagem.
* Procedimentos físicos de ESP32 (gravação por USB, switch, serial) seguem no manual.
