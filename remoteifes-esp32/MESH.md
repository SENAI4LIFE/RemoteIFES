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
| Firmware: protocol and crypto (`src/mesh_protocolo.cpp`) | implemented; compiled for the host and run against the server's own vectors (`test/mesh-protocol.test.js`) |
| Firmware: gateway relay and node mode (`src/mesh.cpp`) | implemented; compiled and linked against the pinned framework |
| Radio, range, reliability and multi-hop behavior on real ESP32 boards | **pending**: no hardware in the validation environment |
| OTA over the mesh | **unavailable by design**; the server refuses it and the firmware refuses it too; direct OTA unchanged |

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

That framework does carry ESP-WIFI-MESH: `esp_mesh.h` is in its SDK headers and `libmesh.a` is in the
link line its PlatformIO build script produces. Compiling and linking the firmware with the mesh
modules confirms it. The cost, measured against the same tree without them, is **+226 KiB flash**
(64.1% → 75.6% of the 1.92 MiB application partition of `min_spiffs.csv`) and **+7 KiB static RAM**
(15.1% → 17.3%). One firmware serves all three modes, so a board can change role without a different
image and OTA keeps offering one artifact per version.

| Option | Multi-hop | IP per node | Framework impact | Limits relevant here | Verdict |
|---|---|---|---|---|---|
| Direct Wi-Fi (baseline) | n/a | yes | none | every board needs infrastructure coverage | **default, unchanged** |
| ESP-WIFI-MESH (`esp_mesh`) | yes, self-healing tree, root election | **root only**; other nodes route through the root | part of ESP-IDF's Wi-Fi component; no framework migration, and its use under Arduino 2.0.17 is confirmed by the firmware build | whole network on the router's channel; per-hop latency 10–30 ms and root healing < 10 s in Espressif's test conditions | **chosen radio**; implemented, hardware validation pending |
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

## Firmware

`src/mesh_protocolo.cpp` is the protocol and the crypto; `src/mesh.cpp` is the radio and the two
state machines. The sketch keeps one exit toward the server (`enviarAoServidor`) and one predicate
for the channel (`canalServidorAberto`), so every existing message travels on whichever transport is
configured and the direct path is unchanged.

### Modes

Configured in the local setup portal and stored in NVS (`meshModo`, `meshId`, `meshSenha`). The
default is `direto`: no mesh code runs, and a board that never opts in behaves exactly as before. A
mesh mode that cannot be used (bad mesh id, short password, no credential) falls back to `direto`
with the reason on the serial console, rather than leaving the board with no way to reach the server.

* **`gateway`** keeps the infrastructure connection the sketch makes with `WiFi.begin` and its own
  WebSocket, and becomes the fixed root of the mesh. It relays what the nodes send, verbatim, to the
  server, and what the server sends, to the node it names. It declares `gateway: true` in `info`;
  the server treats a gateway as present when it actually relays, which is the signal that proves
  the role rather than a self-declaration.
* **`no`** has no infrastructure connection: the mesh is its network. It never calls `WiFi.begin`,
  never uses the HTTP room identification or heartbeat (the server resolves its room from the
  credential it proved), and reaches the server only through the root.

Both mesh modes require the board's own provisioned credential: a gateway may not relay without an
identity of its own, and a node authenticates end to end with the key derived from its secret.

### Radio integration

ESP-WIFI-MESH is used as an **application** transport, not as an IP transport. The gateway is started
with `esp_mesh_fix_root(true)`, `esp_mesh_set_self_organized(false, false)` and
`esp_mesh_set_type(MESH_ROOT)`, and deliberately **without** router configuration and without
`esp_mesh_connect()`: nothing is routed through the mesh toward the external network, so the stack
never needs to own the root's station interface, and the connection the sketch already owns stays the
single source of IP. Nodes use `esp_mesh_set_self_organized(true, false)` with `fix_root`, so a node
can never become root — only the gateway has the server connection and the credential to relay.

One radio means one channel: the mesh runs on the channel the gateway's router puts it on. Nodes are
configured with `channel = 0` and `allow_channel_switch`, so they find the network by mesh id.

The configuration portal replaces the access point the mesh uses for its children. On a gateway or a
node, closing the portal window therefore restarts the board to bring the mesh back in a known state;
a direct board just drops the access point and keeps running.

### Route metadata the firmware reports

A node reports `saltos` (its mesh layer minus one) and the RSSI of its parent link. It names `pai`
only when the parent **is** the root (`"gateway"`): a node knows its parent's MAC, and deviceIds are
not derived from MACs, so reporting a guess would put a wrong edge on the topology view. Deeper
parent-child edges are therefore not drawn; the hop count still shows the depth.

### Bounds in the firmware

| Bound | Value |
|---|---|
| Nodes bound per gateway | 32 (mirrors the server's ceiling) |
| Children per board on the radio | 6 |
| Mesh layers | 6 |
| Message size on the radio | 1200 bytes (under `MESH_MPS`, 1472); a larger message is dropped and counted |
| Uplink messages queued in a gateway | 12; the oldest is dropped when the WebSocket is down |
| Frames drained per `loop()` pass | 8 received, 4 relayed |
| Announcement retry while unauthenticated | every 10 s; 30 s after a `mesh_recusado` |
| Route sweep that reports departures | every 10 s |

The size bound has one visible consequence: **IR capture (clone mode) does not work over the mesh**,
because a captured signal can exceed one frame. Cloning is done with the board on the direct
transport, which is also where a protocol is normally taught to it.

The sequence number advances even when the radio refuses a frame: reusing it would reuse the
(key, nonce) pair, which breaks GCM. The server accepts strictly increasing numbers, so a gap costs
nothing.

### Gateway identity in the handshake

The `ola` proof binds the gateway that relayed the announcement, which is what stops a gateway from
presenting a node's proof as if the node were behind a different gateway. The node needs that
deviceId, and the server's challenge does not carry it, so the relaying gateway states its own
identity in the envelope it sends down the mesh. Trusting it costs nothing: a wrong value only
produces a proof the server refuses. The sealed frame inside the envelope is never touched.

### What is still pending

Hardware. The protocol is verified by a host test against the server's vectors, and the radio
integration is verified only by compiling and linking. Joining, parent changes, root loss, temporary
partitions, credential rotation over the mesh, range and reliability all need real boards.

## OTA over the mesh

Not implemented. A safe design needs bounded, acknowledged chunks per hop with backpressure,
resumption after route changes, no full-image buffering on relays, and the same SHA-256 and
post-reboot version verification as direct OTA. Until then the server refuses OTA for a board
whose current channel is the mesh ("atualização OTA indisponível para placas conectadas pela
malha") and the topology view says so. The firmware refuses it as well, with the same message, so an
older server that still offers it gets the same answer. The smallest next step is to reconnect the
board directly for the update, which the existing direct OTA already supports.
