const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..", "..");
const ESP = path.join(RAIZ, "remoteifes-esp32");
const ino = fs.readFileSync(path.join(ESP, "src", "main.ino"), "utf8");
const platformio = fs.readFileSync(path.join(ESP, "platformio.ini"), "utf8");
const setupHtml = fs.readFileSync(path.join(ESP, "data", "setup.html"), "utf8");
const rotas = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "protocolosIrRoutes.js"), "utf8");
const { compararVersoes } = require("../src/services/otaService");

function bloco(nome) {
  const definicao = new RegExp(`${nome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\([^;{]*\\)\\s*\\{`);
  const encontrado = definicao.exec(ino);
  assert.ok(encontrado, `função ${nome} ausente no firmware`);
  const inicio = encontrado.index;
  const corpo = inicio + encontrado[0].length - 1;
  let nivel = 0;
  for (let i = corpo; i < ino.length; i += 1) {
    if (ino[i] === "{") nivel += 1;
    if (ino[i] === "}") nivel -= 1;
    if (nivel === 0) return ino.slice(inicio, i + 1);
  }
  throw new Error(`bloco de ${nome} não fechado`);
}

test("os GPIOs do hardware de referência são os validados: receptor 15, emissor 4, switch 26 e buzzer 27", () => {
  assert.match(ino, /#define IR_RECV_PIN 15\b/);
  assert.match(ino, /#define IR_SEND_PIN 4\b/);
  assert.match(ino, /#define ACTION_SWITCH_PIN 26\b/);
  assert.match(ino, /#define BUZZER_PIN 27\b/);
  assert.match(ino, /#define ACTION_SWITCH_ACTIVE_LEVEL LOW\b/);
  assert.match(ino, /#define DHTPIN 14\b/);
  for (const pino of ["IR_RECV_PIN", "IR_SEND_PIN", "ACTION_SWITCH_PIN", "BUZZER_PIN", "DHTPIN"]) {
    assert.equal((ino.match(new RegExp(`#define ${pino} `, "g")) || []).length, 1, `${pino} definido mais de uma vez`);
  }
});

test("a versão do firmware avançou a partir de 4.0.0 e é a que o servidor usa para escolher enter_clone", () => {
  const versao = platformio.match(/-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/);
  assert.ok(versao, "FW_VERSAO ausente em platformio.ini");
  assert.equal(compararVersoes(versao[1], "4.0.0"), 1);
  const limiar = rotas.match(/FIRMWARE_COM_MODO_CLONE = "(\d+\.\d+\.\d+)"/);
  assert.ok(limiar);
  assert.ok(compararVersoes(versao[1], limiar[1]) >= 0, "o firmware publicado precisa entender enter_clone");
});

test("o switch usa pull-up interno, nível baixo, debounce de 40 ms e 5 s para o failsafe", () => {
  assert.match(ino, /const unsigned long ACTION_SWITCH_DEBOUNCE_MS = 40;/);
  assert.match(ino, /const unsigned long FAILSAFE_SWITCH_HOLD_MS = 5000;/);
  assert.match(ino, /pinMode\(ACTION_SWITCH_PIN, INPUT_PULLUP\)/);
  assert.match(ino, /digitalRead\(ACTION_SWITCH_PIN\) == ACTION_SWITCH_ACTIVE_LEVEL/);
  const processar = bloco("void processarSwitchAcao");
  assert.match(processar, /agora - actionSwitchLastChangeMs < ACTION_SWITCH_DEBOUNCE_MS\) return;/);
  assert.match(processar, /if \(!foiPressaoLonga\) abrirApTemporario\(\);/, "soltar depois do failsafe não pode abrir o AP");
  assert.match(processar, /actionSwitchLongPressConsumed = true;\s*transmitirFailsafeSalvo\(\);/, "o failsafe dispara uma única vez por pressão");
  assert.match(processar, /if \(!actionSwitchStableActive \|\| actionSwitchLongPressConsumed \|\| actionSwitchPressedSinceMs == 0\) return;/);
  assert.match(ino, /void loop\(\) \{\s*processarSwitchAcao\(\);/, "o switch é lido em todo ciclo, inclusive no modo AP");
  const configurar = bloco("void configurarSwitchAcao");
  assert.match(configurar, /actionSwitchLongPressConsumed = ativo;/, "um botão preso no boot não dispara nem o AP nem o failsafe");
});

test("o failsafe OFF é persistido na NVS, comparado antes de regravar e transmitido sem servidor", () => {
  assert.match(ino, /strcmp\(tipo, "failsafe_raw_set"\) == 0/);
  assert.match(ino, /strcmp\(tipo, "failsafe_raw_clear"\) == 0/);
  assert.match(ino, /preferences\.putBytes\("fsRaw", rawData, bytes\)/);
  assert.match(ino, /preferences\.putUShort\("fsLen", length\)/);
  assert.match(ino, /preferences\.putUInt\("fsHz", carrierHz\)/);
  assert.match(ino, /preferences\.putInt\("fsProto", protocolRecordId\)/);
  for (const chave of ["fsRaw", "fsLen", "fsHz", "fsProto"]) assert.match(ino, new RegExp(`preferences\\.remove\\("${chave}"\\)`));
  assert.match(ino, /if \(failsafeIgualAoSalvo\(rawData, i, carrierHz, protocolRecordId\)\)/, "sincronização repetida não desgasta a NVS");
  assert.match(ino, /rawArr\.size\(\) > MAX_RAW_IR_ENTRIES\s*\|\| carrierHz < FAILSAFE_CARRIER_MIN_HZ \|\| carrierHz > FAILSAFE_CARRIER_MAX_HZ/);
  assert.match(ino, /const uint32_t FAILSAFE_CARRIER_MIN_HZ = 20000;/);
  assert.match(ino, /const uint32_t FAILSAFE_CARRIER_MAX_HZ = 60000;/);
  assert.match(ino, /#define MAX_RAW_IR_ENTRIES CAPTURE_BUFFER_SIZE/);
  assert.match(ino, /#define CAPTURE_BUFFER_SIZE 1024/);
  const transmitir = bloco("bool transmitirFailsafeSalvo");
  assert.match(transmitir, /sendRawIR\(rawData, length, failsafeCarrierHzSalvo\(\) \/ 1000\)/);
  assert.doesNotMatch(transmitir, /WiFi\.status|estadoWsServidor == WS_ESTADO_CONECTADO \|\|/, "o failsafe local não depende de rede");
  assert.match(ino, /doc\["tipo"\] = "failsafe_status"/);
  assert.match(bloco("void enviarInfoDispositivo"), /preencherStatusFailsafe\(doc\)/);
  assert.match(bloco("void enviarTelemetriaWs"), /preencherStatusFailsafe\(doc\)/);
});

test("o papel vem do servidor: só a clonadora entra em modo clone ou captura e o papel não é persistido", () => {
  assert.match(ino, /strcmp\(tipo, "device_role"\) == 0/);
  assert.match(ino, /strcmp\(tipo, "enter_clone"\) == 0/);
  assert.match(ino, /if \(preferences\.isKey\("role"\)\) preferences\.remove\("role"\);/);
  assert.doesNotMatch(ino, /preferences\.putString\("role"/);
  assert.match(bloco("void handleIRCapture"), /if \(!moduloClonador\(\)\) return;/);
  assert.match(ino, /if \(modo == "clone" && moduloClonador\(\)\)/);
  assert.match(ino, /if \(moduloClonador\(\) && runtimeMode == RUNTIME_CONFIG_CLONE\) \{\s*irrecv\.enableIRIn\(\);/);
  assert.match(bloco("void aplicarPapelDoServidor"), /if \(!moduloClonador\(\) && runtimeMode == RUNTIME_CONFIG_CLONE\) sairModoClone\(\);/);
  assert.doesNotMatch(setupHtml, /name=["']role["']/i);
  assert.doesNotMatch(setupHtml, /clonador/i);
});

test("o ponto de acesso fica desligado em operação e só volta sem configuração, após reset ou pelo switch", () => {
  assert.match(bloco("void setup"), /WiFi\.mode\(WIFI_STA\);\s*WiFi\.softAPdisconnect\(true\);/);
  assert.doesNotMatch(bloco("void setup"), /aplicarPontoDeAcesso\(/, "o boot configurado não sobe o AP");
  assert.match(bloco("void startAPMode"), /aplicarPontoDeAcesso\(false\)/);
  assert.match(bloco("void abrirApTemporario"), /aplicarPontoDeAcesso\(true\)/, "o AP do switch mantém a estação conectada");
  assert.match(ino, /const unsigned long AP_TEMPORARIO_TIMEOUT_MS = 600000;/);
  assert.match(bloco("void loop"), /if \(apTemporarioAte != 0 && \(long\)\(millis\(\) - apTemporarioAte\) >= 0\) encerrarApTemporario\(\);/);
  assert.match(bloco("void encerrarApTemporario"), /WiFi\.softAPdisconnect\(true\);\s*WiFi\.mode\(WIFI_STA\);/);
  assert.match(bloco("void loop"), /if \(apIniciado\) \{\s*dnsServer\.processNextRequest\(\);\s*server\.handleClient\(\);/);
  assert.equal(fs.existsSync(path.join(ESP, "data", "status.html")), false, "não existe mais página local de status");
  assert.doesNotMatch(ino, /handleRoot|handleInfo|status\.html|reportAccess/);
  assert.match(ino, /strcmp\(tipo, "reset_wifi"\) == 0/);
});

test("o buzzer acompanha cada transmissão IR sem atraso bloqueante", () => {
  assert.match(bloco("void sendRawIR"), /iniciarAvisoBuzzer\(\);\s*irsend\.sendRaw\(rawData, length, frequency\);\s*atualizarBuzzer\(\);/);
  assert.match(bloco("void sendKnownACState"), /iniciarAvisoBuzzer\(\);\s*universalAC\.sendAc\(\);\s*atualizarBuzzer\(\);/);
  assert.doesNotMatch(bloco("void iniciarAvisoBuzzer"), /delay\(/);
  assert.doesNotMatch(bloco("void atualizarBuzzer"), /delay\(/);
  assert.match(bloco("void loop"), /atualizarBuzzer\(\);/);
  assert.match(ino, /const unsigned long BUZZER_MIN_MS = 60;/);
});

test("o firmware não carrega comentários de código", () => {
  assert.doesNotMatch(ino, /^\s*\/\//m);
  assert.doesNotMatch(ino, /\/\*/);
});
