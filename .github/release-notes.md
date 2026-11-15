## What's new in 1.4.2

### For plugin authors
- **A command instead of the shell**: `sessions.onBeforeShell` lets a plugin start its program right when a session opens, like `ssh -t host 'tmux attach'`, instead of typing into the terminal and racing the welcome text or the connect script. The terminal shows which plugin runs what. New permission: `sessions.shell` ⚠.
- **`server.exec` with `stdin`**: run `sh -s` and pass the script through stdin, so the user's login shell (fish, csh…) never parses it. No more quoting tricks for paths and commands.
- **Talking between a plugin's pages**: `commands.execute` runs the plugin's own commands from a panel, `termdock.post` sends messages to its other pages (the `message` event).
- **`sessions.open`** opens a connection to a saved server in a new tab or next to a pane. New permission: `sessions.open` ⚠.
- **`commands.setState`**: check marks, titles and disabled items in menus and the palette, also per server.
- **`ui.notify`**: system notifications while TermDock is in the background. New permission: `notifications`.
- New events `session.ready` (the login output has settled) and `terminal.title`; `main` in plugin.json may list several files.
- A new example plugin, **claude-tmux**: Claude Code chats live in tmux on the server, survive a dropped connection and open on connect.

## Install

| System | File |
|---|---|
| Windows 10/11 | `TermDock_1.4.2_x64-setup.exe` (recommended) or `TermDock_1.4.2_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.2_amd64.deb` → `sudo apt install ./TermDock_1.4.2_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.2-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.2-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.2-1-x86_64.pkg.tar.zst` |
| Any Linux | `TermDock_1.4.2_amd64.AppImage` → `chmod +x` and run it |

If you have 1.4.0 or newer, click "Update to 1.4.2" in the title bar. Settings and servers from earlier versions are kept.

---

<details>
<summary>🇷🇺 На русском</summary>

## Что нового в 1.4.2

### Для авторов плагинов
- **Команда вместо shell**: через `sessions.onBeforeShell` плагин запускает свою программу сразу при открытии сессии, как `ssh -t host 'tmux attach'`, а не печатает в терминал наперегонки с приветствием сервера и скриптом подключения. В терминале видно, какой плагин что запускает. Новое разрешение: `sessions.shell` ⚠.
- **`server.exec` со `stdin`**: запускайте `sh -s` и передавайте скрипт через stdin, тогда оболочка входа пользователя (fish, csh…) его не разбирает. Больше никаких фокусов с кавычками в путях и командах.
- **Связь между страницами плагина**: `commands.execute` вызывает команды плагина из панели, `termdock.post` отправляет сообщения его другим страницам (событие `message`).
- **`sessions.open`** открывает подключение к сохранённому серверу в новой вкладке или рядом с панелью. Новое разрешение: `sessions.open` ⚠.
- **`commands.setState`**: галочки, заголовки и неактивные пункты в меню и палитре, в том числе для отдельного сервера.
- **`ui.notify`**: системные уведомления, когда TermDock в фоне. Новое разрешение: `notifications`.
- Новые события `session.ready` (вывод после входа затих) и `terminal.title`; в `main` в plugin.json можно перечислить несколько файлов.
- Новый пример плагина **claude-tmux**: чаты Claude Code живут в tmux на сервере, переживают обрыв связи и открываются при подключении.

## Установка

| Система | Файл |
|---|---|
| Windows 10/11 | `TermDock_1.4.2_x64-setup.exe` (рекомендуется) или `TermDock_1.4.2_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.2_amd64.deb` → `sudo apt install ./TermDock_1.4.2_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.2-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.2-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.2-1-x86_64.pkg.tar.zst` |
| Любой Linux | `TermDock_1.4.2_amd64.AppImage` → `chmod +x` и запустить |

Если у вас 1.4.0 или новее, нажмите «Обновить до 1.4.2» в заголовке окна. Настройки и серверы из прошлых версий сохраняются.

</details>
