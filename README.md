# TermDock

Десктопное приложение для работы с серверами: список серверов, SSH-терминалы во вкладках и файловый менеджер «ПК ↔ сервер» с drag & drop.

Стек: **Tauri 2 + Rust** (SSH/SFTP через `russh`, без внешнего `ssh.exe`) и **React + TypeScript** (терминал на xterm.js).

## Возможности

- **Серверы**: добавление/редактирование/удаление, группы, цвета, поиск (`Ctrl+Shift+K`). В поле хоста можно вставить `user@host:port`.
- **Аутентификация**: пароль (с fallback на keyboard-interactive) или SSH-ключ (OpenSSH/PEM, с passphrase). Пароли и passphrase хранятся в системном хранилище — Windows Credential Manager, GNOME Keyring / KWallet (Secret Service). В файл настроек секреты не пишутся.
- **Проверка ключа сервера**: при первом подключении показывается отпечаток SHA256; при смене ключа — предупреждение. Учитывается ваш `~/.ssh/known_hosts`, подтверждённые ключи сохраняются в собственный known_hosts приложения.
- **Терминал**: несколько вкладок (в т.ч. несколько к одному серверу — `Ctrl+клик`), 256 цветов, кликабельные ссылки, изменение размера, переподключение по `Enter`.
- **Файлы** (SFTP): две панели — «Этот компьютер» и сервер.
  - Перетаскивание файлов/папок между панелями (загрузка и скачивание, папки — рекурсивно).
  - Перетаскивание из проводника / файлового менеджера ОС прямо в панель сервера **или в терминал** — загрузится в текущую папку сервера.
  - Бросьте на папку в списке — файл попадёт в неё; перетаскивание внутри одной панели на папку — перемещение.
  - Создание папок, переименование, удаление, скрытые файлы, ручной ввод пути, кнопка «cd сюда» (переходит в терминале в открытую папку).
  - Очередь передач с прогрессом, скоростью и отменой.

## Горячие клавиши

| Клавиши | Действие |
|---|---|
| `Ctrl+Shift+K` | Поиск сервера (Enter — подключиться к первому) |
| `Ctrl+Shift+N` | Новый сервер |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Следующая / предыдущая вкладка |
| `Ctrl+Alt+1…9` | Перейти к вкладке по номеру |
| `Ctrl+Shift+W` | Закрыть вкладку |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Копировать / вставить в терминале |
| Правый клик в терминале | Копировать выделение или вставить |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Размер шрифта терминала |
| В файловой панели: `Enter`, `Backspace`, `Delete`, `F2`, `F5`, `Ctrl+A`, стрелки | Открыть, вверх, удалить, переименовать, обновить, выделить всё, навигация |

## Установка

Готовые пакеты собираются GitHub Actions (`.github/workflows/build.yml`) при пуше тега `v*` или вручную через *Run workflow*:

| Система | Файл |
|---|---|
| Windows 10/11 | `TermDock_x.y.z_x64-setup.exe` (NSIS) или `.msi` |
| Ubuntu / Debian | `TermDock_x.y.z_amd64.deb` → `sudo apt install ./TermDock_*.deb` |
| Arch Linux | `termdock-x.y.z-1-x86_64.pkg.tar.zst` → `sudo pacman -U termdock-*.pkg.tar.zst` |
| Любой Linux | `TermDock_x.y.z_amd64.AppImage` |
| Fedora / openSUSE | `.rpm` |

На Linux для сохранения паролей нужен запущенный Secret Service (GNOME Keyring или KWallet — в обычных десктопах уже есть).

## Сборка из исходников

Требуется: Rust (stable), Node.js 20+.

**Ubuntu/Debian:**
```bash
sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libdbus-1-dev
npm ci
npx tauri build --bundles deb,appimage
```

**Arch Linux:**
```bash
cd packaging/arch
makepkg -si
```

**Windows** (нужны Visual Studio Build Tools с компонентом «Desktop development with C++» и WebView2 — в Windows 10/11 уже есть):
```powershell
npm ci
npx tauri build --bundles nsis,msi
```

**Режим разработки:** `npm ci && npx tauri dev`.

Результаты сборки: `src-tauri/target/release/bundle/`.

## Где хранятся данные

- Список серверов: `servers.json` в каталоге конфигурации приложения
  (`%APPDATA%\dev.termdock.app\` на Windows, `~/.config/dev.termdock.app/` на Linux).
- Ключи серверов: `known_hosts` там же.
- Пароли: системное хранилище секретов (сервис `TermDock`).

## Структура проекта

```
src/                    React + TypeScript
  App.tsx               вкладки, горячие клавиши, приём файлов из ОС
  components/
    Sidebar.tsx         список серверов
    ServerDialog.tsx    добавление / редактирование сервера
    SessionView.tsx     терминал (xterm.js) + подключение
    FilePanel.tsx       двухпанельный файловый менеджер
  lib/
    api.ts              вызовы Rust-команд
    dnd.ts              drag & drop
    transfers.tsx       очередь передач
src-tauri/src/          Rust
  ssh.rs                подключение, аутентификация, known_hosts, shell
  files.rs              локальные/удалённые файлы, загрузка/скачивание
  store.rs              сохранённые серверы и пароли
  lib.rs                Tauri-команды
packaging/arch/         PKGBUILD для Arch Linux
```

## Ограничения

- Перетаскивание файлов **из** приложения в проводник ОС не поддерживается — используйте перетаскивание в панель «Этот компьютер» или кнопку «Скачать».
- Нет поддержки ssh-agent, jump-хостов (ProxyJump) и проброса портов.
- Перенос файлов напрямую между двумя серверами не поддерживается.
