const C = require("./commands");

module.exports = [
  {
    id: "android-release",
    titulo: "Android: preparar, versionar e publicar APK",
    papel: "superadmin",
    categoria: "super_infra",
    tags: ["Cordova", "Android", "APK", "versionCode", "assinatura", "publicar"],
    corpo: [
      { t: "comando", titulo: "Preparação, build e execução", comandos: C.androidBasico, quando: "npm ci na preparação; prepare/build/run conforme a plataforma; validate antes de release.", preRequisitos: "Android: JDK 17, SDK/API 36, Build Tools 36, Platform Tools, ANDROID_HOME e Gradle 8.14.2. iOS: macOS, Xcode, Command Line Tools e CocoaPods.", resultado: "www/ é sincronizado do website; plataforma é preparada; build/run gera ou executa o pacote adequado. validate não exige o Android SDK.", risco: "build-android é de desenvolvimento. Publicação exige build-android-release assinado e nunca aceita debug/unsigned." },
      { t: "comando", titulo: "Versão Android", comandos: C.androidVersao, quando: "Antes de cada publicação ou recompilação instalável.", preRequisitos: "Execute em remoteifes-cordova; revise android-release.json e notas.", resultado: "versionName/versionCode ficam sincronizados com config.xml; --rebuild mantém nome e incrementa build.", risco: "O Android só atualiza sobre a instalação existente quando versionCode cresce e a assinatura é a mesma." },
      { t: "fluxo", titulo: "Release Android", itens: [
        { tipo: "action", texto: "Definir versão e notas" },
        { tipo: "status", texto: "npm run validate" },
        { tipo: "action", texto: "Carregar assinatura fora do Git" },
        { tipo: "action", texto: "Build assinado com origem fixa" },
        { tipo: "action", texto: "Verificar e publicar" },
        { tipo: "device", texto: "Instalar e testar em Android real" },
      ] },
      { t: "comando", titulo: "Build assinado", comandos: [
        "set -a && . ./.signing/signing.env && set +a",
        "REMOTEIFES_SERVER_URL=https://remoteifes.ifes.edu.br npm run build-android-release",
      ], quando: "Após versão/notas e validate.", preRequisitos: "REMOTEIFES_ANDROID_KEYSTORE, REMOTEIFES_ANDROID_KEYSTORE_TYPE, REMOTEIFES_ANDROID_STORE_PASSWORD, REMOTEIFES_ANDROID_KEY_ALIAS e REMOTEIFES_ANDROID_KEY_PASSWORD definidos fora do Git; origem não pode ser loopback.", resultado: "Gera app-release.apk assinado, fixa origem e versão no bundle e restaura config.xml de desenvolvimento mesmo em falha.", risco: "Perder o keystore impede atualizar instalações existentes. Guarde chave e senhas em cofre ou mídia cifrada fora do repositório." },
      { t: "comando", titulo: "Publicar APK verificado", comandos: C.androidPublicacao, quando: "Somente depois de gerar o artefato assinado para a origem desta instalação.", preRequisitos: "apksigner e apkanalyzer; diretório de release lido pelo servidor; build superior ao publicado.", resultado: "Valida assinatura, debuggable=false, versão/build, minSdk 24, targetSdk ≥35, SHA-256 e certificado; grava APK e release.json atomicamente e remove superados.", risco: "Outra origem exige outro APK. A interface oferece download somente quando serverOrigin coincide com a requisição." },
      { t: "nota", nivel: "seguranca", texto: "Nunca coloque valores reais de senhas ou keystore na documentação. Para HTTP em LAN, teste o APK em aparelho real e valide HTTP/WebSocket; uma mudança de scheme do WebView altera a origem local e perde sessão/endereço salvos." },
    ],
  },
  {
    id: "cordova-rede-recursos",
    titulo: "Cordova: política de rede, ícone e splash",
    papel: "superadmin",
    categoria: "super_infra",
    tags: ["harden-config", "cleartext", "cordova-res", "ícone", "splash"],
    corpo: [
      { t: "comando", titulo: "Endurecer ou restaurar config.xml", comandos: C.androidRede, quando: "Teste manual da política; build-android-release já faz endurecimento e restauração automaticamente.", preRequisitos: "Execute em remoteifes-cordova e use uma única origem HTTP/HTTPS válida.", resultado: "Produção restringe access/navigation/intent à origem; HTTPS bloqueia cleartext e HTTP local mantém exceção com aviso. dev-config restaura curingas de desenvolvimento.", risco: "Não distribua APK com configuração curinga. HTTP transmite credenciais e OTA sem criptografia e só cabe em LAN controlada." },
      { t: "comando", titulo: "Gerar variantes de recursos", comandos: C.androidRecursos, quando: "Apenas ao substituir as fontes icon.png/splash.png e precisar de variantes pelo cordova-res.", preRequisitos: "cordova-res instalado separadamente; fontes nas dimensões documentadas.", resultado: "Copia recursos gerados para Android/iOS sem editar config.xml.", risco: "Valide recorte, máscara e splash em orientações/tamanhos diferentes antes do release." },
    ],
  },
  {
    id: "frontend-pwa-release",
    titulo: "Atualizar website e PWA",
    papel: "superadmin",
    categoria: "super_infra",
    tags: ["frontend", "PWA", "cache", "version.json", "service worker", "Cordova"],
    corpo: [
      { t: "passos", itens: [
        "Depois de alterar remoteifes-web, avance a versão canônica em <code>version.json</code> e mantenha index.html, version.js, manifest.webmanifest e sw.js coerentes; o teste de versão detecta divergência.",
        "Execute testes do servidor e end-to-end, incluindo manual offline e atualização da PWA.",
        "Implante o código e abra uma PWA existente com rede. O novo service worker baixa o shell versionado, remove cache anterior e recarrega a tela.",
        "Se a mudança também fará parte do Cordova, rode o fluxo de sync/prepare/build; remoteifes-cordova/www é gerado e não deve virar uma segunda fonte manual.",
      ] },
      { t: "nota", texto: "Não instrua usuários a limpar dados como rotina de release. Falha de atualização deve ser diagnosticada por versão, service worker, cache e origem; limpar dados também remove sessão e configuração local." },
    ],
  },
  {
    id: "diagnostico-testes",
    titulo: "Diagnóstico, carga e testes",
    papel: "superadmin",
    categoria: "super_infra",
    tags: ["testes", "Playwright", "serial-smoke", "carga", "CI"],
    corpo: [
      { t: "comando", titulo: "Validação por componente", comandos: C.testes, quando: "Antes de release e depois de mudanças no componente correspondente.", preRequisitos: "Dependências de cada projeto; Chromium do Playwright; PlatformIO; placa e pyserial apenas para serial-smoke.", resultado: "Testes de servidor, navegador, Cordova, compilação de firmware e smoke físico produzem saída explícita e código zero.", risco: "Testes automatizados não substituem validação em sala piloto, dispositivo móvel real e infraestrutura da instalação." },
      { t: "comando", titulo: "Carga isolada do servidor", comandos: C.carga, quando: "Depois de alterações no servidor ou para conferir capacidade no hardware do campus.", preRequisitos: "Execute em remoteifes-server; ajuste salas/minutos conforme a janela. O script usa banco temporário e ESP32 simulados.", resultado: "Relata memória, latência, tráfego por navegador e entrega de comandos sem tocar o banco de produção.", risco: "Ainda consome CPU/rede do host; não confunda simulação de protocolo com teste físico do infravermelho." },
      { t: "p", texto: "Em falha: reproduza no menor alvo, registre saída sem segredos, confira health/journalctl e compare com a última versão boa. A CI roda servidor, E2E, Cordova e firmware em push/PR para main, mas não tem o hardware nem a rede do campus." },
    ],
  },
  {
    id: "repositorio-git",
    titulo: "Scripts de repositório e transferência",
    papel: "superadmin",
    categoria: "super_infra",
    tags: ["export.py", "import.py", "clear.py", "git", "push"],
    corpo: [
      { t: "comando", titulo: "Fluxos auxiliares", comandos: C.git, quando: "Na raiz: export para adicionar/commitar/enviar; import para atualizar de origin/main; clear somente para recriar deliberadamente todo o histórico.", preRequisitos: "Git instalado, remoto e branch main corretos; árvore e diff revisados; autorização para push.", resultado: "export usa git add -A, cria commit e envia origin/main; import faz pull; clear cria histórico órfão e força o remoto após confirmação.", risco: "export inclui todas as mudanças rastreáveis. clear.py apaga permanentemente todo o histórico anterior e faz push -f: não use em operação normal, deploy ou limpeza local." },
      { t: "nota", nivel: "seguranca", texto: "Antes de exportar, confirme que .env, banco, backups, releases, keystores e segredos continuam ignorados. Se algo sensível já foi commitado, removê-lo do arquivo atual não revoga nem apaga o histórico." },
    ],
  },
];
