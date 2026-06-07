const browser = globalThis.browser ?? globalThis.chrome;

browser.action.onClicked.addListener((tab) => {
  browser.tabs.sendMessage(tab.id, { type: "TOGGLE_TASKBAR" })
    .then((res) => console.log("taskbar visible:", res?.visible))
    .catch((err) => console.warn("no content script on this tab:", err));
});
