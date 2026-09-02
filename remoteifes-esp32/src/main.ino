#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <DHT.h>
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRsend.h>
#include <IRutils.h>
#include <IRac.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <string.h>

#include "root_ca.h"

#ifndef FW_VERSAO
#define FW_VERSAO "0.0.0-dev"
#endif

#define DHTPIN 14
#define DHTTYPE DHT11
#define IR_RECV_PIN 15
#define IR_SEND_PIN 4

#define CAPTURE_BUFFER_SIZE 1024
#define IR_CAPTURE_TIMEOUT_MS 50
#define HTTP_CLIENT_TIMEOUT_MS 2500
#define MAX_RAW_IR_ENTRIES CAPTURE_BUFFER_SIZE

const float AC_TEMP_MIN = 16.0;
const float AC_TEMP_MAX = 30.0;

const unsigned long SERVER_HEARTBEAT_INTERVAL = 30000;
const unsigned long TELEMETRY_WS_INTERVAL = 10000;
const unsigned long SENSOR_READ_INTERVAL = 2500;
const unsigned long WS_RECONNECT_INTERVAL_MS = 5000;
const unsigned long IDENTIFICACAO_INTERVAL_MS = 60000;
const unsigned long IDENTIFICACAO_PENDENTE_INTERVAL_MS = 15000;
const unsigned long INTERVALO_RECONEXAO_WIFI_MS = 30000;
const unsigned long INTERVALO_AP_RECUPERACAO_MS = 120000;
const char SERVER_IDENTIFICACAO_PATH[] = "/dispositivo/identificar";
const char SERVER_HEARTBEAT_PATH[] = "/dispositivo/heartbeat";
const char DEVICE_WS_PATH[] = "/ws/dispositivo";
const char AP_PASSWORD_PADRAO[] = "remoteifes";

const unsigned long OTA_SELFTEST_TIMEOUT_MS = 90000;
const unsigned long OTA_HTTP_TIMEOUT_MS = 20000;
const size_t OTA_BUFFER_BYTES = 1024;
const unsigned long OTA_PROGRESSO_INTERVALO_BYTES = 65536;

enum RuntimeMode {
  RUNTIME_OPERATION = 0,
  RUNTIME_CONFIG_IDLE = 1,
  RUNTIME_CONFIG_CLONE = 2
};

enum WifiState {
  WIFI_ESTADO_DESCONECTADO = 0,
  WIFI_ESTADO_CONECTADO = 1
};

enum ServerWsState {
  WS_ESTADO_DESCONECTADO = 0,
  WS_ESTADO_CONECTADO = 1
};

struct UltimoComandoIR {
  bool valido = false;
  String tipo;
  int protocolo = -1;
  float temp = 0;
  bool power = false;
  bool turbo = false;
  bool swing = false;
  String fan;
  unsigned long timestampMs = 0;
};

WebServer server(80);
WebSocketsClient wsCliente;
DNSServer dnsServer;
Preferences preferences;
DHT dht(DHTPIN, DHTTYPE);

IRrecv irrecv(IR_RECV_PIN, CAPTURE_BUFFER_SIZE, IR_CAPTURE_TIMEOUT_MS, true);
IRsend irsend(IR_SEND_PIN);
IRac universalAC(IR_SEND_PIN);
decode_results results;

bool isCapturing = false;
bool apModeActive = false;
bool apRecuperacaoAtivo = false;
RuntimeMode runtimeMode = RUNTIME_OPERATION;
WifiState estadoWifi = WIFI_ESTADO_DESCONECTADO;
ServerWsState estadoWsServidor = WS_ESTADO_DESCONECTADO;

unsigned long lastSensorRead = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastTelemetryWs = 0;
bool lastKnownPower = false;
bool powerConhecido = false;
UltimoComandoIR ultimoComando;

float ultimaLeituraTemp = NAN;
float ultimaLeituraHum = NAN;

bool wifiConectadoAnteriormente = false;
unsigned long ultimaTentativaReconexao = 0;
unsigned long wifiDesconectadoDesde = 0;
unsigned long ultimaIdentificacao = 0;
unsigned long reinicioAgendadoEm = 0;
bool servicosOperacaoIniciados = false;
bool wsConfigurado = false;
String salaWsConfigurada;
bool littleFsOk = false;

bool otaPendenteValidacao = false;
unsigned long otaValidacaoLimite = 0;
bool otaEmAndamento = false;
bool credencialAlterada = false;

String salaId;
String serverHost;
int serverPort = 0;
String tlsModo;
String deviceId;
String deviceSecret;
String apPassword;
unsigned long lastComandoAceito = 0;
const unsigned long INTERVALO_MINIMO_COMANDO_MS = 400;

void startAPMode();
void iniciarApRecuperacao();
void encerrarApRecuperacao();
void iniciarServicosOperacao();
void handleRoot();
void handleInfo();
void handleSetup();
void handleSaveSetup();
bool requisicaoPortalPermitida();
String escaparHtml(const String& valor);
void handleIRCapture();
void sendRawIR(const uint16_t* rawData, uint16_t length, uint16_t frequency);
void sendKnownACState(decode_type_t protocol, float temp, bool power, bool turbo, const String& fan, bool swing);
void atualizarLeituraSensores();
String urlServidor(const char* path);
int executarHttpPost(const String& url, const String& payload, String& resposta);
bool sendHttpPost(const String& url, const String& payload);
void sendHeartbeat();
void reportAccess(const String& ip, const String& userAgent);
void reportComando(const String& cmd, const String& valor);
void gerenciarConexaoWifi();
bool configuracaoValida();
bool comandoPermitidoAgora();
void conectarWsServidor();
void handleWsServidorEvent(WStype_t type, uint8_t* payload, size_t length);
void processarComandoServidor(uint8_t* payload, size_t length);
void enviarTelemetriaWs();
void enviarModoAlterado();
void enviarInfoDispositivo();
const char* modoAtualTexto();
void identificarSalaNoServidor();
void agendarReinicio(unsigned long esperaMs);
void verificarValidacaoOta();
void aplicarCredencial(JsonDocument& doc);
void iniciarOtaOferta(JsonDocument& doc);
void reportarOtaResultado(bool ok, const String& erro);
void reportarOtaProgresso(size_t recebido, size_t total);
bool versaoSemanticaMenor(const String& candidata, const String& atual);

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.printf("\n--- RemoteIFES IR System Initializing (fw %s) ---\n", FW_VERSAO);

  littleFsOk = LittleFS.begin(true);
  if (!littleFsOk) {
    Serial.println("Falha ao montar LittleFS.");
  }

  const esp_partition_t* particaoAtual = esp_ota_get_running_partition();
  esp_ota_img_states_t estadoOta;
  if (particaoAtual && esp_ota_get_state_partition(particaoAtual, &estadoOta) == ESP_OK
      && estadoOta == ESP_OTA_IMG_PENDING_VERIFY) {
    otaPendenteValidacao = true;
    otaValidacaoLimite = millis() + OTA_SELFTEST_TIMEOUT_MS;
    Serial.println("Firmware recem-instalado aguardando autovalidacao (rollback automatico se falhar).");
  }

  dht.begin();
  irsend.begin();

  preferences.begin("remoteifes", false);
  apPassword = AP_PASSWORD_PADRAO;
  String savedSSID = preferences.isKey("ssid") ? preferences.getString("ssid", "") : "";
  String savedPASS = preferences.isKey("pass") ? preferences.getString("pass", "") : "";
  if (preferences.isKey("sala")) preferences.remove("sala");
  if (preferences.isKey("adminHash")) preferences.remove("adminHash");
  salaId = "";
  serverHost = preferences.isKey("host") ? preferences.getString("host", "") : "";
  serverPort = preferences.isKey("porta") ? preferences.getInt("porta", 0) : 0;
  tlsModo = preferences.isKey("tls") ? preferences.getString("tls", "ca") : "ca";
  if (tlsModo != "ca") Serial.println("AVISO DE SEGURANCA: transporte sem validacao de certificado foi selecionado explicitamente.");
  deviceId = preferences.isKey("devId") ? preferences.getString("devId", "") : "";
  deviceSecret = preferences.isKey("devSec") ? preferences.getString("devSec", "") : "";

  if (savedSSID.length() > 0 && configuracaoValida()) {
    Serial.printf("Conectando a rede salva: %s\n", savedSSID.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(false);
    WiFi.begin(savedSSID.c_str(), savedPASS.c_str());
    apModeActive = false;
    iniciarServicosOperacao();
  } else {
    startAPMode();
  }
}

void loop() {
  if (apModeActive) {
    dnsServer.processNextRequest();
    server.handleClient();
    if (reinicioAgendadoEm != 0 && (long)(millis() - reinicioAgendadoEm) >= 0) ESP.restart();
    return;
  }

  if (apRecuperacaoAtivo) dnsServer.processNextRequest();
  gerenciarConexaoWifi();
  server.handleClient();
  wsCliente.loop();

  if (otaPendenteValidacao) verificarValidacaoOta();

  if (isCapturing && runtimeMode == RUNTIME_CONFIG_CLONE) {
    handleIRCapture();
  } else if (isCapturing) {
    irrecv.disableIRIn();
    isCapturing = false;
  }

  unsigned long agora = millis();
  if (agora - lastSensorRead >= SENSOR_READ_INTERVAL) {
    lastSensorRead = agora;
    atualizarLeituraSensores();
  }

  if (agora - lastTelemetryWs >= TELEMETRY_WS_INTERVAL && estadoWsServidor == WS_ESTADO_CONECTADO) {
    lastTelemetryWs = agora;
    enviarTelemetriaWs();
  }

  const unsigned long intervaloIdentificacao = salaId.length() > 0 ? IDENTIFICACAO_INTERVAL_MS : IDENTIFICACAO_PENDENTE_INTERVAL_MS;
  if (estadoWifi == WIFI_ESTADO_CONECTADO && (ultimaIdentificacao == 0 || agora - ultimaIdentificacao >= intervaloIdentificacao)) {
    ultimaIdentificacao = agora;
    identificarSalaNoServidor();
  }

  if (agora - lastHeartbeat >= SERVER_HEARTBEAT_INTERVAL && estadoWifi == WIFI_ESTADO_CONECTADO && estadoWsServidor != WS_ESTADO_CONECTADO) {
    lastHeartbeat = agora;
    sendHeartbeat();
  }

  if (reinicioAgendadoEm != 0 && (long)(agora - reinicioAgendadoEm) >= 0) ESP.restart();
}

bool configuracaoValida() {
  return serverHost.length() > 0 && serverPort > 0 && serverPort <= 65535;
}

void agendarReinicio(unsigned long esperaMs) {
  reinicioAgendadoEm = millis() + esperaMs;
}

bool comandoPermitidoAgora() {
  unsigned long agora = millis();
  if (lastComandoAceito != 0 && agora - lastComandoAceito < INTERVALO_MINIMO_COMANDO_MS) {
    return false;
  }
  lastComandoAceito = agora;
  return true;
}

const char* modoAtualTexto() {
  if (runtimeMode == RUNTIME_CONFIG_CLONE) return "config_clone";
  if (runtimeMode == RUNTIME_CONFIG_IDLE) return "config_idle";
  return "operation";
}

void gerenciarConexaoWifi() {
  unsigned long agora = millis();

  if (WiFi.status() == WL_CONNECTED) {
    wifiDesconectadoDesde = 0;
    if (apRecuperacaoAtivo) encerrarApRecuperacao();
    if (!wifiConectadoAnteriormente) {
      Serial.println("Wi-Fi reconectado.");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
      ultimaIdentificacao = 0;
    }
    wifiConectadoAnteriormente = true;
    estadoWifi = WIFI_ESTADO_CONECTADO;
    return;
  }

  estadoWifi = WIFI_ESTADO_DESCONECTADO;
  estadoWsServidor = WS_ESTADO_DESCONECTADO;

  if (wifiConectadoAnteriormente) {
    Serial.println("Wi-Fi desconectado. Tentando reconectar...");
  }
  wifiConectadoAnteriormente = false;
  if (wifiDesconectadoDesde == 0) wifiDesconectadoDesde = agora;

  if (!apRecuperacaoAtivo && agora - wifiDesconectadoDesde >= INTERVALO_AP_RECUPERACAO_MS) {
    iniciarApRecuperacao();
  }

  if (ultimaTentativaReconexao == 0 || agora - ultimaTentativaReconexao >= INTERVALO_RECONEXAO_WIFI_MS) {
    ultimaTentativaReconexao = agora;
    Serial.println("Tentando WiFi.reconnect()...");
    WiFi.reconnect();
  }
}

void handleSetup() {
  if (!requisicaoPortalPermitida()) {
    server.send(403, "text/plain", "Portal de configuracao disponivel apenas pela rede RemoteIFES-Setup.");
    return;
  }
  File f = LittleFS.open("/setup.html", "r");
  if (!f) {
    server.send(500, "text/plain", "setup.html ausente no sistema de arquivos");
    return;
  }
  server.streamFile(f, "text/html");
  f.close();
}

void handleSaveSetup() {
  if (!requisicaoPortalPermitida()) {
    server.send(403, "text/plain", "Configuracao permitida apenas pela rede RemoteIFES-Setup.");
    return;
  }
  String newSSID = server.arg("ssid");
  String newPASS = server.arg("pass");
  String newHost = server.arg("host");
  String newPorta = server.arg("porta");
  String newTls = server.arg("tls");
  String newDevId = server.arg("devId");
  String newDevSec = server.arg("devSec");

  int porta = newPorta.toInt();
  if (newSSID.length() == 0 || newHost.length() == 0 || porta <= 0 || porta > 65535) {
    server.send(400, "text/plain", "Preencha todos os campos obrigatorios.");
    return;
  }

  if (newTls != "ca" && newTls != "inseguro" && newTls != "off") newTls = "ca";
  if (newTls != "ca") Serial.println("AVISO DE SEGURANCA: salvando modo de transporte apenas para desenvolvimento ou LAN confiavel.");

  if ((newDevId.length() == 0) != (newDevSec.length() == 0)) {
    server.send(400, "text/plain", "Informe o identificador e o segredo do dispositivo juntos.");
    return;
  }

  preferences.putString("ssid", newSSID);
  preferences.putString("pass", newPASS);
  preferences.putString("host", newHost);
  preferences.putInt("porta", porta);
  preferences.putString("tls", newTls);
  if (newDevId.length() > 0) {
    preferences.putString("devId", newDevId);
    preferences.putString("devSec", newDevSec);
  }

  File f = LittleFS.open("/restart.html", "r");
  String response = f ? f.readString() : String("Credenciais salvas. Reiniciando...");
  if (f) f.close();
  response.replace("{{ssid}}", escaparHtml(newSSID));

  server.send(200, "text/html", response);
  agendarReinicio(1500);
}

bool requisicaoPortalPermitida() {
  if (!apModeActive && !apRecuperacaoAtivo) return false;
  return server.client().localIP() == WiFi.softAPIP();
}

String escaparHtml(const String& valor) {
  String saida = valor;
  saida.replace("&", "&amp;");
  saida.replace("<", "&lt;");
  saida.replace(">", "&gt;");
  saida.replace("\"", "&quot;");
  saida.replace("'", "&#39;");
  return saida;
}

void iniciarApRecuperacao() {
  WiFi.mode(WIFI_AP_STA);
  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  if (!WiFi.softAP("RemoteIFES-Setup", apPassword.c_str())) return;
  dnsServer.start(53, "*", apIP);
  apRecuperacaoAtivo = true;
  Serial.println("Senha do portal de recuperacao: " + apPassword);
  Serial.println("Wi-Fi indisponivel por 2 minutos. Portal de recuperacao aberto em 192.168.4.1; tentativas STA continuam.");
}

void encerrarApRecuperacao() {
  dnsServer.stop();
  WiFi.softAPdisconnect(true);
  apRecuperacaoAtivo = false;
  Serial.println("Wi-Fi restabelecido. Portal de recuperacao encerrado.");
}

void startAPMode() {
  apModeActive = true;
  WiFi.mode(WIFI_AP);

  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  WiFi.softAP("RemoteIFES-Setup", apPassword.c_str());
  Serial.println("Ponto de acesso de configuracao 'RemoteIFES-Setup' aberto.");
  Serial.println("Senha do ponto de acesso: " + apPassword);

  dnsServer.start(53, "*", apIP);

  server.on("/", handleSetup);
  server.on("/save", HTTP_POST, handleSaveSetup);

  server.onNotFound([]() {
    handleSetup();
  });

  server.begin();
  Serial.println("Ponto de Acesso 'RemoteIFES-Setup' ativo no IP: 192.168.4.1");
}

void iniciarServicosOperacao() {
  if (servicosOperacaoIniciados) return;
  servicosOperacaoIniciados = true;
  const char* headerKeys[] = { "User-Agent" };
  server.collectHeaders(headerKeys, 1);
  server.on("/", handleRoot);
  server.on("/setup", handleSetup);
  server.on("/save", HTTP_POST, handleSaveSetup);
  server.on("/info", handleInfo);
  server.begin();
}

void conectarWsServidor() {
  if (WiFi.status() != WL_CONNECTED || salaId.length() == 0) return;
  if (wsConfigurado && salaWsConfigurada == salaId && !credencialAlterada) return;
  if (wsConfigurado) wsCliente.disconnect();
  credencialAlterada = false;
  String headers = "X-Device-Sala: " + salaId + "\r\nX-Device-Mac: " + WiFi.macAddress();
  if (deviceId.length() > 0 && deviceSecret.length() > 0) {
    headers += "\r\nX-Device-Id: " + deviceId + "\r\nX-Device-Secret: " + deviceSecret;
  }
  wsCliente.setExtraHeaders(headers.c_str());
  wsCliente.onEvent(handleWsServidorEvent);
  wsCliente.setReconnectInterval(WS_RECONNECT_INTERVAL_MS);

  if (tlsModo == "off") {
    wsCliente.begin(serverHost.c_str(), serverPort, DEVICE_WS_PATH);
  } else if (tlsModo == "ca") {
    wsCliente.beginSslWithCA(serverHost.c_str(), serverPort, DEVICE_WS_PATH, ISRG_ROOT_X1);
  } else {
    wsCliente.beginSSL(serverHost.c_str(), serverPort, DEVICE_WS_PATH);
  }
  wsConfigurado = true;
  salaWsConfigurada = salaId;
}

void handleWsServidorEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      estadoWsServidor = WS_ESTADO_DESCONECTADO;
      Serial.println("WS servidor: desconectado.");
      break;
    case WStype_CONNECTED:
      estadoWsServidor = WS_ESTADO_CONECTADO;
      Serial.println("WS servidor: conectado.");
      enviarInfoDispositivo();
      break;
    case WStype_TEXT:
      processarComandoServidor(payload, length);
      break;
    default:
      break;
  }
}

void processarComandoServidor(uint8_t* payload, size_t length) {
  JsonDocument doc;
  DeserializationError erro = deserializeJson(doc, payload, length);
  if (erro) return;

  const char* tipo = doc["tipo"] | "";

  if (strcmp(tipo, "enter_config") == 0) {
    runtimeMode = RUNTIME_CONFIG_IDLE;
    enviarModoAlterado();
    reportComando("entrar_config", "");
    Serial.println("Modo CONFIG ativado.");
  } else if (strcmp(tipo, "exit_operation") == 0) {
    if (isCapturing) {
      irrecv.disableIRIn();
      isCapturing = false;
    }
    runtimeMode = RUNTIME_OPERATION;
    enviarModoAlterado();
    reportComando("sair_operacao", "");
    Serial.println("Modo OPERATION restaurado.");
  } else if (strcmp(tipo, "set_mode") == 0) {
    String modo = doc["modo"] | "";
    if (runtimeMode != RUNTIME_OPERATION) {
      if (modo == "clone") {
        runtimeMode = RUNTIME_CONFIG_CLONE;
      } else if (modo == "idle") {
        runtimeMode = RUNTIME_CONFIG_IDLE;
        if (isCapturing) {
          irrecv.disableIRIn();
          isCapturing = false;
        }
      }
      enviarModoAlterado();
      reportComando("modo", modo);
    }
  } else if (strcmp(tipo, "start_capture") == 0) {
    if (runtimeMode == RUNTIME_CONFIG_CLONE) {
      irrecv.enableIRIn();
      isCapturing = true;
      reportComando("captura_ir", "iniciada");
      Serial.println("Receptor IR ativo.");
    } else {
      Serial.println("start_capture ignorado: dispositivo fora do modo clone.");
    }
  } else if (strcmp(tipo, "stop_capture") == 0) {
    irrecv.disableIRIn();
    isCapturing = false;
    reportComando("captura_ir", "parada");
  } else if (strcmp(tipo, "send_raw") == 0) {
    JsonArray rawArr = doc["raw"].as<JsonArray>();
    uint16_t carrierHz = doc["carrierHz"] | 38000;

    if (!rawArr.isNull() && rawArr.size() > 0 && comandoPermitidoAgora()) {
      uint16_t count = (uint16_t)min((size_t)MAX_RAW_IR_ENTRIES, rawArr.size());
      uint16_t* rawData = new uint16_t[count];
      uint16_t i = 0;
      for (JsonVariant v : rawArr) {
        if (i >= count) break;
        rawData[i++] = v.as<uint16_t>();
      }

      sendRawIR(rawData, count, carrierHz / 1000);
      delete[] rawData;

      ultimoComando = UltimoComandoIR();
      ultimoComando.valido = true;
      ultimoComando.tipo = "raw";
      ultimoComando.timestampMs = millis();

      reportComando("controle_raw", "carrier_hz=" + String(carrierHz));
      if (isCapturing) irrecv.enableIRIn();
    }
  } else if (strcmp(tipo, "send_known_state") == 0) {
    int protocolo = doc["protocol"] | -1;
    float temp = doc["temp"] | 24.0;
    bool power = doc["power"] | false;
    bool turbo = doc["turbo"] | false;
    bool swing = doc["swing"] | false;
    String fan = doc["fan"] | "";

    if (protocolo >= 0) {
      sendKnownACState((decode_type_t)protocolo, temp, power, turbo, fan, swing);
      lastKnownPower = power;
      powerConhecido = true;

      ultimoComando = UltimoComandoIR();
      ultimoComando.valido = true;
      ultimoComando.tipo = "known_state";
      ultimoComando.protocolo = protocolo;
      ultimoComando.temp = temp;
      ultimoComando.power = power;
      ultimoComando.turbo = turbo;
      ultimoComando.swing = swing;
      ultimoComando.fan = fan;
      ultimoComando.timestampMs = millis();

      reportComando("controle_nativo", "protocolo=" + String(protocolo) + ";temp=" + String(temp, 1) + ";power=" + String(power ? "on" : "off") + ";turbo=" + String(turbo ? "on" : "off") + (fan.length() ? (";fan=" + fan) : ""));
      if (isCapturing) irrecv.enableIRIn();
    }
  } else if (strcmp(tipo, "reset_wifi") == 0) {
    reportComando("reset_wifi", "");
    preferences.remove("ssid");
    preferences.remove("pass");
    preferences.remove("host");
    preferences.remove("porta");
    preferences.remove("tls");
    agendarReinicio(500);
  } else if (strcmp(tipo, "ota_oferta") == 0) {
    iniciarOtaOferta(doc);
  } else if (strcmp(tipo, "credencial_provisionar") == 0 || strcmp(tipo, "credencial_rotacionar") == 0) {
    aplicarCredencial(doc);
  }
}

void aplicarCredencial(JsonDocument& doc) {
  String novoId = doc["deviceId"] | "";
  String novoSegredo = doc["segredo"] | "";
  if (novoId.length() < 4 || novoSegredo.length() < 20) return;
  if (novoId == deviceId && novoSegredo == deviceSecret) return;

  preferences.putString("devId", novoId);
  preferences.putString("devSec", novoSegredo);
  deviceId = novoId;
  deviceSecret = novoSegredo;
  credencialAlterada = true;
  reportComando("credencial", "aplicada");
  Serial.println("Credencial de dispositivo atualizada; reconectando ao servidor.");
  conectarWsServidor();
}

void enviarModoAlterado() {
  JsonDocument doc;
  doc["tipo"] = "modo_alterado";
  doc["modo"] = modoAtualTexto();
  String saida;
  serializeJson(doc, saida);
  wsCliente.sendTXT(saida);
}

void enviarInfoDispositivo() {
  JsonDocument doc;
  doc["tipo"] = "info";
  doc["fw"] = FW_VERSAO;
  String saida;
  serializeJson(doc, saida);
  wsCliente.sendTXT(saida);
}

void enviarTelemetriaWs() {
  JsonDocument doc;
  doc["tipo"] = "telemetria";
  doc["rssi"] = WiFi.RSSI();
  doc["modo"] = modoAtualTexto();
  doc["fw"] = FW_VERSAO;
  if (powerConhecido) doc["ligado"] = lastKnownPower;

  if (!isnan(ultimaLeituraTemp)) doc["temp"] = ultimaLeituraTemp;
  if (!isnan(ultimaLeituraHum)) doc["hum"] = ultimaLeituraHum;

  if (ultimoComando.valido) {
    JsonObject uc = doc["ultimoComando"].to<JsonObject>();
    uc["tipo"] = ultimoComando.tipo;
    if (ultimoComando.tipo == "known_state") {
      uc["protocol"] = ultimoComando.protocolo;
      uc["temp"] = ultimoComando.temp;
      uc["power"] = ultimoComando.power;
      uc["turbo"] = ultimoComando.turbo;
      uc["swing"] = ultimoComando.swing;
      if (ultimoComando.fan.length()) uc["fan"] = ultimoComando.fan;
    }
    uc["haQuantoTempoMs"] = millis() - ultimoComando.timestampMs;
  }

  String saida;
  serializeJson(doc, saida);
  wsCliente.sendTXT(saida);
}

void handleRoot() {
  if (apRecuperacaoAtivo) {
    handleSetup();
    return;
  }
  File f = LittleFS.open("/status.html", "r");
  if (!f) {
    server.send(500, "text/plain", "status.html ausente no sistema de arquivos");
    return;
  }
  String html = f.readString();
  f.close();
  html.replace("{{sala}}", escaparHtml(salaId.length() > 0 ? salaId : String("Aguardando vinculo por MAC")));
  html.replace("{{mac}}", escaparHtml(WiFi.macAddress()));
  html.replace("{{ip}}", escaparHtml(WiFi.localIP().toString()));
  html.replace("{{servidor}}", escaparHtml(serverHost + ":" + String(serverPort)));
  html.replace("{{fw}}", escaparHtml(String(FW_VERSAO)));
  server.send(200, "text/html", html);
  reportAccess(server.client().remoteIP().toString(), server.header("User-Agent"));
}

void handleInfo() {
  JsonDocument doc;
  doc["sala"] = salaId;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["servidor"] = serverHost + ":" + String(serverPort);
  doc["modo"] = modoAtualTexto();
  doc["fw"] = FW_VERSAO;
  doc["wifiRssi"] = WiFi.RSSI();
  doc["wsServidorConectado"] = estadoWsServidor == WS_ESTADO_CONECTADO;

  String json;
  serializeJson(doc, json);
  server.send(200, "application/json", json);
}

void handleIRCapture() {
  if (!irrecv.decode(&results)) return;

  String protocolName = typeToString(results.decode_type);
  String hexValue = resultToHexidecimal(&results);
  bool isKnownAC = universalAC.isProtocolSupported(results.decode_type);

  if (isKnownAC) {
    irrecv.disableIRIn();
    isCapturing = false;
    Serial.println("Protocolo nativo de ar-condicionado identificado. Leitura pausada.");
  }

  uint16_t* rawArray = resultToRawArray(&results);
  uint16_t length = getCorrectedRawLength(&results);

  JsonDocument doc;
  doc["tipo"] = "captura";
  doc["isKnown"] = isKnownAC;
  doc["protocolId"] = (int)results.decode_type;
  doc["protocol"] = protocolName;
  doc["hex"] = hexValue;
  JsonArray raw = doc["raw"].to<JsonArray>();
  for (uint16_t i = 0; i < length; i++) raw.add(rawArray[i]);

  String saida;
  serializeJson(doc, saida);
  if (estadoWsServidor == WS_ESTADO_CONECTADO) wsCliente.sendTXT(saida);

  reportComando("sinal_capturado", "protocolo=" + protocolName + ";nativo=" + String(isKnownAC ? "sim" : "nao") + ";hex=" + hexValue);
  delete[] rawArray;

  if (!isKnownAC) irrecv.resume();
}

void sendRawIR(const uint16_t* rawData, uint16_t length, uint16_t frequency) {
  irsend.sendRaw(rawData, length, frequency);
}

void sendKnownACState(decode_type_t protocol, float temp, bool power, bool turbo, const String& fan, bool swing) {
  if (!universalAC.isProtocolSupported(protocol)) return;
  if (temp < AC_TEMP_MIN) temp = AC_TEMP_MIN;
  if (temp > AC_TEMP_MAX) temp = AC_TEMP_MAX;
  universalAC.next.protocol = protocol;
  universalAC.next.power = power;
  universalAC.next.degrees = temp;
  universalAC.next.mode = stdAc::opmode_t::kCool;
  universalAC.next.turbo = turbo;

  if (fan == "low") universalAC.next.fanspeed = stdAc::fanspeed_t::kLow;
  else if (fan == "medio") universalAC.next.fanspeed = stdAc::fanspeed_t::kMedium;
  else if (fan == "alto") universalAC.next.fanspeed = stdAc::fanspeed_t::kHigh;
  else if (fan == "max" || turbo) universalAC.next.fanspeed = stdAc::fanspeed_t::kMax;
  else universalAC.next.fanspeed = stdAc::fanspeed_t::kAuto;

  universalAC.next.swingv = swing ? stdAc::swingv_t::kAuto : stdAc::swingv_t::kOff;

  universalAC.sendAc();
}

void atualizarLeituraSensores() {
  ultimaLeituraTemp = dht.readTemperature();
  ultimaLeituraHum = dht.readHumidity();
}

String urlServidor(const char* path) {
  String esquema = tlsModo == "off" ? "http://" : "https://";
  return esquema + serverHost + ":" + String(serverPort) + path;
}

bool iniciarClienteHttp(HTTPClient& http, WiFiClientSecure& clienteSeguro, const String& url) {
  if (tlsModo == "off") {
    return http.begin(url);
  }
  if (tlsModo == "ca") {
    clienteSeguro.setCACert(ISRG_ROOT_X1);
  } else {
    clienteSeguro.setInsecure();
  }
  return http.begin(clienteSeguro, url);
}

int executarHttpPost(const String& url, const String& payload, String& resposta) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP post falhou: WiFi nao conectado.");
    return -1;
  }

  HTTPClient http;
  WiFiClientSecure clienteSeguro;
  if (!iniciarClienteHttp(http, clienteSeguro, url)) {
    Serial.println("HTTP post falhou: nao foi possivel iniciar a conexao.");
    return -1;
  }
  http.setTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-mac", WiFi.macAddress());
  if (deviceId.length() > 0 && deviceSecret.length() > 0) {
    http.addHeader("x-device-id", deviceId);
    http.addHeader("x-device-secret", deviceSecret);
  }
  int statusCode = http.POST(payload);
  resposta = http.getString();
  http.end();

  Serial.printf("HTTP POST %s -> %d\n", url.c_str(), statusCode);
  if (statusCode < 200 || statusCode >= 300) Serial.printf("Falha no POST: %d, resposta: %s\n", statusCode, resposta.c_str());
  return statusCode;
}

bool sendHttpPost(const String& url, const String& payload) {
  String resposta;
  int statusCode = executarHttpPost(url, payload, resposta);
  return statusCode >= 200 && statusCode < 300;
}

void identificarSalaNoServidor() {
  JsonDocument doc;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["fw"] = FW_VERSAO;

  String payload;
  serializeJson(doc, payload);
  String resposta;
  int statusCode = executarHttpPost(urlServidor(SERVER_IDENTIFICACAO_PATH), payload, resposta);
  if (statusCode != 200 && statusCode != 202) return;

  JsonDocument retorno;
  if (deserializeJson(retorno, resposta)) return;
  if (statusCode == 202 || retorno["pendente"] == true) {
    if (salaId.length() > 0) {
      salaId = "";
      powerConhecido = false;
      wsCliente.setReconnectInterval(0);
      wsCliente.disconnect();
      wsConfigurado = false;
      salaWsConfigurada = "";
      estadoWsServidor = WS_ESTADO_DESCONECTADO;
      Serial.println("Vinculo por MAC removido. Aguardando nova sala.");
    }
    return;
  }

  String novaSala = retorno["sala"] | "";
  if (novaSala.length() == 0) return;
  if (novaSala != salaId) {
    if (wsConfigurado) wsCliente.disconnect();
    salaId = novaSala;
    powerConhecido = false;
    wsConfigurado = false;
    salaWsConfigurada = "";
    Serial.println("Sala identificada pelo servidor: " + salaId);
  }
  conectarWsServidor();
}

void sendHeartbeat() {
  if (!configuracaoValida() || salaId.length() == 0) return;

  JsonDocument doc;
  doc["sala"] = salaId;
  if (powerConhecido) doc["ligado"] = lastKnownPower;
  if (!isnan(ultimaLeituraTemp)) doc["temperatura"] = ultimaLeituraTemp;
  doc["mac"] = WiFi.macAddress();
  doc["ip"] = WiFi.localIP().toString();
  doc["fw"] = FW_VERSAO;

  String payload;
  serializeJson(doc, payload);

  String url = urlServidor(SERVER_HEARTBEAT_PATH);
  sendHttpPost(url, payload);
}

void reportAccess(const String& ip, const String& userAgent) {
  if (estadoWsServidor != WS_ESTADO_CONECTADO) return;

  JsonDocument doc;
  doc["tipo"] = "acesso";
  doc["ip"] = ip;
  doc["userAgent"] = userAgent;

  String payload;
  serializeJson(doc, payload);

  wsCliente.sendTXT(payload);
}

void reportComando(const String& cmd, const String& valor) {
  if (estadoWsServidor != WS_ESTADO_CONECTADO) return;

  JsonDocument doc;
  doc["tipo"] = "comando";
  doc["cmd"] = cmd;
  if (valor.length() > 0) doc["valor"] = valor;

  String payload;
  serializeJson(doc, payload);

  wsCliente.sendTXT(payload);
}

void verificarValidacaoOta() {
  bool nucleoOk = littleFsOk && WiFi.status() == WL_CONNECTED && estadoWsServidor == WS_ESTADO_CONECTADO;
  if (nucleoOk) {
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
      Serial.println("Autovalidacao OK: novo firmware confirmado.");
    }
    otaPendenteValidacao = false;
    return;
  }
  if ((long)(millis() - otaValidacaoLimite) >= 0) {
    Serial.println("Autovalidacao falhou dentro do prazo: revertendo para o firmware anterior.");
    esp_err_t r = esp_ota_mark_app_invalid_rollback_and_reboot();
    Serial.printf("Rollback indisponivel (%d): seguindo com a imagem atual, ja verificada por hash.\n", r);
    esp_ota_mark_app_valid_cancel_rollback();
    otaPendenteValidacao = false;
  }
}

void bytesParaHex(const uint8_t* dados, size_t n, char* saida) {
  static const char* hex = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    saida[i * 2] = hex[(dados[i] >> 4) & 0x0F];
    saida[i * 2 + 1] = hex[dados[i] & 0x0F];
  }
  saida[n * 2] = '\0';
}

void reportarOtaResultado(bool ok, const String& erro) {
  if (estadoWsServidor != WS_ESTADO_CONECTADO) return;
  JsonDocument doc;
  doc["tipo"] = "ota_resultado";
  doc["resultado"] = ok ? "ok" : "erro";
  if (!ok) doc["erro"] = erro;
  doc["versao"] = FW_VERSAO;
  String payload;
  serializeJson(doc, payload);
  wsCliente.sendTXT(payload);
}

void reportarOtaProgresso(size_t recebido, size_t total) {
  if (estadoWsServidor != WS_ESTADO_CONECTADO) return;
  JsonDocument doc;
  doc["tipo"] = "ota_progresso";
  doc["recebido"] = recebido;
  doc["total"] = total;
  String payload;
  serializeJson(doc, payload);
  wsCliente.sendTXT(payload);
}

void iniciarOtaOferta(JsonDocument& doc) {
  if (otaEmAndamento) {
    reportarOtaResultado(false, "atualizacao ja em andamento");
    return;
  }
  if (runtimeMode != RUNTIME_OPERATION) {
    reportarOtaResultado(false, "dispositivo em modo de configuracao");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    reportarOtaResultado(false, "sem Wi-Fi");
    return;
  }

  String versao = doc["versao"] | "";
  String shaEsperado = doc["sha256"] | "";
  size_t tamanho = doc["tamanho"] | 0;
  String caminho = doc["caminho"] | "/dispositivo/firmware";
  shaEsperado.toLowerCase();

  if (tamanho < 65536 || shaEsperado.length() != 64) {
    reportarOtaResultado(false, "oferta de firmware invalida");
    return;
  }
  if (versaoSemanticaMenor(versao, FW_VERSAO)) {
    reportarOtaResultado(false, "downgrade de firmware bloqueado");
    return;
  }

  const esp_partition_t* destino = esp_ota_get_next_update_partition(NULL);
  if (!destino) {
    reportarOtaResultado(false, "sem particao OTA (regrave por USB para habilitar)");
    return;
  }
  if (tamanho > destino->size) {
    reportarOtaResultado(false, "firmware maior que a particao OTA");
    return;
  }

  otaEmAndamento = true;
  Serial.printf("OTA: iniciando atualizacao para %s (%u bytes).\n", versao.c_str(), (unsigned)tamanho);

  String url = urlServidor((caminho + "?sala=" + salaId).c_str());
  HTTPClient http;
  WiFiClientSecure clienteSeguro;
  bool iniciou = iniciarClienteHttp(http, clienteSeguro, url);
  if (!iniciou) {
    otaEmAndamento = false;
    reportarOtaResultado(false, "falha ao abrir conexao com o servidor");
    return;
  }
  http.setTimeout(OTA_HTTP_TIMEOUT_MS);
  http.setConnectTimeout(OTA_HTTP_TIMEOUT_MS);
  http.addHeader("x-device-mac", WiFi.macAddress());
  if (deviceId.length() > 0 && deviceSecret.length() > 0) {
    http.addHeader("x-device-id", deviceId);
    http.addHeader("x-device-secret", deviceSecret);
  }

  int codigo = http.GET();
  if (codigo != 200) {
    http.end();
    otaEmAndamento = false;
    reportarOtaResultado(false, "download retornou HTTP " + String(codigo));
    return;
  }

  int contentLength = http.getSize();
  if (contentLength > 0 && (size_t)contentLength != tamanho) {
    http.end();
    otaEmAndamento = false;
    reportarOtaResultado(false, "tamanho do download difere da oferta");
    return;
  }

  if (!Update.begin(tamanho)) {
    http.end();
    otaEmAndamento = false;
    reportarOtaResultado(false, "Update.begin falhou: " + String(Update.errorString()));
    return;
  }

  mbedtls_md_context_t sha;
  mbedtls_md_init(&sha);
  mbedtls_md_setup(&sha, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&sha);

  WiFiClient* stream = http.getStreamPtr();
  uint8_t* buffer = (uint8_t*)malloc(OTA_BUFFER_BYTES);
  if (!buffer) {
    Update.abort();
    http.end();
    mbedtls_md_free(&sha);
    otaEmAndamento = false;
    reportarOtaResultado(false, "sem memoria para o buffer de OTA");
    return;
  }

  size_t recebido = 0;
  size_t ultimoProgresso = 0;
  unsigned long ultimaAtividade = millis();
  bool falhou = false;
  String erro;

  while (recebido < tamanho) {
    int disponivel = stream->available();
    if (disponivel > 0) {
      size_t aLer = (size_t)disponivel < OTA_BUFFER_BYTES ? (size_t)disponivel : OTA_BUFFER_BYTES;
      if (aLer > tamanho - recebido) aLer = tamanho - recebido;
      int lidos = stream->readBytes(buffer, aLer);
      if (lidos > 0) {
        if (Update.write(buffer, lidos) != (size_t)lidos) {
          falhou = true;
          erro = "falha ao gravar o flash: " + String(Update.errorString());
          break;
        }
        mbedtls_md_update(&sha, buffer, lidos);
        recebido += lidos;
        ultimaAtividade = millis();
        if (recebido - ultimoProgresso >= OTA_PROGRESSO_INTERVALO_BYTES) {
          ultimoProgresso = recebido;
          reportarOtaProgresso(recebido, tamanho);
        }
      }
    } else {
      if (!http.connected() && recebido < tamanho) {
        falhou = true;
        erro = "conexao encerrada antes do fim do firmware";
        break;
      }
      if ((long)(millis() - ultimaAtividade) > (long)OTA_HTTP_TIMEOUT_MS) {
        falhou = true;
        erro = "tempo esgotado durante o download";
        break;
      }
      delay(1);
    }
    wsCliente.loop();
    yield();
  }

  free(buffer);
  http.end();

  if (!falhou) {
    uint8_t shaCalc[32];
    mbedtls_md_finish(&sha, shaCalc);
    char shaHex[65];
    bytesParaHex(shaCalc, 32, shaHex);
    if (shaEsperado != shaHex) {
      falhou = true;
      erro = "sha256 divergente";
    }
  }
  mbedtls_md_free(&sha);

  if (falhou) {
    Update.abort();
    otaEmAndamento = false;
    Serial.printf("OTA: falhou (%s). Firmware atual mantido.\n", erro.c_str());
    reportarOtaResultado(false, erro);
    return;
  }

  if (!Update.end(true)) {
    otaEmAndamento = false;
    reportarOtaResultado(false, "Update.end falhou: " + String(Update.errorString()));
    return;
  }

  Serial.println("OTA: firmware gravado e verificado. Reiniciando para validacao.");
  reportarOtaResultado(true, "");
  reportComando("ota", "gravado versao=" + versao);
  agendarReinicio(1200);
}

bool versaoSemanticaMenor(const String& candidata, const String& atual) {
  unsigned int c1, c2, c3, a1, a2, a3;
  char extraC, extraA;
  if (sscanf(candidata.c_str(), "%u.%u.%u%c", &c1, &c2, &c3, &extraC) != 3) return false;
  if (sscanf(atual.c_str(), "%u.%u.%u%c", &a1, &a2, &a3, &extraA) != 3) return false;
  if (c1 != a1) return c1 < a1;
  if (c2 != a2) return c2 < a2;
  return c3 < a3;
}
