const screens = {
  location: document.getElementById("screen-location"),
  floorplan: document.getElementById("screen-floorplan"),
  rooms: document.getElementById("screen-rooms"),
  panel: document.getElementById("screen-panel"),
  agenda: document.getElementById("screen-agenda"),
  grade: document.getElementById("screen-grade"),
  admin: document.getElementById("screen-admin"),
};

let salasSubScreenAtual = "floorplan";

function showScreen(name) {
  if (screens.floorplan && !screens.floorplan.classList.contains("hidden") && name !== "floorplan") {
    if (window.ScreenFloorplan) ScreenFloorplan.aoFechar();
  }
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  if (!["agenda", "admin", "grade", "panel"].includes(name)) salasSubScreenAtual = name;
  if (name === "floorplan" && window.ScreenFloorplan) ScreenFloorplan.aoAbrir();
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
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
  } else if (tab === "admin") {
    showScreen("admin");
    Admin.aoAbrir();
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
