let accountPresets = [];
let currentPresetId = null;
let pendingAccListPresetId = null;
const pendingMicrosoftAccounts = /* @__PURE__ */ new Map();
let draggedMicrosoftAccountIndex = null;
window.addEventListener("DOMContentLoaded", () => {
  window.electron?.ipcRenderer.send("loaded");
  window.electron?.ipcRenderer.on("setConfig", (event, config, version) => {
    setConfigValues(config);
    fetch("https://raw.githubusercontent.com/RattlesHyper/TrafficerMC/main/VERSION", {
      method: "GET"
    }).then((response) => response.text()).then((result) => {
      const liveVersion = parseFloat(result);
      const currentVersion = version.current;
      if (currentVersion != liveVersion) {
        notify("Warning", "New version available. Please update your client", "warning");
      }
    });
    document.getElementById("versionString").innerHTML = `v${version.current}`;
  });
  window.electron?.ipcRenderer.on("fileSelected", (event, id, path) => {
    const filename = path.match(/[^\\]+$/)[0];
    document.getElementById(id).innerHTML = filename;
  });
  window.electron?.ipcRenderer.on("showBottab", () => {
    document.getElementById("bottingTab").click();
  });
  window.electron?.ipcRenderer.on("accountPresets", (event, presets) => {
    loadAccountPresets(presets);
  });
  window.electron?.ipcRenderer.on("microsoftAuth", (event, info) => {
    handleMicrosoftAuth(info);
  });
  const valueElements = document.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="range"], select, textarea'
  );
  valueElements.forEach((select) => {
    select.addEventListener("change", valueChange);
  });
  const checkboxElements = document.querySelectorAll('input[type="checkbox"]');
  checkboxElements.forEach((check) => {
    check.addEventListener("click", checkboxClick);
  });
  const buttonElements = document.querySelectorAll("button, .button");
  buttonElements.forEach((button) => {
    button.addEventListener("click", buttonClick);
  });
  const tabElements = document.querySelectorAll(".tab, .tab-2");
  tabElements.forEach((tab) => {
    tab.addEventListener("click", navClick);
  });
  document.getElementById("botViewerSelect").addEventListener("change", requestBotInventory);
  window.electron?.ipcRenderer.on("initConfig", () => {
    valueElements.forEach((select) => {
      if (!select.id) return;
      window.electron?.ipcRenderer.send("setConfig", "value", select.id, select.value);
    });
    checkboxElements.forEach((check) => {
      if (!check.id) return;
      window.electron?.ipcRenderer.send("setConfig", "boolean", check.id, check.checked);
    });
  });
  window.electron?.ipcRenderer.on("windowMaximized", (event, isMaximized) => {
    const maxBtn = document.getElementById("maximize");
    if (maxBtn) {
      maxBtn.title = isMaximized ? "Restore" : "Maximize";
      maxBtn.src = isMaximized ? "./assets/icons/restore.svg" : "./assets/icons/max.svg";
    }
  });
  window.electron?.ipcRenderer.on("notify", (event, title, body, type, img, keep) => {
    notify(title, body, type, img, keep);
  });
  window.electron?.ipcRenderer.on("proxyEvent", (event, info) => {
    if (info.event === "scraped") {
      logProxy("Scraped", "success", "");
    } else {
      logProxy(info.proxy, info.event, info.message);
    }
    document.getElementById("proxyCheckStatusCount").innerHTML = info.count;
    switch (info.event) {
      case "start":
        document.getElementById("proxyCheckStatus").style.display = "block";
        document.getElementById("proxyList").value = "";
        break;
      case "stop":
        document.getElementById("proxyCheckStatus").style.display = "none";
        notify("Info", "Stopped proxy test.", "success");
        updateProxyList();
        break;
      case "success":
        document.getElementById("proxyList").value += `${info.proxy}
`;
        updateProxyList();
        break;
      case "scraped":
        document.getElementById("proxyList").value += `
${info.message}
`;
        clearProxyEmpty();
        updateProxyList();
        break;
    }
  });
  window.electron?.ipcRenderer.on("botEvent", (event, info) => {
    switch (info.event) {
      case "login":
        addPlayer(info.id);
        logChat("Bot", info.id, "Connected to the server.");
        break;
      case "authmsg":
        directChat(
          `<div class="space-h"><div class="flex"><p class="text-sm link">Auth</p></div><div class="space-h-f pl-2"><p class="text-sm" style="user-select: text;">${info.id}</p></div></div><p class="text-sm-2" style="user-select: text;"> First time signing in. Use a web browser to open the page <a href="https://www.microsoft.com/link" target="_blank" rel="noreferrer" class="text-sm-2">https://www.microsoft.com/link</a> and enter the code: <a class="text-sm-2" style="border-bottom: solid 1px #a1a1a1; cursor: pointer;" onclick="navigator.clipboard.writeText('${info.message}')">${info.message} [click to copy]</a></p>`
        );
        break;
      case "easymcAuth":
        directChat(
          `<div class="space-h"><div class="flex"><p class="text-sm link">EasyMC</p></div><div class="space-h-f pl-2"><p class="text-sm" style="user-select: text;">Authentication</p></div></div><p class="text-sm-2" style="user-select: text;"> EasyMC authentication requires an alt token. Check <a href="https://easymc.io/get" target="_blank" rel="noreferrer" class="text-sm-2">https://easymc.io/get</a> to get a token.</p>`
        );
        break;
      case "chat":
        logChat("Bot", info.id, info.message);
        break;
      case "kicked":
        logChat("Bot", info.id, "Kicked: " + info.message);
        removePlayer(info.id);
        break;
      case "end":
        logChat("Bot", info.id, "Connection: " + info.message);
        removePlayer(info.id);
        break;
      case "reconnecting":
        logChat("Bot", info.id, info.message);
        removePlayer(info.id);
        break;
      case "inventory":
        renderBotInventory(info.message);
        break;
    }
  });
});
function valueChange(event) {
  if (event.target.dataset.noConfig) {
    if (event.target.id === "presetAccounts") updatePresetAccountCount();
    return;
  }
  const selectId = event.target.id;
  let selectedValue = event.target.dataset.itemId ? event.target.dataset.itemId : event.target.value;
  window.electron?.ipcRenderer.send("setConfig", "value", selectId, selectedValue);
  switch (selectId) {
    case "nameType":
      checkUsername();
      break;
  }
}
function buttonClick(event) {
  const buttonId = event.target.id;
  switch (buttonId) {
    case "minimize":
      window.electron?.ipcRenderer.send("win:invoke", "min");
      break;
    case "maximize":
      window.electron?.ipcRenderer.send("win:invoke", "max");
      break;
    case "close":
      window.electron?.ipcRenderer.send("win:invoke", "close");
      break;
    case "resetConfig":
      window.electron?.ipcRenderer.send("deleteConfig");
      notify("Info", "Config has been reset. Please restart the app", "success");
      break;
    case "nameFileLabel":
      window.electron?.ipcRenderer.send("open", "nameFileLabel", "Name File");
      break;
    case "selectAll":
      selectAll();
      break;
    case "proxyClearDupe":
      clearDupe();
      notify("Info", "Cleared duplicate proxies", "success");
      break;
    case "addPreset":
      addAccountPreset();
      break;
    case "savePreset":
      saveAccountPreset();
      break;
    case "deletePreset":
      deleteAccountPreset();
      break;
    case "addMicrosoftAccount":
      addMicrosoftAccount();
      break;
    case "closeViewerContainer": {
      const username = document.getElementById("botViewerSelect").value;
      if (username) window.electron?.ipcRenderer.send("closeBotWindow", username);
      break;
    }
    default:
      window.electron?.ipcRenderer.send("btnClick", buttonId);
      break;
  }
}
function checkboxClick(event) {
  const checkId = event.target.id;
  const state = event.target.checked;
  window.electron?.ipcRenderer.send("setConfig", "boolean", checkId, state);
  window.electron?.ipcRenderer.send("checkboxClick", checkId, state);
}
function navClick(event) {
  const classes = event.target.classList;
  const targetId = event.target.dataset.tabId || event.target.innerText.toLowerCase().replace(/\s+/g, "");
  const tabContent = document.getElementsByClassName(classes[1]);
  Array.from(tabContent).forEach((content) => {
    if (!content.classList.contains(classes[0])) {
      content.style.display = "none";
    }
  });
  let selectedContent = document.getElementById(targetId) || document.getElementById(event.target.innerText.toLowerCase());
  if (selectedContent) {
    selectedContent.style.display = "block";
    selectedContent.scrollTop = 0;
  }
  const tabs = document.getElementsByClassName(classes[0]);
  Array.from(tabs).forEach((tab) => {
    tab.classList.remove("selected");
  });
  event.currentTarget.classList.add("selected");
}
function checkUsername() {
  const nameType = document.getElementById("nameType");
  const fileDiv = document.getElementById("nameFileDiv");
  const accListDiv = document.getElementById("accListDiv");
  fileDiv.style.display = nameType.value === "file" ? "block" : "none";
  accListDiv.style.display = nameType.value === "acclist" ? "block" : "none";
}
function setConfigValues(obj) {
  for (const keyType in obj) {
    const keys = Object.keys(obj[keyType]);
    for (const key of keys) {
      const element = document.getElementById(key);
      if (element) {
        if (keyType === "value") {
          element.value = obj.value[key];
        } else if (keyType === "boolean") {
          element.checked = obj.boolean[key];
        }
      }
    }
  }
  if (obj?.value?.accListPreset) {
    pendingAccListPresetId = obj.value.accListPreset;
  }
  checkUsername();
  updateSpoofVisibility();
}
function notify(title, body, type, img, keep) {
  const notification = document.createElement("li");
  notification.className = type;
  const top = document.createElement("div");
  top.className = "space-h";
  const topbar = document.createElement("div");
  topbar.className = "flex";
  const titleText = document.createElement("p");
  titleText.className = "text-sm";
  titleText.innerHTML = title;
  topbar.appendChild(titleText);
  const closeDiv = document.createElement("div");
  const closeBtn = document.createElement("p");
  closeBtn.className = "text-sm";
  closeBtn.innerHTML = "X";
  closeBtn.onclick = () => rmNotification();
  closeDiv.appendChild(closeBtn);
  top.appendChild(topbar);
  top.appendChild(closeDiv);
  const bodyDiv = document.createElement("div");
  bodyDiv.className = "n-message";
  const bodyText = document.createElement("p");
  bodyText.className = "tip-sm";
  bodyText.innerText = body;
  bodyDiv.appendChild(bodyText);
  if (img) {
    const imgTag = document.createElement("img");
    imgTag.src = img;
    bodyDiv.appendChild(imgTag);
  }
  notification.appendChild(top);
  notification.appendChild(bodyDiv);
  document.getElementById("notifications").appendChild(notification);
  if (!keep) {
    const progress = document.createElement("div");
    progress.className = "n-progress";
    notification.appendChild(progress);
    setTimeout(() => {
      rmNotification();
    }, 3e3);
  }
  function rmNotification() {
    notification.classList.add("fade");
    setTimeout(() => {
      notification.remove();
    }, 300);
  }
}
function addPlayer(name) {
  const list = document.getElementById("botList");
  const auto = document.getElementById("autoSelect").checked;
  const b = document.createElement("li");
  b.className = "botListItem";
  b.innerHTML = name;
  b.onclick = () => {
    b.classList.toggle("selected");
    updateSelected();
  };
  list.appendChild(b);
  const viewerSelect = document.getElementById("botViewerSelect");
  const option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  viewerSelect.appendChild(option);
  if (!viewerSelect.value) {
    viewerSelect.value = name;
    requestBotInventory();
  }
  list.scrollTop = list.scrollHeight;
  updateBotCount();
  if (auto) {
    selectAll("auto");
  }
}
function removePlayer(name) {
  const list = document.querySelectorAll(".botListItem");
  list.forEach((bot) => {
    if (bot.innerHTML === name) {
      bot.remove();
      updateSelected();
    }
  });
  const viewerSelect = document.getElementById("botViewerSelect");
  Array.from(viewerSelect.options).forEach((option) => {
    if (option.value === name) option.remove();
  });
  if (!viewerSelect.value) requestBotInventory();
  updateBotCount();
}
function updateBotCount() {
  const count = document.getElementById("botCount");
  const list = document.getElementById("botList");
  count.innerHTML = list.children.length;
}
function selectAll(auto) {
  const list = document.getElementById("botList");
  const allSelected = Array.from(list.children).every((li) => li.classList.contains("selected"));
  Array.from(list.children).forEach((bot) => {
    if (auto) {
      bot.classList.toggle("selected", true);
    } else {
      bot.classList.toggle("selected", !allSelected);
    }
  });
  updateSelected();
}
function updateSelected() {
  const list = document.getElementById("botList");
  const selectedBots = Array.from(list.children).filter((bot) => bot.classList.contains("selected"));
  window.electron?.ipcRenderer.send(
    "playerList",
    selectedBots.map((bot) => bot.innerHTML)
  );
  if (selectedBots.length === 1) {
    const viewerSelect = document.getElementById("botViewerSelect");
    viewerSelect.value = selectedBots[0].innerHTML;
    requestBotInventory();
  }
}
function requestBotInventory() {
  const username = document.getElementById("botViewerSelect").value;
  if (!username) {
    renderBotInventory();
    return;
  }
  window.electron?.ipcRenderer.send("getBotInventory", username);
}
function renderBotInventory(snapshot) {
  const inventoryGrid = document.getElementById("inventoryGrid");
  const hotbarGrid = document.getElementById("hotbarGrid");
  const offhandSlot = document.getElementById("offhandSlot");
  const status = document.getElementById("botViewerStatus");
  const openWindowPanel = document.getElementById("openWindowPanel");
  const openWindowGrid = document.getElementById("openWindowGrid");
  const openWindowTitle = document.getElementById("openWindowTitle");
  if (!snapshot) {
    ensureGridSize(inventoryGrid, 27);
    ensureGridSize(hotbarGrid, 9);
    Array.from(inventoryGrid.children).forEach((el) => updateSlotElement(el, null));
    Array.from(hotbarGrid.children).forEach((el) => updateSlotElement(el, null));
    updateSlotElement(offhandSlot, null);
    openWindowPanel.style.display = "none";
    status.textContent = "Choose a connected bot to inspect its inventory.";
    return;
  }
  const { username, inventory, hotbar, offhand, selectedSlot, openWindow, windowId } = snapshot;
  const selectedViewer = document.getElementById("botViewerSelect").value;
  if (selectedViewer && selectedViewer !== username) return;
  status.textContent = `${username}'s inventory — updates live`;
  ensureGridSize(inventoryGrid, inventory.length);
  inventory.forEach((item, i) => {
    const slot = 9 + i;
    updateSlotElement(
      inventoryGrid.children[i],
      item,
      windowClickHandlers(username, windowId, slot)
    );
  });
  ensureGridSize(hotbarGrid, hotbar.length);
  hotbar.forEach((item, index) => {
    updateSlotElement(hotbarGrid.children[index], item, {
      held: index === selectedSlot,
      clickable: true,
      onClick: () => window.electron?.ipcRenderer.send("setBotHotbar", username, index),
      extraTitle: `Select hotbar slot ${index + 1}`
    });
  });
  updateSlotElement(offhandSlot, offhand, windowClickHandlers(username, windowId, 45));
  if (openWindow) {
    openWindowTitle.textContent = openWindow.title || "Open container";
    ensureGridSize(openWindowGrid, openWindow.slots.length);
    openWindow.slots.forEach((item, i) => {
      updateSlotElement(
        openWindowGrid.children[i],
        item,
        windowClickHandlers(username, openWindow.id, i)
      );
    });
    openWindowPanel.style.display = "block";
  } else {
    openWindowPanel.style.display = "none";
    openWindowGrid.replaceChildren();
  }
}
function windowClickHandlers(username, windowId, slot) {
  if (windowId == null) return {};
  const send = (mouseButton, shiftKey) => window.electron?.ipcRenderer.send(
    "clickWindowSlot",
    username,
    windowId,
    slot,
    mouseButton,
    shiftKey ? 1 : 0
  );
  return {
    clickable: true,
    onClick: (event) => send(0, event.shiftKey),
    onContextMenu: (event) => send(1, event.shiftKey),
    extraTitle: "Click to move, shift+click to quick-move, right-click to split"
  };
}
const RENDERED_ICON_NAMES = /* @__PURE__ */ new Set([
  "shield",
  "respawn_anchor",
  "chest",
  "ender_chest",
  "trapped_chest"
]);
function ensureGridSize(gridEl, count) {
  while (gridEl.children.length < count) gridEl.appendChild(document.createElement("div"));
  while (gridEl.children.length > count) gridEl.lastChild.remove();
}
function attachSlotListeners(el) {
  if (el._tooltipBound) return;
  el._tooltipBound = true;
  el.addEventListener("mouseenter", (event) => {
    if (el._item) showItemTooltip(event, el._item, el._extraTitle);
  });
  el.addEventListener("mousemove", (event) => {
    const tooltip = document.getElementById("itemTooltip");
    if (tooltip && tooltip.style.display === "block") positionItemTooltip(event, tooltip);
  });
  el.addEventListener("mouseleave", hideItemTooltip);
  el.addEventListener("contextmenu", (event) => {
    if (!el._onContextMenu) return;
    event.preventDefault();
    el._onContextMenu(event);
  });
}
function updateSlotElement(el, item, { held = false, clickable = false, onClick = null, onContextMenu = null, extraTitle = "" } = {}) {
  attachSlotListeners(el);
  el.className = `minecraft-slot${held ? " held" : ""}${clickable ? " clickable" : ""}`;
  el.onclick = clickable ? onClick : null;
  el._onContextMenu = clickable ? onContextMenu : null;
  el._item = item;
  el._extraTitle = extraTitle;
  const itemSig = item ? `${item.name}:${item.count}:${(item.lore || []).join("\0")}` : "";
  if (el.dataset.itemSig === itemSig) return;
  el.dataset.itemSig = itemSig;
  el.replaceChildren();
  if (!item) return;
  const assetName = item.name.replace("minecraft:", "");
  if (RENDERED_ICON_NAMES.has(assetName)) {
    el.appendChild(createRenderedItemIcon(assetName));
    appendItemCount(el, item.count);
    return;
  }
  const image = document.createElement("img");
  const assetRoot = "./minecraft/textures";
  const textureSources = getItemTextureSources(assetName, assetRoot);
  let textureIndex = 0;
  image.src = textureSources[textureIndex];
  image.alt = item.displayName || assetName;
  image.addEventListener("error", () => {
    textureIndex++;
    if (textureIndex < textureSources.length) image.src = textureSources[textureIndex];
    else image.replaceWith(createItemFallback(item.name));
  });
  el.appendChild(image);
  appendItemCount(el, item.count);
}
function ensureItemTooltip() {
  let tooltip = document.getElementById("itemTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "itemTooltip";
    tooltip.className = "item-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}
function showItemTooltip(event, item, extraTitle) {
  if (!item) return;
  const tooltip = ensureItemTooltip();
  tooltip.replaceChildren();
  const nameRow = document.createElement("div");
  const nameSpan = document.createElement("span");
  nameSpan.className = "tooltip-name";
  nameSpan.textContent = item.displayName || item.name.replace("minecraft:", "").replaceAll("_", " ");
  nameRow.appendChild(nameSpan);
  if (item.count > 1) {
    const countSpan = document.createElement("span");
    countSpan.className = "tooltip-count";
    countSpan.textContent = `x${item.count}`;
    nameRow.appendChild(countSpan);
  }
  tooltip.appendChild(nameRow);
  (item.lore || []).forEach((line) => {
    const lineEl = document.createElement("div");
    lineEl.className = /\$/.test(line) ? "tooltip-price" : "tooltip-lore";
    lineEl.textContent = line;
    tooltip.appendChild(lineEl);
  });
  if (extraTitle) {
    const extraEl = document.createElement("div");
    extraEl.className = "tooltip-lore";
    extraEl.textContent = extraTitle;
    tooltip.appendChild(extraEl);
  }
  tooltip.style.display = "block";
  positionItemTooltip(event, tooltip);
}
function positionItemTooltip(event, tooltip) {
  const padding = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + padding;
  let y = event.clientY + padding;
  if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - padding;
  if (y + rect.height > window.innerHeight) y = event.clientY - rect.height - padding;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}
function hideItemTooltip() {
  const tooltip = document.getElementById("itemTooltip");
  if (tooltip) tooltip.style.display = "none";
}
function createRenderedItemIcon(name) {
  const icon = document.createElement("span");
  icon.className = `rendered-item-icon ${name.replaceAll("_", "-")}-icon`;
  if (name === "respawn_anchor") {
    const image = document.createElement("img");
    image.className = "rendered-model-image";
    image.src = "./minecraft/rendered/respawn_anchor.svg";
    image.alt = "Respawn Anchor";
    icon.appendChild(image);
  }
  return icon;
}
function appendItemCount(slot, amount) {
  if (amount <= 1) return;
  const count = document.createElement("span");
  count.className = "item-count";
  count.textContent = amount;
  slot.appendChild(count);
}
function getItemTextureSources(name, assetRoot) {
  if (name === "shield") return [`${assetRoot}/entity/shield_base_nopattern.png`];
  if (name === "respawn_anchor") return [`${assetRoot}/block/respawn_anchor_top.png`];
  if (name.endsWith("_stained_glass_pane")) {
    return [`${assetRoot}/block/${name}_top.png`, `${assetRoot}/block/${name.replace("_pane", "")}.png`];
  }
  return [`${assetRoot}/item/${name}.png`, `${assetRoot}/block/${name}.png`];
}
function createItemFallback(name) {
  const fallback = document.createElement("span");
  fallback.className = "item-fallback";
  fallback.textContent = name.replace("minecraft:", "").replaceAll("_", " ");
  return fallback;
}
function logProxy(proxy, type, message) {
  const scroll = document.getElementById("autoScrollProxy").checked;
  const logBox = document.getElementById("proxyLogbox");
  const li = document.createElement("li");
  li.className = type;
  const updiv = document.createElement("div");
  updiv.className = "space-h";
  const ddiv = document.createElement("div");
  const msg = document.createElement("p");
  msg.className = "text-sm-2 mu-1";
  msg.style = "user-select: text;";
  msg.innerHTML = message;
  ddiv.appendChild(msg);
  const pl = document.createElement("p");
  pl.style = "user-select: text;";
  pl.className = "text-sm";
  pl.innerHTML = proxy;
  updiv.appendChild(pl);
  const pr = document.createElement("p");
  pr.className = "text-sm";
  pr.innerHTML = type;
  updiv.appendChild(pr);
  li.appendChild(updiv);
  li.appendChild(ddiv);
  logBox.appendChild(li);
  if (scroll) {
    logBox.scrollTop = logBox.scrollHeight;
  }
}
function clearProxyEmpty() {
  const textarea = document.getElementById("proxyList");
  const lines = textarea.value.split("\n");
  const nonEmptyLines = lines.filter(function(line) {
    return line.trim() !== "";
  });
  textarea.value = nonEmptyLines.join("\n");
}
function clearDupe() {
  const textarea = document.getElementById("proxyList");
  const lines = textarea.value.split("\n");
  const uniqueLines = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    uniqueLines[line] = true;
  }
  const uniqueLinesArray = Object.keys(uniqueLines);
  const result = uniqueLinesArray.join("\n");
  textarea.value = result;
}
function updateProxyList() {
  window.electron?.ipcRenderer.send(
    "setConfig",
    "value",
    "proxyList",
    document.getElementById("proxyList").value
  );
}
function logChat(prefix, name, text) {
  const enable = document.getElementById("enableChat").checked;
  if (!enable) return;
  const chatBox = document.getElementById("chatBox");
  const scroll = document.getElementById("autoScrollChat").checked;
  const signature = `${prefix}\0${name}\0${text}`;
  const previous = chatBox.lastElementChild;
  if (previous?.dataset.signature === signature) {
    const count = Number(previous.dataset.repeatCount || 1) + 1;
    previous.dataset.repeatCount = count;
    previous.querySelector(".chat-repeat-count").textContent = `×${count}`;
    if (scroll) chatBox.scrollTop = chatBox.scrollHeight;
    return;
  }
  const li = document.createElement("li");
  li.dataset.signature = signature;
  li.dataset.repeatCount = "1";
  const spaceHDiv = document.createElement("div");
  spaceHDiv.className = "space-h";
  const flexDiv = document.createElement("div");
  flexDiv.className = "flex";
  const prefixP = document.createElement("p");
  prefixP.className = "text-sm link";
  prefixP.textContent = prefix;
  flexDiv.appendChild(prefixP);
  const spaceHFDiv = document.createElement("div");
  spaceHFDiv.className = "space-h-f pl-2";
  const nameP = document.createElement("p");
  nameP.className = "text-sm";
  nameP.style = "user-select: text;";
  nameP.textContent = name;
  spaceHFDiv.appendChild(nameP);
  const repeatCount = document.createElement("span");
  repeatCount.className = "chat-repeat-count";
  spaceHFDiv.appendChild(repeatCount);
  spaceHDiv.appendChild(flexDiv);
  spaceHDiv.appendChild(spaceHFDiv);
  const textP = document.createElement("p");
  textP.className = "text-sm-2";
  textP.style = "user-select: text;";
  textP.textContent = text;
  li.appendChild(spaceHDiv);
  li.appendChild(textP);
  chatBox.appendChild(li);
  if (scroll) {
    chatBox.scrollTop = chatBox.scrollHeight;
  }
}
function directChat(string) {
  const chatBox = document.getElementById("chatBox");
  const li = document.createElement("li");
  li.innerHTML = string;
  chatBox.appendChild(li);
}
function loadAccountPresets(presets) {
  accountPresets = presets || [];
  renderPresetList();
  updateAccListDropdown();
  if (pendingAccListPresetId) {
    const select = document.getElementById("accListPreset");
    if (accountPresets.find((p) => p.id === pendingAccListPresetId)) {
      select.value = pendingAccListPresetId;
    }
    pendingAccListPresetId = null;
  }
}
function renderPresetList() {
  const list = document.getElementById("presetList");
  list.innerHTML = "";
  accountPresets.forEach((preset) => {
    const li = document.createElement("li");
    if (preset.id === currentPresetId) li.classList.add("selected");
    const nameSpan = document.createElement("span");
    nameSpan.className = "text-sm";
    nameSpan.textContent = preset.name;
    const authBadge = document.createElement("span");
    authBadge.className = "preset-auth-badge";
    const authLabels = { offline: "Cracked", microsoft: "MS", easymc: "EasyMC" };
    authBadge.textContent = authLabels[preset.authType] || preset.authType;
    li.appendChild(nameSpan);
    li.appendChild(authBadge);
    li.addEventListener("click", () => selectPreset(preset.id));
    list.appendChild(li);
  });
}
function selectPreset(id) {
  currentPresetId = id;
  renderPresetList();
  const preset = accountPresets.find((p) => p.id === id);
  if (!preset) {
    showPresetEditor(false);
    return;
  }
  showPresetEditor(true);
  document.getElementById("presetName").value = preset.name;
  document.getElementById("presetAuthType").value = preset.authType;
  document.getElementById("presetAccounts").value = preset.accounts;
  updatePresetAccountCount();
  updateMicrosoftLinkVisibility();
}
function showPresetEditor(show) {
  document.getElementById("presetEditor").style.display = show ? "block" : "none";
  document.getElementById("presetEmptyState").style.display = show ? "none" : "flex";
}
function updatePresetAccountCount() {
  const textarea = document.getElementById("presetAccounts");
  const count = textarea.value.split(/\r?\n/).filter((a) => a.trim()).length;
  const badge = document.getElementById("presetAccountCount");
  badge.textContent = count;
}
function getMicrosoftAccounts() {
  const preset = accountPresets.find((item) => item.id === currentPresetId);
  if (!preset) return [];
  const legacyAccounts = (preset.accounts || "").split(/\r?\n/).map((account) => account.trim()).filter(Boolean);
  const savedAccounts = Array.isArray(preset.microsoftAccounts) ? preset.microsoftAccounts : [];
  const byId = new Map(savedAccounts.map((account) => [account.id, account]));
  return legacyAccounts.map((id) => byId.get(id) || { id, name: id, status: "linked" });
}
function setMicrosoftAccounts(accounts) {
  const serializedAccounts = accounts.map((account) => account.id).join("\n");
  document.getElementById("presetAccounts").value = serializedAccounts;
  const preset = accountPresets.find((item) => item.id === currentPresetId);
  if (preset) {
    preset.accounts = serializedAccounts;
    preset.microsoftAccounts = accounts.map(({ id, name, profileId }) => ({ id, name, profileId }));
    preset.authType = "microsoft";
    persistAccountPresets();
    updateAccListDropdown();
  }
  updatePresetAccountCount();
  renderMicrosoftAccountList();
}
function addMicrosoftAccount() {
  if (!currentPresetId || document.getElementById("presetAuthType").value !== "microsoft") return;
  const requestId = `msa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  pendingMicrosoftAccounts.set(requestId, {
    requestId,
    presetId: currentPresetId,
    status: "starting",
    name: "Connecting Microsoft account…"
  });
  renderMicrosoftAccountList();
  window.electron?.ipcRenderer.send("addMicrosoftAccount", {
    presetId: currentPresetId,
    requestId
  });
}
function removeMicrosoftAccount(index) {
  const accounts = getMicrosoftAccounts();
  accounts.splice(index, 1);
  setMicrosoftAccounts(accounts);
}
function moveMicrosoftAccount(fromIndex, toIndex) {
  const accounts = getMicrosoftAccounts();
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= accounts.length || toIndex >= accounts.length)
    return;
  const [account] = accounts.splice(fromIndex, 1);
  accounts.splice(toIndex, 0, account);
  setMicrosoftAccounts(accounts);
}
function renderMicrosoftAccountList() {
  const list = document.getElementById("microsoftAccountList");
  const empty = document.getElementById("microsoftAccountsEmpty");
  const accounts = getMicrosoftAccounts();
  const pending = [...pendingMicrosoftAccounts.values()].filter(
    (account) => account.presetId === currentPresetId
  );
  list.innerHTML = "";
  empty.style.display = accounts.length || pending.length ? "none" : "block";
  accounts.forEach((account, index) => {
    const item = document.createElement("li");
    item.className = "microsoft-account-item";
    item.draggable = true;
    item.dataset.index = index;
    const handle = document.createElement("span");
    handle.className = "microsoft-drag-handle";
    handle.textContent = "⋮⋮";
    handle.title = "Drag to reorder";
    const order = document.createElement("span");
    order.className = "microsoft-account-order";
    order.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "microsoft-account-name";
    name.textContent = account.name;
    const remove = document.createElement("button");
    remove.className = "microsoft-account-remove";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => removeMicrosoftAccount(index));
    item.append(handle, order, name, remove);
    item.addEventListener("dragstart", () => {
      draggedMicrosoftAccountIndex = index;
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => {
      draggedMicrosoftAccountIndex = null;
      item.classList.remove("dragging");
      list.querySelectorAll(".drag-over").forEach((row) => row.classList.remove("drag-over"));
    });
    item.addEventListener("dragover", (event) => {
      event.preventDefault();
      item.classList.add("drag-over");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drag-over");
      if (draggedMicrosoftAccountIndex != null) {
        moveMicrosoftAccount(draggedMicrosoftAccountIndex, index);
      }
    });
    list.appendChild(item);
  });
  pending.forEach((account) => {
    const item = document.createElement("li");
    item.className = "microsoft-account-item microsoft-account-pending";
    const state = document.createElement("span");
    state.className = "microsoft-account-spinner";
    state.textContent = account.status === "code" ? "MS" : "·";
    const details = document.createElement("div");
    details.className = "microsoft-auth-details";
    const title = document.createElement("span");
    title.className = "microsoft-account-name";
    title.textContent = account.status === "code" ? "Finish Microsoft sign-in" : account.name;
    details.appendChild(title);
    if (account.status === "code") {
      const instruction = document.createElement("span");
      instruction.className = "microsoft-auth-instruction";
      instruction.textContent = "Open microsoft.com/link and enter this code";
      const code = document.createElement("strong");
      code.className = "microsoft-auth-code";
      code.textContent = account.code;
      details.append(instruction, code);
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "microsoft-copy-code";
      copy.textContent = "Copy code";
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(account.code);
        copy.textContent = "Copied";
        setTimeout(() => {
          copy.textContent = "Copy code";
        }, 1400);
      });
      const open = document.createElement("button");
      open.type = "button";
      open.className = "microsoft-open-link";
      open.textContent = "Open Microsoft";
      open.addEventListener("click", () => {
        window.open("https://www.microsoft.com/link", "_blank", "noopener,noreferrer");
      });
      const actions = document.createElement("div");
      actions.className = "microsoft-auth-actions";
      actions.append(open, copy);
      item.append(state, details, actions);
    } else {
      item.append(state, details);
    }
    list.appendChild(item);
  });
}
function handleMicrosoftAuth(info) {
  const pending = pendingMicrosoftAccounts.get(info.requestId);
  if (!pending) return;
  if (info.status === "code") {
    pending.status = "code";
    pending.code = info.code;
    renderMicrosoftAccountList();
    return;
  }
  if (info.status === "success") {
    const preset = accountPresets.find((item) => item.id === pending.presetId);
    pendingMicrosoftAccounts.delete(info.requestId);
    if (preset) {
      const accounts = getMicrosoftAccountsForPreset(preset);
      accounts.push({
        id: info.accountId,
        name: info.name,
        profileId: info.profileId,
        status: "linked"
      });
      preset.accounts = accounts.map((account) => account.id).join("\n");
      preset.microsoftAccounts = accounts.map(({ id, name, profileId }) => ({
        id,
        name,
        profileId
      }));
      preset.authType = "microsoft";
      persistAccountPresets();
      if (currentPresetId === preset.id) {
        document.getElementById("presetAccounts").value = preset.accounts;
        updatePresetAccountCount();
      }
    }
    renderMicrosoftAccountList();
    updateAccListDropdown();
    notify("Microsoft", `${info.name} is linked and ready.`, "success");
    return;
  }
  pendingMicrosoftAccounts.delete(info.requestId);
  renderMicrosoftAccountList();
  notify("Microsoft", info.message || "Could not link this account.", "error");
}
function getMicrosoftAccountsForPreset(preset) {
  const ids = (preset.accounts || "").split(/\r?\n/).map((account) => account.trim()).filter(Boolean);
  const saved = Array.isArray(preset.microsoftAccounts) ? preset.microsoftAccounts : [];
  const byId = new Map(saved.map((account) => [account.id, account]));
  return ids.map((id) => byId.get(id) || { id, name: id });
}
function updateAccListDropdown() {
  const select = document.getElementById("accListPreset");
  const currentValue = select.value;
  select.innerHTML = "";
  if (accountPresets.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No presets — create one in Accounts tab";
    select.appendChild(opt);
    return;
  }
  accountPresets.forEach((preset2) => {
    const opt = document.createElement("option");
    opt.value = preset2.id;
    opt.textContent = preset2.name;
    select.appendChild(opt);
  });
  if (currentValue && accountPresets.find((p) => p.id === currentValue)) {
    select.value = currentValue;
    return;
  }
  select.value = accountPresets[0].id;
  const preset = accountPresets[0];
  if (preset) {
    window.electron?.ipcRenderer.send("setConfig", "value", "accListPreset", preset.id);
  }
}
function addAccountPreset() {
  const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  const preset = { id, name: "New Preset", authType: "offline", accounts: "" };
  accountPresets.push(preset);
  persistAccountPresets();
  renderPresetList();
  updateAccListDropdown();
  selectPreset(id);
  selectAccListPreset(id);
}
function saveAccountPreset() {
  if (!currentPresetId) return;
  const preset = accountPresets.find((p) => p.id === currentPresetId);
  if (!preset) return;
  preset.name = document.getElementById("presetName").value.trim() || "Unnamed";
  preset.authType = document.getElementById("presetAuthType").value;
  preset.accounts = document.getElementById("presetAccounts").value;
  persistAccountPresets();
  renderPresetList();
  updateAccListDropdown();
  notify("Accounts", `Preset "${preset.name}" saved.`, "success");
  const accListPreset = document.getElementById("accListPreset");
  if (!accListPreset.value || accListPreset.value !== currentPresetId) {
    selectAccListPreset(currentPresetId);
  }
}
function deleteAccountPreset() {
  if (!currentPresetId) return;
  const preset = accountPresets.find((p) => p.id === currentPresetId);
  const name = preset ? preset.name : "preset";
  accountPresets = accountPresets.filter((p) => p.id !== currentPresetId);
  currentPresetId = null;
  persistAccountPresets();
  renderPresetList();
  updateAccListDropdown();
  showPresetEditor(false);
  notify("Accounts", `Deleted "${name}".`, "success");
}
function persistAccountPresets() {
  window.electron?.ipcRenderer.send("saveAccountPresets", accountPresets);
}
function updateMicrosoftLinkVisibility() {
  const manager = document.getElementById("microsoftAccountsManager");
  const textarea = document.getElementById("presetAccounts");
  const authType = document.getElementById("presetAuthType").value;
  const isMicrosoft = authType === "microsoft";
  manager.style.display = isMicrosoft ? "block" : "none";
  textarea.style.display = isMicrosoft ? "none" : "block";
  if (isMicrosoft) renderMicrosoftAccountList();
}
function updateSpoofVisibility() {
  const row = document.getElementById("spoofCustomClientDiv");
  const spoofMode = document.getElementById("spoofMode").value;
  row.style.display = spoofMode === "custom" ? "block" : "none";
}
function selectAccListPreset(id) {
  const select = document.getElementById("accListPreset");
  if (!accountPresets.find((p) => p.id === id)) return;
  select.value = id;
  window.electron?.ipcRenderer.send("setConfig", "value", "accListPreset", id);
}
