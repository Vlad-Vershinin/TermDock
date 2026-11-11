## What's new in 1.4.0

### Plugins
- **TermDock can now be extended with plugins.** They add their own commands, panels and automation: for example, answering `[Y/n]` questions in the terminal or showing a panel with server info.
- **Install from a folder or a .zip**: the puzzle button in the title bar → "Manage plugins…". Plugins are enabled, disabled and removed there too.
- **You decide what a plugin may do.** Before installing, TermDock shows what the plugin asks for: read terminal output, type commands, run commands on the server, read or change files. Uncheck what you don't want.
- **Command palette** `Ctrl+Shift+P`: find and run plugin commands quickly. Commands are also in the right-click menus of tabs, servers and files, and under the "Plugins" button above the terminal.
- **Security**: plugins run in an isolated sandbox. They can't see passwords or keys and can't go online. But a plugin allowed to run commands can do anything on a server that you can, so install plugins only from sources you trust.
- Three example plugins are in the `examples/plugins` folder of the repository, and `docs/plugins` explains how to write your own.

### Updates
- **TermDock tells you about new versions.** It checks at startup and every hour. When a new version is out, an "Update to …" button appears in the title bar.
- **One-click update**: TermDock downloads the new version, verifies the file's checksum, installs it and restarts. On Linux, deb, rpm and Arch packages ask for the admin password.
- Before updating you see what changed. You can skip a version, or turn the automatic check off in the settings, "Updates" section.
- This version has to be installed by hand; later ones install with the button.

## Install

| System | File |
|---|---|
| Windows 10/11 | `TermDock_1.4.0_x64-setup.exe` (recommended) or `TermDock_1.4.0_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.0_amd64.deb` → `sudo apt install ./TermDock_1.4.0_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.0-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.0-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.0-1-x86_64.pkg.tar.zst` |
| Any Linux | `TermDock_1.4.0_amd64.AppImage` → `chmod +x` and run it |

Settings and servers from earlier versions are kept; install the update over the old version.

---

<details>
<summary>🇷🇺 На русском</summary>

## Что нового в 1.4.0

### Плагины
- **TermDock теперь можно расширять плагинами.** Они добавляют свои команды, панели и автоматизацию. Например, отвечают на вопросы `[Y/n]` в терминале или показывают панель со сведениями о сервере.
- **Установка из папки или .zip:** кнопка с пазлом в заголовке окна → «Управление плагинами…». Там же плагины включают, выключают и удаляют.
- **Вы решаете, что плагину можно.** Перед установкой TermDock показывает, что плагин просит: читать вывод терминала, вводить команды, выполнять команды на сервере, читать или менять файлы. Ненужное можно снять галочкой.
- **Палитра команд** `Ctrl+Shift+P` — быстрый поиск и запуск команд плагинов. Команды есть и в меню по правому клику на вкладке, сервере и файле, и под кнопкой «Плагины» над терминалом.
- **Безопасность:** плагины работают в изолированной песочнице. Они не видят пароли и ключи и не выходят в интернет. Но плагин с разрешением на команды может сделать на сервере то же, что и вы, поэтому ставьте плагины только из источников, которым доверяете.
- Три готовых примера лежат в папке `examples/plugins` репозитория, а как написать свой плагин, рассказано в `docs/plugins`.

### Обновления
- **TermDock сам сообщает о новой версии.** Он проверяет её при запуске и раз в час. Когда она выходит, в заголовке окна появляется кнопка «Обновить до …».
- **Обновление в один клик:** TermDock скачает новую версию, проверит контрольную сумму файла, установит и перезапустится. В Linux для пакетов deb, rpm и Arch система спросит пароль администратора.
- Перед обновлением видно, что изменилось. Версию можно пропустить, а автопроверку выключить в настройках, раздел «Обновления».
- Эту версию нужно поставить вручную, следующие будут ставиться по кнопке.

## Установка

| Система | Файл |
|---|---|
| Windows 10/11 | `TermDock_1.4.0_x64-setup.exe` (рекомендуется) или `TermDock_1.4.0_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.0_amd64.deb` → `sudo apt install ./TermDock_1.4.0_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.0-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.0-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.0-1-x86_64.pkg.tar.zst` |
| Любой Linux | `TermDock_1.4.0_amd64.AppImage` → `chmod +x` и запустить |

Настройки и серверы из прошлых версий сохраняются, обновление можно ставить поверх.


</details>
