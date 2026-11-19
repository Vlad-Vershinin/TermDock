## What's new in 1.4.3

### Clipboard
- **Paste screenshots and files onto the server.** Take a screenshot or copy files in your file manager, then press `Ctrl+V` in the server pane (or right-click → "Paste from clipboard"): they're uploaded into the open folder. In the terminal, `Ctrl+Shift+V` (or right-click) uploads them too and types the uploaded file's path, which is handy for showing a screenshot to Claude Code on the server. Text is pasted as text, as before.
- **Copying from tmux works.** Text you select in tmux (with the mouse on) or copy in an editor on the server now lands in your clipboard (OSC 52). The server can only write to the clipboard, never read it.
- **`Ctrl+C` with text selected copies it**; without a selection it still interrupts the command.
- **`Shift` + drag** selects text even when a program in the terminal uses the mouse; TermDock reminds you about it once.

### Server settings
- **The same layout as the app settings**: sections on the left (Connection, Jump server, Connect script, Port forwarding, Advanced), a dot next to the ones with something set up. If something is wrong on save, the window opens that section.

### Fixes
- The port forwarding form no longer spills out of the "Ports" popover, and text fields in forms keep their full height.

## Install

| System | File |
|---|---|
| Windows 10/11 | `TermDock_1.4.3_x64-setup.exe` (recommended) or `TermDock_1.4.3_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.3_amd64.deb` → `sudo apt install ./TermDock_1.4.3_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.3-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.3-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.3-1-x86_64.pkg.tar.zst` |
| Any Linux | `TermDock_1.4.3_amd64.AppImage` → `chmod +x` and run it |

If you have 1.4.0 or newer, click "Update to 1.4.3" in the title bar. Settings and servers from earlier versions are kept.

---

<details>
<summary>🇷🇺 На русском</summary>

## Что нового в 1.4.3

### Буфер обмена
- **Скриншоты и файлы прямо на сервер.** Сделайте скриншот или скопируйте файлы в проводнике и нажмите `Ctrl+V` в панели сервера (или правый клик → «Вставить из буфера обмена»): они загрузятся в открытую папку. В терминале `Ctrl+Shift+V` (или правый клик) тоже загружает их и вписывает путь к файлу. Так удобно показать скриншот Claude Code на сервере. Текст вставляется как текст, как и раньше.
- **Копирование из tmux работает.** Текст, выделенный в tmux (с включённой мышью) или скопированный в редакторе на сервере, теперь попадает в ваш буфер обмена (OSC 52). Сервер может только записать в буфер, прочитать его он не может.
- **`Ctrl+C` при выделенном тексте копирует его**; без выделения, как и раньше, прерывает команду.
- **`Shift` + выделение мышью** выделяет текст, даже если программа в терминале перехватывает мышь; TermDock один раз об этом напомнит.

### Настройки сервера
- **Как в настройках приложения**: разделы слева (Подключение, Сервер-посредник, Скрипт при подключении, Проброс портов, Дополнительно), точка у тех, где что-то настроено. Если при сохранении что-то не так, окно само откроет нужный раздел.

### Исправления
- Форма проброса портов больше не вылезает за рамки окна «Порты», а текстовые поля в формах снова нормальной высоты.

## Установка

| Система | Файл |
|---|---|
| Windows 10/11 | `TermDock_1.4.3_x64-setup.exe` (рекомендуется) или `TermDock_1.4.3_x64_en-US.msi` |
| Ubuntu / Debian | `TermDock_1.4.3_amd64.deb` → `sudo apt install ./TermDock_1.4.3_amd64.deb` |
| Fedora / openSUSE | `TermDock-1.4.3-1.x86_64.rpm` |
| Arch Linux | `termdock-1.4.3-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-1.4.3-1-x86_64.pkg.tar.zst` |
| Любой Linux | `TermDock_1.4.3_amd64.AppImage` → `chmod +x` и запустить |

Если у вас 1.4.0 или новее, нажмите «Обновить до 1.4.3» в заголовке окна. Настройки и серверы из прошлых версий сохраняются.

</details>
