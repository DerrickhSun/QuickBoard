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
    // Fixed/sticky headers stacked under the main nav (e.g. LinkedIn company bars)
    // sit below our bar height but still need shifting.
    MAX_SHIFT_TOP: 200,
    SHIFTED_ATTR: "data-shared-taskbar-prev-top",
    SHIFT_BASE_ATTR: "data-shared-taskbar-shift-base",
    // Stable nav-row height captured at shift time (min seen) — live height
    // grows when a sub-header opens and breaks stacked-header detection.
    SHIFT_ROW_HEIGHT_ATTR: "data-shared-taskbar-row-height",
    CONSTRAINED_ATTR: "data-shared-taskbar-constrained",
    PREV_MAX_HEIGHT_ATTR: "data-shared-taskbar-prev-max-height",
    PREV_MIN_HEIGHT_ATTR: "data-shared-taskbar-prev-min-height",
    PREV_HEIGHT_ATTR: "data-shared-taskbar-prev-height",
    PREV_OVERFLOW_Y_ATTR: "data-shared-taskbar-prev-overflow-y",
    EVT_READY: "shared-taskbar:ready",
    EVT_REMOVED: "shared-taskbar:removed",
};

// ---- page shifting ---------------------------------------------------------
// All shift state is stored in the DOM (an attribute on each moved element and
// body's inline paddingTop) so that *either* extension can undo it, even the one
// that didn't create the taskbar. The MutationObserver is the only piece of
// per-extension JS state, so it self-terminates when it notices the host is gone.
let sharedTaskbarObserver = null;
let sharedMutationTimer = null;
let sharedPendingMutations = null;
let sharedLinkedInJobSearchPage = null;
let sharedOrgStickyObserver = null;
let sharedConstrainTimer = null;
let sharedResizeConstrainHandler = null;
const sharedShiftedElements = new Set();
const sharedOrgStickyWatched = new WeakSet();
const SHARED_MUTATION_DEBOUNCE_MS = 250;
const SHARED_CONSTRAIN_DEBOUNCE_MS = 150;
const SHARED_HEADER_MAX_DEPTH = 10;
const SHARED_MIN_CONSTRAIN_HEIGHT = 100;

// A transform/filter/etc. on an ancestor makes position:fixed relative to that
// ancestor instead of the viewport, so shifting the ancestor is enough.
function sharedCreatesFixedContainingBlock(el) {
    const cs = getComputedStyle(el);
    if (cs.transform !== "none") return true;
    if (cs.perspective !== "none") return true;
    if (cs.filter !== "none") return true;
    if (cs.backdropFilter !== "none") return true;
    const contain = cs.contain;
    if (contain && contain !== "none" && /\b(paint|layout|strict|content)\b/.test(contain)) {
        return true;
    }
    return false;
}

function sharedHasFixedContainingBlockAncestor(el) {
    let node = el.parentElement;
    while (node) {
        if (!(node instanceof HTMLElement)) break;
        if (sharedCreatesFixedContainingBlock(node)) return true;
        node = node.parentElement;
    }
    return false;
}

function sharedFindNearestShiftedFixedAncestor(el) {
    let node = el.parentElement;
    while (node) {
        if (!(node instanceof HTMLElement)) break;
        if (node.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) {
            const pcs = getComputedStyle(node);
            if (pcs.position === "fixed" || pcs.position === "sticky") return node;
        }
        node = node.parentElement;
    }
    return null;
}

function sharedFindPositionedAncestorOrSelf(el) {
    let node = el;
    while (node) {
        if (node instanceof HTMLElement) {
            const pcs = getComputedStyle(node);
            if (pcs.position === "fixed" || pcs.position === "sticky") return node;
        }
        node = node.parentElement;
    }
    return null;
}

function sharedIsOrgStickyCard(el) {
    return !!el.closest(".org-sticky-top-card, .org-sticky-top-card__container");
}

function sharedRefreshPageFlags() {
    sharedLinkedInJobSearchPage = !!document.querySelector('[componentkey="JobsSearchFilters"]');
}

// Google Sheets maps clicks to cells using its own layout math. Body padding and
// shifting fixed/sticky nodes moves the grid visually but not hit-testing, so
// clicks land ~one taskbar height low (often two rows down).
function sharedIsGoogleSheetsPage() {
    return location.hostname === "docs.google.com" &&
        location.pathname.includes("/spreadsheets/");
}

function sharedShouldSkipPageShifting() {
    return sharedIsGoogleSheetsPage();
}

function sharedIsLinkedInJobSearchPage() {
    if (sharedLinkedInJobSearchPage === null) sharedRefreshPageFlags();
    return sharedLinkedInJobSearchPage;
}

function sharedIsJobSearchFilter(el) {
    if (sharedIsOrgStickyCard(el)) return false;
    if (!sharedIsLinkedInJobSearchPage()) return false;
    if (el.closest('[componentkey="JobsSearchFilters"], [class*="jobs-search"], [class*="search-results"]')) {
        return true;
    }
    // Job-search filter toolbar is sticky/fixed itself; JobsSearchFilters is nested
    // inside it, so closest() on the toolbar element never sees that marker.
    if (el.getAttribute("role") === "toolbar" && el.querySelector('[componentkey="JobsSearchFilters"]')) {
        return true;
    }
    return false;
}

// Secondary sticky rows on job search (filter toolbar, "Jobs based on your
// preferences", results chrome) track the shifted main nav — only top ~0 needs
// an independent bump.
function sharedIsJobSearchSecondaryHeader(el, cs) {
    if (!sharedIsLinkedInJobSearchPage()) return false;
    const top = sharedGetEffectiveTop(el, cs);
    return top === null || top >= SHARED_TASKBAR.HEIGHT - 4;
}

function sharedIsStuckInHeaderZone(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return false;
    const min = SHARED_TASKBAR.HEIGHT - 4;
    const max = SHARED_TASKBAR.MAX_SHIFT_TOP + SHARED_TASKBAR.HEIGHT;
    return rect.top >= min && rect.top <= max;
}

function sharedGetEffectiveTop(el, cs) {
    cs = cs || getComputedStyle(el);
    let top = parseFloat(cs.top);
    if (!isNaN(top) && cs.top !== "auto") return top;

    const inset = parseFloat(cs.getPropertyValue("inset-block-start"));
    if (!isNaN(inset) && cs.getPropertyValue("inset-block-start") !== "auto") return inset;

    if (sharedIsOrgStickyCard(el) && sharedIsStuckInHeaderZone(el)) {
        const rectTop = Math.round(el.getBoundingClientRect().top);
        if (el.hasAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR)) {
            return sharedGetShiftBaseTop(el) + SHARED_TASKBAR.HEIGHT;
        }
        return rectTop;
    }

    if (sharedIsLikelyPrimaryNav(el, cs)) {
        const rectTop = Math.round(el.getBoundingClientRect().top);
        if (el.hasAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR)) {
            return sharedGetShiftBaseTop(el) + SHARED_TASKBAR.HEIGHT;
        }
        return rectTop < SHARED_TASKBAR.MAX_SHIFT_TOP ? rectTop : 0;
    }

    if (sharedIsTopViewportChrome(el, cs)) {
        const rectTop = Math.round(el.getBoundingClientRect().top);
        if (el.hasAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR)) {
            return sharedGetShiftBaseTop(el) + SHARED_TASKBAR.HEIGHT;
        }
        return rectTop <= SHARED_TASKBAR.MAX_SHIFT_TOP ? rectTop : 0;
    }
    return null;
}

function sharedIsLikelyPrimaryNav(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return false;
    if (sharedIsOrgStickyCard(el)) return false;
    if (sharedIsJobSearchFilter(el)) return false;
    if (sharedIsJobSearchSecondaryHeader(el, cs)) return false;
    if (el.closest("header, [role=\"banner\"], #global-nav, .global-nav")) return true;
    if (el.closest("shreddit-header, reddit-header")) return true;
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.top <= SHARED_TASKBAR.HEIGHT && rect.width > window.innerWidth * 0.4;
}

// Full-width bar pinned to the top band of the viewport (not a anchored popup).
function sharedIsTopViewportChrome(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return false;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width < window.innerWidth * 0.4) return false;
    return rect.top >= 0 && rect.top <= SHARED_TASKBAR.HEIGHT + 8;
}

// Full-width top chrome we still shift (nav, stacked sub-headers). Narrow overlays
// and menus are usually app-positioned relative to already-shifted layout.
function sharedIsViewportHeaderCandidate(el, cs, rect) {
    cs = cs || getComputedStyle(el);
    if (sharedIsLikelyPrimaryNav(el, cs)) return true;
    rect = rect || el.getBoundingClientRect();
    if (rect.height <= 0) return false;
    return rect.top < SHARED_TASKBAR.MAX_SHIFT_TOP && rect.width > window.innerWidth * 0.4;
}

// Popups/menus positioned below the taskbar zone (often via anchor getBoundingClientRect
// after body padding or a shifted header) — shifting again double-offsets them.
function sharedIsAppPositionedOverlay(el, cs) {
    if (sharedIsViewportHeaderCandidate(el, cs)) return false;
    if (sharedIsTopViewportChrome(el, cs)) return false;

    const top = sharedGetEffectiveTop(el, cs);
    if (top !== null) return top >= SHARED_TASKBAR.HEIGHT - 4;

    return el.getBoundingClientRect().top >= SHARED_TASKBAR.HEIGHT - 4;
}

function sharedRectsLookAnchoredToReference(popupRect, refRect) {
    const vMargin = 96;
    const overlap = Math.min(popupRect.right, refRect.right) -
        Math.max(popupRect.left, refRect.left);
    if (overlap <= Math.min(popupRect.width, refRect.width) * 0.15) return false;
    if (Math.abs(popupRect.top - refRect.bottom) <= vMargin) return true;
    if (popupRect.top >= refRect.top - 8 && popupRect.top <= refRect.bottom + vMargin) {
        return true;
    }
    return false;
}

function sharedFindAnchoredShiftedReference(el) {
    if (sharedIsViewportHeaderCandidate(el, getComputedStyle(el))) return null;
    if (sharedIsTopViewportChrome(el, getComputedStyle(el))) return null;

    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return null;

    for (const shifted of sharedShiftedElements) {
        if (!shifted.isConnected || shifted === el) continue;
        if (shifted.contains(el)) continue;

        const refRect = shifted.getBoundingClientRect();
        if (refRect.height <= 0) continue;
        if (sharedRectsLookAnchoredToReference(rect, refRect)) return shifted;
    }
    return null;
}

function sharedFindLinkedInGlobalNav() {
    if (!/linkedin\.com/i.test(location.hostname)) return null;
    const selectors = [
        "#global-nav",
        "header.global-nav",
        "header[role=\"banner\"]",
        ".global-nav__nav",
        "nav[aria-label=\"Primary\"]",
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) {
            return sharedFindPositionedAncestorOrSelf(el) || el;
        }
    }
    return null;
}

function sharedFindRedditHeader() {
    if (!/reddit\.com/i.test(location.hostname)) return null;
    const selectors = [
        "shreddit-header",
        "reddit-header",
        "[data-testid=\"reddit-header\"]",
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el instanceof HTMLElement) {
            return sharedFindPositionedAncestorOrSelf(el) || el;
        }
    }
    return null;
}

// Cheap upkeep for the main nav and already-tracked headers — not a full-page rescan.
function sharedShiftPrimaryHeaders() {
    const nav = sharedFindLinkedInGlobalNav() || sharedFindRedditHeader();
    if (nav) sharedShiftFixedElement(nav);
    for (const el of sharedShiftedElements) {
        if (el.isConnected) sharedShiftFixedElement(el);
    }
}

function sharedIsNavChrome(el) {
    return !!el.closest("header, [role=\"banner\"], #global-nav, .global-nav");
}

function sharedFindOutermostOverflowingAncestor(el, viewportH) {
    let current = el;
    while (current.parentElement && current.parentElement !== document.body) {
        const parent = current.parentElement;
        const pr = parent.getBoundingClientRect();
        const cr = current.getBoundingClientRect();
        if (pr.bottom > viewportH + 2 && Math.abs(pr.height - cr.height) < 8) {
            current = parent;
        } else {
            break;
        }
    }
    return current;
}

function sharedRestoreViewportConstraint(el) {
    const prevMax = el.getAttribute(SHARED_TASKBAR.PREV_MAX_HEIGHT_ATTR);
    el.style.removeProperty("max-height");
    if (prevMax) el.style.setProperty("max-height", prevMax);
    el.removeAttribute(SHARED_TASKBAR.PREV_MAX_HEIGHT_ATTR);

    const prevMin = el.getAttribute(SHARED_TASKBAR.PREV_MIN_HEIGHT_ATTR);
    el.style.removeProperty("min-height");
    if (prevMin) el.style.setProperty("min-height", prevMin);
    el.removeAttribute(SHARED_TASKBAR.PREV_MIN_HEIGHT_ATTR);

    const prevHeight = el.getAttribute(SHARED_TASKBAR.PREV_HEIGHT_ATTR);
    el.style.removeProperty("height");
    if (prevHeight) el.style.setProperty("height", prevHeight);
    el.removeAttribute(SHARED_TASKBAR.PREV_HEIGHT_ATTR);

    const prevOverflowY = el.getAttribute(SHARED_TASKBAR.PREV_OVERFLOW_Y_ATTR);
    el.style.removeProperty("overflow-y");
    if (prevOverflowY) el.style.setProperty("overflow-y", prevOverflowY);
    el.removeAttribute(SHARED_TASKBAR.PREV_OVERFLOW_Y_ATTR);

    el.removeAttribute(SHARED_TASKBAR.CONSTRAINED_ATTR);
}

function sharedApplyViewportConstraint(el, maxH, cs) {
    cs = cs || getComputedStyle(el);
    if (!el.hasAttribute(SHARED_TASKBAR.PREV_MAX_HEIGHT_ATTR)) {
        el.setAttribute(SHARED_TASKBAR.PREV_MAX_HEIGHT_ATTR, el.style.getPropertyValue("max-height") || "");
    }
    el.style.setProperty("max-height", maxH + "px", "important");

    const minH = parseFloat(cs.minHeight);
    if (!isNaN(minH) && minH > maxH) {
        if (!el.hasAttribute(SHARED_TASKBAR.PREV_MIN_HEIGHT_ATTR)) {
            el.setAttribute(SHARED_TASKBAR.PREV_MIN_HEIGHT_ATTR, el.style.getPropertyValue("min-height") || "");
        }
        el.style.setProperty("min-height", "0px", "important");
    }

    const height = parseFloat(cs.height);
    if (!isNaN(height) && height > maxH) {
        if (!el.hasAttribute(SHARED_TASKBAR.PREV_HEIGHT_ATTR)) {
            el.setAttribute(SHARED_TASKBAR.PREV_HEIGHT_ATTR, el.style.getPropertyValue("height") || "");
        }
        el.style.setProperty("height", maxH + "px", "important");
    }

    if (cs.overflowY === "visible" || cs.overflowY === "clip") {
        if (!el.hasAttribute(SHARED_TASKBAR.PREV_OVERFLOW_Y_ATTR)) {
            el.setAttribute(SHARED_TASKBAR.PREV_OVERFLOW_Y_ATTR, el.style.getPropertyValue("overflow-y") || "");
        }
        el.style.setProperty("overflow-y", "auto", "important");
    }

    el.setAttribute(SHARED_TASKBAR.CONSTRAINED_ATTR, "1");
}

function sharedConstrainElementToViewport(el, viewportH) {
    if (!(el instanceof HTMLElement)) return;
    if (el.id === SHARED_TASKBAR.HOST_ID || sharedIsNavChrome(el)) return;

    const rect = el.getBoundingClientRect();
    if (rect.height < SHARED_MIN_CONSTRAIN_HEIGHT || rect.top >= viewportH) return;

    const overflow = rect.bottom - viewportH;
    if (overflow <= 2) {
        if (el.hasAttribute(SHARED_TASKBAR.CONSTRAINED_ATTR)) sharedRestoreViewportConstraint(el);
        return;
    }

    const maxH = Math.max(SHARED_MIN_CONSTRAIN_HEIGHT, Math.floor(viewportH - rect.top));
    const cs = getComputedStyle(el);
    const currentMax = parseFloat(cs.maxHeight);
    if (!isNaN(currentMax) && currentMax <= maxH + 1 && el.hasAttribute(SHARED_TASKBAR.CONSTRAINED_ATTR)) return;

    sharedApplyViewportConstraint(el, maxH, cs);
}

function sharedCollectViewportConstraintCandidates() {
    const candidates = new Set();
    for (const el of sharedShiftedElements) {
        if (el.isConnected) candidates.add(el);
    }
    document.querySelectorAll("[" + SHARED_TASKBAR.CONSTRAINED_ATTR + "]").forEach((el) => candidates.add(el));
    document.querySelectorAll('[style*="vh"]').forEach((el) => candidates.add(el));

    const main = document.querySelector("main, [role=\"main\"]");
    if (main instanceof HTMLElement) {
        const stack = [[main, 0]];
        while (stack.length) {
            const pair = stack.pop();
            const node = pair[0];
            const depth = pair[1];
            if (!(node instanceof HTMLElement) || depth > 4) continue;
            candidates.add(node);
            for (const child of node.children) stack.push([child, depth + 1]);
        }
    }
    return candidates;
}

// Job-search panels often use 100vh / calc(100vh - …) and overflow once we shift headers.
function sharedConstrainViewportOverflow() {
    if (!sharedIsLinkedInJobSearchPage()) return;
    const viewportH = window.innerHeight;
    const roots = new Set();
    for (const el of sharedCollectViewportConstraintCandidates()) {
        if (!(el instanceof HTMLElement) || sharedIsNavChrome(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= viewportH + 2 || rect.height < SHARED_MIN_CONSTRAIN_HEIGHT) continue;
        roots.add(sharedFindOutermostOverflowingAncestor(el, viewportH));
    }
    for (const el of roots) sharedConstrainElementToViewport(el, viewportH);
}

function sharedScheduleViewportConstrain() {
    if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) return;
    if (sharedConstrainTimer) return;
    sharedConstrainTimer = setTimeout(() => {
        sharedConstrainTimer = null;
        sharedConstrainViewportOverflow();
    }, SHARED_CONSTRAIN_DEBOUNCE_MS);
}

function sharedApplyTop(el, topPx) {
    el.style.setProperty("top", topPx + "px", "important");
}

function sharedFindPositionedForRoot(root) {
    if (!(root instanceof HTMLElement)) return null;
    const pcs = getComputedStyle(root);
    if (pcs.position === "fixed" || pcs.position === "sticky") return root;
    for (const child of root.children) {
        if (!(child instanceof HTMLElement)) continue;
        const ccs = getComputedStyle(child);
        if (ccs.position === "fixed" || ccs.position === "sticky") return child;
    }
    return sharedFindPositionedAncestorOrSelf(root);
}

function sharedEnsureOrgStickyObserver() {
    if (sharedOrgStickyObserver) return;
    sharedOrgStickyObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const positioned = sharedFindPositionedForRoot(entry.target);
            if (positioned) sharedShiftFixedElement(positioned);
        }
    }, {
        rootMargin: (-SHARED_TASKBAR.HEIGHT) + "px 0px 0px 0px",
        threshold: [0, 0.01, 1],
    });
}

function sharedWatchOrgStickyRoot(root) {
    if (!(root instanceof HTMLElement) || sharedOrgStickyWatched.has(root)) return;
    sharedEnsureOrgStickyObserver();
    sharedOrgStickyWatched.add(root);
    sharedOrgStickyObserver.observe(root);
    const positioned = sharedFindPositionedForRoot(root);
    if (positioned) sharedShiftFixedElement(positioned);
}

function sharedDiscoverOrgStickyCards(root) {
    if (!(root instanceof HTMLElement)) return;
    if (root.matches(".org-sticky-top-card, .org-sticky-top-card__container")) {
        sharedWatchOrgStickyRoot(root);
    }
    if (!root.querySelectorAll) return;
    root.querySelectorAll(".org-sticky-top-card, .org-sticky-top-card__container").forEach(sharedWatchOrgStickyRoot);
}

function sharedGetShiftBaseTop(el) {
    const base = parseFloat(el.getAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR));
    return isNaN(base) ? 0 : base;
}

function sharedGetShiftRowHeight(el) {
    const stored = parseFloat(el.getAttribute(SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR));
    if (!isNaN(stored) && stored > 0) return stored;
    return el.getBoundingClientRect().height;
}

// Keep the smallest height seen for a shifted header row so an opened sub-bar
// does not inflate the stored value and block re-shift after scroll up/down.
function sharedRecordShiftRowHeight(el) {
    const measured = Math.round(el.getBoundingClientRect().height);
    if (measured <= 0) return;
    const prev = parseFloat(el.getAttribute(SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR));
    if (isNaN(prev) || measured < prev) {
        el.setAttribute(SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR, String(measured));
    }
}

// In-header chrome (job-search filter pills) uses a small computed top inside
// the shifted row. Stacked sub-headers (LinkedIn company bar) use top at/near
// the row's original height and need their own bump.
function sharedIsInShiftedHeaderBand(el, ancestor) {
    const top = parseFloat(getComputedStyle(el).top);
    if (isNaN(top)) return true;

    // Company-style sub-navs pin at ~nav-height (50px+). Catch these even when
    // the stored row height was inflated by an already-open sub-bar.
    if (top >= SHARED_TASKBAR.HEIGHT - 10) return false;

    const rowHeight = sharedGetShiftRowHeight(ancestor);
    return top < rowHeight - 4;
}

// Skip when the element already moves with a shifted fixed/sticky ancestor.
function sharedShouldSkipShift(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return true;

    if (sharedIsOrgStickyCard(el)) return false;
    if (sharedIsJobSearchFilter(el)) return true;
    if (sharedIsJobSearchSecondaryHeader(el, cs)) return true;
    if (sharedIsAppPositionedOverlay(el, cs)) return true;
    if (sharedFindAnchoredShiftedReference(el)) return true;

    const ancestor = sharedFindNearestShiftedFixedAncestor(el);
    if (!ancestor) return false;

    if (sharedHasFixedContainingBlockAncestor(el)) return true;
    if (sharedIsInShiftedHeaderBand(el, ancestor)) return true;
    if (!sharedIsViewportHeaderCandidate(el, cs)) return true;
    return false;
}

function sharedRestoreShiftedElement(el) {
    const prev = el.getAttribute(SHARED_TASKBAR.SHIFTED_ATTR);
    el.style.removeProperty("top");
    if (prev) el.style.setProperty("top", prev);
    el.removeAttribute(SHARED_TASKBAR.SHIFTED_ATTR);
    el.removeAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR);
    sharedShiftedElements.delete(el);
}

function sharedShiftFixedElement(el, cs) {
    if (!(el instanceof HTMLElement)) return;
    if (el.id === SHARED_TASKBAR.HOST_ID) return;
    cs = cs || getComputedStyle(el);
    if (sharedShouldSkipShift(el, cs)) {
        if (el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) sharedRestoreShiftedElement(el);
        return;
    }

    if (cs.position !== "fixed" && cs.position !== "sticky") {
        // Page stopped sticking this element; restore so we can shift again later.
        if (el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) sharedRestoreShiftedElement(el);
        return;
    }

    if (sharedIsOrgStickyCard(el) && !sharedIsStuckInHeaderZone(el)) {
        if (el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) sharedRestoreShiftedElement(el);
        return;
    }

    if (el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) {
        // Always restore to the original base + bar height. Do not add HEIGHT
        // to the current computed top (that double-shifts after Google scroll).
        const target = sharedGetShiftBaseTop(el) + SHARED_TASKBAR.HEIGHT;
        const current = sharedGetEffectiveTop(el, cs);
        if (current === null || Math.abs(current - target) > 0.5) {
            sharedApplyTop(el, target);
        }
        if (sharedGetShiftBaseTop(el) < SHARED_TASKBAR.HEIGHT) {
            sharedRecordShiftRowHeight(el);
        }
        return;
    }

    const top = sharedGetEffectiveTop(el, cs);
    if (top === null || top >= SHARED_TASKBAR.MAX_SHIFT_TOP) return;

    el.setAttribute(SHARED_TASKBAR.SHIFTED_ATTR, el.style.getPropertyValue("top") || "");
    el.setAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR, String(top));
    sharedApplyTop(el, top + SHARED_TASKBAR.HEIGHT);
    sharedShiftedElements.add(el);
    if (top < SHARED_TASKBAR.HEIGHT) sharedRecordShiftRowHeight(el);
}

function sharedShiftElementTree(root) {
    if (!(root instanceof HTMLElement) && !(root instanceof DocumentFragment)) return;

    const queue = [root];
    const seenRoots = new Set([root]);

    while (queue.length) {
        const node = queue.shift();
        if (!(node instanceof HTMLElement) && !(node instanceof DocumentFragment)) continue;

        if (node instanceof HTMLElement) sharedShiftFixedElement(node);

        if (!node.querySelectorAll) continue;
        node.querySelectorAll("*").forEach((el) => {
            sharedShiftFixedElement(el);
            if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
                seenRoots.add(el.shadowRoot);
                queue.push(el.shadowRoot);
            }
        });
    }
}

function sharedShiftWithin(root) {
    sharedShiftElementTree(root);
    if (document.getElementById(SHARED_TASKBAR.HOST_ID)) sharedDiscoverOrgStickyCards(root);
}

// Cheap filter — no getBoundingClientRect (avoids layout thrash on feed mutations).
function sharedIsHeaderMutationCandidate(el) {
    if (el.id === SHARED_TASKBAR.HOST_ID) return false;
    if (el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) return true;
    if (el.closest(".org-sticky-top-card, .org-sticky-top-card__container, header, [role=\"banner\"], [role=\"toolbar\"]")) {
        return true;
    }
    if (el.hasAttribute("componentkey")) return true;
    const style = el.getAttribute("style");
    if (style && /position\s*:\s*(fixed|sticky)/i.test(style)) return true;
    let depth = 0;
    let node = el;
    while (node && node !== document.body) {
        depth++;
        node = node.parentElement;
    }
    return depth <= SHARED_HEADER_MAX_DEPTH;
}

function sharedProcessMutationBatch(mutations) {
    const seen = new Set();
    for (const m of mutations) {
        if (m.type === "attributes") {
            const el = m.target;
            if (!(el instanceof HTMLElement) || seen.has(el)) continue;
            if (!sharedIsHeaderMutationCandidate(el)) continue;
            seen.add(el);
            sharedShiftFixedElement(el);
        } else {
            for (const node of m.addedNodes) {
                if (!(node instanceof HTMLElement)) continue;
                sharedDiscoverOrgStickyCards(node);
                if (sharedIsHeaderMutationCandidate(node)) sharedShiftFixedElement(node);
            }
        }
    }
    sharedShiftPrimaryHeaders();
    sharedScheduleViewportConstrain();
}

function sharedStartShifting() {
    sharedRefreshPageFlags();

    if (sharedShouldSkipPageShifting()) {
        // Keep the fixed taskbar overlay only; do not pad or shift the page.
        return;
    }

    sharedShiftWithin(document.body);
    sharedShiftPrimaryHeaders();
    sharedScheduleViewportConstrain();
    document.body.style.paddingTop = SHARED_TASKBAR.HEIGHT + "px";

    if (sharedTaskbarObserver) return;
    sharedTaskbarObserver = new MutationObserver((mutations) => {
        // If another extension removed the host, stop and clean up after ourselves.
        if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) {
            sharedStopShifting();
            return;
        }
        if (!sharedPendingMutations) sharedPendingMutations = [];
        sharedPendingMutations.push.apply(sharedPendingMutations, mutations);
        if (sharedMutationTimer) return;
        sharedMutationTimer = setTimeout(() => {
            sharedMutationTimer = null;
            const batch = sharedPendingMutations;
            sharedPendingMutations = null;
            if (!batch || !batch.length) return;
            sharedRefreshPageFlags();
            sharedProcessMutationBatch(batch);
        }, SHARED_MUTATION_DEBOUNCE_MS);
    });
    sharedTaskbarObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
    });

    if (!sharedResizeConstrainHandler) {
        sharedResizeConstrainHandler = () => sharedScheduleViewportConstrain();
        window.addEventListener("resize", sharedResizeConstrainHandler, { passive: true });
    }
}

function sharedStopShifting() {
    if (sharedMutationTimer) {
        clearTimeout(sharedMutationTimer);
        sharedMutationTimer = null;
    }
    if (sharedConstrainTimer) {
        clearTimeout(sharedConstrainTimer);
        sharedConstrainTimer = null;
    }
    if (sharedResizeConstrainHandler) {
        window.removeEventListener("resize", sharedResizeConstrainHandler);
        sharedResizeConstrainHandler = null;
    }
    sharedPendingMutations = null;
    sharedLinkedInJobSearchPage = null;
    sharedShiftedElements.clear();
    if (sharedOrgStickyObserver) {
        sharedOrgStickyObserver.disconnect();
        sharedOrgStickyObserver = null;
    }
    if (sharedTaskbarObserver) {
        sharedTaskbarObserver.disconnect();
        sharedTaskbarObserver = null;
    }
    document.body.style.paddingTop = "0";
    document.querySelectorAll("[" + SHARED_TASKBAR.SHIFTED_ATTR + "]").forEach(sharedRestoreShiftedElement);
    document.querySelectorAll("[" + SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR + "]").forEach((el) => {
        el.removeAttribute(SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR);
    });
    document.querySelectorAll("[" + SHARED_TASKBAR.CONSTRAINED_ATTR + "]").forEach(sharedRestoreViewportConstraint);
}

// ---- host lifecycle --------------------------------------------------------
// Build the shadow DOM with createElement (not innerHTML) so static analyzers
// don't flag unsafe HTML assignment; markup is still entirely hardcoded constants.
function sharedBuildShadowDom(shadow) {
    const style = document.createElement("style");
    style.textContent =
        ":host{display:block;width:100%;height:100%;}" +
        ".bar{display:flex;align-items:center;gap:8px;height:100%;padding:0 12px;" +
        "box-sizing:border-box;font-family:system-ui,sans-serif;}" +
        "." + SHARED_TASKBAR.SLOTS_CLASS + "{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;}" +
        "." + SHARED_TASKBAR.SLOT_CLASS + "{display:flex;align-items:center;gap:6px;flex:0 0 auto;}" +
        "button{padding:6px 12px;font-size:13px;cursor:pointer;}";

    const bar = document.createElement("div");
    bar.className = "bar";

    const slots = document.createElement("div");
    slots.className = SHARED_TASKBAR.SLOTS_CLASS;

    bar.appendChild(slots);
    shadow.appendChild(style);
    shadow.appendChild(bar);
}

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
    sharedBuildShadowDom(shadow);

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
