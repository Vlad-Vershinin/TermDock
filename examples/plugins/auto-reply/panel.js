const t = termdock.i18n.t;
let rules = [];

function row(rule, i) {
  const el = document.createElement("div");
  el.className = "rule";
  el.innerHTML = `
    <input type="checkbox" data-k="on" title="${t({ ru: "Правило включено", en: "Rule is on" })}">
    <input type="text" data-k="when" placeholder="${t({ ru: "Когда в выводе появится…", en: "When the output shows…" })}">
    <button data-del title="${t({ ru: "Удалить", en: "Delete" })}">×</button>
    <span></span>
    <input type="text" class="wide" data-k="reply" placeholder="${t({ ru: "…ввести (можно пусто)", en: "…type (may be empty)" })}">
    <span></span>
    <label class="wide small"><input type="checkbox" data-k="enter"> ${t({ ru: "и нажать Enter", en: "and press Enter" })}</label>`;
  for (const input of el.querySelectorAll("[data-k]")) {
    const k = input.dataset.k;
    if (input.type === "checkbox") input.checked = !!rule[k];
    else input.value = rule[k] || "";
    input.oninput = () => (rule[k] = input.type === "checkbox" ? input.checked : input.value);
  }
  el.querySelector("[data-del]").onclick = () => {
    rules.splice(i, 1);
    render();
  };
  return el;
}

function render() {
  const list = document.getElementById("list");
  list.replaceChildren(...rules.map(row));
}

async function load() {
  await termdock.ready;
  const s = await loadSettings();
  rules = s.rules.map((r) => ({ ...r }));
  document.getElementById("enabled").checked = s.enabled;
  document.getElementById("enabledLabel").textContent = t({ ru: "Автоответы включены", en: "Auto-reply is on" });
  document.getElementById("intro").textContent = t({
    ru: "Когда в конце вывода терминала появится текст правила, плагин введёт ответ. Регистр не важен.",
    en: "When the rule's text shows up at the end of the terminal output, the plugin types the reply. Case doesn't matter.",
  });
  document.getElementById("add").textContent = t({ ru: "Добавить правило", en: "Add rule" });
  document.getElementById("save").textContent = t({ ru: "Сохранить", en: "Save" });
  render();
}

document.getElementById("add").onclick = () => {
  rules.push({ when: "", reply: "", enter: true, on: true });
  render();
};
document.getElementById("save").onclick = async () => {
  await termdock.storage.set("rules", rules.filter((r) => r.when.trim()));
  await termdock.storage.set("enabled", document.getElementById("enabled").checked);
  await termdock.ui.toast(t({ ru: "Правила сохранены", en: "Rules saved" }), "success");
};
termdock.on("language", load);
load();
