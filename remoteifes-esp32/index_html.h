#ifndef INDEX_HTML_H
#define INDEX_HTML_H

const char SETUP_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RemoteIFES - Configuracao Wi-Fi</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f2f4f3; padding: 20px; color: #1f2937; margin: 0; }
    .card { background: white; padding: 24px; border-radius: 12px; max-width: 420px; margin: 40px auto; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
    h2 { color: #135d33; margin-top: 0; text-align: center; }
    p { font-size: 0.9rem; color: #4b5563; line-height: 1.4; }
    label { display: block; margin-top: 12px; font-weight: bold; font-size: 0.85rem; }
    input[type="text"], input[type="password"] { width: 100%; padding: 10px; margin-top: 4px; border: 1px solid #d1d5db; border-radius: 6px; box-sizing: border-box; }
    button { width: 100%; background: #135d33; color: white; border: none; padding: 12px; border-radius: 6px; font-size: 1rem; margin-top: 20px; cursor: pointer; font-weight: bold; }
    button:hover { background: #0e4626; }
    .info-box { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 0.85rem; color: #166534; }
  </style>
</head>
<body>
  <div class="card">
    <h2>RemoteIFES Setup</h2>
    <div class="info-box">
      <strong>Modo Ponto de Acesso (AP)</strong><br>
      Conecte o modulo a rede Wi-Fi local. Apos salvar, o ESP32 tentara se conectar e estara disponivel na sua rede.
    </div>
    <form action="/save" method="POST">
      <label for="ssid">Nome da Rede Wi-Fi (SSID):</label>
      <input type="text" id="ssid" name="ssid" placeholder="Ex: IFES-SALA101" required>
      <label for="pass">Senha:</label>
      <input type="password" id="pass" name="pass" placeholder="Sua senha de Wi-Fi">
      <label for="sala">Codigo da sala (cadastrado no servidor):</label>
      <input type="text" id="sala" name="sala" placeholder="Ex: A101" required>
      <label for="host">Endereco do servidor RemoteIFES:</label>
      <input type="text" id="host" name="host" placeholder="Ex: 192.168.0.10" required>
      <label for="porta">Porta do servidor:</label>
      <input type="text" id="porta" name="porta" placeholder="8080" required>
      <label for="token">Token do dispositivo:</label>
      <input type="password" id="token" name="token" placeholder="valor de DEVICE_TOKEN no servidor" required>
      <button type="submit">Salvar e Conectar</button>
    </form>
  </div>
</body>
</html>
)rawliteral";

const char RESTART_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>RemoteIFES - Reiniciando</title>
  <style>
    body { font-family: sans-serif; background: #f2f4f3; padding: 20px; text-align: center; color: #1f2937; }
    .card { background: white; padding: 30px; border-radius: 12px; max-width: 420px; margin: 40px auto; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
    h2 { color: #135d33; }
    p { color: #4b5563; line-height: 1.5; }
    .ip-box { background: #f8fafc; border: 1px solid #cbd5e1; padding: 12px; border-radius: 8px; font-family: monospace; font-weight: bold; margin: 15px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Credenciais Salvas</h2>
    <p>O ESP32 tentara se conectar a rede <strong>{{ssid}}</strong> em 5 segundos.</p>
    <p>Apos reiniciar, verifique o IP atribuido pelo roteador local ou acesse pelo hostname configurado na sua rede.</p>
    <div class="ip-box">Aguarde o reinicio do modulo...</div>
  </div>
</body>
</html>
)rawliteral";

const char INDEX_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>RemoteIFES - IR Cloner</title>
  <style>
    :root {
      --bg-color: #f2f4f3;
      --header-bg: #135d33;
      --card-bg: #ffffff;
      --card-border: #e5e7eb;
      --text-main: #1f2937;
      --text-muted: #6b7280;
      --primary: #135d33;
      --primary-hover: #0e4626;
      --danger: #dc2626;
      --input-bg: #ffffff;
      --input-border: #d1d5db;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg-color); color: var(--text-main); padding-bottom: 80px; min-height: 100vh; }

    .topbar { display: flex; justify-content: space-between; align-items: center; background: var(--header-bg); padding: 10px 16px; position: sticky; top: 0; z-index: 100; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); flex-wrap: wrap; gap: 8px; }
    .brand { font-size: 1.15rem; font-weight: 700; color: #ffffff; letter-spacing: 0.5px; }
    .metrics-group { display: flex; align-items: center; gap: 8px; }
    .metric-pill { background: rgba(255, 255, 255, 0.15); color: #ffffff; padding: 4px 10px; border-radius: 16px; font-size: 0.78rem; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .status-badge { padding: 4px 10px; border-radius: 16px; font-size: 0.78rem; font-weight: 600; display: flex; align-items: center; gap: 4px; }
    .status-badge.online { background: #ffffff; color: var(--primary); }
    .status-badge.offline { background: #fee2e2; color: var(--danger); }

    main { max-width: 500px; margin: 0 auto; padding: 20px 16px; }
    .screen-head { margin-bottom: 20px; }
    .screen-head h1 { font-size: 1.4rem; font-weight: 700; color: #111827; }
    .screen-head .hint { font-size: 0.85rem; color: var(--text-muted); margin-top: 4px; }

    .capture-status-banner { display: flex; align-items: center; gap: 14px; padding: 14px; border-radius: 12px; margin-bottom: 16px; border: 1px solid var(--card-border); transition: all 0.3s ease; }
    .capture-status-banner.state-paused { background: #fef3c7; border-color: #fde68a; color: #92400e; }
    .capture-status-banner.state-paused .status-icon { background: #d97706; color: #ffffff; }
    .capture-status-banner.state-active { background: #dcfce7; border-color: #86efac; color: #14532d; }
    .capture-status-banner.state-active .status-icon { background: #135d33; color: #ffffff; animation: pulse 1.5s infinite; }
    .capture-status-banner.state-captured { background: #e0f2fe; border-color: #7dd3fc; color: #075985; }
    .capture-status-banner.state-captured .status-icon { background: #0284c7; color: #ffffff; }

    .status-icon { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 1.1rem; flex-shrink: 0; }
    @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.08); opacity: 0.85; } 100% { transform: scale(1); opacity: 1; } }

    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 20px; margin-bottom: 18px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04); }
    .card h2 { font-size: 1.1rem; font-weight: 700; color: #111827; margin-bottom: 14px; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: #374151; margin-bottom: 6px; margin-top: 12px; }
    label:first-of-type { margin-top: 0; }

    input[type="text"], input[type="number"], textarea { width: 100%; padding: 10px 12px; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 8px; font-size: 0.9rem; }
    textarea { resize: vertical; font-family: monospace; font-size: 0.82rem; line-height: 1.4; }

    .btn { display: inline-flex; align-items: center; justify-content: center; width: 100%; padding: 12px 16px; border-radius: 8px; border: none; font-size: 0.92rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; background: var(--primary); color: #ffffff; margin-top: 10px; }
    .btn:hover:not(:disabled) { background: var(--primary-hover); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-off { background: var(--danger); }
    .btn-reset { background: #4b5563; }
    .btn-reset:hover { background: #374151; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px; }

    .thermostat-card { text-align: center; padding: 30px 20px; }
    .temp-display { font-size: 3.5rem; font-weight: 800; color: var(--primary); margin: 15px 0; }
    .thermostat-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 20px; }
    .ctrl-btn { padding: 18px; font-size: 1.5rem; font-weight: bold; border-radius: 12px; background: #f0fdf4; border: 2px solid #bbf7d0; color: var(--primary); cursor: pointer; }
    .ctrl-btn:active { transform: scale(0.96); }
    .aux-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

    .wizard-step { background: #f8fafc; border: 1px solid var(--input-border); border-radius: 10px; padding: 15px; margin-top: 10px; }
    .step-badge { display: inline-block; background: var(--primary); color: white; padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; margin-bottom: 8px; }
    .step-status { margin-top: 10px; font-size: 0.85rem; font-weight: bold; }
    .step-status.waiting { color: #d97706; }
    .step-status.ready { color: var(--primary); }

    .data-box { background: #f8fafc; border: 1px solid var(--input-border); border-radius: 8px; padding: 10px; font-family: monospace; font-size: 0.85rem; margin-top: 4px; word-break: break-all; }
    .data-box.highlight { color: var(--primary); font-weight: 700; background: #f0fdf4; border-color: #bbf7d0; }

    .tabbar { position: fixed; bottom: 0; left: 0; right: 0; height: 60px; background: #ffffff; border-top: 1px solid var(--card-border); display: flex; justify-content: space-around; align-items: center; z-index: 100; }
    .tab-btn { flex: 1; height: 100%; background: transparent; border: none; color: var(--text-muted); font-size: 0.82rem; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .tab-btn.active { color: var(--primary); border-top: 3px solid var(--primary); background: #f0fdf4; }
    .hidden { display: none !important; }
  </style>
</head>
<body>

  <header class="topbar">
    <span class="brand">RemoteIFES</span>
    <div class="metrics-group">
      <div class="metric-pill" title="Temperatura DHT11"><span id="tempValue">-- °C</span></div>
      <div class="metric-pill" title="Umidade DHT11"><span id="humValue">-- %</span></div>
      <div class="metric-pill" title="Modo Atual"><span id="modeValue">OPERATION</span></div>
      <span id="statusBadge" class="status-badge offline"><span id="wifiValue">Desconectado</span></span>
    </div>
  </header>

  <main id="app">

    <section id="screen-capture" class="screen tab-content">
      <div class="screen-head">
        <h1>Aprendizado de Controle</h1>
        <p class="hint">Aponte o controle remoto para a ESP32 para calibrar.</p>
      </div>

      <div id="captureStatusBanner" class="capture-status-banner state-paused">
        <div id="statusIcon" class="status-icon">||</div>
        <div>
          <strong id="captureStatusTitle">Receptor Pausado</strong>
        </div>
      </div>

      <div class="card">
        <h2>Controle do Sensor IR</h2>
        <div class="two-col">
          <button id="btnStart" class="btn" onclick="startCapture()">Iniciar Leitura</button>
          <button id="btnStop" class="btn btn-off" onclick="stopCapture()" disabled>Pausar Leitura</button>
        </div>
        <button class="btn btn-reset" onclick="resetCalibration()">Calibrar Novo Controle</button>

        <div class="two-col" style="margin-top: 14px;">
          <div>
            <label>Protocolo Detectado:</label>
            <div id="protocolOutput" class="data-box highlight">--</div>
          </div>
          <div>
            <label>Status de Suporte:</label>
            <div id="supportOutput" class="data-box">Aguardando...</div>
          </div>
        </div>
      </div>

      <div id="knownProtocolPanel" class="card hidden">
        <h2>Protocolo Nativo Identificado</h2>
        <p class="hint">Este controle possui suporte nativo para ar-condicionado. O calculo de temperatura e checksum sera automatico.</p>
        <button class="btn" onclick="switchTab('screen-remote', document.querySelectorAll('.tab-btn')[2])">Abrir Termostato Virtual</button>
      </div>

      <div id="unknownProtocolPanel" class="card hidden">
        <h2>Assistente de Varredura (Generico)</h2>
        <div class="wizard-step">
          <span class="step-badge" id="wizardStepNumber">Etapa 1/11</span>
          <strong style="display:block; margin-bottom: 6px;" id="wizardStepTitle">Comando POWER</strong>
          <p class="hint" id="wizardStepDesc">Aperte o botao no controle remoto.</p>
          
          <div id="wizardStepStatus" class="step-status waiting">Aguardando voce apertar o botao no controle...</div>
          <button id="btnSaveStep" class="btn" style="margin-top: 10px;" onclick="saveWizardStep()" disabled>Gravar e Ir para Proxima Etapa</button>
        </div>
      </div>
    </section>

    <section id="screen-status" class="screen tab-content hidden">
      <div class="screen-head">
        <h1>Status do Sistema</h1>
        <p class="hint">Visao geral do modo, telemetria e ultimo comando.</p>
      </div>

      <div class="card">
        <h2>Resumo de Conexao</h2>
        <div class="two-col">
          <div>
            <label>Modo Atual</label>
            <div class="data-box highlight" id="statusModeValue">OPERATION</div>
          </div>
          <div>
            <label>Ultimo Update</label>
            <div class="data-box" id="statusLastCommand">Nenhum</div>
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Telemetria</h2>
        <div class="two-col">
          <div>
            <label>RSSI</label>
            <div class="data-box" id="statusRssi">-- dBm</div>
          </div>
          <div>
            <label>Temperatura</label>
            <div class="data-box" id="statusTemp">-- °C</div>
          </div>
          <div>
            <label>Umidade</label>
            <div class="data-box" id="statusHum">-- %</div>
          </div>
          <div>
            <label>Protocolo</label>
            <div class="data-box" id="statusProtocol">--</div>
          </div>
        </div>
      </div>
    </section>

    <section id="screen-import" class="screen tab-content hidden">
      <div class="screen-head">
        <h1>Exportacao de Perfil</h1>
        <p class="hint">JSON de perfil para o backend da aplicacao.</p>
      </div>

      <div class="card">
        <h2>Informacoes do Aparelho</h2>
        <label for="profileName">Nome do Dispositivo</label>
        <input type="text" id="profileName" value="Ar-Condicionado Sala" oninput="updateProfileJSON()" />

        <label for="carrierHz">Frequencia da Portadora (Hz)</label>
        <input type="number" id="carrierHz" value="38000" oninput="updateProfileJSON()" />

        <label>Sala configurada</label>
        <input type="text" id="infoSala" value="—" readonly />

        <label>Endereco MAC deste ESP32</label>
        <input type="text" id="infoMac" value="—" readonly />

        <label>Endereco IP na rede</label>
        <input type="text" id="infoIp" value="—" readonly />

        <p class="hint">Use o endereco MAC acima para vincular este dispositivo a uma sala no painel de administracao (ESP32 / Salas), caso ele ainda nao apareca automaticamente na lista de dispositivos detectados.</p>
      </div>

      <div class="card">
        <h2>JSON do Perfil</h2>
        <textarea id="jsonTextarea" rows="12" readonly></textarea>
        <button type="button" class="btn" onclick="downloadJSON()">Baixar Ficheiro JSON</button>
      </div>

      <div class="card">
        <h2>Rede Wi-Fi</h2>
        <p class="hint">Deseja alterar a rede Wi-Fi do ESP32? Clique abaixo para apagar a rede atual e reabrir o ponto de acesso de configuracao (RemoteIFES-Setup).</p>
        <button type="button" class="btn btn-off" onclick="resetWiFiCredentials()">Resetar Wi-Fi do ESP32</button>
      </div>
    </section>

    <section id="screen-remote" class="screen tab-content hidden">
      <div class="screen-head">
        <h1 id="remoteTitle">Termostato Virtual</h1>
        <p id="remoteSubtitle" class="hint">Modo: Nativo</p>
      </div>

      <div class="card thermostat-card">
        <div class="temp-display" id="displayTemp">22°C</div>
        <div class="thermostat-controls">
          <button class="ctrl-btn" onclick="adjustTemp(-1)">-</button>
          <button class="ctrl-btn" onclick="adjustTemp(1)">+</button>
        </div>
        <div class="aux-controls">
          <button class="btn" id="btnPower" style="margin-top:0;" onclick="togglePower()">Power: OFF</button>
          <button class="btn" id="btnTurbo" style="margin-top:0; background:#6366f1;" onclick="toggleTurbo()">Turbo: OFF</button>
        </div>
      </div>
    </section>

    <section id="screen-presets" class="screen tab-content hidden">
      <div class="screen-head">
        <h1>Presets</h1>
        <p class="hint">Cadastre presets de ar-condicionado (funcoes configuraveis) e envie para o servidor central.</p>
      </div>

      <div class="card">
        <h2>Preset atribuido a esta sala</h2>
        <div class="data-box" id="assignedPresetBox">Carregando...</div>
        <button type="button" class="btn" style="margin-top:10px;" onclick="requestAssignedPreset()">Atualizar</button>
      </div>

      <div class="card">
        <h2>Cadastrar novo preset</h2>
        <label for="presetNomeInput">Nome do preset</label>
        <input type="text" id="presetNomeInput" placeholder="Ex: Padrao com ventilacao" />

        <label for="presetFuncaoChave">Chave da funcao (letras/numeros/underscore)</label>
        <input type="text" id="presetFuncaoChave" placeholder="Ex: velocidade" />
        <label for="presetFuncaoRotulo">Rotulo exibido</label>
        <input type="text" id="presetFuncaoRotulo" placeholder="Ex: Velocidade do ventilador" />
        <label for="presetFuncaoTipo">Tipo</label>
        <select id="presetFuncaoTipo">
          <option value="numero">Numero</option>
          <option value="booleano">Sim/Nao</option>
          <option value="selecao">Selecao</option>
        </select>
        <button type="button" class="btn" onclick="addPresetFuncaoDraft()">Adicionar funcao ao preset</button>

        <div id="presetFuncoesDraftList" style="margin-top:10px;"></div>

        <button type="button" class="btn" style="margin-top:14px;" onclick="salvarPresetNoServidor()">Salvar preset no servidor</button>
        <div class="data-box" id="presetSaveStatus" style="margin-top:8px;"></div>
      </div>
    </section>

  </main>

  <nav class="tabbar">
    <button type="button" class="tab-btn active" onclick="switchTab('screen-capture', this)">Aprendizado</button>
    <button type="button" class="tab-btn" onclick="switchTab('screen-status', this)">Status</button>
    <button type="button" class="tab-btn" onclick="switchTab('screen-import', this)">Exportar JSON</button>
    <button type="button" class="tab-btn" onclick="switchTab('screen-remote', this)">Termostato</button>
    <button type="button" class="tab-btn" onclick="switchTab('screen-presets', this)">Presets</button>
  </nav>

  <script>
    const WS_TOKEN = "__WS_TOKEN__";
    let ws;
    let lastCapturedRaw = [];
    let lastCapturedProtocol = "--";
    let lastCapturedIsKnown = false;
    let lastCapturedProtocolId = -1;
    let hasSignalForStep = false;
    const byId = (id) => document.getElementById(id);

    let activeState = { power: false, temp: 22, turbo: false };
    let presetFuncoesDraft = [];
    let presetAtribuido = null;

    const defaultProfile = () => ({
      profile_name: "Ar-Condicionado Sala",
      carrier_hz: 38000,
      is_known_protocol: false,
      protocol: "UNKNOWN",
      protocol_id: -1,
      raw_map: {}
    });

    let currentProfile = defaultProfile();

    const wizardSteps = [
      { key: "power", title: "Comando POWER (Ligar/Desligar)", desc: "Aperte o botao Power no controle fisico." },
      { key: "18", title: "Temperatura 18°C", desc: "Ajuste o controle fisico para 18°C e aperte enviar." },
      { key: "19", title: "Temperatura 19°C", desc: "Ajuste para 19°C e aperte enviar." },
      { key: "20", title: "Temperatura 20°C", desc: "Ajuste para 20°C e aperte enviar." },
      { key: "21", title: "Temperatura 21°C", desc: "Ajuste para 21°C e aperte enviar." },
      { key: "22", title: "Temperatura 22°C", desc: "Ajuste para 22°C e aperte enviar." },
      { key: "23", title: "Temperatura 23°C", desc: "Ajuste para 23°C e aperte enviar." },
      { key: "24", title: "Temperatura 24°C", desc: "Ajuste para 24°C e aperte enviar." },
      { key: "25", title: "Temperatura 25°C", desc: "Ajuste para 25°C e aperte enviar." },
      { key: "26", title: "Temperatura 26°C", desc: "Ajuste para 26°C e aperte enviar." },
      { key: "turbo", title: "Comando TURBO", desc: "Ative a funcao Turbo/Maxima no controle fisico." }
    ];
    let currentWizardIdx = 0;

    function rssiToPercentage(rssi) {
      if (rssi >= -50) return 100;
      if (rssi <= -100) return 0;
      return Math.round(2 * (rssi + 100));
    }

    function initWebSocket() {
      const gateway = `ws://${window.location.hostname}:81/?token=${encodeURIComponent(WS_TOKEN)}`;
      ws = new WebSocket(gateway);

      ws.onopen = () => {
        byId('wifiValue').innerText = 'Conectado';
        byId('statusBadge').className = 'status-badge online';
        requestAssignedPreset();
      };

      ws.onclose = () => {
        byId('wifiValue').innerText = 'Desconectado';
        byId('statusBadge').className = 'status-badge offline';
        setTimeout(initWebSocket, 2000);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'status') {
            if (data.rssi !== undefined) {
              byId('wifiValue').innerText = `${data.rssi} dBm (${rssiToPercentage(data.rssi)}%)`;
              byId('statusRssi').innerText = `${data.rssi} dBm`;
            }
            byId('modeValue').innerText = data.mode ? data.mode.toUpperCase() : 'N/A';
            byId('statusModeValue').innerText = data.mode ? data.mode.toUpperCase() : 'N/A';
            byId('statusLastCommand').innerText = data.reason ? data.reason : 'Atualizacao de status';
            byId('tempValue').innerText = data.temp !== null ? `${data.temp.toFixed(1)} °C` : `-- °C`;
            byId('statusTemp').innerText = data.temp !== null ? `${data.temp.toFixed(1)} °C` : `-- °C`;
            byId('humValue').innerText = data.hum !== null ? `${data.hum.toFixed(1)} %` : `-- %`;
            byId('statusHum').innerText = data.hum !== null ? `${data.hum.toFixed(1)} %` : `-- %`;
          }

          if (data.type === 'raw_captured') {
            lastCapturedProtocol = data.protocol || "UNKNOWN";
            lastCapturedRaw = data.raw || [];
            lastCapturedIsKnown = data.is_known;
            lastCapturedProtocolId = data.protocol_id;

            byId('protocolOutput').innerText = lastCapturedProtocol;
            byId('supportOutput').innerText = lastCapturedIsKnown ? "Nativo" : "Generico";
            byId('statusProtocol').innerText = lastCapturedProtocol;
            byId('supportOutput').style.color = lastCapturedIsKnown ? "#135d33" : "#d97706";

            if (lastCapturedIsKnown) {
              updateCaptureStatusUI('paused');
            } else {
              hasSignalForStep = true;
              byId('wizardStepStatus').innerText = "Sinal Capturado! Clique para gravar e avancar.";
              byId('wizardStepStatus').className = "step-status ready";
              byId('btnSaveStep').disabled = false;
            }

            handleCalibrationBranch(lastCapturedIsKnown, lastCapturedProtocol, lastCapturedProtocolId);
          }

          if (data.type === 'assigned_preset') {
            presetAtribuido = data.data && data.data.preset ? data.data.preset : null;
            renderAssignedPreset();
          }

          if (data.type === 'preset_saved') {
            byId('presetSaveStatus').innerText = data.ok ? 'Preset salvo no servidor com sucesso.' : 'Falha ao salvar o preset no servidor.';
            byId('presetSaveStatus').style.color = data.ok ? '#135d33' : '#b91c1c';
            if (data.ok) requestAssignedPreset();
          }
        } catch (e) {
          console.error("Erro no WebSocket:", e);
        }
      };
    }

    function resetCalibration() {
      currentProfile = defaultProfile();
      currentWizardIdx = 0;
      hasSignalForStep = false;
      lastCapturedRaw = [];

      byId('protocolOutput').innerText = "--";
      byId('supportOutput').innerText = "Aguardando...";
      byId('supportOutput').style.color = "#1f2937";

      byId('knownProtocolPanel').classList.add('hidden');
      byId('unknownProtocolPanel').classList.add('hidden');

      stopCapture();
      updateProfileJSON();
      updateThermostatUI();
    }

    function handleCalibrationBranch(isKnown, protocol, protocolId) {
      currentProfile.is_known_protocol = isKnown;
      currentProfile.protocol = protocol;
      currentProfile.protocol_id = protocolId;

      const knownPanel = byId('knownProtocolPanel');
      const unknownPanel = byId('unknownProtocolPanel');

      if (isKnown) {
        knownPanel.classList.remove('hidden');
        unknownPanel.classList.add('hidden');
      } else {
        knownPanel.classList.add('hidden');
        unknownPanel.classList.remove('hidden');
        renderWizardStep();
      }
      updateProfileJSON();
    }

    function renderWizardStep() {
      if (currentWizardIdx >= wizardSteps.length) {
        byId('wizardStepNumber').innerText = "Concluido";
        byId('wizardStepTitle').innerText = "Mapeamento RAW Finalizado";
        byId('wizardStepDesc').innerText = "Todos os comandos foram salvos com sucesso.";
        byId('wizardStepStatus').innerText = "Mapeamento pronto.";
        byId('wizardStepStatus').className = "step-status ready";
        byId('btnSaveStep').disabled = true;
        return;
      }
      const step = wizardSteps[currentWizardIdx];
      byId('wizardStepNumber').innerText = `Etapa ${currentWizardIdx + 1}/${wizardSteps.length}`;
      byId('wizardStepTitle').innerText = step.title;
      byId('wizardStepDesc').innerText = step.desc;

      if (!hasSignalForStep) {
        byId('wizardStepStatus').innerText = "Aguardando voce apertar o botao no controle...";
        byId('wizardStepStatus').className = "step-status waiting";
        byId('btnSaveStep').disabled = true;
      }
    }

    function saveWizardStep() {
      if (!hasSignalForStep) return;
      const step = wizardSteps[currentWizardIdx];
      currentProfile.raw_map[step.key] = [...lastCapturedRaw];
      currentWizardIdx++;
      hasSignalForStep = false;
      renderWizardStep();
      updateProfileJSON();
    }

    function adjustTemp(delta) {
      activeState.temp = Math.max(18, Math.min(26, activeState.temp + delta));
      updateThermostatUI();
      dispatchACState();
    }

    function togglePower() {
      activeState.power = !activeState.power;
      updateThermostatUI();
      dispatchACState();
    }

    function toggleTurbo() {
      activeState.turbo = !activeState.turbo;
      updateThermostatUI();
      dispatchACState();
    }

    function updateThermostatUI() {
      byId('displayTemp').innerText = `${activeState.temp}°C`;
      byId('btnPower').innerText = `Power: ${activeState.power ? 'ON' : 'OFF'}`;
      byId('btnPower').style.background = activeState.power ? '#135d33' : '#dc2626';
      byId('btnTurbo').innerText = `Turbo: ${activeState.turbo ? 'ON' : 'OFF'}`;
      byId('remoteSubtitle').innerText = `Modo: ${currentProfile.is_known_protocol ? currentProfile.protocol + ' (Nativo)' : 'Generico (Mapeado)'}`;
      updateProfileJSON();
    }

    function dispatchACState() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (currentProfile.is_known_protocol) {
        const payload = {
          action: "set_known_state",
          protocol: currentProfile.protocol_id,
          temp: activeState.temp,
          power: activeState.power,
          turbo: activeState.turbo,
          fan: activeState.fan || "auto",
          swing: !!activeState.swing
        };
        ws.send(JSON.stringify(payload));
      } else {
        let targetKey = String(activeState.temp);
        if (!activeState.power) targetKey = "power";
        else if (activeState.turbo) targetKey = "turbo";

        const rawArray = currentProfile.raw_map[targetKey];
        if (rawArray) {
          const payload = {
            action: "send_raw",
            carrier_hz: currentProfile.carrier_hz,
            raw: rawArray
          };
          ws.send(JSON.stringify(payload));
        } else {
          alert(`Sinal RAW para "${targetKey}" ainda nao foi gravado!`);
        }
      }
    }

    function requestAssignedPreset() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "get_preset" }));
      }
    }

    function renderAssignedPreset() {
      const box = byId('assignedPresetBox');
      if (!box) return;
      if (!presetAtribuido) {
        box.innerText = "Nenhum preset atribuido a esta sala ainda.";
        return;
      }
      const funcoesTxt = (presetAtribuido.funcoes || []).map((f) => f.rotulo).join(", ") || "sem funcoes";
      box.innerText = `${presetAtribuido.nome} — funcoes: ${funcoesTxt}`;
    }

    function addPresetFuncaoDraft() {
      const chave = byId('presetFuncaoChave').value.trim();
      const rotulo = byId('presetFuncaoRotulo').value.trim();
      const tipo = byId('presetFuncaoTipo').value;
      if (!chave || !rotulo) {
        alert("Preencha a chave e o rotulo da funcao.");
        return;
      }
      presetFuncoesDraft.push({ chave, rotulo, tipo });
      byId('presetFuncaoChave').value = "";
      byId('presetFuncaoRotulo').value = "";
      renderPresetFuncoesDraft();
    }

    function renderPresetFuncoesDraft() {
      const list = byId('presetFuncoesDraftList');
      list.innerHTML = presetFuncoesDraft.map((f, i) =>
        `<div class="data-box">${f.rotulo} (${f.chave} · ${f.tipo}) <button type="button" class="btn btn-off" style="width:auto; padding:4px 10px; margin:0 0 0 8px;" onclick="removerPresetFuncaoDraft(${i})">remover</button></div>`
      ).join("");
    }

    function removerPresetFuncaoDraft(i) {
      presetFuncoesDraft.splice(i, 1);
      renderPresetFuncoesDraft();
    }

    function salvarPresetNoServidor() {
      const nome = byId('presetNomeInput').value.trim();
      if (!nome) {
        alert("Informe o nome do preset.");
        return;
      }
      if (presetFuncoesDraft.length === 0) {
        alert("Adicione ao menos uma funcao ao preset.");
        return;
      }
      const funcoesSpec = presetFuncoesDraft.map((f) => `${f.chave}|${f.rotulo}|${f.tipo}`).join(";");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "save_preset", name: nome, funcoes: funcoesSpec }));
      }
    }

    function resetWiFiCredentials() {
      if (confirm("Tem certeza que deseja apagar as credenciais de Wi-Fi? O ESP32 reiniciara em modo de configuracao ('RemoteIFES-Setup').")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "reset_wifi" }));
        }
      }
    }

    function updateProfileJSON() {
      currentProfile.profile_name = document.getElementById('profileName').value;
      currentProfile.carrier_hz = parseInt(document.getElementById('carrierHz').value) || 38000;
      
      const exportedProfile = {
        profile_name: currentProfile.profile_name,
        carrier_hz: currentProfile.carrier_hz,
        is_known_protocol: currentProfile.is_known_protocol,
        protocol: currentProfile.protocol,
        protocol_id: currentProfile.protocol_id
      };

      if (!currentProfile.is_known_protocol) {
        exportedProfile.raw_map = currentProfile.raw_map;
      }

      byId('jsonTextarea').value = JSON.stringify(exportedProfile, null, 2);
    }

    function downloadJSON() {
      updateProfileJSON();
      const exportedJson = byId('jsonTextarea').value;
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(exportedJson);
      const anchor = document.createElement('a');
      anchor.setAttribute("href", dataStr);
      anchor.setAttribute("download", (currentProfile.profile_name || "ar_condicionado").toLowerCase().replace(/[^a-z0-9]/g, "_") + ".json");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    function updateCaptureStatusUI(state) {
      const banner = byId('captureStatusBanner');
      const icon = byId('statusIcon');
      banner.className = 'capture-status-banner state-' + state;

      if (state === 'active') {
        icon.innerText = '->';
        byId('captureStatusTitle').innerText = 'Receptor Ativo';
        byId('btnStart').disabled = true;
        byId('btnStop').disabled = false;
      } else {
        icon.innerText = '||';
        byId('captureStatusTitle').innerText = 'Receptor Pausado';
        byId('btnStart').disabled = false;
        byId('btnStop').disabled = true;
      }
    }

    function startCapture() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "start_capture" }));
        updateCaptureStatusUI('active');
      }
    }

    function stopCapture() {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: "stop_capture" }));
        updateCaptureStatusUI('paused');
      }
    }

    function switchTab(screenId, btnElement) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById(screenId).classList.remove('hidden');
      if (btnElement) btnElement.classList.add('active');
      if (screenId === 'screen-remote') updateThermostatUI();
      if (screenId === 'screen-import') updateProfileJSON();
    }

    window.onload = () => {
      initWebSocket();
      updateProfileJSON();
      updateThermostatUI();
      byId('modeValue').innerText = 'OPERATION';
      byId('statusModeValue').innerText = 'OPERATION';
      carregarInfoDispositivo();
    };

    function carregarInfoDispositivo() {
      fetch('/info')
        .then((r) => r.json())
        .then((info) => {
          byId('infoSala').value = info.sala || '—';
          byId('infoMac').value = info.mac || '—';
          byId('infoIp').value = info.ip || '—';
        })
        .catch(() => {});
    }
  </script>
</body>
</html>
)rawliteral";

#endif