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
// A member is { content, name? }: `content` is the real value that gets copied
// and is never changed by renaming; `name` (optional) is a display-only label.
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

let qbItems = [];                 // [{ id, name?, members: [{ content, name? }] }]
let qbIdSeq = 0;
let qbEntriesEl = null;           // the scrollable section that holds the chips
let qbPanelEl = null;             // shared dropdown panel (lives outside the scroller)
let qbActivePanelItemId = null;
let qbPanelHideTimer = null;
let qbDrag = null;                // { fromItemId, member|null }  (null member = whole chip)
let qbHighlightEl = null;         // current merge-target chip
let qbEditingItemId = null;       // group whose name is currently being edited
let qbRenameMode = false;         // when true, clicking elements edits instead of copying
let qbPanelLocked = false;        // keep the dropdown open while editing a member

// content.js also lives in this scope and declares `browser`; use a distinct name.
function qbBrowserApi() { return globalThis.browser ?? globalThis.chrome; }

const qbStorageReady = qbLoadFromStorage();

function qbNewId() { return "qb-item-" + (++qbIdSeq); }

// Accepts legacy string members and the current { content, name? } shape.
function qbNormalizeMember(m) {
    if (typeof m === "string") return { content: m };
    if (m && typeof m.content === "string") {
        const out = { content: m.content };
        if (typeof m.name === "string" && m.name !== "") out.name = m.name;
        return out;
    }
    return null;
}

function qbNormalizeLoadedItems(items) {
    if (!Array.isArray(items)) return [];
    const result = [];
    for (const item of items) {
        if (!item || typeof item.id !== "string" || !Array.isArray(item.members)) continue;
        const members = item.members.map(qbNormalizeMember).filter(Boolean);
        if (members.length === 0) continue;
        const out = { id: item.id, members };
        if (typeof item.name === "string" && item.name !== "") out.name = item.name;
        result.push(out);
    }
    return result;
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

// A member's display label: its custom name if set, else its raw content.
function qbMemberDisplay(m) {
    return m.name != null && m.name !== "" ? m.name : m.content;
}

// A group's display name: the user-set name if present, else a preview of its
// first member's display.
function qbGroupName(item) {
    return item.name != null && item.name !== ""
        ? item.name
        : qbPreview(qbMemberDisplay(item.members[0]));
}

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
    section.style.setProperty("flex", "1 1 auto", "important");
    section.style.setProperty("min-width", "0", "important");
    section.style.setProperty("overflow-x", "auto", "important");
    section.style.setProperty("overflow-y", "hidden", "important");
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
    qbItems.push({ id: qbNewId(), members: [{ content: text }] });
    qbSaveToStorage();
    qbRender();
    if (qbEntriesEl) qbEntriesEl.scrollLeft = qbEntriesEl.scrollWidth;
}

// Toggles rename mode. In rename mode, clicking an element edits its displayed
// content; otherwise clicking copies it (groups open their dropdown on hover).
function setScrollRenameMode(on) {
    qbRenameMode = !!on;
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
        qbDrag = { fromItemId: item.id, member: null };
        chip.classList.add("qb-dragging");
        chip.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", item.members.map((m) => m.content).join("\n")); // required for Firefox
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
        mainBtn.textContent = qbGroupName(item) + " (" + item.members.length + ") ▾";
        mainBtn.title = item.members.map((m) => m.content).join(", ");
        // In rename mode, click edits the group's name; otherwise the dropdown
        // (on hover) is the group's only interaction.
        mainBtn.addEventListener("click", () => {
            if (qbRenameMode) qbStartRenameGroup(item, chip, mainBtn);
        });
    } else {
        const m = item.members[0];
        mainBtn.textContent = qbPreview(qbMemberDisplay(m));
        mainBtn.title = m.content; // hover reveals the real (copied) content
        mainBtn.addEventListener("click", () => {
            if (qbRenameMode) qbStartRenameSingle(item, chip, mainBtn);
            else qbCopyText(m.content);
        });
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

// Generic inline editor: swap a button for a text field that commits on Enter or
// blur (Escape cancels). onSave(value) applies the change; onDone() runs after
// either outcome (cleanup + re-render). draggableEl has its dragging disabled
// during the edit so the caret/selection works.
function qbInlineEdit(anchorBtn, draggableEl, initialValue, onSave, onDone) {
    const prevDraggable = draggableEl.draggable;
    draggableEl.draggable = false;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "qb-rename";
    input.value = initialValue;
    input.style.cssText =
        "padding: 5px 8px; font-size: 13px; min-width: 80px;" +
        "border-top-right-radius: 0; border-bottom-right-radius: 0;";

    let done = false;
    const finish = (save) => {
        if (done) return; // Enter triggers a re-render whose blur would double-fire
        done = true;
        if (save) onSave(input.value);
        draggableEl.draggable = prevDraggable;
        onDone();
    };

    input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // don't let the section/page see these keys
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));

    anchorBtn.replaceWith(input);
    input.focus();
    input.select();
}

// Rename a group's display name. Empty clears it (reverts to the auto preview).
function qbStartRenameGroup(item, chip, mainBtn) {
    qbHidePanel();
    qbEditingItemId = item.id;
    qbInlineEdit(mainBtn, chip, qbGroupName(item), (value) => {
        const v = value.trim();
        if (v === "") delete item.name;
        else item.name = v;
        qbSaveToStorage();
    }, () => {
        qbEditingItemId = null;
        qbRender();
    });
}

// Rename a single chip's display label. Content is preserved; empty clears the
// custom name and reverts the display to the content.
function qbStartRenameSingle(item, chip, mainBtn) {
    const m = item.members[0];
    qbInlineEdit(mainBtn, chip, qbMemberDisplay(m), (value) => {
        const v = value.trim();
        if (v === "") delete m.name;
        else m.name = v;
        qbSaveToStorage();
    }, () => qbRender());
}

// Rename a member's display label from inside the dropdown. Content is preserved;
// empty clears the custom name and reverts the display to the content.
function qbStartRenameMember(group, member, row, btn) {
    qbPanelLocked = true;
    qbInlineEdit(btn, row, qbMemberDisplay(member), (value) => {
        const v = value.trim();
        if (v === "") delete member.name;
        else member.name = v;
        qbSaveToStorage();
    }, () => {
        qbPanelLocked = false;
        qbHidePanel();
        qbRender();
    });
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
    if (qbEditingItemId === item.id) return; // don't cover the rename field
    qbCancelHidePanel();
    qbActivePanelItemId = item.id;
    qbPanelEl.replaceChildren();
    for (const member of item.members) qbPanelEl.appendChild(qbRenderMember(item, member));
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
    if (qbPanelLocked) return; // a member is being edited; keep the panel open
    qbCancelHidePanel();
    qbPanelHideTimer = setTimeout(qbHidePanel, 150);
}

function qbCancelHidePanel() {
    if (qbPanelHideTimer) { clearTimeout(qbPanelHideTimer); qbPanelHideTimer = null; }
}

// A member row inside the dropdown: draggable (to extract it) with its own "×".
function qbRenderMember(group, member) {
    const row = document.createElement("span");
    row.className = "qb-member";
    row.draggable = true;
    row.style.cssText = "display: inline-flex; align-items: stretch; cursor: grab;";

    row.addEventListener("dragstart", (e) => {
        qbDrag = { fromItemId: group.id, member };
        row.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", member.content); // required for Firefox
    });
    row.addEventListener("dragend", () => {
        row.style.opacity = "";
        qbEndDrag();
    });

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "qb-entry-btn";
    btn.textContent = qbMemberDisplay(member);
    btn.title = member.content; // hover reveals the real (copied) content
    btn.style.cssText = "border-top-right-radius: 0; border-bottom-right-radius: 0; text-align: left;";
    btn.addEventListener("click", () => {
        if (qbRenameMode) qbStartRenameMember(group, member, row, btn);
        else qbCopyText(member.content);
    });

    const del = qbMakeDeleteButton(() => qbDeleteMember(group, member));

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
    return !!qbDrag && qbDrag.member != null && qbDrag.fromItemId === targetId;
}

// Merge the dragged source (a whole item or a single member) into the target.
function qbMergeInto(targetId) {
    const target = qbFindItem(targetId);
    if (!target || !qbDrag) return;

    if (qbDrag.member == null) {
        const srcIdx = qbItems.findIndex((i) => i.id === qbDrag.fromItemId);
        if (srcIdx < 0) return;
        target.members.push(...qbItems[srcIdx].members);
        qbItems.splice(srcIdx, 1);
    } else {
        const src = qbFindItem(qbDrag.fromItemId);
        if (!src) return;
        const mi = src.members.indexOf(qbDrag.member);
        if (mi < 0) return;
        src.members.splice(mi, 1);
        target.members.push(qbDrag.member); // keeps the member's own display name
        qbRemoveIfEmpty(src);
    }
}

// Reorder a dragged chip, or extract a dragged member into a new chip, placing
// the result at the given model index.
function qbReorderOrExtract(index) {
    if (!qbDrag) return;

    if (qbDrag.member == null) {
        const srcIdx = qbItems.findIndex((i) => i.id === qbDrag.fromItemId);
        if (srcIdx < 0) return;
        const [item] = qbItems.splice(srcIdx, 1);
        const insertAt = srcIdx < index ? index - 1 : index;
        qbItems.splice(insertAt, 0, item);
    } else {
        const src = qbFindItem(qbDrag.fromItemId);
        if (!src) return;
        const mi = src.members.indexOf(qbDrag.member);
        if (mi < 0) return;
        const [member] = src.members.splice(mi, 1);
        qbItems.splice(index, 0, { id: qbNewId(), members: [member] }); // keeps its display name
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

function qbDeleteMember(group, member) {
    const mi = group.members.indexOf(member);
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
