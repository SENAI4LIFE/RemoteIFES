# Hardware acceptance checklist

What still has to be proven on real ESP32 boards, in a real room, and on a real Raspberry Pi, before
the physical behaviour can be called validated. **Nothing below has been validated on physical
hardware.** Every row says which software evidence exists today, under one of these labels:

- **Host test**: the `remoteifes-server` test suites with simulated boards (protocol and server state
  machines), the firmware contract tests (source-level checks of `src/main.ino` in
  `remoteifes-server/test/firmware-contract.test.js`), and the mesh protocol compiled for the host.
- **Virtual hardware**: the production firmware image (same source, same PlatformIO configuration) on
  an emulated ESP32 against the real server, with faults injected (workflow *Virtual Hardware
  Validation*, [`virtual-lab/`](../README.md#laboratório-de-hardware-virtual)); and the Raspberry Pi OS 32-bit userland under
  user-mode emulation. It proves how the firmware's logic behaves: boot, the setup portal, NVS, OTA
  through the real bootloader and partition table, the device protocol, and levels and edges at the
  pins. It proves nothing electrical, optical or radio, nothing about a flash sector half-written by a
  brownout (a power cut there stops the chip at an instruction), and nothing about watchdogs (disabled
  in the emulator, as ESP-IDF's own QEMU target does).
- **Native CI**: real ARM64 hardware that is not a Pi: the server suites and the deployment rehearsal
  on Ubuntu 24.04 ARM64 (`ci.yml`), and the Raspberry Pi OS 64-bit userland in a container on a native
  ARM64 runner (*Virtual Hardware Validation*).
- **Pending physical hardware**: the *Physical status* column. A row leaves that state only with a
  recorded physical test.

Record each physical result with the date, the board (module and revision), the firmware version
(`FW_VERSAO`) and the room.

## Device I/O (firmware `src/main.ino`)

| Item | How to test | Passes when | Evidence today | Physical status |
|---|---|---|---|---|
| IR transmission (GPIO 4) | From the panel, send power, temperature and turbo to a real air conditioner of each protocol in use; repeat from 2 m, 5 m and the far side of the room | The unit follows every command; the board reports `ultimoComando` and the server shows the state as confirmed | **Host test:** command path, version echo and confirmation with simulated boards. **Virtual hardware:** a panel command produces a modulated frame on GPIO 4 (over a thousand edges) with the buzzer on and off, the board echoes the intent's version and its own telemetry names the command; RAW carrier edge counts at 38 and 56 kHz within 15% of what the timings imply; no IR from power-on until the session opens. Nothing about the LED's optical output or what a unit receives | **pending** |
| IR reception and cloning (GPIO 15) | Put the cloner board in clone mode and capture each remote in use; save it and transmit it back through another board | Captured protocol and pulses match; the replay operates the unit | **Host test:** capture handling, library and failsafe storage with simulated captures. **Virtual hardware:** none; the emulator has no IR receiver | **pending** |
| GPIO electrical behaviour | Measure the IR LED drive current and the pins at rest, during transmission and at boot; check no pin toggles at power-up | Currents and levels within the parts' ratings; no spurious IR at boot | **Host test:** pin assignments are a contract test. **Virtual hardware:** GPIO 4 and 27 are outputs, low at rest; GPIO 26 is an input with its pull-up enabled; no edge on GPIO 4 or 27 from power-on to the session. Logic levels only, not voltages or currents | **pending** |
| Local switch (GPIO 26, input pull-up, active low) | Press, hold and bounce the switch; wire it with the room's actual cable length | One press toggles exactly once; the local OFF latch is reported and adopted by the server | **Host test:** latch semantics with simulated reports; the switch is sampled by a 10 ms timer (contract test). **Virtual hardware:** a bounce shorter than 40 ms does nothing; a short press opens the setup AP; a 6 s hold without a stored failsafe transmits nothing; a 6 s hold with one transmits it once (carrier edges within 15%), writes the latch, which survives a power cut, refuses the automatic restoration and is cleared by an explicit command; with the server accepting connections and never answering, all 8 short presses (12 s apart) were recognised and a 6 s hold transmitted the failsafe (the test allows up to 10 s of board time after the release, since the transmission waits for the loop; before the switch was sampled by a timer: 4 of 8 presses at 4 s intervals, and the hold never transmitted). This holds while the 10 ms sampling timer runs; if it cannot be created at boot, the firmware says so on the serial console and reads the switch from the loop, as before. Real contact bounce and cable length are not modelled | **pending** |
| Setup portal during operation (short press) | With the board in operation, press the switch, join `RemoteIFES-Setup` from a phone and save a change; repeat on a site network that uses 192.168.4.x | The portal opens (at 192.168.5.1 on a 192.168.4.x network); the board keeps its session while the AP is open and applies the saved change | **Virtual hardware:** the AP opens without a restart; the session open before it keeps serving commands; on the lab's 192.168.4.0/24 network the AP moves to 192.168.5.1 and a connection lost while it is open is made again (with the AP in the station's subnet it was not, until the AP closed). Joining the AP and using the portal while the board is a station cannot be done here: the emulator's radio carries one link | **pending** |
| Buzzer (GPIO 27) | Trigger each event that sounds | Audible in the room; silent otherwise | **Virtual hardware:** GPIO 27 goes high and back low around every IR transmission, and stays low at rest. Audibility is physical | **pending** |
| DHT11 readings (GPIO 14) | Compare with a reference thermometer and hygrometer for 24 h, AC on and off | Within the sensor's specified error; no stuck or missing readings | **Host test:** out-of-range telemetry is dropped by the server. **Virtual hardware:** with no sensor attached, telemetry reports no temperature or humidity instead of an invented value (the emulator has no DHT11) | **pending** |

## Storage and updates

| Item | How to test | Passes when | Evidence today | Physical status |
|---|---|---|---|---|
| NVS under sudden power loss | Cut power while a credential rotation is being written (`aplicarCredencial`), and while the Wi-Fi setup is saved; repeat many times | The board boots with either the old or the new complete value, never a mix, and reconnects | **Host test:** a rotation lost before being proven keeps the current secret. **Virtual hardware:** power cut at exact instructions: with the rotation received and not yet written, and with the new secret written and verified, the board reconnects with a valid secret; an activated rotation whose write was lost comes back on the previous secret within the grace period; a cut inside `nvs::Page::eraseItem` while the failsafe record is rewritten leaves the old or the new record, whole; an erased NVS, a partial configuration, a wrong-typed port, a missing secret and a corrupted failsafe record are each handled without a reboot loop, and a corrupted failsafe is never transmitted; an unknown transport mode falls back to certificate validation. **Open:** a power cut between the `devId` and `devSec` writes of a credential *provisioned over the connection* leaves the board refused (the server already requires the credential for that room), and only a visit with the credential shown to the administrator recovers it; this is the current rule, kept by decision | **pending** |
| Flash behaviour | Long-running writes of the failsafe and captures; check wear-sensitive paths | No corruption after the test; partitions (`min_spiffs.csv`) intact | None (the emulator's flash does not wear) | **pending** |
| OTA A/B rollback on real silicon | Publish a good image, then one that fails the 90 s self-test (no LittleFS, no server channel), then one that crashes at boot | Good image validates (`ota_validado`); the failing ones roll back to the previous slot and the server records `falhou` with cause `rollback` | **Host test:** the whole server-side OTA state machine with simulated boards. **Virtual hardware**, through the real bootloader and partition table, checked from the flash itself: a valid image boots pending verification and is confirmed only by its own self-test; a candidate that cannot reach the server rolls back by itself after the 90 s self-test; a candidate that crashes at boot is rolled back by the bootloader; a byte altered in transit, a truncated, stalled or wrongly sized download, an image larger than the partition and a downgrade (refused by the server, and by the board when forged) are all rejected without a reboot; power cut at `Update.begin` and halfway through the writes; the server killed mid-download. After every attempt that fails, the last known-good image is still byte for byte in its slot and is the image the bootloader starts (for a candidate that booted, after its rollback). A power cut after the image is completely written boots the complete candidate, which then passes its own self-test. The board answers the server's keepalive pings while it downloads. Real flash timing and watchdogs are not covered | **pending** |

## Radio

| Item | How to test | Passes when | Evidence today | Physical status |
|---|---|---|---|---|
| Wi-Fi RF stability | Leave boards in their rooms for days; include weak-signal rooms | Reconnections are rare and recovered by the firmware; commands are confirmed | **Host test:** reconnection storms, drops and server restarts with simulated boards. **Virtual hardware:** the firmware's own association, DHCP and reconnection against an emulated access point: server down at boot, server gone and back, repeated cuts, a server killed and restarted, a connection cut right after a command, 1.5 s of added delay, a server that accepts and never answers, and malformed frames; retries stay within 20 per minute of board time, the intent given during an outage reaches the board, and the board never restarts. The radio itself is not emulated | **pending** |
| ESP-WIFI-MESH radio range | Measure the node-to-parent distance and walls a link survives in the building | A documented range per wall type | None (no radio in software tests) | **pending** |
| Mesh parent and root election | Power nodes in different orders; power-cycle the gateway (fixed root) | Nodes join the gateway's mesh and choose parents without manual help | **Host test:** server side of parent and route changes, with simulated gateways | **pending** |
| Mesh self-healing | Remove a parent node while its children are active | Children re-attach and re-authenticate; the server shows the new route | **Host test:** route changes, node moves and re-keyed sessions with simulated gateways | **pending** |
| Multi-hop reliability | Chains of 2 to 6 layers under normal traffic for days | Commands delivered and confirmed across hops; retransmissions bounded | **Host test:** delayed, duplicated and replayed forwarding with simulated gateways | **pending** |
| Real RF latency | Time commands from the panel to the IR emission, direct and at each mesh depth | Documented median and tail per path | **Host test:** software-path latency only (`npm run latencia`, loopback) | **pending** |
| Interference | Repeat the Wi-Fi and mesh tests with the building's normal load, microwave ovens and neighbouring networks | Degradation documented; no stuck states | None | **pending** |

The mesh is not exercised on virtual hardware at all: the emulator has no ESP-WIFI-MESH radio.

## Long running

| Item | How to test | Passes when | Evidence today | Physical status |
|---|---|---|---|---|
| ESP32 heap over time | Log free heap and the largest free block through the serial console for a week of normal use, including OTA offers and credential rotations | No steady decline; no fragmentation that blocks OTA | **Host test:** server-side soak with simulated boards (`npm run ensaio`). Virtual runs last minutes, not days | **pending** |

## Server host (Raspberry Pi)

| Item | How to test | Passes when | Evidence today | Physical status |
|---|---|---|---|---|
| Installation and service on a Pi 4/5 (64-bit) | Follow the README's Raspberry Pi section on a fresh SD card | Service up, frontend served, boards connect, updates and restores work | **Native CI:** the deployment rehearsal (install, systemd unit, restart, update and rollback, backup and restore, nginx, HTTPS configuration, Console `.deb`, removal) on Ubuntu ARM64, and the same rehearsal inside the Raspberry Pi OS Lite 64-bit userland on a native ARM64 runner, limited to 1 GiB and 2 CPUs. **Virtual hardware:** the real firmware against that production installation through nginx, riding out a service restart, a killed process and nginx stopped. The container shares the runner's kernel: not the Pi kernel, boot, SD card or real performance | **pending** |
| Pi 3 with a 32-bit system (armv7) | Same, on a Pi 3 | Same | **Virtual hardware:** Raspberry Pi OS Lite 32-bit userland under user-mode emulation: `setup.sh` installs the armv7 Node.js, the server runs, two simulated boards connect and confirm, backup, restore and restart keep the data | **pending** |
| SD card, power and thermal behaviour | A week of normal load, one power cut per day, in the room's enclosure | No corruption; the service comes back by itself; no throttling | None | **pending** |

See also [MESH.md](MESH.md), which lists the mesh protocol's host-side validation and what it does
not cover.
