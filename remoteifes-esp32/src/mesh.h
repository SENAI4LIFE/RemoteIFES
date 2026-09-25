#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Optional mesh transport for the firmware (remoteifes-esp32/MESH.md).
//
// Direct infrastructure Wi-Fi remains the default and is untouched: with MESH_MODO_DIRETO nothing
// here runs and no mesh code executes. The two other modes are opt-in, configured in the local setup
// portal:
//
//   MESH_MODO_GATEWAY  the board keeps its own direct WebSocket to the server and relays, without
//                      reading them, the sealed frames of the boards behind it. It is the fixed root
//                      of the ESP-WIFI-MESH network.
//   MESH_MODO_NO       the board has no infrastructure connection: it joins the mesh, authenticates
//                      end to end with its own credential and exchanges sealed frames with the
//                      server through the root.
//
// A gateway is a courier, never an identity: it cannot read, forge or replay a node's frames.

enum MeshModo { MESH_MODO_DIRETO = 0, MESH_MODO_GATEWAY = 1, MESH_MODO_NO = 2 };

struct MeshConfig {
  MeshModo modo = MESH_MODO_DIRETO;
  String meshId;    // 12 hex characters; identifies the mesh network
  String senha;     // mesh radio password (shared, >= 8 characters); not an identity
  String deviceId;  // this board's credential
  String segredo;
};

const char* meshModoTexto(MeshModo modo);
MeshModo meshModoDeTexto(const String& texto);
MeshModo meshModo();
bool meshGatewayAtivo();
bool meshNoAtivo();

/** Validates the configuration. Returns false and fills `motivo` (pt-BR) when the mode is unusable. */
bool meshConfigurar(const MeshConfig& config, String& motivo);

/** Brings the mesh up. Called once, after the Wi-Fi driver is started. */
bool meshIniciar(String& motivo);

/** Pumps the receive queue and the periodic work. Called from loop(). */
void meshProcessar();

// --- Gateway ------------------------------------------------------------------------------------

/** Takes the next message to relay to the server. False when there is nothing queued. */
bool meshGatewayParaServidor(String& json);

/**
 * Hands a `mesh`/`mesh_recusado` message from the server to the node it names. The document is the
 * one the sketch already parsed; the gateway adds its own identity to it, which the node needs to
 * build the proof, and never touches the sealed frame inside.
 */
void meshGatewayDoServidor(JsonDocument& doc);

uint8_t meshGatewayNosLigados();

// --- Node ---------------------------------------------------------------------------------------

/** True once the handshake finished and the session is usable. */
bool meshNoConectado();

/** Seals and sends one server-bound message. False when it could not be handed to the radio. */
bool meshNoEnviar(const String& payload);

/** Adds the node's own transport diagnostics to a telemetry/info document. */
void meshNoDiagnostico(JsonDocument& doc);

/** Implemented by the sketch: an opened (decrypted) server message, handled as a direct one. */
void meshEntregarDoServidor(const uint8_t* dados, size_t tamanho);
