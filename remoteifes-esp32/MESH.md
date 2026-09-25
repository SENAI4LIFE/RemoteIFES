# Optional mesh transport

Engineering reference for the optional mesh transport: technology selection, the protocol the
server implements, its security properties and limits, and what is still pending. Operator
documentation (pt-BR) is in the main README, section "Rede mesh opcional e topologia".

## Status

| Part | State |
|---|---|
| Transport boundary in the server (`deviceHub` channels: direct or mesh) | implemented |
| Mesh protocol v1, server side (`remoteifes-server/src/services/meshService.js`) | implemented, covered by protocol tests |
| Reference implementation of the board side (`remoteifes-server/test/support/mesh-reference.js`) | implemented; drives the server tests and the topology E2E test |
| Topology view (Administração › Status › Topologia) and `GET /admin/topologia` | implemented |
| Firmware: gateway relay and node mode | **pending** (not written) |
| Radio, range, reliability and multi-hop behavior on real ESP32 boards | **pending**: no hardware in the validation environment |
| OTA over the mesh | **unavailable by design** for now; the server refuses it with an explicit message; direct OTA unchanged |

Direct Wi-Fi/WebSocket remains the default. A board with no gateway involved behaves exactly as
before, and a direct-only installation shows the mesh as "not in use" in the topology view.

## Technology selection

Facts below come from Espressif's own documentation sources on GitHub (the rendered
docs.espressif.com site was not reachable from the build environment):
[ESP-WIFI-MESH guide](https://github.com/espressif/esp-idf/blob/master/docs/en/api-guides/esp-wifi-mesh.rst),
[ESP-NOW reference](https://github.com/espressif/esp-idf/blob/master/docs/en/api-reference/network/esp_now.rst),
[ESP-Mesh-Lite user guide](https://github.com/espressif/esp-mesh-lite/blob/master/components/mesh_lite/User_Guide.md),
and the [platform-espressif32 v7.0.1 release notes](https://github.com/platformio/platform-espressif32/releases/tag/v7.0.1).

The firmware builds with `platform = espressif32@7.0.1`, `framework = arduino`, which ships
**Arduino-ESP32 2.0.17 on ESP-IDF 4.4.7**. That constrains the choice more than anything else.

| Option | Multi-hop | IP per node | Framework impact | Limits relevant here | Verdict |
|---|---|---|---|---|---|
| Direct Wi-Fi (baseline) | n/a | yes | none | every board needs infrastructure coverage | **default, unchanged** |
| ESP-WIFI-MESH (`esp_mesh`) | yes, self-healing tree, root election | **root only**; other nodes route through the root | part of ESP-IDF's Wi-Fi component; no framework migration expected, but its use under Arduino 2.0.17 is **not yet verified by a firmware build** | whole network on the router's channel; per-hop latency 10–30 ms and root healing < 10 s in Espressif's test conditions | **recommended radio for multi-hop**, pending firmware work |
| ESP-Mesh-Lite | yes | yes (NAT per parent) | **requires ESP-IDF 5.x** → migration of the whole firmware framework | would let each node keep its current WebSocket code | rejected for now: framework migration without evidence |
| ESP-NOW with application routing | no (single hop per frame) | no | available in Arduino core 2.0.17 | 250-byte frames (1470 only in newer IDF), 20 peers, 7 encrypted peers, send callback confirms MAC-layer only | fallback for small single-hop extensions; needs fragmentation for larger messages |

Consequences of the choice:

* In ESP-WIFI-MESH only the root has IP connectivity, so a **gateway** board (the root) must bridge
  the traffic of the others to the server. The server protocol below is written for exactly that
  shape, and it does not depend on the radio: the same gateway contract works over ESP-NOW.
* Because the gateway sees every relayed frame, it must not be trusted with identities. Each board
  authenticates end to end with its own credential and the payload is sealed per session.

## Protocol v1

All messages travel as JSON on the gateway's own authenticated device WebSocket
(`/ws/dispositivo`). The gateway is an ordinary board: it has a credential of its own (MAC-only
boards cannot relay) and a room of its own.

### Keys

* Mesh key `K = HMAC-SHA256(key = board secret, "remoteifes-mesh-v1")`. The server stores `K` per
  credential generation (current, pending rotation, previous during the 24 h grace), computed when
  it generates a secret or, for credentials created before mesh support, the next time the board
  connects directly with its current secret. The gateway never holds `K` or the secret.
* Session key `Ks = HMAC-SHA256(K, "sessao|" + ns + "|" + nn)`.

### Handshake (gateway ↔ server; the node's frames are relayed verbatim)

1. Gateway → server: `{ "tipo": "mesh_evento", "evento": "entrou", "no": "<deviceId>", "rota": { "pai", "saltos", "rssi" } }`.
2. Server → gateway: `{ "tipo": "mesh", "no", "v": 1, "quadro": { "t": "desafio", "ns": "<16 random bytes, base64url>" } }`.
3. Node → server: `{ "t": "ola", "nn": "<16 random bytes>", "prova": base64url(HMAC(K, "ola|<deviceId>|<gatewayDeviceId>|<ns>|<nn>")) }`.
4. Server → node: `{ "t": "aceito", "prova": base64url(HMAC(Ks, "aceito|<deviceId>")) }`. The node
   checks this proof (mutual authentication) before using the session.

A wrong proof, an expired challenge (15 s), an unknown or revoked credential, or too many pending
handshakes produce `{ "tipo": "mesh_recusado", "no", "motivo" }` to the gateway and nothing else.
A proof made with the pending generation activates the rotation, as a direct connection would.

### Data frames

`{ "t": "dados", "seq": n, "dados": base64url(ciphertext), "tag": base64url(16-byte GCM tag) }`

* AES-256-GCM with key `Ks`; nonce (12 bytes) = direction byte (`0x01` server→node, `0x02`
  node→server), three zero bytes, `seq` as unsigned 64-bit big endian; AAD = the node's deviceId.
* `seq` starts at 1 per direction per session and strictly increases. A frame with `seq` not greater
  than the last accepted one is a replay or duplicate: counted, never processed. A frame that fails
  authentication is counted as rejected.
* The plaintext is exactly the message a direct board would send or receive (`info`,
  `telemetria`, `send_known_state`, `credencial_rotacionar`, ...). The node acknowledges each
  server frame with a sealed `{ "tipo": "mesh_ack", "seq": n }`.

### Route metadata

`rota` (`pai`, `saltos` 1–15, `rssi`) is supplied by the gateway on events and frames. It feeds the
topology view only (hop count, parent, route changes) and is never used for authorization.

### Bounds

| Bound | Value |
|---|---|
| Authenticated nodes per gateway | 32 |
| Pending handshakes per gateway | 8 (challenge valid 15 s) |
| Queued downlink frames per node | 8; a newer `send_known_state` replaces an unacknowledged older one |
| Retransmissions of an unacknowledged frame | 2 (every 3 s), then counted as a failed delivery |
| Node without news | unreachable after 90 s; the room goes offline |
| Topology cache | 256 observed nodes; unreachable ones dropped after 10 min |
| Gateway message budget | 120 per 10 s plus 120 per authenticated node, capped at 2 400 |

The topology is an in-memory observation: nothing about routes is written to SQLite.

### Semantics kept from the direct transport

* Gateway availability never proves a node: a node is online only after its own handshake, and it
  goes offline when its gateway disconnects or it stops sending.
* Desired state, "sent to the channel", device confirmation (the `versao` echo) and physical IR
  reception remain distinct. For a mesh node "sent" means handed to the gateway; the node's ack
  means received by the board; only the node's own report confirms the desired state.

## What the firmware must implement (pending)

* Gateway (root) mode: keep the direct WebSocket; announce nodes (`mesh_evento`), relay `mesh`
  frames both ways without interpreting them; report route metadata; declare `gateway: true` in
  `info`.
* Node mode: join the mesh instead of the infrastructure network; run the handshake and the
  AES-GCM framing above (mbedTLS `mbedtls_gcm_*` and `mbedtls_md_hmac` are available in the
  Arduino core); feed the decrypted messages to the existing message handling.
* A firmware build in CI proving `esp_mesh` under Arduino 2.0.17, then hardware validation of
  joining, parent changes, root loss, partitions and credential rotation.

## OTA over the mesh

Not implemented. A safe design needs bounded, acknowledged chunks per hop with backpressure,
resumption after route changes, no full-image buffering on relays, and the same SHA-256 and
post-reboot version verification as direct OTA. Until then the server refuses OTA for a board
whose current channel is the mesh ("atualização OTA indisponível para placas conectadas pela
malha") and the topology view says so. The smallest next step is to reconnect the board directly
for the update, which the existing direct OTA already supports.
