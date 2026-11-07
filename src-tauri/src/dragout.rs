//! Support for dragging files out of the app into the OS file manager.
//! The native drag itself is done by `tauri-plugin-drag`; this module provides the temp
//! folders remote files are downloaded into and a check of the real mouse button state.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Runtime, Window};

/// Remote files dragged out are downloaded into `<tmp>/TermDock-drag/<uuid>/`.
fn root() -> PathBuf {
    std::env::temp_dir().join("TermDock-drag")
}

/// Creates a fresh per-drag temp folder and returns its path.
#[tauri::command]
pub fn drag_temp_dir() -> Result<String, String> {
    let dir = root().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Removes per-drag folders older than a day. The file manager has long finished copying them.
pub fn cleanup_old() {
    let Ok(entries) = std::fs::read_dir(root()) else { return };
    let max_age = Duration::from_secs(24 * 60 * 60);
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Whether the primary mouse button is physically held right now.
/// A native drag started after the button was released would drop immediately on whatever
/// is under the cursor (Windows' DoDragDrop treats "button up" as "drop"), so remote
/// drag-outs check this after their download finishes.
#[tauri::command]
pub async fn mouse_button_held<R: Runtime>(app: AppHandle<R>, window: Window<R>) -> Result<bool, String> {
    let _ = (&app, &window);

    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
        // GetAsyncKeyState reports physical buttons; honour the "swap buttons" setting.
        let vk = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
        return Ok((unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0);
    }

    #[cfg(target_os = "linux")]
    {
        use gtk::gdk;
        use gtk::prelude::*;
        let (tx, rx) = std::sync::mpsc::channel();
        // GTK must be touched on the main thread.
        app.run_on_main_thread(move || {
            let held = window.gtk_window().ok().and_then(|w| {
                let gdk_win = w.window()?;
                let pointer = w.display().default_seat()?.pointer()?;
                let (_, _, _, mask) = gdk_win.device_position(&pointer);
                Some(mask.contains(gdk::ModifierType::BUTTON1_MASK))
            });
            let _ = tx.send(held.unwrap_or(false));
        })
        .map_err(|e| e.to_string())?;
        return tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
            .await
            .map_err(|e| e.to_string());
    }

    // Other platforms: trust the pointer tracking done in the webview.
    #[allow(unreachable_code)]
    Ok(true)
}
