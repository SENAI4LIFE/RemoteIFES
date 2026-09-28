"use strict";

// Started by the emulator (libslirp guestfwd, restrict=on) once for each TCP connection the virtual
// board opens to its one reachable address. stdin and stdout are that connection; this splices it to
// the lab's intermediary on the loopback interface and to nothing else. It parses nothing and prints
// nothing: libslirp also wires stderr to the board's socket.
//
//   relay.js <intermediary port> <run id>      (the run id only marks the process as this run's)

const net = require("net");

const porta = Number(process.argv[2]);
if (!Number.isInteger(porta) || porta <= 0 || porta > 65535) process.exit(2);

const fim = () => process.exit(0);
// A relay never outlives a stalled or forgotten connection.
setTimeout(fim, 60 * 60 * 1000).unref();
const soquete = net.connect({ port: porta, host: "127.0.0.1" });
soquete.on("error", fim);
soquete.on("close", fim);
process.stdin.on("error", fim);
process.stdout.on("error", fim);
process.stdin.on("end", () => soquete.end());
process.stdin.pipe(soquete);
soquete.pipe(process.stdout);
