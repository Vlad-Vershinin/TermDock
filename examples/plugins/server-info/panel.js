const t = termdock.i18n.t;
const $ = (id) => document.getElementById(id);

async function sh(command) {
  const r = await termdock.server.exec(termdock.context.paneId, command, { timeout: 15000 });
  return r.stdout.trim() || r.stderr.trim();
}

async function refresh() {
  await termdock.ready;
  $("refresh").textContent = t({ ru: "Обновить", en: "Refresh" });
  $("disksTitle").textContent = t({ ru: "Диски", en: "Disks" });
  $("procTitle").textContent = t({ ru: "Процессы (по CPU)", en: "Processes (by CPU)" });
  $("error").textContent = "";
  try {
    // files.read: read a file over SFTP. Not every system has it, so fall back to uname.
    const release = await termdock.files.readText(termdock.context.paneId, "/etc/os-release").catch(() => "");
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(release);
    $("os").textContent = pretty ? pretty[1] : await sh("uname -sr");
    $("uptime").textContent = await sh("uptime");
    $("disks").textContent = await sh("df -hP -x tmpfs -x devtmpfs 2>/dev/null || df -h");
    $("procs").textContent = await sh("ps -eo pid,comm,%cpu,%mem --sort=-%cpu 2>/dev/null | head -n 11 || ps aux | head -n 11");
  } catch (e) {
    $("error").textContent = e.message;
  }
}

$("refresh").onclick = refresh;
termdock.on("context", refresh);
termdock.on("language", refresh);
refresh();
