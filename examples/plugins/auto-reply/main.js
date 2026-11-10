// Background code: watches terminal output and answers when a rule matches.
// plugin.json names one main file; the helpers shared with the panel (rules.js) are added
// with a script tag at the end.
const t = termdock.i18n.t;
let state = { rules: [], enabled: true };
/** Last output of each session, without colours: rules match its end. */
const tails = new Map();

// Colour and cursor escape sequences would split the text we look for.
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\r/g;

async function reload() {
  state = await loadSettings();
}

termdock.on("terminal.output", ({ paneId, text }) => {
  if (!state.enabled) return;
  const tail = ((tails.get(paneId) || "") + text.replace(ANSI, "")).slice(-400);
  tails.set(paneId, tail);
  const rule = state.rules.find((r) => r.on && r.when && tail.toLowerCase().includes(r.when.toLowerCase()));
  if (!rule) return;
  // Forget what matched, so the same prompt isn't answered twice.
  tails.set(paneId, "");
  termdock.terminal.send(paneId, rule.reply + (rule.enter ? "\r" : "")).catch((e) => termdock.ui.toast(e.message, "error"));
});

termdock.on("session.closed", ({ paneId }) => tails.delete(paneId));
termdock.on("storage.changed", reload);

termdock.commands.register("toggle", async () => {
  state.enabled = !state.enabled;
  await termdock.storage.set("enabled", state.enabled);
  await termdock.ui.toast(state.enabled ? t({ ru: "Автоответы включены", en: "Auto-reply is on" }) : t({ ru: "Автоответы выключены", en: "Auto-reply is off" }));
});
termdock.commands.register("rules", () => termdock.ui.openPanel("rules"));

const shared = document.createElement("script");
shared.src = "rules.js";
shared.onload = reload;
document.head.appendChild(shared);
