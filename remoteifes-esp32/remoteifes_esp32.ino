#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <DHT.h>
#include <IRremoteESP8266.h>
#include <IRrecv.h>
#include <IRsend.h>
#include <IRutils.h>
#include <IRac.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "esp_random.h"

#include "index_html.h"
#include "root_ca.h"

#define DHTPIN 14
#define DHTTYPE DHT11
#define IR_RECV_PIN 15
#define IR_SEND_PIN 4

#define CAPTURE_BUFFER_SIZE 1024
#define TIMEOUT_US 50000
#define HTTP_CLIENT_TIMEOUT_MS 5000
#define MAX_RAW_IR_ENTRIES CAPTURE_BUFFER_SIZE

const float AC_TEMP_MIN = 16.0;
const float AC_TEMP_MAX = 30.0;

const unsigned long SERVER_HEARTBEAT_INTERVAL = 7000;
const char SERVER_HEARTBEAT_PATH[] = "/dispositivo/heartbeat";
const char SERVER_ACESSO_PATH[] = "/dispositivo/acesso";
const char SERVER_COMANDO_PATH[] = "/dispositivo/comando";
const char SERVER_PRESET_PATH[] = "/dispositivo/preset";

enum DeviceMode {
  MODE_OPERATION = 0,
  MODE_CLONE = 1
};

WebServer server(80);
WebSocketsServer webSocket(81);
const uint8_t WS_MAX_CLIENTES = 8;
bool wsAutenticado[WS_MAX_CLIENTES];
DNSServer dnsServer;
Preferences preferences;
DHT dht(DHTPIN, DHTTYPE);

IRrecv irrecv(IR_RECV_PIN, CAPTURE_BUFFER_SIZE, TIMEOUT_US, true);
IRsend irsend(IR_SEND_PIN);
IRac universalAC(IR_SEND_PIN);
decode_results results;

bool isCapturing = false;
bool apModeActive = false;
unsigned long lastSensorRead = 0;
const unsigned long SENSOR_INTERVAL = 2500;
unsigned long lastHeartbeat = 0;
bool lastKnownPower = false;
DeviceMode currentMode = MODE_OPERATION;

bool wifiConectadoAnteriormente = true;
unsigned long wifiDesconectadoDesde = 0;
unsigned long ultimaTentativaReconexao = 0;
const unsigned long INTERVALO_RECONEXAO = 15000;
const unsigned long TEMPO_MAXIMO_SEM_WIFI_PARA_REINICIAR = 300000;

String salaId;
String serverHost;
int serverPort = 0;
String deviceToken;
String tlsModo;
unsigned long lastComandoAceito = 0;
const unsigned long INTERVALO_MINIMO_COMANDO_MS = 400;

void startAPMode();
void handleRoot();
void handleInfo();
void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length);
void handleIRCapture();
void sendRawIR(const uint16_t* rawData, uint16_t length, uint16_t frequency);
void sendKnownACState(decode_type_t protocol, float temp, bool power, bool turbo, const String& fan, bool swing);
void readSensorsAndBroadcast();
String urlServidor(const char* path);
bool sendHttpPost(const String& url, const String& payload);
bool sendHttpGet(const String& url, String& responseOut);
void sendHeartbeat();
void reportAccess(const String& ip, const String& userAgent);
void reportComando(const String& cmd, const String& valor);
void requestAssignedPreset();
void gerenciarConexaoWifi();
void savePresetToServer(const String& nome, const String& funcoesSpec);
String buildFuncoesJsonFromSpec(const String& funcoesSpec);
String buildRawArrayJson(const uint16_t* rawArray, uint16_t length);
bool configuracaoValida();
bool jsonBoolAt(const String& msg, int keyIdx);
bool comandoPermitidoAgora();

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n--- RemoteIFES IR System Initializing ---");

  for (uint8_t i = 0; i < WS_MAX_CLIENTES; i++) wsAutenticado[i] = false;

  dht.begin();
  irsend.begin();

  preferences.begin("remoteifes", false);
  String savedSSID = preferences.getString("ssid", "");
  String savedPASS = preferences.getString("pass", "");
  salaId = preferences.getString("sala", "");
  serverHost = preferences.getString("host", "");
  serverPort = preferences.getInt("porta", 0);
  deviceToken = preferences.getString("token", "");
  tlsModo = preferences.getString("tls", "off");

  if (savedSSID.length() > 0 && configuracaoValida()) {
    Serial.printf("Conectando a rede salva: %s\n", savedSSID.c_str());
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    WiFi.begin(savedSSID.c_str(), savedPASS.c_str());

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 30) {
      delay(500);
      Serial.print(".");
      attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("\nWi-Fi Conectado!");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
      apModeActive = false;
    } else {
      Serial.println("\nFalha na conexao. Modo AP ativado.");
      startAPMode();
    }
  } else {
    startAPMode();
  }

  if (!apModeActive) {
    const char* headerKeys[] = { "User-Agent" };
    server.collectHeaders(headerKeys, 1);
    server.on("/", handleRoot);
    server.on("/info", handleInfo);
    server.begin();
    webSocket.begin();
    webSocket.onEvent(handleWebSocketEvent);
    requestAssignedPreset();
  }
}

void loop() {
  if (apModeActive) {
    dnsServer.processNextRequest();
    server.handleClient();
  } else {
    gerenciarConexaoWifi();

    server.handleClient();
    webSocket.loop();

    if (isCapturing) {
      handleIRCapture();
    }

    unsigned long currentMillis = millis();
    if (currentMillis - lastSensorRead >= SENSOR_INTERVAL) {
      lastSensorRead = currentMillis;
      readSensorsAndBroadcast();
    }

    if (currentMillis - lastHeartbeat >= SERVER_HEARTBEAT_INTERVAL && WiFi.status() == WL_CONNECTED) {
      lastHeartbeat = currentMillis;
      sendHeartbeat();
    }
  }
}

bool configuracaoValida() {
  return salaId.length() > 0 && serverHost.length() > 0 && serverPort > 0 && deviceToken.length() > 0;
}

bool comandoPermitidoAgora() {
  unsigned long agora = millis();
  if (lastComandoAceito != 0 && agora - lastComandoAceito < INTERVALO_MINIMO_COMANDO_MS) {
    return false;
  }
  lastComandoAceito = agora;
  return true;
}

void gerenciarConexaoWifi() {
  unsigned long agora = millis();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiConectadoAnteriormente) {
      Serial.println("Wi-Fi reconectado.");
      Serial.print("IP: ");
      Serial.println(WiFi.localIP());
      webSocket.begin();
      webSocket.onEvent(handleWebSocketEvent);
      requestAssignedPreset();
    }
    wifiConectadoAnteriormente = true;
    wifiDesconectadoDesde = 0;
    return;
  }

  if (wifiConectadoAnteriormente) {
    Serial.println("Wi-Fi desconectado. Tentando reconectar...");
    wifiDesconectadoDesde = agora;
  }
  wifiConectadoAnteriormente = false;

  if (wifiDesconectadoDesde != 0 && agora - wifiDesconectadoDesde >= TEMPO_MAXIMO_SEM_WIFI_PARA_REINICIAR) {
    Serial.println("Sem Wi-Fi por tempo prolongado. Reiniciando o dispositivo.");
    ESP.restart();
  }

  if (agora - ultimaTentativaReconexao >= INTERVALO_RECONEXAO) {
    ultimaTentativaReconexao = agora;
    Serial.println("Tentando WiFi.reconnect()...");
    WiFi.reconnect();
  }
}

void startAPMode() {
  apModeActive = true;
  WiFi.mode(WIFI_AP);

  String apPass = preferences.getString("apPass", "");
  if (apPass.length() < 12) {
    uint8_t randomBytes[4];
    for (uint8_t i = 0; i < sizeof(randomBytes); i++) randomBytes[i] = (uint8_t)(esp_random() & 0xFF);
    char apPassBuf[16];
    snprintf(apPassBuf, sizeof(apPassBuf), "ifes-%02x%02x%02x%02x",
             randomBytes[0], randomBytes[1], randomBytes[2], randomBytes[3]);
    apPass = String(apPassBuf);
    preferences.putString("apPass", apPass);
  }

  WiFi.softAP("RemoteIFES-Setup", apPass.c_str());
  Serial.print("Senha do Wi-Fi de configuracao (RemoteIFES-Setup): ");
  Serial.println(apPass);
  IPAddress apIP(192, 168, 4, 1);
  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));

  dnsServer.start(53, "*", apIP);
  server.on("/", []() {
    server.send_P(200, "text/html", SETUP_HTML);
  });

  server.on("/save", HTTP_POST, []() {
    String newSSID = server.arg("ssid");
    String newPASS = server.arg("pass");
    String newSala = server.arg("sala");
    String newHost = server.arg("host");
    String newPorta = server.arg("porta");
    String newToken = server.arg("token");
    String newTls = server.arg("tls");

    if (newSSID.length() == 0 || newSala.length() == 0 || newHost.length() == 0 ||
        newPorta.length() == 0 || newToken.length() == 0) {
      server.send(400, "text/plain", "Preencha todos os campos obrigatorios.");
      return;
    }

    if (newTls != "ca" && newTls != "inseguro" && newTls != "off") {
      newTls = "ca";
    }

    preferences.putString("ssid", newSSID);
    preferences.putString("pass", newPASS);
    preferences.putString("sala", newSala);
    preferences.putString("host", newHost);
    preferences.putInt("porta", newPorta.toInt());
    preferences.putString("token", newToken);
    preferences.putString("tls", newTls);

    String response = String(RESTART_HTML);
    response.replace("{{ssid}}", newSSID);

    server.send(200, "text/html", response);
    delay(5000);
    ESP.restart();
  });

  server.onNotFound([]() {
    server.send_P(200, "text/html", SETUP_HTML);
  });
  server.begin();
  Serial.println("Ponto de Acesso 'RemoteIFES-Setup' ativo no IP: 192.168.4.1");
}

void handleRoot() {
  if (deviceToken.length() == 0 || !server.authenticate("remoteifes", deviceToken.c_str())) {
    return server.requestAuthentication();
  }
  String html = String(INDEX_HTML);
  html.replace("__WS_TOKEN__", deviceToken);
  server.send(200, "text/html", html);
  reportAccess(server.client().remoteIP().toString(), server.header("User-Agent"));
}

void handleInfo() {
  if (deviceToken.length() == 0 || !server.authenticate("remoteifes", deviceToken.c_str())) {
    return server.requestAuthentication();
  }
  String json = "{";
  json += "\"sala\":\"" + salaId + "\",";
  json += "\"mac\":\"" + WiFi.macAddress() + "\",";
  json += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"servidor\":\"" + serverHost + ":" + String(serverPort) + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleWebSocketEvent(uint8_t num, WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      if (num < WS_MAX_CLIENTES) wsAutenticado[num] = false;
      break;

    case WStype_CONNECTED: {
      String url = String((char*)payload);
      bool autenticado = false;
      int tokenIdx = url.indexOf("token=");
      if (deviceToken.length() > 0 && tokenIdx != -1) {
        String supplied = url.substring(tokenIdx + 6);
        int ampIdx = supplied.indexOf('&');
        if (ampIdx != -1) supplied = supplied.substring(0, ampIdx);
        autenticado = supplied.length() == deviceToken.length() && supplied == deviceToken;
      }
      if (num < WS_MAX_CLIENTES) wsAutenticado[num] = autenticado;
      if (!autenticado) {
        webSocket.disconnect(num);
        break;
      }
      readSensorsAndBroadcast();
      break;
    }

    case WStype_TEXT: {
      if (num >= WS_MAX_CLIENTES || !wsAutenticado[num]) break;
      String msg = String((char*)payload);

      if (msg.indexOf("start_capture") >= 0) {
        irrecv.enableIRIn();
        isCapturing = true;
        reportComando("captura_ir", "iniciada");
        Serial.println("Receptor IR Ativo.");
      }
      else if (msg.indexOf("stop_capture") >= 0) {
        irrecv.disableIRIn();
        isCapturing = false;
        reportComando("captura_ir", "parada");
        Serial.println("Receptor IR Pausado.");
      }
      else if (msg.indexOf("set_mode") >= 0) {
        if (msg.indexOf("\"mode\":\"clone\"") >= 0) {
          currentMode = MODE_CLONE;
          reportComando("modo", "clone");
          Serial.println("Modo trocado para CLONE.");
        } else if (msg.indexOf("\"mode\":\"operation\"") >= 0) {
          currentMode = MODE_OPERATION;
          reportComando("modo", "operation");
          Serial.println("Modo trocado para OPERATION.");
        }
      }
      else if (msg.indexOf("send_raw") >= 0) {
        int rawStart = msg.indexOf("[");
        int rawEnd = msg.indexOf("]");

        if (rawStart != -1 && rawEnd != -1 && !comandoPermitidoAgora()) {
          webSocket.sendTXT(num, "{\"type\":\"comando_ignorado\",\"motivo\":\"limite_de_taxa\"}");
        } else if (rawStart != -1 && rawEnd != -1) {
          String rawArrayStr = msg.substring(rawStart + 1, rawEnd);
          int count = 1;
          for (int i = 0; i < rawArrayStr.length(); i++) {
            if (rawArrayStr.charAt(i) == ',') count++;
          }
          if (count > MAX_RAW_IR_ENTRIES) count = MAX_RAW_IR_ENTRIES;

          uint16_t* rawData = new uint16_t[count];
          int idx = 0, fromIdx = 0;
          int commaIdx = rawArrayStr.indexOf(',');

          while (commaIdx != -1 && idx < count - 1) {
            rawData[idx++] = rawArrayStr.substring(fromIdx, commaIdx).toInt();
            fromIdx = commaIdx + 1;
            commaIdx = rawArrayStr.indexOf(',', fromIdx);
          }
          if (idx < count) {
            rawData[idx] = rawArrayStr.substring(fromIdx).toInt();
          }

          uint16_t carrierHz = 38000;
          int hzIdx = msg.indexOf("carrier_hz");
          if (hzIdx != -1) {
            int colonIdx = msg.indexOf(":", hzIdx);
            int commaAfterHz = msg.indexOf(",", colonIdx);
            if (colonIdx != -1 && commaAfterHz != -1) {
              carrierHz = msg.substring(colonIdx + 1, commaAfterHz).toInt();
            }
          }

          sendRawIR(rawData, count, carrierHz / 1000);
          delete[] rawData;
          reportComando("controle_raw", "carrier_hz=" + String(carrierHz));

          if (isCapturing) irrecv.enableIRIn();
        }
      }
      else if (msg.indexOf("set_known_state") >= 0) {
        int protoIdx = msg.indexOf("\"protocol\":");
        int tempIdx = msg.indexOf("\"temp\":");
        int powerIdx = msg.indexOf("\"power\":");
        int turboIdx = msg.indexOf("\"turbo\":");
        int fanIdx = msg.indexOf("\"fan\":\"");
        int swingIdx = msg.indexOf("\"swing\":");

        if (protoIdx != -1 && tempIdx != -1 && !comandoPermitidoAgora()) {
          webSocket.sendTXT(num, "{\"type\":\"comando_ignorado\",\"motivo\":\"limite_de_taxa\"}");
        } else if (protoIdx != -1 && tempIdx != -1) {
          int protocolNum = msg.substring(protoIdx + 11, msg.indexOf(",", protoIdx)).toInt();
          float temp = msg.substring(tempIdx + 7, msg.indexOf(",", tempIdx)).toFloat();
          bool power = jsonBoolAt(msg, powerIdx);
          bool turbo = turboIdx != -1 && jsonBoolAt(msg, turboIdx);
          bool temSwing = swingIdx != -1 && jsonBoolAt(msg, swingIdx);

          String fan = "";
          if (fanIdx != -1) {
            int fanValStart = fanIdx + 7;
            int fanValEnd = msg.indexOf("\"", fanValStart);
            if (fanValEnd != -1) fan = msg.substring(fanValStart, fanValEnd);
          }

          sendKnownACState((decode_type_t)protocolNum, temp, power, turbo, fan, temSwing);
          lastKnownPower = power;
          reportComando("controle_nativo", "protocolo=" + String(protocolNum) + ";temp=" + String(temp, 1) + ";power=" + String(power ? "on" : "off") + ";turbo=" + String(turbo ? "on" : "off") + (fan.length() ? (";fan=" + fan) : ""));
          if (isCapturing) irrecv.enableIRIn();
        }
      }
      else if (msg.indexOf("get_preset") >= 0) {
        requestAssignedPreset();
      }
      else if (msg.indexOf("save_preset") >= 0) {
        int nomeIdx = msg.indexOf("\"name\":\"");
        int funcoesIdx = msg.indexOf("\"funcoes\":\"");
        if (nomeIdx != -1) {
          int nomeStart = nomeIdx + 8;
          int nomeEnd = msg.indexOf("\"", nomeStart);
          String nome = msg.substring(nomeStart, nomeEnd);

          String funcoesSpec = "";
          if (funcoesIdx != -1) {
            int funcoesStart = funcoesIdx + 11;
            int funcoesEnd = msg.indexOf("\"", funcoesStart);
            funcoesSpec = msg.substring(funcoesStart, funcoesEnd);
          }

          savePresetToServer(nome, funcoesSpec);
        }
      }
      else if (msg.indexOf("reset_wifi") >= 0) {
        reportComando("reset_wifi", "");
        preferences.clear();
        delay(500);
        ESP.restart();
      }
      break;
    }
    default:
      break;
  }
}

void handleIRCapture() {
  if (irrecv.decode(&results)) {
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

    String jsonMsg = "{\"type\":\"raw_captured\",";
    jsonMsg += "\"is_known\":" + String(isKnownAC ? "true" : "false") + ",";
    jsonMsg += "\"protocol_id\":" + String((int)results.decode_type) + ",";
    jsonMsg += "\"protocol\":\"" + protocolName + "\",";
    jsonMsg += "\"hex\":\"" + hexValue + "\",";
    jsonMsg += "\"raw\":" + buildRawArrayJson(rawArray, length);
    jsonMsg += "}";

    webSocket.broadcastTXT(jsonMsg);
    reportComando("sinal_capturado", "protocolo=" + protocolName + ";nativo=" + String(isKnownAC ? "sim" : "nao") + ";hex=" + hexValue);
    delete[] rawArray;

    if (!isKnownAC) {
      irrecv.resume();
    }
  }
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

void readSensorsAndBroadcast() {
  int rssi = WiFi.RSSI();
  float temp = dht.readTemperature();
  float hum = dht.readHumidity();

  String telemetryJson = "{\"type\":\"status\"";
  telemetryJson += ",\"mode\":" + String(currentMode == MODE_CLONE ? "\"clone\"" : "\"operation\"");
  telemetryJson += ",\"rssi\":" + String(rssi);
  telemetryJson += ",\"temp\":" + (!isnan(temp) ? String(temp, 1) : "null");
  telemetryJson += ",\"hum\":" + (!isnan(hum) ? String(hum, 1) : "null");
  telemetryJson += "}";

  webSocket.broadcastTXT(telemetryJson);
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

bool sendHttpPost(const String& url, const String& payload) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP post falhou: WiFi nao conectado.");
    return false;
  }

  HTTPClient http;
  WiFiClientSecure clienteSeguro;
  if (!iniciarClienteHttp(http, clienteSeguro, url)) {
    Serial.println("HTTP post falhou: nao foi possivel iniciar a conexao.");
    return false;
  }
  http.setTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-token", deviceToken);
  http.addHeader("x-device-mac", WiFi.macAddress());
  int statusCode = http.POST(payload);
  String response = http.getString();
  http.end();

  Serial.printf("HTTP POST %s -> %d\n", url.c_str(), statusCode);
  if (statusCode >= 200 && statusCode < 300) {
    return true;
  }

  Serial.printf("Falha no POST: %d, resposta: %s\n", statusCode, response.c_str());
  return false;
}

String jsonEscape(const String& valor) {
  String escaped = valor;
  escaped.replace("\\", "\\\\");
  escaped.replace("\"", "\\\"");
  return escaped;
}

bool jsonBoolAt(const String& msg, int keyIdx) {
  if (keyIdx == -1) return false;
  int colonIdx = msg.indexOf(":", keyIdx);
  if (colonIdx == -1) return false;
  int commaIdx = msg.indexOf(",", colonIdx);
  int braceIdx = msg.indexOf("}", colonIdx);
  int endIdx;
  if (commaIdx == -1) endIdx = braceIdx;
  else if (braceIdx == -1) endIdx = commaIdx;
  else endIdx = min(commaIdx, braceIdx);
  if (endIdx == -1) endIdx = msg.length();
  return msg.substring(colonIdx, endIdx).indexOf("true") != -1;
}

void sendHeartbeat() {
  if (!configuracaoValida()) return;

  float temp = dht.readTemperature();

  String payload = "{\"sala\":\"" + jsonEscape(salaId) + "\"";
  payload += ",\"ligado\":" + String(lastKnownPower ? "true" : "false");
  if (!isnan(temp)) {
    payload += ",\"temperatura\":" + String(temp, 1);
  }
  payload += ",\"mac\":\"" + WiFi.macAddress() + "\"";
  payload += ",\"ip\":\"" + WiFi.localIP().toString() + "\"";
  payload += "}";

  String url = urlServidor(SERVER_HEARTBEAT_PATH);
  sendHttpPost(url, payload);
}

void reportAccess(const String& ip, const String& userAgent) {
  if (!configuracaoValida()) return;

  String payload = "{\"sala\":\"" + jsonEscape(salaId) + "\"";
  payload += ",\"ip\":\"" + jsonEscape(ip) + "\"";
  payload += ",\"userAgent\":\"" + jsonEscape(userAgent) + "\"";
  payload += "}";

  String url = urlServidor(SERVER_ACESSO_PATH);
  sendHttpPost(url, payload);
}

void reportComando(const String& cmd, const String& valor) {
  if (!configuracaoValida()) return;

  String payload = "{\"sala\":\"" + jsonEscape(salaId) + "\"";
  payload += ",\"cmd\":\"" + jsonEscape(cmd) + "\"";
  if (valor.length() > 0) {
    payload += ",\"valor\":\"" + jsonEscape(valor) + "\"";
  }
  payload += "}";

  String url = urlServidor(SERVER_COMANDO_PATH);
  sendHttpPost(url, payload);
}

String buildFuncoesJsonFromSpec(const String& funcoesSpec) {
  String json = "[";
  int fromIdx = 0;
  bool first = true;
  while (fromIdx <= (int)funcoesSpec.length()) {
    int semiIdx = funcoesSpec.indexOf(";", fromIdx);
    String entry = semiIdx == -1 ? funcoesSpec.substring(fromIdx) : funcoesSpec.substring(fromIdx, semiIdx);

    if (entry.length() > 0) {
      int pipe1 = entry.indexOf("|");
      int pipe2 = entry.indexOf("|", pipe1 + 1);
      if (pipe1 != -1 && pipe2 != -1) {
        String chave = entry.substring(0, pipe1);
        String rotulo = entry.substring(pipe1 + 1, pipe2);
        String tipo = entry.substring(pipe2 + 1);

        if (!first) json += ",";
        json += "{\"chave\":\"" + jsonEscape(chave) + "\",\"rotulo\":\"" + jsonEscape(rotulo) + "\",\"tipo\":\"" + jsonEscape(tipo) + "\"}";
        first = false;
      }
    }

    if (semiIdx == -1) break;
    fromIdx = semiIdx + 1;
  }
  json += "]";
  return json;
}

void savePresetToServer(const String& nome, const String& funcoesSpec) {
  if (!configuracaoValida()) return;

  String payload = "{\"sala\":\"" + jsonEscape(salaId) + "\"";
  payload += ",\"nome\":\"" + jsonEscape(nome) + "\"";
  payload += ",\"funcoes\":" + buildFuncoesJsonFromSpec(funcoesSpec);
  payload += "}";

  String url = urlServidor(SERVER_PRESET_PATH);
  bool ok = sendHttpPost(url, payload);
  webSocket.broadcastTXT("{\"type\":\"preset_saved\",\"ok\":" + String(ok ? "true" : "false") + "}");
}

bool sendHttpGet(const String& url, String& responseOut) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  WiFiClientSecure clienteSeguro;
  if (!iniciarClienteHttp(http, clienteSeguro, url)) return false;
  http.setTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_CLIENT_TIMEOUT_MS);
  http.addHeader("x-device-token", deviceToken);
  http.addHeader("x-device-mac", WiFi.macAddress());
  int statusCode = http.GET();
  responseOut = http.getString();
  http.end();

  return statusCode >= 200 && statusCode < 300;
}

void requestAssignedPreset() {
  if (!configuracaoValida()) return;

  String url = urlServidor(SERVER_PRESET_PATH) + "?sala=" + salaId;
  String response;
  if (sendHttpGet(url, response)) {
    webSocket.broadcastTXT("{\"type\":\"assigned_preset\",\"data\":" + response + "}");
  }
}

String buildRawArrayJson(const uint16_t* rawArray, uint16_t length) {
  String json = "[";
  for (uint16_t i = 0; i < length; i++) {
    json += String(rawArray[i]);
    if (i < length - 1) json += ",";
  }
  json += "]";
  return json;
}
