const screens = {
  simple: document.getElementById("screen-simple"),
  location: document.getElementById("screen-location"),
  floorplan: document.getElementById("screen-floorplan"),
  rooms: document.getElementById("screen-rooms"),
  panel: document.getElementById("screen-panel"),
  agenda: document.getElementById("screen-agenda"),
  grade: document.getElementById("screen-grade"),
  propriedade: document.getElementById("screen-propriedade"),
  admin: document.getElementById("screen-admin"),
};

let salasSubScreenAtual = "simple";

function showScreen(name) {
  if (screens.floorplan && !screens.floorplan.classList.contains("hidden") && name !== "floorplan") {
    if (typeof ScreenFloorplan !== "undefined") ScreenFloorplan.aoFechar();
  }
  if (screens.panel && !screens.panel.classList.contains("hidden") && name !== "panel") {
    if (typeof pararAutoRefreshPanel === "function") pararAutoRefreshPanel();
  }
  if (screens.rooms && !screens.rooms.classList.contains("hidden") && name !== "rooms") {
    if (typeof pararAutoRefreshRooms === "function") pararAutoRefreshRooms();
  }
  if (screens.simple && !screens.simple.classList.contains("hidden") && name !== "simple") {
    if (typeof SimpleWizard !== "undefined") SimpleWizard.pararAutoRefresh();
  }
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  if (!["agenda", "admin", "grade", "panel", "propriedade"].includes(name)) salasSubScreenAtual = name;
  if (name === "floorplan" && typeof ScreenFloorplan !== "undefined") ScreenFloorplan.aoAbrir();
  if (name === "simple" && typeof SimpleWizard !== "undefined") {
    const stepSala = document.getElementById("simpleStepSala");
    if (stepSala && !stepSala.classList.contains("hidden")) SimpleWizard.iniciarAutoRefresh();
  }
  if (name === "rooms" && typeof iniciarAutoRefreshRooms === "function") iniciarAutoRefreshRooms(true);
  if (typeof Router !== "undefined") Router.sync();
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const ativo = btn.dataset.tab === tab;
    btn.classList.toggle("active", ativo);
    if (ativo) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });

  if (tab === "salas") {
    showScreen(salasSubScreenAtual);
    if (salasSubScreenAtual === "floorplan") ScreenFloorplan.aoAbrir();
  } else if (tab === "agenda") {
    showScreen("agenda");
    Schedule.aoAbrir();
  } else if (tab === "grade") {
    showScreen("grade");
    Grade.aoAbrir();
  } else if (tab === "propriedade") {
    showScreen("propriedade");
    ScreenPropriedade.aoAbrir();
  } else if (tab === "admin") {
    showScreen("admin");
    Admin.aoAbrir();
  }
  if (typeof Router !== "undefined") Router.sync();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
