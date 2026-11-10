// Shared by the background code and the rules panel.
const DEFAULT_RULES = [
  { when: "[Y/n]", reply: "y", enter: true, on: false },
  { when: "Press any key to continue", reply: "", enter: true, on: false },
];

async function loadSettings() {
  const rules = (await termdock.storage.get("rules")) || DEFAULT_RULES;
  const enabled = (await termdock.storage.get("enabled")) ?? true;
  return { rules, enabled };
}
