const RTStatus = (() => {
  let salaObservada = null;
  const ouvintesSalas = new Set();
  const ouvintesStatus = new Set();

  function enviarObservar(sala) {
    ServerStatus.enviar({ tipo: "observar", sala });
  }

  function conectar() {
    ServerStatus.conectar();
    if (salaObservada && ServerStatus.estaConectado()) enviarObservar(salaObservada);
  }

  function desconectar() {
    salaObservada = null;
  }

  function observarSala(sala) {
    salaObservada = sala;
    enviarObservar(sala);
  }

  function pararObservarSala() {
    salaObservada = null;
    enviarObservar(null);
  }

  function aoSalas(cb) {
    ouvintesSalas.add(cb);
    return () => ouvintesSalas.delete(cb);
  }

  function aoStatusSala(cb) {
    ouvintesStatus.add(cb);
    return () => ouvintesStatus.delete(cb);
  }

  ServerStatus.aoConectar(() => {
    if (salaObservada) enviarObservar(salaObservada);
  });

  ServerStatus.aoMensagem((msg) => {
    if (msg.tipo === "salas") {
      ouvintesSalas.forEach((cb) => cb(msg.salas));
    } else if (msg.tipo === "status") {
      ouvintesStatus.forEach((cb) => cb(msg.status));
    }
  });

  return { conectar, desconectar, observarSala, pararObservarSala, aoSalas, aoStatusSala };
})();
