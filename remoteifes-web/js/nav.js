const screens = {
  location: document.getElementById("screen-location"),
  rooms: document.getElementById("screen-rooms"),
  panel: document.getElementById("screen-panel"),
  agenda: document.getElementById("screen-agenda"),
  admin: document.getElementById("screen-admin"),
};

let salasSubScreenAtual = "location";

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add("hidden"));
  screens[name].classList.remove("hidden");
  if (name !== "agenda" && name !== "admin") salasSubScreenAtual = name;
}

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });

  if (tab === "salas") {
    showScreen(salasSubScreenAtual);
  } else if (tab === "agenda") {
    showScreen("agenda");
    Schedule.aoAbrir();
  } else if (tab === "admin") {
    showScreen("admin");
    Admin.aoAbrir();
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
