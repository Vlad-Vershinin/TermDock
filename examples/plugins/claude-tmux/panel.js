const t = termdock.i18n.t;
const tm = window.claudeTmux;
const $ = (id) => document.getElementById(id);
const pane = () => termdock.context.paneId;

let serverId = null;
let busy = false;

function el(tag, props, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

async function run(fn) {
  if (busy) return;
  busy = true;
  $("error").textContent = "";
  try {
    await fn();
  } catch (e) {
    $("error").textContent = e.message;
  } finally {
    busy = false;
  }
  await refresh();
}

function labels() {
  $("title").textContent = t({ ru: "Чаты Claude", en: "Claude chats" });
  $("new").textContent = t({ ru: "Новый чат", en: "New chat" });
  $("attach").textContent = t({ ru: "Открыть в терминале", en: "Open in terminal" });
  $("refresh").textContent = t({ ru: "Обновить", en: "Refresh" });
  $("autoLabel").textContent = t({ ru: "Открывать при подключении к этому серверу", en: "Open on connect to this server" });
  $("cmdLabel").textContent = t({ ru: "Команда запуска", en: "Launch command" });
}

async function refresh() {
  await termdock.ready;
  labels();
  if (!pane()) return;
  const s = (await termdock.sessions.list()).find((x) => x.paneId === pane());
  serverId = s ? s.serverId : null;
  $("auto").checked = !((await termdock.storage.get("noAuto")) || []).includes(serverId);
  if (document.activeElement !== $("cmd")) $("cmd").value = (await termdock.storage.get("command")) || "claude";
  if (!s || s.status !== "connected") {
    $("chats").replaceChildren();
    $("empty").textContent = t({ ru: "Сессия не подключена.", en: "The session is not connected." });
    return;
  }
  let res;
  try {
    res = await tm.list(pane());
  } catch (e) {
    $("error").textContent = e.message;
    return;
  }
  $("empty").textContent = !res.tmux
    ? t({ ru: "На сервере нет tmux. Установите его (например, sudo apt install tmux), чтобы чаты переживали обрыв связи.", en: "tmux isn't installed on the server. Install it (e.g. sudo apt install tmux) so chats survive a dropped connection." })
    : res.chats.length
      ? ""
      : t({ ru: "Чатов пока нет.", en: "No chats yet." });
  $("chats").replaceChildren(
    ...res.chats.map((c) => {
      const open = el("button", { textContent: t({ ru: "Перейти", en: "Switch" }), onclick: () => run(() => exec("open", { windowId: c.id })) });
      const close = el("button", {
        className: "danger",
        textContent: t({ ru: "Закрыть", en: "Close" }),
        onclick: () =>
          run(async () => {
            if (await termdock.ui.confirm(t({ ru: `Закрыть чат «${c.name}»?`, en: `Close chat “${c.name}”?` }), t({ ru: "Claude в этом окне будет остановлен.", en: "Claude in this window will be stopped." }))) await tm.kill(pane(), c.id);
          }),
      });
      const state = c.command === "claude" || c.command === "node" ? "" : ` · ${c.command}`;
      return el(
        "tr",
        { className: c.active ? "active" : "" },
        el("td", { className: "name", textContent: `${c.index}: ${c.name}${state}` }),
        el("td", { className: "path", textContent: c.path, title: c.path }),
        el("td", { className: "actions" }, open, " ", close),
      );
    }),
  );
}

// The background code does the work (commands.execute), so the logic lives in one place.
const exec = (id, ctx) => termdock.commands.execute(id, { paneId: pane(), ...ctx });

$("new").onclick = () => run(() => exec("new"));
$("attach").onclick = () => run(() => exec("open"));
$("refresh").onclick = () => run(async () => {});
$("auto").onchange = () => run(() => exec("auto", { serverId }));

$("cmd").onchange = () =>
  run(async () => {
    await termdock.storage.set("command", tm.required($("cmd").value, t({ ru: "Команда", en: "Command" })));
  });

termdock.on("context", refresh);
termdock.on("language", refresh);
termdock.on("session.connected", refresh);
termdock.on("session.closed", refresh);
// The background code changed something (a chat created, auto-open toggled…).
termdock.on("message", ({ data }) => data && data.type === "changed" && refresh());
// Chats finish or rename themselves; a slow poll keeps the list honest without hammering the server.
setInterval(() => {
  if (!busy && document.visibilityState === "visible") refresh();
}, 10000);
refresh();
