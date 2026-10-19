process.env.REMOTEIFES_DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

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
  assert.ok(encontrado, `function ${nome} missing from the firmware`);
  const inicio = encontrado.index;
  const corpo = inicio + encontrado[0].length - 1;
  let nivel = 0;
  for (let i = corpo; i < ino.length; i += 1) {
    if (ino[i] === "{") nivel += 1;
    if (ino[i] === "}") nivel -= 1;
    if (nivel === 0) return ino.slice(inicio, i + 1);
  }
  throw new Error(`${nome} block not closed`);
}

test("the reference hardware GPIOs are the validated ones: receiver 15, emitter 4, switch 26, buzzer 27 and network LED 25", () => {
  assert.match(ino, /#define IR_RECV_PIN 15\b/);
  assert.match(ino, /#define IR_SEND_PIN 4\b/);
  assert.match(ino, /#define ACTION_SWITCH_PIN 26\b/);
  assert.match(ino, /#define BUZZER_PIN 27\b/);
  assert.match(ino, /#define NETWORK_LED_PIN 25\b/);
  assert.match(ino, /#define ACTION_SWITCH_ACTIVE_LEVEL LOW\b/);
  assert.match(ino, /#define NETWORK_LED_ACTIVE_LEVEL HIGH\b/);
  assert.match(ino, /#define DHTPIN 14\b/);
  const numeros = [];
  for (const pino of ["IR_RECV_PIN", "IR_SEND_PIN", "ACTION_SWITCH_PIN", "BUZZER_PIN", "NETWORK_LED_PIN", "DHTPIN"]) {
    assert.equal((ino.match(new RegExp(`#define ${pino} `, "g")) || []).length, 1, `${pino} defined more than once`);
    numeros.push(Number(ino.match(new RegExp(`#define ${pino} (\\d+)\\b`))[1]));
  }
  assert.equal(new Set(numeros).size, numeros.length, `two functions share a GPIO: ${numeros.join(", ")}`);
});

test("the firmware version advanced from 4.0.0 and is what the server uses to choose enter_clone", () => {
  const versao = platformio.match(/-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/);
  assert.ok(versao, "FW_VERSAO missing from platformio.ini");
  assert.equal(compararVersoes(versao[1], "4.0.0"), 1);
  const limiar = rotas.match(/FIRMWARE_COM_MODO_CLONE = "(\d+\.\d+\.\d+)"/);
  assert.ok(limiar);
  assert.ok(compararVersoes(versao[1], limiar[1]) >= 0, "the published firmware must understand enter_clone");
});

test("the switch uses the internal pull-up, active low, 40 ms debounce and 5 s for the setup AP", () => {
  assert.match(ino, /const unsigned long ACTION_SWITCH_DEBOUNCE_MS = 40;/);
  assert.match(ino, /const unsigned long AP_SWITCH_HOLD_MS = 5000;/);
  assert.doesNotMatch(ino, /FAILSAFE_SWITCH_HOLD_MS/, "the 5 s hold no longer sends the failsafe");
  assert.match(ino, /pinMode\(ACTION_SWITCH_PIN, INPUT_PULLUP\)/);
  assert.match(ino, /digitalRead\(ACTION_SWITCH_PIN\) == ACTION_SWITCH_ACTIVE_LEVEL/);
  const amostrar = bloco("void amostrarSwitchAcao");
  assert.match(amostrar, /agora - actionSwitchLastChangeMs < ACTION_SWITCH_DEBOUNCE_MS\) return;/);
  assert.match(amostrar, /if \(!foiPressaoLonga\) sinalizarSwitchAcao\(false\);/, "releasing after the 5 s hold must not send the failsafe");
  assert.match(amostrar, /if \(agora - actionSwitchPressedSinceMs >= AP_SWITCH_HOLD_MS\) \{\s*actionSwitchLongPressConsumed = true;\s*sinalizarSwitchAcao\(true\);/, "the setup AP opens once per press, after 5 s");
  assert.match(amostrar, /if \(!actionSwitchStableActive \|\| actionSwitchLongPressConsumed \|\| actionSwitchPressedSinceMs == 0\) return;/);
  assert.doesNotMatch(amostrar, /transmitirFailsafeSalvo|abrirApTemporario|Serial\./, "the sampler only records the press; the loop acts on it");
  assert.match(ino, /void loop\(\) \{\s*processarSwitchAcao\(\);/, "presses are acted on every cycle, including in AP mode");
  const configurar = bloco("void configurarSwitchAcao");
  assert.match(configurar, /actionSwitchLongPressConsumed = ativo;/, "a button held at boot fires neither the AP nor the failsafe");
});

// The switch was sampled only between loop() iterations. With the server accepting connections but
// never answering, HTTP and WebSocket calls block for seconds at a time: short taps were lost and a
// 6 s hold never reached the 5 s failsafe (virtual board, virtual-lab/ scenario "Switch com o servidor
// inalcancavel"). A periodic timer now samples it; the loop acts on what it recorded.
test("the switch is sampled by a periodic timer, so blocking network calls cannot hide a press", () => {
  assert.match(ino, /#include <esp_timer\.h>/);
  assert.match(ino, /const uint64_t ACTION_SWITCH_AMOSTRA_US = 10000;/);
  const configurar = bloco("void configurarSwitchAcao");
  assert.match(configurar, /amostragem\.callback = &amostrarSwitchAcao;/);
  assert.match(configurar, /esp_timer_start_periodic\(timerSwitchAcao, ACTION_SWITCH_AMOSTRA_US\)/);
  assert.ok(configurar.indexOf("actionSwitchLongPressConsumed = ativo;") < configurar.indexOf("esp_timer_create"), "the state is ready before the timer starts");
  const processar = bloco("void processarSwitchAcao");
  assert.match(processar, /if \(!timerSwitchAcao\) amostrarSwitchAcao\(nullptr\);/, "without the timer the loop samples as before");
  assert.match(processar, /portENTER_CRITICAL\(&muxSwitchAcao\);[\s\S]*switchToqueLongoPendente = false;\s*switchToqueCurtoPendente = false;\s*portEXIT_CRITICAL\(&muxSwitchAcao\);/, "presses are taken atomically");
  assert.match(processar, /if \(longo\) abrirApTemporario\(\);\s*if \(curto\) transmitirFailsafeSalvo\(\);/, "a short press sends the failsafe and a 5 s hold opens the setup AP");
  const chamadas = (nome) => ino.split("\n").filter((l) => l.includes(`${nome}()`) && !new RegExp(`^(void|bool) ${nome}\\(`).test(l)).length;
  assert.equal(chamadas("transmitirFailsafeSalvo"), 1, "the switch is the only caller of the local failsafe");
  assert.equal(chamadas("abrirApTemporario"), 1, "the switch is the only caller of the temporary AP");
  const sinalizar = bloco("void sinalizarSwitchAcao");
  assert.match(sinalizar, /portENTER_CRITICAL\(&muxSwitchAcao\);/);
});

test("the failsafe OFF is persisted in NVS, compared before rewriting and transmitted without the server", () => {
  assert.match(ino, /strcmp\(tipo, "failsafe_raw_set"\) == 0/);
  assert.match(ino, /strcmp\(tipo, "failsafe_raw_clear"\) == 0/);
  const salvar = bloco("bool salvarFailsafeRaw");
  assert.equal((salvar.match(/preferences\.put/g) || []).length, 1, "the failsafe is written as a single logical record, in one NVS write");
  assert.match(salvar, /preferences\.putBytes\(FAILSAFE_REC_KEY, bruto, total\) == total/);
  assert.match(salvar, /cabecalho\.crc32 = crcRegistroFailsafe\(cabecalho, rawData\)/);
  assert.match(salvar, /if \(!duracaoRawAceitavel\(rawData, length\)\) return false;/);
  assert.match(ino, /const uint32_t FAILSAFE_REC_MAGIC = 0x53464952UL;/);
  assert.match(ino, /const uint16_t FAILSAFE_REC_VERSAO = 1;/);
  const ler = bloco("bool lerRegistroFailsafe");
  assert.match(ler, /cabecalho\.magic == FAILSAFE_REC_MAGIC && cabecalho\.versao == FAILSAFE_REC_VERSAO/);
  assert.match(ler, /crcRegistroFailsafe\(cabecalho, dados\) == cabecalho\.crc32/);
  assert.match(ler, /esperado == total/, "header and blob lengths must match");
  const migrar = bloco("void migrarFailsafeLegado");
  assert.match(migrar, /preferences\.getBytesLength\("fsRaw"\) == bytes/, "the four old keys are migrated once to the single record");
  for (const chave of ["fsRaw", "fsLen", "fsHz", "fsProto"]) assert.match(ino, new RegExp(`preferences\\.remove\\("${chave}"\\)`));
  assert.match(bloco("void setup"), /migrarFailsafeLegado\(\);\s*carregarFailsafeCache\(\);/);
  assert.doesNotMatch(ino, /new uint16_t\[/, "every dynamic RAW allocation uses std::nothrow and is checked");
  assert.match(ino, /#define MAX_RAW_IR_DURACAO_US 2000000UL/);
  assert.match(bloco("bool duracaoRawAceitavel"), /if \(total > MAX_RAW_IR_DURACAO_US\) return false;/);
  assert.match(ino, /if \(failsafeIgualAoSalvo\(rawData, i, carrierHz, protocolRecordId\)\)/, "repeated synchronization does not wear the NVS");
  assert.match(ino, /rawArr\.size\(\) > MAX_RAW_IR_ENTRIES\s*\|\| carrierHz < FAILSAFE_CARRIER_MIN_HZ \|\| carrierHz > FAILSAFE_CARRIER_MAX_HZ/);
  assert.match(ino, /const uint32_t FAILSAFE_CARRIER_MIN_HZ = 20000;/);
  assert.match(ino, /const uint32_t FAILSAFE_CARRIER_MAX_HZ = 60000;/);
  assert.match(ino, /#define MAX_RAW_IR_ENTRIES CAPTURE_BUFFER_SIZE/);
  assert.match(ino, /#define CAPTURE_BUFFER_SIZE 1024/);
  const transmitir = bloco("bool transmitirFailsafeSalvo");
  assert.match(transmitir, /sendRawIR\(rawData, length, failsafeCarrierHzSalvo\(\) \/ 1000\)/);
  assert.match(transmitir, /lerRegistroFailsafe\(cabecalho, rawData, length\)/, "the transmitted RAW comes from the CRC-validated record");
  assert.doesNotMatch(transmitir, /WiFi\.status|estadoWsServidor == WS_ESTADO_CONECTADO \|\|/, "the local failsafe does not depend on the network");
  assert.match(transmitir, /definirFailsafeLatch\(true\)/, "the local OFF stays latched until an explicit command");
  assert.match(ino, /doc\["tipo"\] = "failsafe_status"/);
  assert.match(bloco("void enviarInfoDispositivo"), /preencherStatusFailsafe\(doc\)/);
  assert.match(bloco("void enviarTelemetriaWs"), /preencherStatusFailsafe\(doc\)/);
  assert.match(bloco("void preencherStatusFailsafe"), /doc\["failsafeLatched"\] = failsafeLatched;/);
});

test("the persisted local OFF is only undone by an explicit server command and never leaves the board stuck", () => {
  const setup = bloco("void setup");
  assert.match(setup, /failsafeLatched = preferences\.isKey\(FAILSAFE_LATCH_KEY\)/);
  assert.match(setup, /if \(failsafeLatched\) \{\s*lastKnownPower = false;\s*powerConhecido = true;/);
  const processar = bloco("void processarComandoServidor");
  const conhecido = processar.slice(processar.indexOf('"send_known_state"'));
  assert.match(conhecido, /powerConhecido = true;\s*definirFailsafeLatch\(false\);/, "send_known_state limpa o latch");
  const raw = processar.slice(processar.indexOf('"send_raw"'), processar.indexOf('"send_known_state"'));
  assert.match(raw, /definirFailsafeLatch\(false\);/, "send_raw limpa o latch");
  assert.match(raw, /new \(std::nothrow\) uint16_t\[count\]/);
  assert.match(raw, /rejeitado_memoria/);
  assert.match(raw, /rejeitado_duracao/);
  const claro = processar.slice(processar.indexOf('"failsafe_raw_clear"'), processar.indexOf('"reset_wifi"'));
  assert.doesNotMatch(claro, /definirFailsafeLatch/, "erasing the failsafe RAW is not a control command");
  const latch = bloco("void definirFailsafeLatch");
  assert.match(latch, /if \(failsafeLatched == ativo\) return;/, "no rewrite when nothing changes");
  assert.match(bloco("void enviarInfoDispositivo"), /if \(powerConhecido\) doc\["ligado"\] = lastKnownPower;/);
});

// ota_oferta arrives inside the WebSocket library's event callback. A download run from there calls
// wsCliente.loop() re-entrantly, which reads no frames: the board sent progress but never answered the
// server's pings, so the server closed the socket and recorded the transfer as failed while the board
// finished and installed the image (virtual board, virtual-lab/ OTA scenarios). The offer is only
// validated in the callback; the download runs from loop(), where the socket keeps being serviced.
test("an accepted OTA offer is downloaded from loop(), outside the WebSocket callback", () => {
  const oferta = bloco("void iniciarOtaOferta");
  assert.doesNotMatch(oferta, /HTTPClient|Update\.begin|while \(recebido < tamanho\)/, "the callback only validates and records the offer");
  assert.match(oferta, /otaEmAndamento = true;\s*ofertaOta\.pendente = true;/);
  assert.match(bloco("void loop"), /if \(ofertaOta\.pendente\) executarOtaPendente\(\);/);
  assert.match(bloco("void executarOtaPendente"), /^void executarOtaPendente\(\) \{\s*ofertaOta\.pendente = false;/);
});

test("during OTA the physical switch and buzzer are still serviced and the download has a total deadline", () => {
  const ota = bloco("void executarOtaPendente");
  const laco = ota.slice(ota.indexOf("while (recebido < tamanho)"));
  assert.match(laco, /^\s*while \(recebido < tamanho\) \{\s*processarSwitchAcao\(\);\s*atualizarBuzzer\(\);\s*atualizarLedRede\(\);/);
  assert.doesNotMatch(ota, /atualizarApAutomatico|aplicarPontoDeAcesso/, "the automatic setup AP is not opened while a firmware download is under way; the switch still is");
  assert.match(laco, /OTA_TOTAL_TIMEOUT_MS/);
  assert.match(ino, /const unsigned long OTA_TOTAL_TIMEOUT_MS = 600000;/);
});

// The Arduino core marks a freshly updated image valid in initArduino(), before setup() runs, unless
// the sketch overrides the weak C function verifyRollbackLater(). A plain C++ definition compiles but
// is name-mangled and never replaces it, so the self-test below would never run: the virtual board
// showed a candidate that could not reach the server staying active (virtual-lab/, OTA scenarios).
test("a new OTA image stays pending until the firmware's own boot validation accepts or rolls it back", () => {
  assert.match(ino, /^extern "C" bool verifyRollbackLater\(\) \{\s*return true;\s*\}/m);
  assert.match(bloco("void setup"), /estadoOta == ESP_OTA_IMG_PENDING_VERIFY\) \{\s*otaPendenteValidacao = true;/);
  const validar = bloco("void verificarValidacaoOta");
  assert.match(validar, /esp_ota_mark_app_valid_cancel_rollback\(\)/);
  assert.match(validar, /esp_ota_mark_app_invalid_rollback_and_reboot\(\)/);
  assert.match(ino, /const unsigned long OTA_SELFTEST_TIMEOUT_MS = 90000;/);
});

test("the role comes from the server: only the cloner enters clone or capture mode and the role is not persisted", () => {
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

test("the access point stays off while the server is reachable and only returns without configuration, after reset, through the switch or when the server stays unreachable", () => {
  assert.match(bloco("void setup"), /WiFi\.mode\(WIFI_STA\);\s*WiFi\.softAPdisconnect\(true\);/);
  assert.doesNotMatch(bloco("void setup"), /aplicarPontoDeAcesso\(/, "a configured boot does not start the AP");
  assert.match(bloco("void startAPMode"), /aplicarPontoDeAcesso\(false\)/);
  assert.match(bloco("void abrirApTemporario"), /aplicarPontoDeAcesso\(true\)/, "the switch AP keeps the station connected");
  assert.match(ino, /const unsigned long AP_TEMPORARIO_TIMEOUT_MS = 600000;/);
  assert.match(bloco("void loop"), /if \(apTemporarioAte != 0 && \(long\)\(millis\(\) - apTemporarioAte\) >= 0\) encerrarApTemporario\(\);/);
  assert.match(bloco("void encerrarApTemporario"), /WiFi\.softAPdisconnect\(true\);\s*WiFi\.mode\(WIFI_STA\);/);

  assert.match(ino, /const unsigned long INTERVALO_RECONEXAO_WIFI_MS = 30000;/);
  assert.match(ino, /const unsigned long AP_AUTOMATICO_CARENCIA_MS = 3 \* INTERVALO_RECONEXAO_WIFI_MS;/, "the grace period spans several reconnection cycles, so a normal reconnection never opens the AP");
  assert.match(bloco("bool servidorIndisponivelAlemDaCarencia"), /return servidorIndisponivelDesde != 0 && millis\(\) - servidorIndisponivelDesde >= AP_AUTOMATICO_CARENCIA_MS;/);
  const automatico = bloco("void atualizarApAutomatico");
  assert.match(automatico, /if \(canalServidorAberto\(\)\) \{\s*servidorIndisponivelDesde = 0;\s*if \(apAberturaAutomatica\) \{\s*Serial\.println\("[^"]*"\);\s*encerrarApTemporario\(\);\s*\}\s*return;\s*\}/, "the server channel coming back closes only an AP the firmware opened by itself");
  assert.match(automatico, /if \(apIniciado \|\| !servidorIndisponivelAlemDaCarencia\(\)\) return;\s*aplicarPontoDeAcesso\(true\);/, "the AP opens only after the grace period, keeps the station retrying and never takes over an AP already open");
  assert.match(automatico, /if \(!apIniciado\) \{\s*servidorIndisponivelDesde = agora;\s*return;\s*\}/, "a failed AP start waits another grace period instead of retrying every pass");
  assert.match(automatico, /registrarPortal\(\);\s*server\.begin\(\);\s*apAberturaAutomatica = true;/);
  assert.match(automatico, /if \(meshModo\(\) != MESH_MODO_DIRETO\) apTemporarioAte = agora \+ AP_TEMPORARIO_TIMEOUT_MS;/, "on the mesh the automatic AP replaces the mesh AP, so it has the switch's window and its end restarts the board");
  assert.match(bloco("void abrirApTemporario"), /if \(apModeActive\) return;\s*bool jaAberto = apIniciado;\s*apAberturaAutomatica = false;/, "a switch hold makes the AP the user's: the server coming back does not close it");
  const encerrar = bloco("void encerrarApTemporario");
  assert.match(encerrar, /if \(meshModo\(\) == MESH_MODO_DIRETO && servidorIndisponivelAlemDaCarencia\(\)\) \{\s*apAberturaAutomatica = true;\s*Serial\.println\("[^"]*"\);\s*return;\s*\}\s*apAberturaAutomatica = false;\s*server\.stop\(\);/, "a direct board whose window ends with no server keeps the AP, now automatic");
  assert.match(encerrar, /if \(meshModo\(\) != MESH_MODO_DIRETO\) \{\s*reportComando\("setup_ap", "encerrado"\);[\s\S]*?agendarReinicio\(1000\);\s*return;\s*\}/, "on the mesh closing still restarts the board to bring the mesh back");
  const loop = bloco("void loop");
  assert.ok(loop.indexOf("if (apModeActive) {") < loop.indexOf("atualizarApAutomatico();"), "the provisioning AP is never touched");
  assert.ok(loop.indexOf("wsCliente.loop();") < loop.indexOf("atualizarApAutomatico();") && loop.indexOf("meshProcessar();") < loop.indexOf("atualizarApAutomatico();"), "the decision uses this pass's channel state");
  assert.match(bloco("void loop"), /if \(apIniciado\) \{\s*dnsServer\.processNextRequest\(\);\s*server\.handleClient\(\);/);
  assert.equal(fs.existsSync(path.join(ESP, "data", "status.html")), false, "the local status page no longer exists");
  assert.doesNotMatch(ino, /handleRoot|handleInfo|status\.html|reportAccess/);
  assert.match(ino, /strcmp\(tipo, "reset_wifi"\) == 0/);
});

test("every IR transmission is preceded by the buzzer for at least 100 ms, and loop() switches the buzzer off", () => {
  assert.match(ino, /const unsigned long BUZZER_ANTECEDENCIA_IR_MS = 100;/);
  assert.match(bloco("void avisarAntesDoIr"), /^void avisarAntesDoIr\(\) \{\s*iniciarAvisoBuzzer\(\);\s*const unsigned long inicio = micros\(\);\s*while \(micros\(\) - inicio < BUZZER_ANTECEDENCIA_IR_MS \* 1000UL\) delay\(1\);\s*\}$/, "the buzzer starts first and the wait is measured from it, never shorter than 100 ms");
  assert.match(bloco("void sendRawIR"), /^void sendRawIR\([^)]*\) \{\s*avisarAntesDoIr\(\);\s*irsend\.sendRaw\(rawData, length, frequency\);\s*atualizarBuzzer\(\);\s*\}$/);
  const conhecido = bloco("void sendKnownACState");
  assert.match(conhecido, /avisarAntesDoIr\(\);\s*universalAC\.sendAc\(\);\s*atualizarBuzzer\(\);\s*\}$/);
  assert.ok(conhecido.indexOf("if (!universalAC.isProtocolSupported(protocol)) return;") < conhecido.indexOf("avisarAntesDoIr();"), "a protocol the library cannot send sounds nothing");
  assert.equal((ino.match(/irsend\.send|universalAC\.send/g) || []).length, 2, "every IR transmission goes through sendRawIR or sendKnownACState");
  assert.equal((ino.match(/avisarAntesDoIr\(\);/g) || []).length, 3, "declared once and called right before each of the two transmissions");
  assert.doesNotMatch(bloco("void iniciarAvisoBuzzer"), /delay\(/);
  assert.doesNotMatch(bloco("void atualizarBuzzer"), /delay\(/);
  assert.match(bloco("void loop"), /atualizarBuzzer\(\);/);
  assert.match(ino, /const unsigned long BUZZER_MIN_MS = 60;/);
});

test("the board echoes the desired state version and never transmits the server's automatic restoration", () => {
  const versao = platformio.match(/-DFW_VERSAO=\\"(\d+\.\d+\.\d+)\\"/);
  assert.ok(compararVersoes(versao[1], "4.3.0") >= 0, "version echo and restoration refusal exist from 4.3.0");
  assert.ok(compararVersoes(versao[1], "4.4.0") >= 0, "a restoration transmits nothing from 4.4.0");
  assert.match(ino, /uint32_t ultimaVersaoEstado = 0;/);
  assert.match(ino, /bool versaoEstadoConhecida = false;/);
  assert.match(bloco("void preencherVersaoEstado"), /^void preencherVersaoEstado\(JsonDocument& doc\) \{\s*if \(failsafeLatched && versaoRecebidaConhecida\) doc\["versao"\] = ultimaVersaoRecebida;\s*else if \(versaoEstadoConhecida\) doc\["versao"\] = ultimaVersaoEstado;\s*\}$/, "only a board latched in local OFF echoes a version it received without transmitting, so the server can adopt that OFF; otherwise the echo is the version it transmitted");
  assert.equal((ino.match(/ultimaVersaoRecebida/g) || []).length, 3, "the received version is declared, written once and read only by the latched echo");
  for (const fn of ["void enviarInfoDispositivo", "void enviarTelemetriaWs", "void enviarStatusFailsafe"]) {
    assert.match(bloco(fn), /preencherVersaoEstado\(doc\);/, `${fn} must echo the version`);
  }
  const processar = bloco("void processarComandoServidor");
  const conhecido = processar.slice(processar.indexOf('"send_known_state"'), processar.indexOf('"failsafe_raw_set"'));
  assert.match(conhecido, /bool restauracao = doc\["restauracao"\] \| false;/);
  assert.match(conhecido, /if \(protocolo >= 0\) \{\s*if \(doc\["versao"\]\.is<uint32_t>\(\)\) \{\s*ultimaVersaoRecebida = doc\["versao"\]\.as<uint32_t>\(\);\s*versaoRecebidaConhecida = true;\s*\}\s*if \(restauracao && !failsafeLatched\) \{\s*Serial\.println\("[^"]*"\);\s*return;\s*\}/, "a restoration on an unlatched board transmits nothing and reports nothing new; only the version it received is kept");
  const semTrava = conhecido.indexOf("if (restauracao && !failsafeLatched)");
  for (const depois of ['ultimaVersaoEstado = doc["versao"]', "sendKnownACState(", "lastKnownPower = power;", "definirFailsafeLatch(false)", "ultimoComando = UltimoComandoIR();", "enviarTelemetriaWs();"]) {
    assert.ok(semTrava >= 0 && semTrava < conhecido.indexOf(depois), `the untransmitted restoration returns before ${depois}: the server never sees it confirmed`);
  }
  assert.match(conhecido, /if \(doc\["versao"\]\.is<uint32_t>\(\)\) \{\s*ultimaVersaoEstado = doc\["versao"\]\.as<uint32_t>\(\);\s*versaoEstadoConhecida = true;\s*\} else \{\s*versaoEstadoConhecida = false;\s*\}/, "a latched board records the version of the restoration it refuses, so the server can adopt the local OFF; a transmission without a version (an administrative test) stops the echo, also across a server restart");
  assert.match(processar.slice(processar.indexOf('"send_raw"'), processar.indexOf('"send_known_state"')), /definirFailsafeLatch\(false\);\s*versaoEstadoConhecida = false;/, "after a RAW transmission the board no longer echoes an intent it may have overridden");
  assert.match(conhecido, /if \(restauracao && failsafeLatched\) \{\s*reportComando\("controle_nativo", "ignorado_failsafe_latch"\);\s*enviarStatusFailsafe\(\);\s*return;\s*\}/, "a board latched in local OFF ignores the restoration and answers with failsafe_status");
  assert.ok(conhecido.indexOf("if (restauracao && failsafeLatched)") < conhecido.indexOf("sendKnownACState("), "the refusal comes before any IR transmission");
  assert.ok(conhecido.indexOf("if (restauracao && failsafeLatched)") < conhecido.indexOf("definirFailsafeLatch(false)"), "the refusal comes before clearing the latch");
  assert.match(conhecido, /lastTelemetryWs = millis\(\);\s*enviarTelemetriaWs\(\);/, "the applied state is confirmed immediately");
  const raw = processar.slice(processar.indexOf('"send_raw"'), processar.indexOf('"send_known_state"'));
  assert.doesNotMatch(raw, /restauracao/, "send_raw is always explicit");
});

test("the credential changes only in RAM and reconnects only after being written and reread from NVS; failure keeps the current one", () => {
  const aplicar = bloco("void aplicarCredencial");
  assert.match(aplicar, /bool gravado = gravarChaveNvsVerificada\("devId", novoId\) && gravarChaveNvsVerificada\("devSec", novoSegredo\);/);
  assert.match(aplicar, /if \(!gravado\) \{\s*restaurarChaveNvs\("devId", idAnterior\);\s*restaurarChaveNvs\("devSec", segredoAnterior\);\s*reportComando\("credencial", "falha_nvs"\);/, "a partial write is undone and reported");
  assert.ok(aplicar.indexOf("if (!gravado)") < aplicar.indexOf("deviceId = novoId;"), "RAM only changes after the verified write");
  assert.ok(aplicar.indexOf("deviceId = novoId;") < aplicar.indexOf("conectarWsServidor();"), "reconnecting with the new secret comes afterwards");
  assert.doesNotMatch(aplicar.slice(0, aplicar.indexOf("bool gravado")), /deviceId = novoId|deviceSecret = novoSegredo/);
  const gravar = bloco("bool gravarChaveNvsVerificada");
  assert.match(gravar, /preferences\.putString\(chave, valor\) != valor\.length\(\)\) return false;/);
  assert.match(gravar, /return preferences\.getString\(chave, ""\) == valor;/, "the write is reread from NVS");
  const restaurar = bloco("void restaurarChaveNvs");
  assert.match(restaurar, /else if \(preferences\.isKey\(chave\)\) preferences\.remove\(chave\);/, "without a previous value the key is removed instead of left empty");
});

test("a transport mode stored in NVS that the firmware does not know means certificate validation, never an unvalidated connection", () => {
  assert.match(bloco("void setup"), /tlsModo = preferences\.isKey\("tls"\) \? preferences\.getString\("tls", "ca"\) : "ca";\s*if \(tlsModo != "ca" && tlsModo != "inseguro" && tlsModo != "off"\) tlsModo = "ca";/);
  assert.match(bloco("void handleSaveSetup"), /if \(newTls != "ca" && newTls != "inseguro" && newTls != "off"\) newTls = "ca";/, "the portal applies the same rule before saving");
  assert.equal((ino.match(/preferences\.getString\("tls"/g) || []).length, 1, "the stored mode is read in one place only");
});

// The setup AP is always 192.168.4.1/24. Opened next to a station on a network that is itself
// 192.168.4.0/24, the board had two interfaces in one subnet: the session already open went on, but no
// new connection to the server could be made until the AP closed, ten minutes after the last press
// (virtual board, virtual-lab/ scenario 09, against the same firmware with only the AP moved).
test("a temporary setup AP never shares the station's subnet", () => {
  const endereco = bloco("IPAddress enderecoDoPontoDeAcesso");
  assert.match(endereco, /const bool mesmaSubrede = manterSta && sta\[0\] == 192 && sta\[1\] == 168 && sta\[2\] == 4;/);
  assert.match(endereco, /return IPAddress\(192, 168, mesmaSubrede \? 5 : 4, 1\);/);
  const aplicar = bloco("void aplicarPontoDeAcesso");
  assert.ok(aplicar.indexOf("IPAddress apIP = enderecoDoPontoDeAcesso(manterSta);") < aplicar.indexOf("WiFi.mode("), "the address is chosen from the station before the mode changes");
  assert.match(aplicar, /IPAddress apIP = enderecoDoPontoDeAcesso\(manterSta\);\s*if \(apIniciado && senhaAlvo == apPasswordAtiva && WiFi\.softAPIP\(\) == apIP\) return;/, "an open AP is reapplied when its subnet has to change");
  assert.match(bloco("void gerenciarConexaoWifi"), /ultimaIdentificacao = 0;\s*if \(apIniciado && !apModeActive\) aplicarPontoDeAcesso\(true\);\s*\}/, "a station that joins a 192.168.4.x network while the AP is open moves the AP out of its subnet");
  assert.match(aplicar, /WiFi\.softAPConfig\(apIP, apIP, IPAddress\(255, 255, 255, 0\)\);/);
  assert.match(aplicar, /if \(apIniciado\) dnsServer\.stop\(\);\s*dnsServer\.start\(53, "\*", apIP\);/, "the captive DNS answers with the AP's current address, also when a policy change reapplies the AP");
  assert.doesNotMatch(ino, /IPAddress apIP\(192, 168, 4, 1\)/);
  assert.doesNotMatch(ino, /Serial\.println\("[^"]*192\.168\.4\.1/, "messages print the AP's real address");
  assert.match(bloco("bool requisicaoPortalPermitida"), /server\.client\(\)\.localIP\(\) == WiFi\.softAPIP\(\)/);
});

test("the network LED on GPIO 25 shows the server channel in every transport mode and the provisioning AP", () => {
  assert.match(ino, /const unsigned long WIFI_TENTATIVA_DURACAO_MS = 15000;/);
  assert.match(ino, /const unsigned long NETWORK_LED_SHORT_BLINK_MS = 200;/);
  assert.match(ino, /const unsigned long NETWORK_LED_LONG_BLINK_MS = 1200;/);
  assert.match(bloco("void setup"), /pinMode\(NETWORK_LED_PIN, OUTPUT\);\s*escreverLedRede\(true\);/, "lit from power-on until the server channel opens");
  assert.match(bloco("void loop"), /^void loop\(\) \{\s*processarSwitchAcao\(\);\s*atualizarBuzzer\(\);\s*atualizarLedRede\(\);/, "updated every pass, also in the provisioning AP");
  assert.match(bloco("NetworkLedState estadoDaRedeParaLed"), /if \(apModeActive\) return NETWORK_LED_SEM_REDE;\s*if \(canalServidorAberto\(\)\) return NETWORK_LED_SERVIDOR_CONECTADO;\s*if \(meshNoAtivo\(\)\) return NETWORK_LED_CONECTANDO;\s*if \(estadoWifi == WIFI_ESTADO_CONECTADO\) return NETWORK_LED_SERVIDOR_INDISPONIVEL;\s*if \(ultimaTentativaReconexao != 0 && agora - ultimaTentativaReconexao < WIFI_TENTATIVA_DURACAO_MS\) return NETWORK_LED_CONECTANDO;\s*return NETWORK_LED_SEM_REDE;/, "the server channel decides for direct boards, gateways and mesh nodes alike");
  const atualizar = bloco("void atualizarLedRede");
  assert.match(atualizar, /if \(estadoLedRede == NETWORK_LED_SERVIDOR_CONECTADO\) \{\s*escreverLedRede\(false\);\s*\} else if \(estadoLedRede == NETWORK_LED_SEM_REDE\) \{\s*escreverLedRede\(true\);/, "off with the server, steady without a network");
  assert.match(atualizar, /estadoLedRede == NETWORK_LED_CONECTANDO \? NETWORK_LED_SHORT_BLINK_MS : NETWORK_LED_LONG_BLINK_MS;/, "fast blink while connecting, slow blink while the network is up and the server is not");
  const escrever = bloco("void escreverLedRede");
  assert.match(escrever, /if \(nivel == nivelLedRede\) return;/, "the pin is written only when its level changes");
  assert.match(escrever, /digitalWrite\(NETWORK_LED_PIN, aceso \? NETWORK_LED_ACTIVE_LEVEL : !NETWORK_LED_ACTIVE_LEVEL\);/);
  assert.equal((ino.match(/digitalWrite\(NETWORK_LED_PIN/g) || []).length, 1, "one writer for the LED");
  assert.doesNotMatch(atualizar + escrever, /delay\(/);
});

test("connecting, reconnecting and synchronizing never transmit IR: the buzzer alone signals the session", () => {
  const evento = bloco("void handleWsServidorEvent");
  const conectado = evento.slice(evento.indexOf("case WStype_CONNECTED:"), evento.indexOf("case WStype_TEXT:"));
  assert.match(conectado, /Serial\.println\("WS servidor: conectado\."\);\s*enviarInfoDispositivo\(\);\s*iniciarAvisoBuzzer\(\);\s*break;/, "the beep comes after the session is logged and announced");
  assert.match(bloco("void loop"), /if \(canalMalhaAnterior\) \{\s*enviarInfoDispositivo\(\);\s*iniciarAvisoBuzzer\(\);\s*\}/, "a mesh node beeps when its session with the server opens");
  for (const fn of ["void setup", "void handleWsServidorEvent", "void enviarInfoDispositivo", "void gerenciarConexaoWifi", "void conectarWsServidor", "void identificarSalaNoServidor", "void configurarMalha", "void atualizarApAutomatico", "void carregarFailsafeCache"]) {
    assert.doesNotMatch(bloco(fn), /sendRawIR|sendKnownACState|transmitirFailsafeSalvo|avisarAntesDoIr|irsend\.send|universalAC\.send/, `${fn} never transmits IR`);
  }
});

test("the cloner ignores captures the IR library cannot transmit as an air-conditioner state", () => {
  const captura = bloco("void handleIRCapture");
  assert.match(captura, /bool isKnownAC = universalAC\.isProtocolSupported\(results\.decode_type\);\s*if \(!isKnownAC\) \{\s*reportComando\("sinal_ignorado", "protocolo=" \+ protocolName \+ ";hex=" \+ hexValue\);\s*if \(isCapturing && runtimeMode == RUNTIME_CONFIG_CLONE\) irrecv\.resume\(\);\s*return;\s*\}/, "an unsupported capture is reported as ignored and the receiver keeps listening");
  const ignorar = captura.indexOf("if (!isKnownAC)");
  assert.ok(ignorar < captura.indexOf("resultToRawArray("), "nothing is allocated for an ignored capture");
  assert.ok(ignorar < captura.indexOf('doc["tipo"] = "captura";'), "an ignored capture never reaches the server");
});

test("swing is on unless a command explicitly turns it off", () => {
  const conhecido = bloco("void processarComandoServidor").slice(bloco("void processarComandoServidor").indexOf('"send_known_state"'));
  assert.match(conhecido, /bool swing = doc\["swing"\] \| true;/);
  assert.match(bloco("void sendKnownACState"), /universalAC\.next\.swingv = swing \? stdAc::swingv_t::kAuto : stdAc::swingv_t::kOff;/);
});

test("the firmware carries no code comments", () => {
  assert.doesNotMatch(ino, /^\s*\/\//m);
  assert.doesNotMatch(ino, /\/\*/);
});
