import { openUrl as open } from "@tauri-apps/plugin-opener";

export function openUrl(url: string) {
  if (/^https?:\/\//i.test(url)) open(url).catch(() => {});
}
