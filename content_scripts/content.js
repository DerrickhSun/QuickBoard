// content.js
// Shared constants and the shift* helpers live in shift.js, which is loaded
// before this file and shares the same isolated-world scope.

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

function createTaskbar() {
    if (document.getElementById(TASKBAR_ID)) return;

    const host = document.createElement("div");
    host.id = TASKBAR_ID;
    host.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 50px; box-sizing: border-box; border-bottom: 2px solid #000; background-color: #f0f0f0; z-index: 2147483647;';

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
        <style>
            :host {
                display: block;
                width: 100%;
                height: 100%;
            }
            .bar {
                display: flex;
                align-items: center;
                height: 100%;
                padding: 0 12px;
                box-sizing: border-box;
                font-family: system-ui, sans-serif;
            }
            button {
                padding: 6px 12px;
                font-size: 13px;
                cursor: pointer;
            }
        </style>
        <div class="bar">
            <button type="button" id="save-btn">Save "Hello world"</button>
        </div>
    `;

    shadow.getElementById("save-btn").addEventListener("click", () => {
        saveTextFile("Hello world", "hello.txt");
    });

    /*document.body.appendChild(host);*/
    document.documentElement.prepend(host);
    document.body.style.paddingTop = "50px";

    // Offsets any fixed/sticky elements from the page itself
    shiftAllFixedElements();
}

function removeTaskbar() {
    const host = document.getElementById(TASKBAR_ID);
    if (!host) return;
    host.remove();
    document.body.style.paddingTop = "0";

    // Restores the fixed/sticky elements to their original position
    restoreFixedElements();
}

const browser = globalThis.browser ?? globalThis.chrome;
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'TOGGLE_TASKBAR') {
    const exists = document.getElementById(TASKBAR_ID);
    exists ? removeTaskbar() : createTaskbar();
    sendResponse({ visible: !exists });
  }
  return true; // keep channel open for async sendResponse
});