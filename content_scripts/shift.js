// shift.js
// Loaded before content.js. Content scripts in the same entry share one
// isolated-world scope, so these constants/functions are visible to content.js.
const TASKBAR_ID = "jobhelp-taskbar-host";
const TASKBAR_HEIGHT = 50;
const SHIFTED_ATTR = "data-jobhelp-prev-top";

// Internal: watches for elements added after the initial shift (SPAs like
// Reddit inject their header later). Owned entirely by this module.
let fixedObserver = null;

// Body padding only reflows normal-flow content. Elements with
// position:fixed/sticky are anchored to the viewport and must be offset
// individually so they don't hide behind our top bar.
function shiftFixedElement(el) {
    if (!(el instanceof HTMLElement)) return;
    if (el.id === TASKBAR_ID || el.hasAttribute(SHIFTED_ATTR)) return;

    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return;

    const top = parseFloat(cs.top);
    // Only push elements anchored at/near the very top of the viewport.
    if (isNaN(top) || top >= TASKBAR_HEIGHT) return;

    // Remember the original inline value (often "") so we can restore exactly.
    el.setAttribute(SHIFTED_ATTR, el.style.top);
    el.style.top = top + TASKBAR_HEIGHT + "px";
}

// Internal: shift everything under a given root (used for both the initial
// pass and for nodes the observer reports later).
function shiftWithin(root) {
    shiftFixedElement(root);
    if (root.querySelectorAll) root.querySelectorAll("*").forEach(shiftFixedElement);
}

// Public: offset all top-anchored fixed/sticky elements and keep doing so as
// the page mutates. Idempotent — calling it again won't add a second observer.
function shiftAllFixedElements() {
    shiftWithin(document.body);

    if (fixedObserver) return;
    fixedObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes.forEach((node) => {
                if (node instanceof HTMLElement) shiftWithin(node);
            });
        }
    });
    fixedObserver.observe(document.body, { childList: true, subtree: true });
}

// Public: stop watching and undo every shift, restoring original top values.
function restoreFixedElements() {
    if (fixedObserver) {
        fixedObserver.disconnect();
        fixedObserver = null;
    }
    document.querySelectorAll("[" + SHIFTED_ATTR + "]").forEach((el) => {
        el.style.top = el.getAttribute(SHIFTED_ATTR);
        el.removeAttribute(SHIFTED_ATTR);
    });
}
