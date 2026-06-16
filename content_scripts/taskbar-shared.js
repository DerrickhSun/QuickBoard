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
    EVT_PAGE_NAV: "shared-taskbar:page-nav",
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
let sharedSpaNavInstalled = false;
let sharedSlotIntegrityObserver = null;
let sharedSlotIntegrityConfig = null;
let sharedRegisteringSlot = false;
let sharedTaskbarOpenAllowed = false;
let sharedOpenEpoch = 0;
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
// an independent bump. Must not call sharedGetEffectiveTop (that calls
// sharedIsLikelyPrimaryNav, which calls back here).
function sharedIsJobSearchSecondaryHeader(el, cs) {
    if (!sharedIsLinkedInJobSearchPage()) return false;
    cs = cs || getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return false;

    const rect = el.getBoundingClientRect();
    if (rect.height > 0) {
        if (rect.top >= SHARED_TASKBAR.HEIGHT - 4) return true;
        return false;
    }

    let top = parseFloat(cs.top);
    if (!isNaN(top) && cs.top !== "auto") {
        return top >= SHARED_TASKBAR.HEIGHT - 4;
    }

    const inset = parseFloat(cs.getPropertyValue("inset-block-start"));
    if (!isNaN(inset) && cs.getPropertyValue("inset-block-start") !== "auto") {
        return inset >= SHARED_TASKBAR.HEIGHT - 4;
    }

    // Unknown top — treat as secondary (prior sharedGetEffectiveTop null path).
    return true;
}

function sharedIsStuckInHeaderZone(el) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return false;
    const min = SHARED_TASKBAR.HEIGHT - 4;
    const max = SHARED_TASKBAR.MAX_SHIFT_TOP + SHARED_TASKBAR.HEIGHT;
    return rect.top >= min && rect.top <= max;
}

// When body padding has already moved in-flow sticky chrome to the taskbar band,
// rect.top ≈ HEIGHT but the CSS top base is still 0 — do not treat rect as base.
function sharedRectTopToShiftBase(el, cs, rectTop) {
    cs = cs || getComputedStyle(el);
    if (cs.position === "sticky" && rectTop >= SHARED_TASKBAR.HEIGHT - 4 &&
        rectTop <= SHARED_TASKBAR.HEIGHT + 12) {
        return 0;
    }
    if (rectTop <= SHARED_TASKBAR.HEIGHT + 8) return rectTop;
    if (cs.position === "sticky") return 0;
    return rectTop;
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
        const base = sharedRectTopToShiftBase(el, cs, rectTop);
        return base < SHARED_TASKBAR.MAX_SHIFT_TOP ? base : 0;
    }

    if (sharedIsTopViewportChrome(el, cs)) {
        const rectTop = Math.round(el.getBoundingClientRect().top);
        if (el.hasAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR)) {
            return sharedGetShiftBaseTop(el) + SHARED_TASKBAR.HEIGHT;
        }
        const base = sharedRectTopToShiftBase(el, cs, rectTop);
        return base <= SHARED_TASKBAR.MAX_SHIFT_TOP ? base : 0;
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

function sharedOverflowCreatesScrollport(cs) {
    return cs.overflow === "auto" || cs.overflow === "scroll" || cs.overflow === "overlay" ||
        cs.overflowY === "auto" || cs.overflowY === "scroll" || cs.overflowY === "overlay";
}

// Nearest ancestor whose overflow establishes the stick container for position:sticky.
function sharedFindStickyScrollport(el) {
    let node = el.parentElement;
    while (node) {
        if (!(node instanceof HTMLElement)) break;
        if (sharedOverflowCreatesScrollport(getComputedStyle(node))) return node;
        node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
}

// Sticky in a nested scrollport (e.g. SPA main panel) is offset by body padding alone.
// Sticky on the document scrollport (e.g. forum nav) needs top so its stick point clears
// our bar — padding does not change where sticky;top:0 pins when the page scrolls.
function sharedStickyUsesDocumentScroll(el) {
    const scrollport = sharedFindStickyScrollport(el);
    return scrollport === document.body ||
        scrollport === document.documentElement ||
        (document.scrollingElement && scrollport === document.scrollingElement);
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

// Stacked sub-headers (e.g. LinkedIn company bar) pin below the main row with an
// explicit top/inset and need their own bump even inside an already-shifted ancestor.
function sharedIsStackedSubHeaderRow(el, cs) {
    if (sharedIsOrgStickyCard(el)) return true;

    cs = cs || getComputedStyle(el);
    let top = parseFloat(cs.top);
    if (!isNaN(top) && cs.top !== "auto" && top >= SHARED_TASKBAR.HEIGHT - 4) return true;

    const inset = parseFloat(cs.getPropertyValue("inset-block-start"));
    if (!isNaN(inset) && cs.getPropertyValue("inset-block-start") !== "auto" &&
        inset >= SHARED_TASKBAR.HEIGHT - 4) {
        return true;
    }
    return false;
}

// Skip when a shifted fixed/sticky ancestor already moves this element. The only
// descendant exception is a stacked sub-row with explicit top/inset ≥ nav height.
function sharedShouldSkipShift(el, cs) {
    cs = cs || getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") return true;

    if (sharedIsOrgStickyCard(el)) return false;
    if (sharedIsJobSearchFilter(el)) return true;
    if (sharedIsJobSearchSecondaryHeader(el, cs)) return true;
    if (sharedIsAppPositionedOverlay(el, cs)) return true;
    if (sharedFindAnchoredShiftedReference(el)) return true;

    // Nested scrollport: body padding is enough. Document scrollport: set top so the
    // stick point clears our bar when the page scrolls (forum navs, etc.).
    if (cs.position === "sticky" && !sharedIsStackedSubHeaderRow(el, cs)) {
        if (!sharedStickyUsesDocumentScroll(el)) return true;
    }

    if (sharedHasFixedContainingBlockAncestor(el)) return true;

    const ancestor = sharedFindNearestShiftedFixedAncestor(el);
    if (ancestor && !sharedIsStackedSubHeaderRow(el, cs)) return true;

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
        let base = sharedGetShiftBaseTop(el);
        if (cs.position === "sticky" && base >= SHARED_TASKBAR.HEIGHT - 4 &&
            base <= SHARED_TASKBAR.HEIGHT + 12) {
            const prevTop = el.getAttribute(SHARED_TASKBAR.SHIFTED_ATTR) || "";
            if (prevTop === "" || prevTop === "0" || prevTop === "0px") {
                base = 0;
                el.setAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR, "0");
            }
        }
        const target = base + SHARED_TASKBAR.HEIGHT;
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

    const targetTop = top + SHARED_TASKBAR.HEIGHT;
    const rectTop = Math.round(el.getBoundingClientRect().top);
    if (Math.abs(rectTop - targetTop) <= 3) {
        // Already at the intended visual offset (e.g. body padding) — track only.
        if (!el.hasAttribute(SHARED_TASKBAR.SHIFTED_ATTR)) {
            el.setAttribute(SHARED_TASKBAR.SHIFTED_ATTR, el.style.getPropertyValue("top") || "");
            el.setAttribute(SHARED_TASKBAR.SHIFT_BASE_ATTR, String(top));
            sharedShiftedElements.add(el);
        }
        return;
    }

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
    sharedEnsureBodyPadding();
}

function sharedEnsureBodyPadding() {
    if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) return;
    if (sharedShouldSkipPageShifting()) return;

    const pad = parseFloat(getComputedStyle(document.body).paddingTop);
    if (isNaN(pad) || pad < SHARED_TASKBAR.HEIGHT - 1) {
        document.body.style.setProperty(
            "padding-top", SHARED_TASKBAR.HEIGHT + "px", "important"
        );
    }
}

function sharedPruneDisconnectedShiftedElements() {
    for (const el of sharedShiftedElements) {
        if (!el.isConnected) sharedShiftedElements.delete(el);
    }
}

function sharedApplyPageShift() {
    sharedRefreshPageFlags();

    if (sharedShouldSkipPageShifting()) return;

    sharedPruneDisconnectedShiftedElements();
    sharedShiftWithin(document.body);
    sharedShiftPrimaryHeaders();
    sharedScheduleViewportConstrain();
    if (document.getElementById(SHARED_TASKBAR.HOST_ID)) {
        document.body.style.setProperty(
            "padding-top", SHARED_TASKBAR.HEIGHT + "px", "important"
        );
    }
}

function sharedRescanAfterOpen() {
    if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) return;
    sharedLinkedInJobSearchPage = null;
    sharedApplyPageShift();
    sharedEnsureBodyPadding();
}

function sharedStartShifting() {
    if (sharedShouldSkipPageShifting()) return;

    sharedApplyPageShift();

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
    sharedStopSlotIntegrityObserver();
    document.body.style.removeProperty("padding-top");
    document.querySelectorAll("[" + SHARED_TASKBAR.SHIFTED_ATTR + "]").forEach(sharedRestoreShiftedElement);
    document.querySelectorAll("[" + SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR + "]").forEach((el) => {
        el.removeAttribute(SHARED_TASKBAR.SHIFT_ROW_HEIGHT_ATTR);
    });
    document.querySelectorAll("[" + SHARED_TASKBAR.CONSTRAINED_ATTR + "]").forEach(sharedRestoreViewportConstraint);
}

// ---- host lifecycle --------------------------------------------------------
// Open shadow root for the bar interior. LinkedIn job search often clears
// foreign light-DOM children under <html>; shadow content survives that.
// Any cooperating extension can still reach slots via host.shadowRoot.
function sharedApplyHostChromeStyles(host) {
    const h = SHARED_TASKBAR.HEIGHT + "px";
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "0", "important");
    host.style.setProperty("left", "0", "important");
    host.style.setProperty("width", "100%", "important");
    host.style.setProperty("height", h, "important");
    host.style.setProperty("max-height", h, "important");
    host.style.setProperty("box-sizing", "border-box", "important");
    host.style.setProperty("border-bottom", "2px solid #000", "important");
    host.style.setProperty("background-color", "#f0f0f0", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("overflow", "hidden", "important");
}

function sharedGetTaskbarRoot(host) {
    if (!host) return null;
    if (host.shadowRoot) return host.shadowRoot;
    host.replaceChildren();
    return host.attachShadow({ mode: "open" });
}

function sharedQueryTaskbar(host, selector) {
    const root = host && host.shadowRoot;
    return root ? root.querySelector(selector) : null;
}

function sharedHostStyleSheet() {
    const h = SHARED_TASKBAR.HEIGHT + "px";
    return (
        ":host{display:block!important;width:100%!important;height:100%!important;" +
        "max-height:" + h + "!important;box-sizing:border-box!important;" +
        "overflow:hidden!important;visibility:visible!important;opacity:1!important;}" +
        ".bar{display:flex!important;align-items:center!important;gap:8px!important;" +
        "height:100%!important;max-height:" + h + "!important;padding:0 12px!important;" +
        "box-sizing:border-box!important;font-family:system-ui,sans-serif!important;" +
        "visibility:visible!important;overflow:hidden!important;" +
        "background-color:#f0f0f0!important;}" +
        "." + SHARED_TASKBAR.SLOTS_CLASS +
        "{display:flex!important;align-items:center!important;gap:8px!important;flex:1 1 auto!important;" +
        "min-width:0!important;visibility:visible!important;overflow:visible!important;}" +
        "." + SHARED_TASKBAR.SLOT_CLASS +
        "{display:flex!important;align-items:center!important;gap:6px!important;flex:0 0 auto!important;" +
        "visibility:visible!important;overflow:visible!important;}" +
        "button{display:inline-block!important;visibility:visible!important;" +
        "opacity:1!important;padding:6px 12px!important;font-size:13px!important;cursor:pointer!important;}"
    );
}

function sharedBuildHostDom(host) {
    sharedApplyHostChromeStyles(host);
    const root = sharedGetTaskbarRoot(host);

    let style = root.querySelector("style[data-shared-taskbar]");
    if (!style) {
        style = document.createElement("style");
        style.setAttribute("data-shared-taskbar", "1");
        root.appendChild(style);
    }
    style.textContent = sharedHostStyleSheet();

    let bar = root.querySelector(".bar");
    if (!bar) {
        bar = document.createElement("div");
        bar.className = "bar";
        root.appendChild(bar);
    }

    let slots = bar.querySelector("." + SHARED_TASKBAR.SLOTS_CLASS);
    if (!slots) {
        slots = document.createElement("div");
        slots.className = SHARED_TASKBAR.SLOTS_CLASS;
        bar.appendChild(slots);
    }
}

function sharedEnsureHostStructure(host) {
    if (!host.shadowRoot) sharedGetTaskbarRoot(host);
    if (sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS)) return;
    sharedBuildHostDom(host);
}

function sharedGetSlot(extKey) {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return null;
    return sharedQueryTaskbar(host, sharedSlotSelector(extKey));
}

function sharedSlotHasButtons(extKey) {
    const slot = sharedGetSlot(extKey);
    return !!(slot && slot.querySelector("button"));
}

function sharedStopSlotIntegrityObserver() {
    if (sharedSlotIntegrityObserver) {
        sharedSlotIntegrityObserver.disconnect();
        sharedSlotIntegrityObserver = null;
    }
    sharedSlotIntegrityConfig = null;
}

function sharedWatchSlotIntegrity(extKey, buildFn, order) {
    sharedSlotIntegrityConfig = { extKey, buildFn, order };
    sharedStopSlotIntegrityObserver();

    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return;

    const root = sharedGetTaskbarRoot(host);
    sharedSlotIntegrityObserver = new MutationObserver(() => {
        if (sharedRegisteringSlot) return;

        const currentHost = document.getElementById(SHARED_TASKBAR.HOST_ID);
        if (!currentHost || !sharedSlotIntegrityConfig) {
            sharedStopSlotIntegrityObserver();
            return;
        }

        if (!sharedQueryTaskbar(currentHost, "." + SHARED_TASKBAR.SLOTS_CLASS)) {
            sharedBuildHostDom(currentHost);
        }

        if (!sharedTaskbarOpenAllowed) return;

        const cfg = sharedSlotIntegrityConfig;
        if (!sharedSlotHasButtons(cfg.extKey)) {
            registerTaskbar(cfg.extKey, cfg.buildFn, cfg.order);
        }
    });
    sharedSlotIntegrityObserver.observe(root, { childList: true, subtree: true });
}

// Remove a host that lost its slots (e.g. LinkedIn SPA clobbered the bar tree).
function sharedTeardownEmptyHost() {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return false;

    const slots = sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS);
    if (!slots || slots.children.length === 0) {
        host.remove();
        sharedStopShifting();
        sharedStopSlotIntegrityObserver();
        document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_REMOVED, {
            detail: { hostId: SHARED_TASKBAR.HOST_ID },
        }));
        return true;
    }

    return false;
}

function sharedHostIsEmptyShell() {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return false;

    const slots = sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS);
    if (!slots || slots.children.length === 0) return true;

    return Array.from(slots.children).every(
        (slot) => !slot.querySelector("button")
    );
}

function sharedRemoveTaskbarHost() {
    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return false;

    host.remove();
    sharedStopShifting();
    sharedStopSlotIntegrityObserver();
    document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_REMOVED, {
        detail: { hostId: SHARED_TASKBAR.HOST_ID },
    }));
    return true;
}

function sharedInstallSpaNavigationWatch() {
    if (sharedSpaNavInstalled) return;
    sharedSpaNavInstalled = true;

    let lastHref = location.href;
    const onNavigate = () => {
        if (location.href === lastHref) return;
        lastHref = location.href;
        sharedLinkedInJobSearchPage = null;
        if (!document.getElementById(SHARED_TASKBAR.HOST_ID)) return;
        sharedStartShifting();
        document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_PAGE_NAV, {
            detail: { href: location.href },
        }));
    };

    window.addEventListener("popstate", onNavigate);
    const wrapHistory = (original) => function (...args) {
        const ret = original.apply(this, args);
        onNavigate();
        return ret;
    };
    history.pushState = wrapHistory(history.pushState);
    history.replaceState = wrapHistory(history.replaceState);
}

// Idempotent and synchronous: content scripts from different extensions run as
// separate tasks on the same thread, so a synchronous check-then-create here
// guarantees the second extension reuses the first one's host (no race, no
// duplicate bars).
function sharedEnsureTaskbar() {
    sharedInstallSpaNavigationWatch();

    let existing = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (existing) {
        if (!existing.shadowRoot) {
            existing.replaceChildren();
            existing.attachShadow({ mode: "open" });
        }
        sharedEnsureHostStructure(existing);
        sharedApplyHostChromeStyles(existing);
    }
    if (existing) {
        sharedStartShifting();
        return existing;
    }

    const host = document.createElement("div");
    host.id = SHARED_TASKBAR.HOST_ID;
    sharedBuildHostDom(host);

    document.documentElement.prepend(host);
    sharedStartShifting();
    document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_READY, {
        detail: { hostId: SHARED_TASKBAR.HOST_ID },
    }));
    return host;
}

function sharedRebuildSlotIfEmpty(extKey, buildFn, order) {
    if (!sharedTaskbarOpenAllowed) return false;

    const host = document.getElementById(SHARED_TASKBAR.HOST_ID);
    if (!host) return false;

    if (!sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS)) {
        sharedBuildHostDom(host);
    }
    if (sharedSlotHasButtons(extKey)) return true;

    registerTaskbar(extKey, buildFn, order);
    return sharedSlotHasButtons(extKey);
}

function sharedSlotSelector(extKey) {
    return "." + SHARED_TASKBAR.SLOT_CLASS + '[data-ext="' + extKey + '"]';
}

// Full teardown — same end state as a page with the taskbar closed.
function sharedFullyCloseTaskbar(extKey) {
    sharedTaskbarOpenAllowed = false;
    sharedOpenEpoch += 1;
    unregisterTaskbar(extKey);
    sharedRemoveTaskbarHost();
}

// Open after a navigation-style reset. Page load restores via
// storage.get().then(show), which always runs later than script init; reopen
// used to run synchronously on click while the SPA was mid-update.
function sharedResetAndOpenTaskbar(extKey, buildFn, order) {
    sharedTaskbarOpenAllowed = true;
    sharedOpenEpoch += 1;
    const openEpoch = sharedOpenEpoch;

    unregisterTaskbar(extKey);
    sharedRemoveTaskbarHost();
    sharedStopShifting();

    const openNow = () => {
        if (!sharedTaskbarOpenAllowed || openEpoch !== sharedOpenEpoch) return;
        registerTaskbar(extKey, buildFn, order);
        queueMicrotask(() => {
            if (!sharedTaskbarOpenAllowed || openEpoch !== sharedOpenEpoch) return;
            sharedRescanAfterOpen();
        });
    };

    queueMicrotask(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(openNow);
        });
    });
}

// ---- public API ------------------------------------------------------------

// Ensure the shared taskbar exists and (re)build this extension's slot.
// extKey MUST be unique per extension. buildFn(slot, shadowRoot) populates the
// slot with the caller's own buttons. order controls left-to-right placement
// (lower = further left); slots with equal order fall back to insertion order.
// Returns the slot element.
function registerTaskbar(extKey, buildFn, order) {
    sharedTaskbarOpenAllowed = true;

    sharedRegisteringSlot = true;
    try {
        const host = sharedEnsureTaskbar();
        if (!host) return null;

        sharedEnsureHostStructure(host);
        const slots = sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS);
        if (!slots) return null;

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

        if (typeof buildFn === "function") {
            try {
                buildFn(slot, host.shadowRoot || sharedGetTaskbarRoot(host));
            } catch (err) {
                console.warn("shared taskbar buildFn failed:", err);
            }
        }

        if (sharedIsLinkedInJobSearchPage()) {
            setTimeout(() => {
                if (!sharedTaskbarOpenAllowed) return;
                sharedApplyPageShift();
            }, 120);
        } else {
            sharedApplyPageShift();
        }
        sharedWatchSlotIntegrity(extKey, buildFn, order);
        return slot;
    } finally {
        sharedRegisteringSlot = false;
    }
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
    if (!host) return false;

    const slots = sharedQueryTaskbar(host, "." + SHARED_TASKBAR.SLOTS_CLASS);
    const slot = slots && slots.querySelector(sharedSlotSelector(extKey));
    if (slot) slot.remove();

    if (slots) {
        Array.from(slots.children).forEach((child) => {
            if (!child.querySelector("button")) child.remove();
        });
    }

    if (!slots || slots.children.length === 0) {
        host.remove();
        sharedStopShifting();
        sharedStopSlotIntegrityObserver();
        document.dispatchEvent(new CustomEvent(SHARED_TASKBAR.EVT_REMOVED, {
            detail: { hostId: SHARED_TASKBAR.HOST_ID },
        }));
    }
    return true;
}

// Whether this extension currently has a slot in the taskbar.
function isTaskbarRegistered(extKey) {
    return !!sharedGetSlot(extKey);
}
