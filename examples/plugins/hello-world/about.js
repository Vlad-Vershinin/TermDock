const t = termdock.i18n.t;

async function render() {
  await termdock.ready;
  document.getElementById("calls").textContent = String((await termdock.storage.get("calls")) || 0);
  document.getElementById("label").textContent = t({ ru: "столько раз плагин здоровался", en: "times the plugin said hello" });
  document.getElementById("close").textContent = t({ ru: "Закрыть", en: "Close" });
  document.getElementById("reset").textContent = t({ ru: "Сбросить", en: "Reset" });
}

document.getElementById("close").onclick = () => termdock.ui.closePanel();
document.getElementById("reset").onclick = async () => {
  await termdock.storage.delete("calls");
  render();
};
// The background code changed the counter, or the UI language changed.
termdock.on("storage.changed", render);
termdock.on("language", render);
render();
