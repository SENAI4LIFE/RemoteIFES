#include "mesh.h"

#include <WiFi.h>
#include <esp_event.h>
#include <esp_mesh.h>
#include <esp_random.h>
#include <esp_wifi.h>
#include <string.h>

#include "mesh_protocolo.h"

// ESP-WIFI-MESH is used as an APPLICATION transport, not as an IP transport. The root keeps the
// station link the sketch already owns (WiFi.begin) and mesh is started without router
// configuration and without esp_mesh_connect(): nothing here routes IP through the mesh, so the
// stack never needs to own the root's station interface. That keeps one owner of the Wi-Fi
// connection and leaves the direct path byte for byte as it was.
//
// One radio means one channel: the mesh runs on the channel the root's router put it on. Nodes are
// configured with channel 0 and channel switching allowed so they find the network by mesh id.
//
// Validated by compiling and linking against the pinned framework (espressif32@7.0.1, Arduino
// 2.0.17, ESP-IDF 4.4.7, which ships esp_mesh.h and libmesh.a) and by the host test of the protocol
// module. Radio behavior (joining, parent changes, root loss, partitions, range) needs hardware and
// is recorded as pending in MESH.md.

namespace {

const uint8_t MAX_CAMADAS = 6;
const uint8_t MAX_FILHOS = 6;
// Mirrors the server's ceiling (MAX_NOS_POR_GATEWAY): a gateway that bound more nodes than the
// server accepts would relay frames the server refuses.
const uint8_t MAX_NOS = 32;
const size_t MAX_QUADRO = 1200;          // under MESH_MPS (1472), leaving room for the envelope
const uint8_t MAX_FILA_SERVIDOR = 12;    // uplink messages waiting for the gateway's WebSocket
const unsigned long ANUNCIAR_MS = 10000;
const unsigned long RECUSADO_ESPERA_MS = 30000;
const unsigned long VARRER_ROTAS_MS = 10000;
const char ROTULO_GATEWAY[] = "gateway";

MeshConfig cfg;
bool configurado = false;
bool iniciado = false;
uint8_t meshId[6] = {0};

uint8_t buffer[MESH_MPS];

// --- Gateway state ------------------------------------------------------------------------------

struct NoLigado {
  bool usado = false;
  uint8_t endereco[6] = {0};
  char deviceId[24] = {0};
};

NoLigado ligados[MAX_NOS];
String filaServidor[MAX_FILA_SERVIDOR];
uint8_t filaInicio = 0;
uint8_t filaTamanho = 0;
uint32_t descartadosFila = 0;
uint32_t recusadosGateway = 0;
unsigned long ultimaVarreduraRotas = 0;

// --- Node state ---------------------------------------------------------------------------------

enum EstadoNo { NO_SEM_MALHA, NO_NA_MALHA, NO_AUTENTICANDO, NO_CONECTADO };

EstadoNo estadoNo = NO_SEM_MALHA;
uint8_t chaveNo[meshp::CHAVE_BYTES] = {0};
uint8_t chaveSessao[meshp::CHAVE_BYTES] = {0};
uint64_t seqEnvio = 0;
uint64_t seqRecebido = 0;
String nsPendente;
String nnPendente;
// The proof binds the gateway that relayed the announcement, so the node needs the gateway's
// deviceId. The relaying gateway states it in the envelope it sends down the mesh. Trusting it costs
// nothing: a wrong value only produces a proof the server refuses, and the binding is exactly what
// stops a gateway from presenting a node's proof as if the node were behind another gateway.
String gatewayAtual;
unsigned long proximoAnuncio = 0;
// Set by the mesh event handler, which runs on the ESP-IDF event task, and consumed by
// meshProcessar() on the Arduino loop. The handler only raises flags: writing the session state or
// an Arduino String from another task would race with the loop that owns them, and a String
// reallocated under a concurrent read corrupts the heap.
volatile bool avisoPaiConectado = false;
volatile bool avisoPaiPerdido = false;
uint32_t quadrosRejeitados = 0;
uint32_t quadrosDuplicados = 0;
uint32_t quadrosEnviados = 0;
uint32_t quadrosGrandes = 0;
String ultimaRecusa;

bool hexPar(char alto, char baixo, uint8_t& valor) {
  auto digito = [](char c, uint8_t& saida) {
    if (c >= '0' && c <= '9') saida = static_cast<uint8_t>(c - '0');
    else if (c >= 'a' && c <= 'f') saida = static_cast<uint8_t>(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') saida = static_cast<uint8_t>(c - 'A' + 10);
    else return false;
    return true;
  };
  uint8_t a = 0;
  uint8_t b = 0;
  if (!digito(alto, a) || !digito(baixo, b)) return false;
  valor = static_cast<uint8_t>((a << 4) | b);
  return true;
}

bool lerMeshId(const String& texto, uint8_t saida[6]) {
  if (texto.length() != 12) return false;
  for (int i = 0; i < 6; i++) {
    if (!hexPar(texto[i * 2], texto[i * 2 + 1], saida[i])) return false;
  }
  return true;
}

std::string paraStd(const String& valor) {
  return std::string(valor.c_str(), valor.length());
}

// --- Node: route metadata ----------------------------------------------------------------------

/**
 * Fills `rota`. The parent is named only when it IS the root, because a node knows its parent's MAC
 * and deviceIds are not derived from MACs: reporting a guess would put a wrong edge on the topology
 * view. Hop count and RSSI are always known.
 */
void preencherRota(JsonObject rota) {
  const int camada = esp_mesh_get_layer();
  if (camada >= 2) {
    const int saltos = camada - 1;
    rota["saltos"] = saltos > 15 ? 15 : saltos;
    if (camada == 2) rota["pai"] = ROTULO_GATEWAY;
  }
  const int rssi = WiFi.RSSI();
  if (rssi < 0 && rssi >= -120) rota["rssi"] = rssi;
}

// --- Radio send --------------------------------------------------------------------------------

bool enviarNaMalha(const uint8_t* destino, const String& json) {
  if (json.length() > MAX_QUADRO) {
    quadrosGrandes++;
    Serial.printf("Malha: mensagem de %u bytes excede o limite de %u e foi descartada.\n",
                  static_cast<unsigned>(json.length()), static_cast<unsigned>(MAX_QUADRO));
    return false;
  }
  mesh_data_t dados = {};
  dados.data = reinterpret_cast<uint8_t*>(const_cast<char*>(json.c_str()));
  dados.size = static_cast<uint16_t>(json.length());
  dados.proto = MESH_PROTO_JSON;
  dados.tos = MESH_TOS_P2P;
  esp_err_t r;
  if (destino) {
    mesh_addr_t para = {};
    memcpy(para.addr, destino, 6);
    r = esp_mesh_send(&para, &dados, MESH_DATA_P2P | MESH_DATA_NONBLOCK, NULL, 0);
  } else {
    // "to" NULL with flag 0 is how the SDK addresses the root.
    r = esp_mesh_send(NULL, &dados, MESH_DATA_NONBLOCK, NULL, 0);
  }
  if (r != ESP_OK) {
    Serial.printf("Malha: envio falhou (%d).\n", static_cast<int>(r));
    return false;
  }
  return true;
}

// --- Gateway: node table ------------------------------------------------------------------------

NoLigado* acharPorEndereco(const uint8_t endereco[6]) {
  for (auto& no : ligados) {
    if (no.usado && memcmp(no.endereco, endereco, 6) == 0) return &no;
  }
  return nullptr;
}

NoLigado* acharPorDeviceId(const char* deviceId) {
  for (auto& no : ligados) {
    if (no.usado && strcmp(no.deviceId, deviceId) == 0) return &no;
  }
  return nullptr;
}

/**
 * Binds one mesh address to one deviceId. A second address claiming a bound deviceId is refused:
 * the server would reject it anyway (it cannot produce the proof), and accepting it here would put
 * a false edge on the topology view.
 */
bool ligar(const uint8_t endereco[6], const char* deviceId) {
  if (strlen(deviceId) >= sizeof(NoLigado::deviceId)) return false;
  NoLigado* porEndereco = acharPorEndereco(endereco);
  NoLigado* porId = acharPorDeviceId(deviceId);
  if (porEndereco && porId && porEndereco != porId) return false;
  if (porId && !porEndereco) return false;
  if (porEndereco) {
    if (strcmp(porEndereco->deviceId, deviceId) != 0) {
      // The board behind this address changed identity (a re-provisioned credential): rebind.
      strncpy(porEndereco->deviceId, deviceId, sizeof(porEndereco->deviceId) - 1);
      porEndereco->deviceId[sizeof(porEndereco->deviceId) - 1] = '\0';
    }
    return true;
  }
  for (auto& no : ligados) {
    if (no.usado) continue;
    no.usado = true;
    memcpy(no.endereco, endereco, 6);
    strncpy(no.deviceId, deviceId, sizeof(no.deviceId) - 1);
    no.deviceId[sizeof(no.deviceId) - 1] = '\0';
    return true;
  }
  return false;
}

void enfileirarParaServidor(const String& json) {
  if (filaTamanho >= MAX_FILA_SERVIDOR) {
    // The oldest goes: a stale relay is worth less than the newest state, and the queue is bounded
    // so a gateway whose WebSocket is down cannot grow until it runs out of memory.
    filaInicio = static_cast<uint8_t>((filaInicio + 1) % MAX_FILA_SERVIDOR);
    filaTamanho--;
    descartadosFila++;
  }
  filaServidor[(filaInicio + filaTamanho) % MAX_FILA_SERVIDOR] = json;
  filaTamanho++;
}

/** A gateway relays only what the protocol defines, for the node bound to the source address. */
void gatewayRecebeuDoNo(const uint8_t origem[6], const char* json, size_t tamanho) {
  JsonDocument doc;
  if (deserializeJson(doc, json, tamanho)) {
    recusadosGateway++;
    return;
  }
  const char* tipo = doc["tipo"] | "";
  const char* no = doc["no"] | "";
  if (strlen(no) == 0) {
    recusadosGateway++;
    return;
  }
  const bool evento = strcmp(tipo, "mesh_evento") == 0;
  if (!evento && strcmp(tipo, "mesh") != 0) {
    recusadosGateway++;
    return;
  }
  if (evento && strcmp(doc["evento"] | "", "entrou") == 0) {
    if (!ligar(origem, no)) {
      recusadosGateway++;
      Serial.printf("Malha: nó %s não pôde ser ligado (tabela cheia ou identidade em conflito).\n", no);
      return;
    }
  }
  const NoLigado* ligado = acharPorEndereco(origem);
  if (!ligado || strcmp(ligado->deviceId, no) != 0) {
    // A frame whose claimed identity is not the one bound to this address is not relayed.
    recusadosGateway++;
    return;
  }
  // Relayed verbatim: the gateway does not read, rewrite or reorder what it carries.
  enfileirarParaServidor(String(json, tamanho));
}

/**
 * Reports nodes whose route disappeared. A child disconnect only covers direct children, so the
 * routing table is the honest source: a descendant that left is gone from it at every depth.
 */
void varrerRotas() {
  const int total = esp_mesh_get_total_node_num();
  if (total <= 0) return;
  const int capacidade = total > (MAX_NOS + 1) ? (MAX_NOS + 1) : total;
  mesh_addr_t tabela[MAX_NOS + 1];
  int tamanho = 0;
  if (esp_mesh_get_routing_table(tabela, capacidade * static_cast<int>(sizeof(mesh_addr_t)), &tamanho) != ESP_OK) return;
  for (auto& no : ligados) {
    if (!no.usado) continue;
    bool presente = false;
    for (int i = 0; i < tamanho; i++) {
      if (memcmp(tabela[i].addr, no.endereco, 6) == 0) {
        presente = true;
        break;
      }
    }
    if (presente) continue;
    JsonDocument doc;
    doc["tipo"] = "mesh_evento";
    doc["evento"] = "saiu";
    doc["no"] = no.deviceId;
    String json;
    serializeJson(doc, json);
    enfileirarParaServidor(json);
    Serial.printf("Malha: nó %s saiu da tabela de rotas.\n", no.deviceId);
    no.usado = false;
  }
}

// --- Node: handshake and frames -----------------------------------------------------------------

void anunciarNaMalha() {
  JsonDocument doc;
  doc["tipo"] = "mesh_evento";
  doc["evento"] = "entrou";
  doc["no"] = cfg.deviceId;
  preencherRota(doc["rota"].to<JsonObject>());
  String json;
  serializeJson(doc, json);
  if (enviarNaMalha(nullptr, json)) {
    estadoNo = NO_AUTENTICANDO;
    Serial.println("Malha: anúncio enviado ao gateway; aguardando o desafio do servidor.");
  }
  proximoAnuncio = millis() + ANUNCIAR_MS;
}

bool enviarQuadroDoNo(JsonObject quadro) {
  JsonDocument doc;
  doc["tipo"] = "mesh";
  doc["no"] = cfg.deviceId;
  doc["v"] = 1;
  doc["quadro"] = quadro;
  preencherRota(doc["rota"].to<JsonObject>());
  String json;
  serializeJson(doc, json);
  return enviarNaMalha(nullptr, json);
}

bool selarEEnviar(const String& payload) {
  if (estadoNo != NO_CONECTADO) return false;
  // The sequence number advances even when the radio refuses the frame: reusing it would reuse the
  // (key, nonce) pair, which breaks GCM. The server accepts strictly increasing numbers, so a gap
  // costs nothing.
  seqEnvio++;
  std::string dados;
  std::string tag;
  if (!meshp::selar(chaveSessao, paraStd(cfg.deviceId), meshp::DIRECAO_NO, seqEnvio, paraStd(payload), &dados, &tag)) {
    return false;
  }
  JsonDocument doc;
  JsonObject quadro = doc.to<JsonObject>();
  quadro["t"] = "dados";
  quadro["seq"] = seqEnvio;
  quadro["dados"] = dados;
  quadro["tag"] = tag;
  if (!enviarQuadroDoNo(quadro)) return false;
  quadrosEnviados++;
  return true;
}

void confirmarQuadro(uint64_t seq) {
  JsonDocument ack;
  ack["tipo"] = "mesh_ack";
  ack["seq"] = seq;
  String payload;
  serializeJson(ack, payload);
  selarEEnviar(payload);
}

void responderDesafio(const char* ns) {
  if (gatewayAtual.length() == 0) {
    quadrosRejeitados++;
    Serial.println("Malha: desafio sem a identidade do gateway; atualize o firmware do gateway.");
    return;
  }
  uint8_t aleatorio[16];
  esp_fill_random(aleatorio, sizeof(aleatorio));
  nsPendente = ns;
  nnPendente = meshp::base64url(aleatorio, sizeof(aleatorio)).c_str();

  JsonDocument doc;
  JsonObject quadro = doc.to<JsonObject>();
  quadro["t"] = "ola";
  quadro["nn"] = nnPendente;
  // The gateway's deviceId is part of the proof, so a gateway cannot present a node's proof as if
  // the node were behind a different gateway. The node does not know it: the server binds the proof
  // to the gateway that relayed the announcement, and a mismatch simply fails authentication.
  quadro["prova"] =
      meshp::provaOla(chaveNo, paraStd(cfg.deviceId), paraStd(gatewayAtual), paraStd(nsPendente), paraStd(nnPendente))
          .c_str();
  estadoNo = NO_AUTENTICANDO;
  enviarQuadroDoNo(quadro);
}

void aceitarSessao(const char* prova) {
  uint8_t candidata[meshp::CHAVE_BYTES];
  meshp::chaveDeSessao(chaveNo, paraStd(nsPendente), paraStd(nnPendente), candidata);
  // Mutual authentication: only a server that derived the same session key can produce this proof.
  if (!meshp::iguais(meshp::provaAceito(candidata, paraStd(cfg.deviceId)), std::string(prova))) {
    quadrosRejeitados++;
    Serial.println("Malha: prova do servidor inválida; a sessão não foi aberta.");
    estadoNo = NO_NA_MALHA;
    return;
  }
  memcpy(chaveSessao, candidata, sizeof(chaveSessao));
  seqEnvio = 0;
  seqRecebido = 0;
  estadoNo = NO_CONECTADO;
  nsPendente = "";
  nnPendente = "";
  Serial.println("Malha: sessão aberta com o servidor.");
}

void receberQuadroSelado(JsonObject quadro) {
  if (estadoNo != NO_CONECTADO) return;
  const uint64_t seq = quadro["seq"] | 0ULL;
  const char* dados = quadro["dados"] | "";
  const char* tag = quadro["tag"] | "";
  if (seq == 0 || strlen(dados) == 0 || strlen(tag) == 0) {
    quadrosRejeitados++;
    return;
  }
  if (seq <= seqRecebido) {
    // Replay or duplicate delivery through the mesh. The ack is repeated so the server can retire
    // the frame, but the content is processed at most once.
    quadrosDuplicados++;
    confirmarQuadro(seq);
    return;
  }
  std::string texto;
  if (!meshp::abrir(chaveSessao, paraStd(cfg.deviceId), meshp::DIRECAO_SERVIDOR, seq, std::string(dados),
                    std::string(tag), &texto)) {
    quadrosRejeitados++;
    return;
  }
  seqRecebido = seq;
  confirmarQuadro(seq);
  meshEntregarDoServidor(reinterpret_cast<const uint8_t*>(texto.data()), texto.size());
}

void noRecebeuDoGateway(const char* json, size_t tamanho) {
  JsonDocument doc;
  if (deserializeJson(doc, json, tamanho)) {
    quadrosRejeitados++;
    return;
  }
  const char* tipo = doc["tipo"] | "";
  const char* no = doc["no"] | "";
  if (cfg.deviceId != no) return;
  const char* gateway = doc["gateway"] | "";
  if (strlen(gateway) > 0) gatewayAtual = gateway;

  if (strcmp(tipo, "mesh_recusado") == 0) {
    ultimaRecusa = doc["motivo"] | "";
    estadoNo = NO_NA_MALHA;
    nsPendente = "";
    nnPendente = "";
    proximoAnuncio = millis() + RECUSADO_ESPERA_MS;
    Serial.printf("Malha: o servidor recusou este nó (%s).\n", ultimaRecusa.c_str());
    return;
  }
  if (strcmp(tipo, "mesh") != 0) return;

  JsonObject quadro = doc["quadro"];
  if (quadro.isNull()) return;
  const char* t = quadro["t"] | "";
  if (strcmp(t, "desafio") == 0) {
    const char* ns = quadro["ns"] | "";
    if (strlen(ns) >= 16) responderDesafio(ns);
  } else if (strcmp(t, "aceito") == 0) {
    const char* prova = quadro["prova"] | "";
    if (strlen(prova) > 0 && nsPendente.length() > 0) aceitarSessao(prova);
  } else if (strcmp(t, "dados") == 0) {
    receberQuadroSelado(quadro);
  }
}

// --- Events -------------------------------------------------------------------------------------

void eventoMesh(void* /*arg*/, esp_event_base_t /*base*/, int32_t id, void* /*dados*/) {
  switch (id) {
    case MESH_EVENT_PARENT_CONNECTED:
      avisoPaiConectado = true;
      break;
    case MESH_EVENT_PARENT_DISCONNECTED:
    case MESH_EVENT_NO_PARENT_FOUND:
      avisoPaiPerdido = true;
      break;
    default:
      break;
  }
}

/** Applies what the event handler raised, on the task that owns the state. */
void aplicarAvisosDaMalha() {
  if (avisoPaiPerdido) {
    avisoPaiPerdido = false;
    avisoPaiConectado = false;
    if (estadoNo != NO_SEM_MALHA) {
      // Losing the parent invalidates the session: the server's own liveness drops the node, and a
      // new handshake is required after reconnecting. Nothing is assumed to have survived.
      estadoNo = NO_SEM_MALHA;
      nsPendente = "";
      nnPendente = "";
      gatewayAtual = "";
      Serial.println("Malha: pai perdido; a sessão com o servidor foi encerrada.");
    }
  }
  if (avisoPaiConectado) {
    avisoPaiConectado = false;
    if (estadoNo == NO_SEM_MALHA) {
      estadoNo = NO_NA_MALHA;
      proximoAnuncio = 0;
      Serial.printf("Malha: conectado à malha na camada %d.\n", esp_mesh_get_layer());
    }
  }
}

}  // namespace

const char* meshModoTexto(MeshModo modo) {
  if (modo == MESH_MODO_GATEWAY) return "gateway";
  if (modo == MESH_MODO_NO) return "no";
  return "direto";
}

MeshModo meshModoDeTexto(const String& texto) {
  if (texto == "gateway") return MESH_MODO_GATEWAY;
  if (texto == "no") return MESH_MODO_NO;
  return MESH_MODO_DIRETO;
}

MeshModo meshModo() {
  return configurado ? cfg.modo : MESH_MODO_DIRETO;
}

bool meshGatewayAtivo() {
  return meshModo() == MESH_MODO_GATEWAY;
}

bool meshNoAtivo() {
  return meshModo() == MESH_MODO_NO;
}

bool meshConfigurar(const MeshConfig& config, String& motivo) {
  configurado = false;
  if (config.modo == MESH_MODO_DIRETO) {
    cfg = MeshConfig();
    configurado = true;
    return true;
  }
  if (!lerMeshId(config.meshId, meshId)) {
    motivo = "identificador da malha inválido (12 dígitos hexadecimais)";
    return false;
  }
  if (config.senha.length() < 8 || config.senha.length() > 63) {
    motivo = "senha da malha deve ter de 8 a 63 caracteres";
    return false;
  }
  // Both modes need the board's own credential: the gateway may not relay without an identity of its
  // own, and a node authenticates end to end with the key derived from its secret.
  if (config.deviceId.length() < 4 || config.segredo.length() < 20) {
    motivo = "modo de malha exige identificador e segredo do dispositivo";
    return false;
  }
  cfg = config;
  configurado = true;
  if (config.modo == MESH_MODO_NO) {
    meshp::chaveDoSegredo(paraStd(cfg.segredo), chaveNo);
  }
  return true;
}

bool meshIniciar(String& motivo) {
  if (!configurado || cfg.modo == MESH_MODO_DIRETO) return true;
  if (iniciado) return true;

  // AP+STA: the softAP side serves the children, the station side is the parent link (for the root,
  // the infrastructure connection the sketch already made).
  WiFi.mode(WIFI_AP_STA);

  esp_err_t r = esp_mesh_init();
  if (r != ESP_OK) {
    motivo = "esp_mesh_init falhou (" + String(static_cast<int>(r)) + ")";
    return false;
  }
  esp_event_handler_register(MESH_EVENT, ESP_EVENT_ANY_ID, &eventoMesh, NULL);

  mesh_cfg_t malha = MESH_INIT_CONFIG_DEFAULT();
  memcpy(malha.mesh_id.addr, meshId, sizeof(meshId));
  malha.channel = 0;
  malha.allow_channel_switch = cfg.modo == MESH_MODO_NO;
  malha.mesh_ap.max_connection = MAX_FILHOS;
  malha.mesh_ap.nonmesh_max_connection = 0;
  strncpy(reinterpret_cast<char*>(malha.mesh_ap.password), cfg.senha.c_str(), sizeof(malha.mesh_ap.password) - 1);
  // No router configuration: IP connectivity is the station link the sketch owns, and nothing is
  // routed through the mesh toward the external network.
  r = esp_mesh_set_config(&malha);
  if (r != ESP_OK) {
    motivo = "esp_mesh_set_config falhou (" + String(static_cast<int>(r)) + ")";
    return false;
  }

  esp_mesh_set_ap_authmode(WIFI_AUTH_WPA2_PSK);
  esp_mesh_set_max_layer(MAX_CAMADAS);
  // The gateway is the designated root and there is no election: a node must never become root,
  // because only the gateway has the server connection and the credential to relay.
  esp_mesh_fix_root(true);
  if (cfg.modo == MESH_MODO_GATEWAY) {
    esp_mesh_set_self_organized(false, false);
    esp_mesh_set_type(MESH_ROOT);
  } else {
    esp_mesh_set_self_organized(true, false);
  }

  r = esp_mesh_start();
  if (r != ESP_OK) {
    motivo = "esp_mesh_start falhou (" + String(static_cast<int>(r)) + ")";
    return false;
  }
  iniciado = true;
  Serial.printf("Malha iniciada no modo %s (id %s).\n", meshModoTexto(cfg.modo), cfg.meshId.c_str());
  return true;
}

void meshProcessar() {
  if (!iniciado) return;
  if (meshNoAtivo()) aplicarAvisosDaMalha();

  // The receive queue is drained every pass and bounded per pass, so one busy neighbour cannot keep
  // the sketch out of its own loop (IR, sensors, the action switch).
  for (uint8_t i = 0; i < 8; i++) {
    mesh_addr_t origem = {};
    mesh_data_t dados = {};
    dados.data = buffer;
    dados.size = sizeof(buffer);
    int bandeira = 0;
    if (esp_mesh_recv(&origem, &dados, 0, &bandeira, NULL, 0) != ESP_OK) break;
    if (dados.size == 0 || dados.size > sizeof(buffer)) continue;
    if (meshGatewayAtivo()) {
      gatewayRecebeuDoNo(origem.addr, reinterpret_cast<const char*>(dados.data), dados.size);
    } else {
      noRecebeuDoGateway(reinterpret_cast<const char*>(dados.data), dados.size);
    }
  }

  const unsigned long agora = millis();
  if (meshGatewayAtivo()) {
    if (agora - ultimaVarreduraRotas >= VARRER_ROTAS_MS) {
      ultimaVarreduraRotas = agora;
      varrerRotas();
    }
    return;
  }

  if (estadoNo == NO_CONECTADO) return;
  if (estadoNo == NO_SEM_MALHA && esp_mesh_get_layer() < 2) return;
  if ((long)(agora - proximoAnuncio) >= 0) anunciarNaMalha();
}

bool meshGatewayParaServidor(String& json) {
  if (!meshGatewayAtivo() || filaTamanho == 0) return false;
  json = filaServidor[filaInicio];
  filaServidor[filaInicio] = "";
  filaInicio = static_cast<uint8_t>((filaInicio + 1) % MAX_FILA_SERVIDOR);
  filaTamanho--;
  return true;
}

void meshGatewayDoServidor(JsonDocument& doc) {
  if (!iniciado || !meshGatewayAtivo()) return;
  const char* no = doc["no"] | "";
  if (strlen(no) == 0) return;
  const NoLigado* ligado = acharPorDeviceId(no);
  if (!ligado) {
    // A frame for a node this gateway does not carry. Dropping it is correct: the server retries and
    // gives up on its own schedule.
    return;
  }
  // The gateway states its own identity so the node can build the proof the server expects. The
  // sealed frame inside `quadro` is not touched: the gateway cannot read or alter it.
  doc["gateway"] = cfg.deviceId;
  String json;
  serializeJson(doc, json);
  enviarNaMalha(ligado->endereco, json);
}

uint8_t meshGatewayNosLigados() {
  uint8_t n = 0;
  for (const auto& no : ligados) {
    if (no.usado) n++;
  }
  return n;
}

bool meshNoConectado() {
  return meshNoAtivo() && estadoNo == NO_CONECTADO;
}

bool meshNoEnviar(const String& payload) {
  return selarEEnviar(payload);
}

void meshNoDiagnostico(JsonDocument& doc) {
  if (!meshNoAtivo()) return;
  JsonObject malha = doc["malha"].to<JsonObject>();
  malha["camada"] = esp_mesh_get_layer();
  malha["sessao"] = estadoNo == NO_CONECTADO;
  malha["rejeitados"] = quadrosRejeitados;
  malha["duplicados"] = quadrosDuplicados;
  malha["enviados"] = quadrosEnviados;
  if (quadrosGrandes) malha["grandes"] = quadrosGrandes;
  if (ultimaRecusa.length()) malha["recusa"] = ultimaRecusa;
}
