//! Files and images from the OS clipboard, for pasting them onto a server.
//! Copied files come as their local paths; an image (a screenshot) is saved as a PNG in a temp
//! folder first. The upload itself goes through the normal transfer queue.

use std::path::Path;

/// Local paths of files copied in the file manager; with `image_name`, falls back to saving a
/// clipboard image under that name. Empty when the clipboard holds neither.
#[tauri::command]
pub async fn clipboard_paths(image_name: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read(image_name.as_deref())).await.map_err(|e| e.to_string())?
}

fn read(image_name: Option<&str>) -> Result<Vec<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| tr!("Буфер обмена недоступен: {e}", "The clipboard isn't available: {e}"))?;
    if let Ok(list) = cb.get().file_list() {
        let paths: Vec<String> = list.into_iter().filter(|p| p.exists()).map(|p| p.to_string_lossy().into_owned()).collect();
        if !paths.is_empty() {
            return Ok(paths);
        }
    }
    let Some(name) = image_name else { return Ok(vec![]) };
    let Ok(img) = cb.get_image() else { return Ok(vec![]) };
    let file = crate::dragout::new_temp_dir()?.join(safe_name(name));
    write_png(&file, img.width as u32, img.height as u32, &img.bytes).map_err(|e| tr!("Не удалось сохранить картинку: {e}", "Couldn't save the image: {e}"))?;
    Ok(vec![file.to_string_lossy().into_owned()])
}

/// A plain file name (no folders), ending in .png.
fn safe_name(name: &str) -> String {
    let base: String = name.chars().map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect();
    let base = base.trim_matches('.');
    let base = if base.is_empty() { "clipboard" } else { base };
    if base.to_ascii_lowercase().ends_with(".png") { base.to_string() } else { format!("{base}.png") }
}

fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| e.to_string())?);
    let mut enc = png::Encoder::new(file, width, height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(|e| e.to_string())?;
    w.write_image_data(rgba).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("screenshot-2026-11-19_16-45-53"), "screenshot-2026-11-19_16-45-53.png");
        assert_eq!(safe_name("../../etc/passwd"), "-..-etc-passwd.png");
        assert_eq!(safe_name("a.PNG"), "a.PNG");
        assert_eq!(safe_name(""), "clipboard.png");
    }

    #[test]
    fn png_roundtrip() {
        let dir = crate::dragout::new_temp_dir().unwrap();
        let f = dir.join("x.png");
        write_png(&f, 2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        let bytes = std::fs::read(&f).unwrap();
        assert_eq!(&bytes[1..4], b"PNG");
        let _ = std::fs::remove_dir_all(dir);
    }
}
