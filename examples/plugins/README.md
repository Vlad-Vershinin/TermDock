# Примеры плагинов / Example plugins

Установка: TermDock → кнопка с пазлом в заголовке → «Управление плагинами…» → «Установить из папки…» → выберите папку плагина.
To install: TermDock → the puzzle button in the title bar → “Manage plugins…” → “Install from folder…” → pick a plugin folder.

| Плагин / Plugin | Разрешения / Permissions | |
|---|---|---|
| [hello-world](hello-world) | — | Команды в меню, палитре (`Ctrl+Shift+P`) и по `Ctrl+Alt+H`, хранилище, окно-диалог. / Commands in menus, the palette and on `Ctrl+Alt+H`, storage, a dialog panel. |
| [auto-reply](auto-reply) | `terminal.read`, `terminal.write` | Отвечает в терминал по правилам (например, `[Y/n]` → `y`), правила — в боковой панели. / Answers terminal prompts by rules (e.g. `[Y/n]` → `y`), rules in a sidebar panel. |
| [server-info](server-info) | `server.exec`, `files.read` | Панель под терминалом: ОС, uptime, диски, процессы. / A panel under the terminal: OS, uptime, disks, processes. |
| [claude-tmux](claude-tmux) | `server.exec`, `terminal.write`, `sessions.shell` | Чаты Claude Code в tmux на сервере переживают обрыв SSH и открываются при подключении вместо shell; панель со списком чатов. / Claude Code chats in tmux on the server survive a dropped SSH connection and open on connect instead of the shell; a panel with the chat list. |

Документация / Docs: [docs/plugins](../../docs/plugins/README.md) ([English](../../docs/plugins/README.en.md)).
