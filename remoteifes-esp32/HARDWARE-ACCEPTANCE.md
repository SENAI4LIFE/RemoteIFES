# Hardware acceptance checklist

What still has to be proven on real ESP32 boards, in a real room, before the physical behaviour can
be called validated. Nothing below has been validated: the project's evidence so far is software
only (server and protocol tests with simulated boards, the firmware's mesh protocol compiled for the
host, and firmware builds). A simulated board proves how the server and the protocol state machines
react; it says nothing about radios, pins, flash or air conditioners.

Record each result with the date, the board (module and revision), the firmware version (`FW_VERSAO`)
and the room.

## Device I/O (firmware `src/main.ino`)

| Item | How to test | Passes when | Software coverage today | Status |
|---|---|---|---|---|
| IR transmission (GPIO 4) | From the panel, send power, temperature and turbo to a real air conditioner of each protocol in use; repeat from 2 m, 5 m and the far side of the room | The unit follows every command; the board reports `ultimoComando` and the server shows the state as confirmed | Command path, version echo and confirmation with simulated boards; the board's report is not proof that the unit received the IR | **pending** |
| IR reception and cloning (GPIO 15) | Put the cloner board in clone mode and capture each remote in use; save it and transmit it back through another board | Captured protocol and pulses match; the replay operates the unit | Capture handling, library and failsafe storage with simulated captures | **pending** |
| GPIO electrical behaviour | Measure the IR LED drive current and the pins at rest, during transmission and at boot; check no pin toggles at power-up | Currents and levels within the parts' ratings; no spurious IR at boot | Pin assignments are a contract test (`remoteifes-server/test/firmware-contract.test.js`) | **pending** |
| Local switch (GPIO 26, input pull-up, active low) | Press, hold and bounce the switch; wire it with the room's actual cable length | One press toggles exactly once; the local OFF latch is reported and adopted by the server | Latch semantics with simulated reports | **pending** |
| Buzzer (GPIO 27) | Trigger each event that sounds | Audible in the room; silent otherwise | None beyond the pin contract | **pending** |
| DHT11 readings (GPIO 14) | Compare with a reference thermometer and hygrometer for 24 h, AC on and off | Within the sensor's specified error; no stuck or missing readings | Out-of-range telemetry is dropped by the server | **pending** |

## Storage and updates

| Item | How to test | Passes when | Software coverage today | Status |
|---|---|---|---|---|
| NVS under sudden power loss | Cut power while a credential rotation is being written (`aplicarCredencial`), and while the Wi-Fi setup is saved; repeat many times | The board boots with either the old or the new complete value, never a mix, and reconnects | Rotation that is lost before being proven keeps the current secret (server tests); the firmware's write-and-read-back is compiled only | **pending** |
| Flash behaviour | Long-running writes of the failsafe and captures; check wear-sensitive paths | No corruption after the test; partitions (`min_spiffs.csv`) intact | None | **pending** |
| OTA A/B rollback on real silicon | Publish a good image, then one that fails the 90 s self-test (no LittleFS, no server channel), then one that crashes at boot | Good image validates (`ota_validado`); the failing ones roll back to the previous slot and the server records `falhou` with cause `rollback` | The whole server-side OTA state machine with simulated boards, including rollback reports, timeouts and a server crash mid-update | **pending** |

## Radio

| Item | How to test | Passes when | Software coverage today | Status |
|---|---|---|---|---|
| Wi-Fi RF stability | Leave boards in their rooms for days; include weak-signal rooms | Reconnections are rare and recovered by the firmware; commands are confirmed | Reconnection storms, drops and server restarts with simulated boards | **pending** |
| ESP-WIFI-MESH radio range | Measure the node-to-parent distance and walls a link survives in the building | A documented range per wall type | None (no radio in software tests) | **pending** |
| Mesh parent and root election | Power nodes in different orders; power-cycle the gateway (fixed root) | Nodes join the gateway's mesh and choose parents without manual help | Server side of parent and route changes, with simulated gateways | **pending** |
| Mesh self-healing | Remove a parent node while its children are active | Children re-attach and re-authenticate; the server shows the new route | Route changes, node moves and re-keyed sessions with simulated gateways | **pending** |
| Multi-hop reliability | Chains of 2 to 6 layers under normal traffic for days | Commands delivered and confirmed across hops; retransmissions bounded | Delayed, duplicated and replayed forwarding with simulated gateways | **pending** |
| Real RF latency | Time commands from the panel to the IR emission, direct and at each mesh depth | Documented median and tail per path | Software-path latency only (`npm run latencia`, loopback) | **pending** |
| Interference | Repeat the Wi-Fi and mesh tests with the building's normal load, microwave ovens and neighbouring networks | Degradation documented; no stuck states | None | **pending** |

## Long running

| Item | How to test | Passes when | Software coverage today | Status |
|---|---|---|---|---|
| ESP32 heap over time | Log free heap and the largest free block through the serial console for a week of normal use, including OTA offers and credential rotations | No steady decline; no fragmentation that blocks OTA | Server-side soak with simulated boards (`npm run ensaio`) | **pending** |

See also [MESH.md](MESH.md), which lists the mesh protocol's host-side validation and what it does
not cover.
