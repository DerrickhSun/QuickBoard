// content.js
// The shared taskbar contract (host lifecycle, page shifting, register/
// unregister API) lives in taskbar-shared.js, which is loaded before this file
// and shares the same isolated-world scope. Keep taskbar-shared.js identical
// across every extension that shares the bar.

// Unique key identifying THIS extension's slot in the shared taskbar.
const QUICKBOARD_EXT_KEY = "quickboard";
// Lower order = further left. Keep this below the other extension's order so
// QuickBoard's buttons always appear first, regardless of which loads first.
const QUICKBOARD_ORDER = 0;

// Triggers a file download from the page context via a temporary <a download>.
// This works in both Chrome and Firefox, unlike downloads.download with a
// data:/blob: URL (Firefox rejects those outright).
function saveTextFile(text, filename) {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Populates QuickBoard's own slot. The shared module handles creating the bar,
// shifting the page, and tearing everything down when the last slot leaves. The
// scrollable strip of generated elements is managed entirely by
// scroll_elements.js — content.js only mounts the section and adds new elements.
function buildQuickBoardSlot(slot, shadow) {
    // Let this slot grow within the bar so the scrollable section can claim the
    // leftover space instead of pushing the Save button out.
    slot.style.flex = "1 1 auto";
    slot.style.minWidth = "0";

    // Text field — the first element in QuickBoard's section of the taskbar.
    const input = document.createElement("input");
    input.type = "text";
    input.id = "qb-entry-input";
    input.placeholder = "Type, then Enter…";
    input.style.cssText = "padding: 5px 8px; font-size: 13px; flex: 0 0 auto;";

    // The scrollable strip of generated elements, owned by scroll_elements.js.
    const section = createScrollSection(shadow);

    // Existing save action, kept at the end of the slot (never scrolls away).
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.id = "qb-save-btn";
    saveBtn.textContent = 'Save "Hello world"';
    saveBtn.style.cssText = "flex: 0 0 auto;";
    saveBtn.addEventListener("click", () => saveTextFile("Hello world", "hello.txt"));

    // On Enter, hand the text to scroll_elements to create a new element.
    input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        addScrollElement(text);
        input.value = "";
    });

    slot.appendChild(input);
    slot.appendChild(section);
    slot.appendChild(saveBtn);
}

function createTaskbar() {
    registerTaskbar(QUICKBOARD_EXT_KEY, buildQuickBoardSlot, QUICKBOARD_ORDER);
}

function removeTaskbar() {
    unregisterTaskbar(QUICKBOARD_EXT_KEY);
}

const browser = globalThis.browser ?? globalThis.chrome;

// Persisted on/off state so the taskbar survives navigations and page reloads.
// It stays in storage.local until the user toggles it off, so every page we
// load (and every tab) re-applies it.
const QUICKBOARD_ACTIVE_KEY = "quickboard_taskbar_active";

async function getQuickBoardActive() {
    try {
        const res = await browser.storage.local.get(QUICKBOARD_ACTIVE_KEY);
        return !!res[QUICKBOARD_ACTIVE_KEY];
    } catch (e) {
        return false;
    }
}

function setQuickBoardActive(active) {
    return browser.storage.local.set({ [QUICKBOARD_ACTIVE_KEY]: active }).catch(() => {});
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TOGGLE_TASKBAR') {
    // Toggle only OUR slot — the bar itself may be owned by the other extension.
    const mine = isTaskbarRegistered(QUICKBOARD_EXT_KEY);
    mine ? removeTaskbar() : createTaskbar();
    setQuickBoardActive(!mine); // remember the choice for future page loads
    sendResponse({ visible: !mine });
  }
  return true; // keep channel open for async sendResponse
});

// Keep already-open tabs in sync when the state changes elsewhere.
browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(QUICKBOARD_ACTIVE_KEY in changes)) return;
    const active = !!changes[QUICKBOARD_ACTIVE_KEY].newValue;
    const mine = isTaskbarRegistered(QUICKBOARD_EXT_KEY);
    if (active && !mine) createTaskbar();
    else if (!active && mine) removeTaskbar();
});

// On every page load, re-apply the persisted state.
getQuickBoardActive().then((active) => {
    if (active) createTaskbar();
});