// Opens the panel under the session the command was called for.
termdock.commands.register("show", (ctx) => termdock.ui.openPanel("info", ctx.paneId));
