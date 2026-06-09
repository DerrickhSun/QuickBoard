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

// Inline styles for the Rename toggle in its default vs. pressed (active) state.
const QUICKBOARD_RENAME_BTN_BASE = "flex: 0 0 auto;";
const QUICKBOARD_RENAME_BTN_ACTIVE =
    "flex: 0 0 auto; background: #cfcfcf;" +
    "box-shadow: inset 0 2px 4px rgba(0,0,0,0.35); transform: translateY(1px);";

// Populates QuickBoard's own slot. The shared module handles creating the bar,
// shifting the page, and tearing everything down when the last slot leaves. The
// scrollable strip of generated elements is managed entirely by
// scroll_elements.js — content.js only mounts the section and adds new elements.
function buildQuickBoardSlot(slot, shadow) {
    // Let this slot grow within the bar so the scrollable section can claim the
    // leftover space instead of pushing the Rename button out.
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

    // Rename-mode toggle, kept at the end of the slot (never scrolls away). While
    // active, clicking elements edits their content instead of copying it, and
    // the button shows a pressed-down state.
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.id = "qb-rename-btn";
    renameBtn.textContent = "Rename";
    renameBtn.style.cssText = QUICKBOARD_RENAME_BTN_BASE;
    renameBtn.setAttribute("aria-pressed", "false");

    let renameMode = false;
    const syncRenameBtn = () => {
        renameBtn.setAttribute("aria-pressed", String(renameMode));
        renameBtn.style.cssText = renameMode
            ? QUICKBOARD_RENAME_BTN_ACTIVE
            : QUICKBOARD_RENAME_BTN_BASE;
    };
    renameBtn.addEventListener("click", () => {
        renameMode = !renameMode;
        setScrollRenameMode(renameMode);
        syncRenameBtn();
    });
    setScrollRenameMode(false); // start in default mode each time the bar is built
    syncRenameBtn();

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
    slot.appendChild(renameBtn);
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