// Background code of the plugin: runs while the plugin is enabled.
const t = termdock.i18n.t;

termdock.commands.register("greet", async (ctx) => {
  const calls = ((await termdock.storage.get("calls")) || 0) + 1;
  await termdock.storage.set("calls", calls);
  const session = ctx.paneId ? (await termdock.sessions.list()).find((s) => s.paneId === ctx.paneId) : null;
  const who = session ? `, ${session.serverName}` : "";
  await termdock.ui.toast(t({ ru: `Привет${who}! Это вызов №${calls}.`, en: `Hello${who}! This is call #${calls}.` }), "success");
});

termdock.commands.register("server", async (ctx) => {
  // Without the servers.read permission a plugin only sees servers with an open session.
  const open = (await termdock.sessions.list()).filter((s) => s.serverId === ctx.serverId);
  const text = open.length
    ? t({ ru: `Открыто сессий: ${open.length}, адрес ${open[0].username}@${open[0].host}`, en: `Open sessions: ${open.length}, address ${open[0].username}@${open[0].host}` })
    : t({ ru: "К этому серверу сейчас нет подключений.", en: "No open sessions to this server." });
  await termdock.ui.toast(text);
});

termdock.commands.register("files", async (ctx) => {
  const where = ctx.side === "remote" ? t({ ru: "на сервере", en: "on the server" }) : t({ ru: "на компьютере", en: "on this computer" });
  await termdock.ui.toast(t({ ru: `Выбрано ${ctx.paths.length} ${where}: ${ctx.paths.join(", ")}`, en: `${ctx.paths.length} selected ${where}: ${ctx.paths.join(", ")}` }));
});

termdock.commands.register("about", () => termdock.ui.openPanel("about"));
