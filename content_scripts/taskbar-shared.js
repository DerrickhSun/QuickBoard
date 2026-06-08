// taskbar-shared.js
// SHARED COORDINATION MODULE — keep this file BYTE-FOR-BYTE IDENTICAL in every
// extension that wants to share the taskbar.
//
// Extensions can't share JavaScript (each content script runs in its own
// isolated world), so they coordinate purely through the page DOM. The contract
// below — the host element id, the slots container, and the events — is the
// shared "API". Whichever extension's content script runs first creates the
// taskbar; the one that removes the last slot tears it down.

const SHARED_TASKBAR = {
    HOST_ID: "shared-taskbar-host",
    SLOTS_CLASS: "shared-taskbar-slots",
    SLOT_CLASS: "shared-taskbar-slot",
    HEIGHT: 50,
    SHIFTED_ATTR: "data-shared-taskbar-prev-top",
    EVT_READY: "shared-taskbar:ready",
    EVT_REMOVED: "shared-taskbar:removed",
};

// ---- page shifting ---------------------------------------------------------
// All shift state is stored in the DOM (an attribute on each moved element and
// body's inline paddingTop) so that *either* extension can undo it, even the one
// that didn't create the taskbar. The MutationObserver is the only piece of
// per-extension JS state, so it self-terminates when it notices the host is gone.
let sharedTaskbarObserver = null;

function sharedShiftFixedElement(el) {
    if (!(el instanceof HTMLElement)) return;
    if (el.id === SHARED_TASKBAR.HOST_ID || el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) return;

    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return;

    const top = parseFloat(cs.top);
    if (isNaN(top) || top >= SHARED_TASKBAR.HEIGHT) return;

    el.setAttribute(SHARED_TASKBAR.SHIFTED_ATTR, el.style.top);
    el.style.top = top + SHARED_TASKBAR.HEIGHT + "px";
}

function sharedShiftWithin(root) {
    sharedShiftFixedElement(root);
    if (root.querySelectorAll) root.querySelectorAll("*").forEach(sharedShiftFixedElement);
}

function sharedStartShifting() {
    sharedShiftWithin(document.body);
    document.body.style.paddingTop = SHARED_TASKBAR.HEIGHT + "px";

    if (sharedTaskbarObserver) return;
    sharedTaskbarObserver = new MutationObserver((mutations) => {
        // If another extension removed the host, stop and clean up after ourselves.
        if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) {
            sharedStopShifting();
            return;
        }
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) sharedShiftWithin(node);
            });
        }
    });
    sharedTaskbarObserver.observe(document.body, { childList: true, subtree: true });
}

function sharedStopShifting() {
    if (sharedTaskbarObserver) {
        sharedTaskbarObserver.disconnect();
        sharedTaskbarObserver = null;
    }
    document.body.style.paddingTop = "0";
    document.querySelectorAll("[" + SHARED_TASKBAR.SHIFTED_ATTR + "]").forEach((el) => {
        el.style.top = el.getAttribute(SHARED_TASKBAR.SHIFTED_ATTR);
        el.removeAttribute(SHARED_TASKBAR.SHIFTED_ATTR);
    });
}

// ---- host lifecycle --------------------------------------------------------
// Idempotent and synchronous: content scripts from different extensions run as
// separate tasks on the same thread, so a synchronous check-then-create here
// guarantees the second extension reuses the first one's host (no race, no
// duplicate bars).
function sharedEnsureTaskbar() {
    const existing = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (existing) return existing.shadowRoot;

    const host = document.createElement("div");
    host.id = SHARED_TASKBAR.HOST_ID;
    host.style.cssText =
        "position: fixed; top: 0; left: 0; width: 100%; height: " + SHARED_TASKBAR.HEIGHT +
        "px; box-sizing: border-box; border-bottom: 2px solid #000;" +
        "background-color: #f0f0f0; z-index: 2147483647;";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
        "<style>" +
        ":host{display:block;width:100%;height:100%;}" +
        ".bar{display:flex;align-items:center;gap:8px;height:100%;padding:0 12px;" +
        "box-sizing:border-box;font-family:system-ui,sans-serif;}" +
        "." + SHARED_TASKBAR.SLOTS_CLASS + "{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;}" +
        "." + SHARED_TASKBAR.SLOT_CLASS + "{display:flex;align-items:center;gap:6px;flex:0 0 auto;}" +
        "button{padding:6px 12px;font-size:13px;cursor:pointer;}" +
        "</style>" +
        '<div class="bar"><div class="' + SHARED_TASKBAR.SLOTS_CLASS + '"></div></div>';

    document.documentElement.prepend(host);
    sharedStartShifting();
    document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_READY, {
        detail: { hostId: SHARED_TASKBAR.HOST_ID },
    }));
    return shadow;
}

function sharedSlotSelector(extKey) {
    return "." + SHARED_TASKBAR.SLOT_CLASS + '[data-ext="' + extKey + '"]';
}

// ---- public API ------------------------------------------------------------

// Ensure the shared taskbar exists and (re)build this extension's slot.
// extKey MUST be unique per extension. buildFn(slot, shadowRoot) populates the
// slot with the caller's own buttons. order controls left-to-right placement
// (lower = further left); slots with equal order fall back to insertion order.
// Returns the slot element.
function registerTaskbar(extKey, buildFn, order) {
    const shadow = sharedEnsureTaskbar();
    const slots = shadow.querySelector("." + SHARED_TASKBAR.SLOTS_CLASS);

    let slot = slots.querySelector(sharedSlotSelector(extKey));
    if (!slot) {
        slot = document.createElement("div");
        slot.className = SHARED_TASKBAR.SLOT_CLASS;
        slot.setAttribute("data-ext", extKey);
        slot.setAttribute("data-order", String(Number(order) || 0));
        sharedInsertSlotOrdered(slots, slot);
    } else {
        slot.setAttribute("data-order", String(Number(order) || 0));
        sharedInsertSlotOrdered(slots, slot); // re-place in case order changed
        slot.replaceChildren(); // idempotent re-register
    }

    if (typeof buildFn === "function") buildFn(slot, shadow);
    return slot;
}

// Insert/move slot so siblings stay sorted by data-order. Insertion order is
// preserved among equal orders, so this is stable regardless of which extension
// loaded first.
function sharedInsertSlotOrdered(slots, slot) {
    const order = Number(slot.getAttribute("data-order")) || 0;
    const siblings = Array.from(slots.children).filter((c) => c !== slot);
    const before = siblings.find((c) => (Number(c.getAttribute("data-order")) || 0) > order);
    slots.insertBefore(slot, before || null);
}

// Remove this extension's slot. If it was the last one, tear down the whole
// taskbar and restore the page — safe to call from either extension.
function unregisterTaskbar(extKey) {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host || !host.shadowRoot) return false;

    const slots = host.shadowRoot.querySelector("." + SHARED_TASKBAR.SLOTS_CLASS);
    const slot = slots && slots.querySelector(sharedSlotSelector(extKey));
    if (slot) slot.remove();

    if (slots && slots.children.length === 0) {
        host.remove();
        sharedStopShifting();
        document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_REMOVED, {
            detail: { hostId: SHARED_TASKBAR.HOST_ID },
        }));
    }
    return true;
}

// Whether this extension currently has a slot in the taskbar.
function isTaskbarRegistered(extKey) {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host || !host.shadowRoot) return false;
    return !!host.shadowRoot.querySelector(sharedSlotSelector(extKey));
}
