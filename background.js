// Toggle the in-page panel when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "YTVA_TOGGLE" });
  } catch {
    // Content script not present yet (page opened before install) — inject then toggle.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.tabs.sendMessage(tab.id, { type: "YTVA_TOGGLE" });
  }
});
