// scroll_elements.js
// Self-contained manager for the scrollable strip of generated elements (chips),
// including merging chips into dropdown groups, dragging members out of groups,
// reordering, and deletion. Loaded before content.js and shares the same
// isolated-world scope.
//
// Public API used by content.js:
//   createScrollSection(shadow) -> HTMLElement   the scrollable section to mount
//   addScrollElement(text)                       add a new single element
//
// Everything else below is internal. Entries are kept as a model and rendered
// from it, which keeps merge / extract / collapse logic simple and robust (no
// fragile DOM surgery mid-drag). Each item has one or more members:
//   - members.length === 1  -> a plain chip
//   - members.length  >  1  -> a dropdown group
// State is module-scoped so it survives toggling the bar off/on within a page.
// It is also persisted in extension storage so chips survive navigation and stay
// in sync across tabs.

const QUICKBOARD_SCROLL_KEY = "quickboard_scroll_state";

// Max characters shown on a chip's label; the full text is kept in the title
// (hover) and in dataset.fullText for the future click handler.
const SCROLL_LABEL_PREVIEW = 8;

// Fraction of a chip's width (centered) that counts as the merge zone. The
// outer edges act as reorder zones, so dropping near a chip's side reorders
// instead of merging.
const SCROLL_MERGE_ZONE = 0.5;

let qbItems = [];                 // [{ id, members: string[] }]
let qbIdSeq = 0;
let qbEntriesEl = null;           // the scrollable section that holds the chips
let qbPanelEl = null;             // shared dropdown panel (lives outside the scroller)
let qbActivePanelItemId = null;
let qbPanelHideTimer = null;
let qbDrag = null;                // { fromItemId, memberText|null }  (null member = whole chip)
let qbHighlightEl = null;         // current merge-target chip

// content.js also lives in this scope and declares `browser`; use a distinct name.
function qbBrowserApi() { return globalThis.browser ?? globalThis.chrome; }

const qbStorageReady = qbLoadFromStorage();

function qbNewId() { return "qb-item-" + (++qbIdSeq); }

function qbNormalizeLoadedItems(items) {
    if (!Array.isArray(items)) return [];
    return items
        .filter((item) =>
            item && typeof item.id === "string" && Array.isArray(item.members) &&
            item.members.length > 0 && item.members.every((m) => typeof m === "string")
        )
        .map((item) => ({ id: item.id, members: [...item.members] }));
}

function qbSyncIdSeqFromItems() {
    let max = qbIdSeq;
    for (const item of qbItems) {
        const m = /^qb-item-(\d+)$/.exec(item.id);
        if (m) max = Math.max(max, Number(m[1]));
    }
    qbIdSeq = max;
}

async function qbLoadFromStorage() {
    try {
        const res = await qbBrowserApi().storage.local.get(QUICKBOARD_SCROLL_KEY);
        const state = res[QUICKBOARD_SCROLL_KEY];
        if (state && Array.isArray(state.items)) {
            qbItems = qbNormalizeLoadedItems(state.items);
            qbIdSeq = Number.isFinite(state.idSeq) ? state.idSeq : 0;
            qbSyncIdSeqFromItems();
        }
    } catch (e) { /* ignore */ }
    if (qbEntriesEl) qbRender();
}

function qbSaveToStorage() {
    qbBrowserApi().storage.local.set({
        [QUICKBOARD_SCROLL_KEY]: { items: qbItems, idSeq: qbIdSeq },
    }).catch(() => {});
}

function qbApplyStoredState(state) {
    if (state && Array.isArray(state.items)) {
        qbItems = qbNormalizeLoadedItems(state.items);
        qbIdSeq = Number.isFinite(state.idSeq) ? state.idSeq : 0;
        qbSyncIdSeqFromItems();
    } else {
        qbItems = [];
        qbIdSeq = 0;
    }
    qbHidePanel();
    qbRender();
}

try {
    qbBrowserApi().storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(QUICKBOARD_SCROLL_KEY in changes)) return;
        qbApplyStoredState(changes[QUICKBOARD_SCROLL_KEY].newValue);
    });
} catch (e) { /* ignore */ }

function qbPreview(text) {
    return text.length > SCROLL_LABEL_PREVIEW
        ? text.slice(0, SCROLL_LABEL_PREVIEW) + "…"
        : text;
}

function qbFindItem(id) { return qbItems.find((i) => i.id === id); }

function qbCopyText(text) {
    navigator.clipboard.writeText(text).catch(() => {});
}

// ---- public API ------------------------------------------------------------

// Builds the scrollable section, wires up its drag/drop/wheel/dropdown behavior,
// renders any existing model, and returns the element for the caller to mount.
// shadow is the taskbar's shadow root, used to host the dropdown panel.
function createScrollSection(shadow) {
    const section = document.createElement("div");
    section.className = "qb-entries";
    section.style.cssText =
        "display: flex; align-items: center; gap: 6px;" +
        "flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden;" +
        "scrollbar-width: thin;";
    qbEntriesEl = section;

    // The dropdown panel must live OUTSIDE the scroll container: the scroller
    // clips overflow-y, which would hide a dropdown opening downward. Anchoring
    // it to the shadow root and positioning it fixed avoids that clipping.
    qbEnsurePanel(shadow);

    // Mouse wheel scrolls the section horizontally (only when there's overflow).
    section.addEventListener("wheel", (e) => {
        if (e.deltaY === 0) return;
        if (section.scrollWidth <= section.clientWidth) return;
        e.preventDefault();
        section.scrollLeft += e.deltaY;
    }, { passive: false });

    // Dropping on the section background (not on a chip) reorders a dragged chip
    // or extracts a dragged member into a new chip at that position.
    section.addEventListener("dragover", (e) => {
        if (!qbDrag) return;
        e.preventDefault();
    });
    section.addEventListener("drop", (e) => {
        if (!qbDrag) return;
        e.preventDefault();
        const after = getDragAfterElement(section, e.clientX);
        qbReorderOrExtract(qbIndexFromAfterElement(after));
        qbFinishDrag();
    });

    qbStorageReady.then(() => qbRender());
    return section;
}

// Adds a new single-member element and scrolls to reveal it.
function addScrollElement(text) {
    qbItems.push({ id: qbNewId(), members: [text] });
    qbSaveToStorage();
    qbRender();
    if (qbEntriesEl) qbEntriesEl.scrollLeft = qbEntriesEl.scrollWidth;
}

// ---- drop positioning ------------------------------------------------------

// Given the pointer's X, returns the chip the dragged item should be inserted
// before, or null if it belongs at the end.
function getDragAfterElement(container, x) {
    const chips = [...container.querySelectorAll(".qb-entry-chip:not(.qb-dragging)")];
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    for (const chip of chips) {
        const box = chip.getBoundingClientRect();
        const offset = x - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
            closest = { offset, element: chip };
        }
    }
    return closest.element;
}

function qbIndexFromAfterElement(afterEl) {
    if (!afterEl) return qbItems.length;
    const idx = qbItems.findIndex((i) => i.id === afterEl.dataset.itemId);
    return idx < 0 ? qbItems.length : idx;
}

// ---- rendering -------------------------------------------------------------
function qbRender() {
    if (!qbEntriesEl) return;
    qbEntriesEl.replaceChildren();
    for (const item of qbItems) qbEntriesEl.appendChild(qbRenderItem(item));
}

// A chip wraps two sibling buttons styled as one unit (main + "×"). For groups
// the main button is a dropdown summary; hovering it reveals the members panel.
function qbRenderItem(item) {
    const isGroup = item.members.length > 1;

    const chip = document.createElement("span");
    chip.className = "qb-entry-chip";
    chip.draggable = true;
    chip.dataset.itemId = item.id;
    chip.dataset.kind = isGroup ? "group" : "single";
    chip.style.cssText = "display: inline-flex; align-items: stretch; cursor: grab; flex: 0 0 auto;";

    chip.addEventListener("dragstart", (e) => {
        qbDrag = { fromItemId: item.id, memberText: null };
        chip.classList.add("qb-dragging");
        chip.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.members.join("\n")); // required for Firefox
        qbHidePanel();
    });
    chip.addEventListener("dragend", () => {
        chip.classList.remove("qb-dragging");
        chip.style.opacity = "";
        qbEndDrag();
    });

    // Merge target: only the centered zone of a chip merges; its edges fall
    // through to the section so dropping near a side reorders instead.
    chip.addEventListener("dragover", (e) => {
        const inZone = qbInMergeZone(chip, e.clientX);
        if (qbDraggingOwnGroup(item.id)) {
            if (inZone) { e.preventDefault(); e.stopPropagation(); } // swallow center (no-op)
            else qbClearMergeHighlight(chip);                        // edges → reorder/extract
            return;
        }
        if (!qbCanMerge(item.id) || !inZone) { qbClearMergeHighlight(chip); return; }
        e.preventDefault();
        e.stopPropagation();
        qbSetMergeHighlight(chip);
    });
    chip.addEventListener("dragleave", () => qbClearMergeHighlight(chip));
    chip.addEventListener("drop", (e) => {
        const inZone = qbInMergeZone(chip, e.clientX);
        if (qbDraggingOwnGroup(item.id)) {
            if (inZone) { e.preventDefault(); e.stopPropagation(); qbFinishDrag(); } // no-op
            return;                                                                  // edges bubble → reorder/extract
        }
        if (!qbCanMerge(item.id) || !inZone) return; // bubble → reorder on the section
        e.preventDefault();
        e.stopPropagation();
        qbMergeInto(item.id);
        qbFinishDrag();
    });

    const mainBtn = document.createElement("button");
    mainBtn.type = "button";
    mainBtn.className = "qb-entry-btn";
    mainBtn.style.cssText = "border-top-right-radius: 0; border-bottom-right-radius: 0;";
    if (isGroup) {
        mainBtn.textContent = qbPreview(item.members[0]) + " (" + item.members.length + ") ▾";
        mainBtn.title = item.members.join(", ");
    } else {
        mainBtn.textContent = qbPreview(item.members[0]);
        mainBtn.title = item.members[0];
        mainBtn.addEventListener("click", () => qbCopyText(item.members[0]));
    }

    const delBtn = qbMakeDeleteButton(() => qbRemoveItem(item.id));

    chip.appendChild(mainBtn);
    chip.appendChild(delBtn);

    if (isGroup) {
        chip.addEventListener("mouseenter", () => qbShowPanel(item, chip));
        chip.addEventListener("mouseleave", qbScheduleHidePanel);
    }

    return chip;
}

function qbMakeDeleteButton(onClick) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "qb-entry-del";
    del.textContent = "×";
    del.title = "Delete";
    del.setAttribute("aria-label", "Delete");
    del.style.cssText =
        "padding: 6px 8px; font-weight: bold; line-height: 1;" +
        "border-left: none; border-top-left-radius: 0; border-bottom-left-radius: 0;";
    del.addEventListener("click", onClick);
    return del;
}

// ---- dropdown panel --------------------------------------------------------
function qbEnsurePanel(shadow) {
    if (qbPanelEl && qbPanelEl.isConnected) return qbPanelEl;
    const panel = document.createElement("div");
    panel.className = "qb-panel";
    panel.style.cssText =
        "position: fixed; z-index: 2147483647; display: none; flex-direction: column;" +
        "gap: 6px; padding: 6px; background: #fff; border: 1px solid #ccc; border-radius: 4px;" +
        "box-shadow: 0 2px 8px rgba(0,0,0,0.25); max-height: 50vh; overflow-y: auto;" +
        "font-family: system-ui, sans-serif;";
    panel.addEventListener("mouseenter", qbCancelHidePanel);
    panel.addEventListener("mouseleave", qbScheduleHidePanel);
    shadow.appendChild(panel);
    qbPanelEl = panel;
    return panel;
}

function qbShowPanel(item, chipEl) {
    if (!qbPanelEl || item.members.length <= 1) return;
    qbCancelHidePanel();
    qbActivePanelItemId = item.id;
    qbPanelEl.replaceChildren();
    for (const text of item.members) qbPanelEl.appendChild(qbRenderMember(item, text));
    const rect = chipEl.getBoundingClientRect();
    qbPanelEl.style.left = Math.max(0, rect.left) + "px";
    qbPanelEl.style.top = rect.bottom + "px";
    qbPanelEl.style.display = "flex";
}

function qbHidePanel() {
    if (qbPanelEl) {
        qbPanelEl.style.display = "none";
        qbPanelEl.replaceChildren();
    }
    qbActivePanelItemId = null;
}

function qbScheduleHidePanel() {
    qbCancelHidePanel();
    qbPanelHideTimer = setTimeout(qbHidePanel, 150);
}

function qbCancelHidePanel() {
    if (qbPanelHideTimer) { clearTimeout(qbPanelHideTimer); qbPanelHideTimer = null; }
}

// A member row inside the dropdown: draggable (to extract it) with its own "×".
function qbRenderMember(group, text) {
    const row = document.createElement("span");
    row.className = "qb-member";
    row.draggable = true;
    row.style.cssText = "display: inline-flex; align-items: stretch; cursor: grab;";

    row.addEventListener("dragstart", (e) => {
        qbDrag = { fromItemId: group.id, memberText: text };
        row.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", text); // required for Firefox
    });
    row.addEventListener("dragend", () => {
        row.style.opacity = "";
        qbEndDrag();
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qb-entry-btn";
    btn.textContent = text;
    btn.title = text;
    btn.style.cssText = "border-top-right-radius: 0; border-bottom-right-radius: 0; text-align: left;";
    btn.addEventListener("click", () => qbCopyText(text));

    const del = qbMakeDeleteButton(() => qbDeleteMember(group, text));

    row.appendChild(btn);
    row.appendChild(del);
    return row;
}

// ---- model operations ------------------------------------------------------
function qbCanMerge(targetId) {
    return !!qbDrag && qbDrag.fromItemId !== targetId;
}

// True when the pointer X falls within the centered merge zone of a chip; the
// outer edges are reserved for reordering.
function qbInMergeZone(chip, x) {
    const rect = chip.getBoundingClientRect();
    const margin = rect.width * (1 - SCROLL_MERGE_ZONE) / 2;
    return x >= rect.left + margin && x <= rect.right - margin;
}

// A member dragged back onto its own group is a no-op (it's already there).
function qbDraggingOwnGroup(targetId) {
    return !!qbDrag && qbDrag.memberText != null && qbDrag.fromItemId === targetId;
}

// Merge the dragged source (a whole item or a single member) into the target.
function qbMergeInto(targetId) {
    const target = qbFindItem(targetId);
    if (!target || !qbDrag) return;

    if (qbDrag.memberText == null) {
        const srcIdx = qbItems.findIndex((i) => i.id === qbDrag.fromItemId);
        if (srcIdx < 0) return;
        target.members.push(...qbItems[srcIdx].members);
        qbItems.splice(srcIdx, 1);
    } else {
        const src = qbFindItem(qbDrag.fromItemId);
        if (!src) return;
        const mi = src.members.indexOf(qbDrag.memberText);
        if (mi < 0) return;
        src.members.splice(mi, 1);
        target.members.push(qbDrag.memberText);
        qbRemoveIfEmpty(src);
    }
}

// Reorder a dragged chip, or extract a dragged member into a new chip, placing
// the result at the given model index.
function qbReorderOrExtract(index) {
    if (!qbDrag) return;

    if (qbDrag.memberText == null) {
        const srcIdx = qbItems.findIndex((i) => i.id === qbDrag.fromItemId);
        if (srcIdx < 0) return;
        const [item] = qbItems.splice(srcIdx, 1);
        const insertAt = srcIdx < index ? index - 1 : index;
        qbItems.splice(insertAt, 0, item);
    } else {
        const src = qbFindItem(qbDrag.fromItemId);
        if (!src) return;
        const mi = src.members.indexOf(qbDrag.memberText);
        if (mi < 0) return;
        src.members.splice(mi, 1);
        qbItems.splice(index, 0, { id: qbNewId(), members: [qbDrag.memberText] });
        qbRemoveIfEmpty(src);
    }
}

function qbRemoveIfEmpty(item) {
    if (item.members.length === 0) {
        const i = qbItems.findIndex((x) => x.id === item.id);
        if (i >= 0) qbItems.splice(i, 1);
    }
}

function qbRemoveItem(id) {
    const i = qbItems.findIndex((x) => x.id === id);
    if (i >= 0) qbItems.splice(i, 1);
    if (qbActivePanelItemId === id) qbHidePanel();
    qbSaveToStorage();
    qbRender();
}

function qbDeleteMember(group, text) {
    const mi = group.members.indexOf(text);
    if (mi >= 0) group.members.splice(mi, 1);
    qbRemoveIfEmpty(group);
    qbHidePanel();
    qbSaveToStorage();
    qbRender();
}

// ---- drag bookkeeping ------------------------------------------------------
function qbSetMergeHighlight(el) {
    if (qbHighlightEl === el) return;
    qbClearAllHighlight();
    el.style.outline = "2px solid #4a90d9";
    el.style.outlineOffset = "1px";
    qbHighlightEl = el;
}

function qbClearMergeHighlight(el) {
    if (qbHighlightEl === el) qbClearAllHighlight();
}

function qbClearAllHighlight() {
    if (qbHighlightEl) {
        qbHighlightEl.style.outline = "";
        qbHighlightEl.style.outlineOffset = "";
        qbHighlightEl = null;
    }
}

// Cleanup after a drag that did NOT result in a model change (fires on dragend).
function qbEndDrag() {
    qbDrag = null;
    qbClearAllHighlight();
}

// Cleanup + re-render after a drag that DID change the model (fires on drop).
function qbFinishDrag() {
    qbDrag = null;
    qbClearAllHighlight();
    qbHidePanel();
    qbSaveToStorage();
    qbRender();
}
