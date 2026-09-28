"use strict";

// What the lab must leave untouched on the host, observed before and after a run with read-only,
// unprivileged queries. A difference in anything the lab could have caused fails the run's host
// safety; values the host changes on its own (addresses leased by DHCP, adapter up/down) are
// reported but not judged.

const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const POWERSHELL = `
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
$r.adaptadores = @(Get-NetAdapter -IncludeHidden | ForEach-Object { "$($_.Name)|$($_.InterfaceDescription)|$($_.MacAddress)" } | Sort-Object)
$r.estadoAdaptadores = @(Get-NetAdapter | ForEach-Object { "$($_.Name)=$($_.Status)" } | Sort-Object)
$r.enderecos = @(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { "$($_.InterfaceAlias)=$($_.IPAddress)/$($_.PrefixLength)" } | Sort-Object)
$r.rotaPadrao = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | ForEach-Object { "$($_.InterfaceAlias)>$($_.NextHop)" } | Sort-Object)
$r.dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object { "$($_.InterfaceAlias)=$($_.ServerAddresses -join ',')" } | Sort-Object)
$p = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
$r.proxyUsuario = "$($p.ProxyEnable)|$($p.ProxyServer)|$($p.AutoConfigURL)"
$r.proxyWinHttp = ((netsh winhttp show proxy) -join ' ') -replace '\\s+', ' '
$r.firewall = @(Get-NetFirewallProfile | ForEach-Object { "$($_.Name)|$($_.Enabled)|$($_.DefaultInboundAction)|$($_.DefaultOutboundAction)" } | Sort-Object)
$r.tarefas = @(Get-ScheduledTask | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" } | Sort-Object)
$r.servicos = @(Get-Service | ForEach-Object { $_.Name } | Sort-Object)
$r.escuta = @(Get-NetTCPConnection -State Listen | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)|$($_.OwningProcess)" } | Sort-Object)
$r | ConvertTo-Json -Depth 3 -Compress
`;

function executar(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function linhas(texto) {
  return texto ? texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort() : null;
}

function fotografarLinux() {
  const link = executar("ip", ["-j", "link"]);
  const rota = executar("ip", ["-j", "route", "show", "default"]);
  const enderecos = executar("ip", ["-j", "-4", "addr"]);
  let resolv = null;
  try { resolv = linhas(fs.readFileSync("/etc/resolv.conf", "utf8").split("\n").filter((l) => /^\s*nameserver/.test(l)).join("\n")); } catch {}
  const escuta = linhas(executar("ss", ["-ltnpH"]));
  return {
    adaptadores: link ? JSON.parse(link).map((l) => `${l.ifname}|${l.link_type}|${l.address || ""}`).sort() : null,
    estadoAdaptadores: link ? JSON.parse(link).map((l) => `${l.ifname}=${l.operstate}`).sort() : null,
    enderecos: enderecos ? JSON.parse(enderecos).flatMap((i) => (i.addr_info || []).map((a) => `${i.ifname}=${a.local}/${a.prefixlen}`)).sort() : null,
    rotaPadrao: rota ? JSON.parse(rota).map((r) => `${r.dev}>${r.gateway || ""}`).sort() : null,
    dns: resolv,
    proxyAmbiente: ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"].map((k) => `${k}=${process.env[k] || ""}`),
    servicos: linhas(executar("systemctl", ["list-unit-files", "--type=service", "--no-legend", "--no-pager"])),
    temporizadores: linhas(executar("systemctl", ["list-timers", "--all", "--no-legend", "--no-pager"]))?.map((l) => l.split(/\s+/).slice(-2).join(" ")) ?? null,
    crontab: linhas(executar("crontab", ["-l"])) || [],
    escuta,
  };
}

function fotografar() {
  if (process.platform === "win32") {
    const saida = executar("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL]);
    if (!saida) throw new Error("could not read the host state with PowerShell");
    return JSON.parse(saida);
  }
  if (process.platform === "linux") return fotografarLinux();
  throw new Error(`host safety snapshot not implemented for ${process.platform}`);
}

// Differences here would mean the lab touched the host's network, security or persistence.
const JULGADOS = ["adaptadores", "rotaPadrao", "dns", "proxyUsuario", "proxyWinHttp", "proxyAmbiente", "firewall", "tarefas", "servicos", "temporizadores", "crontab"];
// Reported only: the host changes these by itself.
const INFORMATIVOS = ["estadoAdaptadores", "enderecos"];

function diferenca(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = new Set(a);
    const sb = new Set(b);
    const novos = b.filter((x) => !sa.has(x));
    const removidos = a.filter((x) => !sb.has(x));
    return novos.length || removidos.length ? { novos, removidos } : null;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : { antes: a, depois: b };
}

/**
 * Compares two snapshots. `pidsDoLab` and `portasDoLab` identify listeners the run itself opened: any
 * of them still listening afterwards is a failure; unrelated listeners come and go with other apps.
 */
function comparar(antes, depois, { pidsDoLab = new Set(), portasDoLab = new Set() } = {}) {
  const problemas = [];
  const observacoes = [];
  for (const chave of JULGADOS) {
    if (!(chave in antes) && !(chave in depois)) continue;
    if (antes[chave] === null || depois[chave] === null) { observacoes.push(`${chave}: not observable on this host`); continue; }
    const d = diferenca(antes[chave], depois[chave]);
    if (d) problemas.push({ chave, ...d });
  }
  for (const chave of INFORMATIVOS) {
    const d = antes[chave] && depois[chave] ? diferenca(antes[chave], depois[chave]) : null;
    if (d) observacoes.push({ chave, ...d });
  }
  const escuta = (depois.escuta || []).filter((l) => {
    const pid = Number((/(?:pid=|\|)(\d+)/.exec(l) || [])[1]);
    const porta = Number((/:(\d+)[\s|]/.exec(`${l} `) || [])[1]);
    return pidsDoLab.has(pid) || portasDoLab.has(porta);
  });
  if (escuta.length) problemas.push({ chave: "escuta", doLaboratorio: escuta });
  return { ok: problemas.length === 0, problemas, observacoes };
}

/** Whether this process runs elevated (Windows High/System integrity, or root). */
function elevado() {
  if (process.platform === "win32") {
    const saida = executar("whoami", ["/groups"]) || "";
    return /S-1-16-(12288|16384)/.test(saida);
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function espacoLivreBytes(dir = os.tmpdir()) {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

module.exports = { fotografar, comparar, elevado, espacoLivreBytes };
