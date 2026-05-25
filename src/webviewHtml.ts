import * as vscode from "vscode";

function createNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i++) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

// Runs before any scripts load: applies color scheme + theme id to <html>, then
// pre-loads any custom theme CSS from localStorage so there is no flash.
const themePreload = `;(function () {
  function safe(fn) { try { return fn() } catch {} }
  var setItem  = function(k,v) { safe(function(){ localStorage.setItem(k,v) }) }
  var getItem  = function(k)   { return safe(function(){ return localStorage.getItem(k) }) }
  var removeItem = function(k) { safe(function(){ localStorage.removeItem(k) }) }

  function readJson(k, fb) {
    try { var r=getItem(k); if(!r) return fb; var p=JSON.parse(r); return (p&&typeof p==="object"&&!Array.isArray(p))?p:fb } catch { return fb }
  }
  function writeJson(k,v) { safe(function(){ setItem(k,JSON.stringify(v)) }) }
  function ensureObj(v) { return (v&&typeof v==="object"&&!Array.isArray(v))?v:{} }
  function b64url(v) {
    try {
      var bytes=new TextEncoder().encode(v), bin=""
      for(var i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i])
      return btoa(bin).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=/g,"")
    } catch { return "" }
  }

  var cfg = window.__OPENCODE_VSCODE_CONFIG__ || {}
  var hostScheme = (cfg.colorScheme === "dark" || cfg.colorScheme === "light") ? cfg.colorScheme : null
  var ns  = (cfg.nativeSettings && typeof cfg.nativeSettings === "object") ? cfg.nativeSettings : null

  if (ns) {
    if (ns.language === "auto") removeItem("opencode.global.dat:language")
    else if (typeof ns.language === "string" && ns.language) writeJson("opencode.global.dat:language", { locale: ns.language })

    var s = ensureObj(readJson("settings.v3", {}))
    s.general = ensureObj(s.general); s.updates = ensureObj(s.updates)
    s.appearance = ensureObj(s.appearance); s.notifications = ensureObj(s.notifications); s.sounds = ensureObj(s.sounds)

    s.general.showReasoningSummaries = !!ns.showReasoningSummaries
    s.general.shellToolPartsExpanded = !!ns.shellToolPartsExpanded
    s.general.editToolPartsExpanded  = !!ns.editToolPartsExpanded
    s.general.autoSave               = ns.autoSave !== false
    s.general.releaseNotes           = ns.releaseNotes !== false
    s.updates.startup                = ns.checkUpdatesOnStartup !== false
    s.appearance.sans     = typeof ns.uiFont === "string" ? ns.uiFont : ""
    s.appearance.mono     = typeof ns.codeFont === "string" ? ns.codeFont : ""
    s.appearance.fontSize = (typeof ns.fontSize === "number" && isFinite(ns.fontSize)) ? Math.max(10, Math.min(28, ns.fontSize)) : 14
    s.notifications.agent       = ns.notifyAgent !== false
    s.notifications.permissions = ns.notifyPermissions !== false
    s.notifications.errors      = !!ns.notifyErrors
    s.sounds.agentEnabled       = ns.soundAgentEnabled !== false
    s.sounds.agent              = (typeof ns.soundAgent === "string" && ns.soundAgent) ? ns.soundAgent : "staplebops-01"
    s.sounds.permissionsEnabled = ns.soundPermissionsEnabled !== false
    s.sounds.permissions        = (typeof ns.soundPermissions === "string" && ns.soundPermissions) ? ns.soundPermissions : "staplebops-02"
    s.sounds.errorsEnabled      = ns.soundErrorsEnabled !== false
    s.sounds.errors             = (typeof ns.soundErrors === "string" && ns.soundErrors) ? ns.soundErrors : "nope-03"

    if (ns.customKeybinds && typeof ns.customKeybinds === "object" && !Array.isArray(ns.customKeybinds)) {
      var kb = {}
      for (var id in ns.customKeybinds) {
        if (!Object.prototype.hasOwnProperty.call(ns.customKeybinds, id)) continue
        var kv = ns.customKeybinds[id]; if (typeof kv !== "string") continue
        kb[id] = kv
      }
      s.keybinds = kb
    }

    writeJson("settings.v3", s)

    if (ns.modelVisibility && typeof ns.modelVisibility === "object" && !Array.isArray(ns.modelVisibility)) {
      var ms = ensureObj(readJson("opencode.global.dat:model", {}))
      var user = []
      for (var mk in ns.modelVisibility) {
        if (!Object.prototype.hasOwnProperty.call(ns.modelVisibility, mk)) continue
        var vis = ns.modelVisibility[mk]; if (vis !== "show" && vis !== "hide") continue
        var sl = mk.indexOf("/"); if (sl<=0||sl>=mk.length-1) continue
        user.push({ providerID: mk.slice(0,sl), modelID: mk.slice(sl+1), visibility: vis })
      }
      ms.user = user; ms.recent = Array.isArray(ms.recent)?ms.recent:[]; ms.variant = ensureObj(ms.variant)
      writeJson("opencode.global.dat:model", ms)
    }

    if (typeof ns.autoAcceptWorkspacePermissions === "boolean" && typeof cfg.workspaceDirectory === "string" && cfg.workspaceDirectory) {
      var ps = ensureObj(readJson("opencode.global.dat:permission", {}))
      ps.autoAccept = ensureObj(ps.autoAccept)
      var pkey = b64url(cfg.workspaceDirectory) + "/*"
      if (pkey) { ps.autoAccept[pkey] = ns.autoAcceptWorkspacePermissions; writeJson("opencode.global.dat:permission", ps) }
    }
  }

  // The extension owns appearance in VS Code: OpenCode's built-in themes are
  // intentionally bypassed so the webview follows the active IDE theme.
  var themeId = "oc-2"
  setItem("opencode-theme-id", themeId)
  if (hostScheme) setItem("opencode-color-scheme", hostScheme)

  if (themeId === "oc-1") {
    themeId = "oc-2"; setItem("opencode-theme-id", themeId)
    removeItem("opencode-theme-css-light"); removeItem("opencode-theme-css-dark")
  }

  var scheme = hostScheme || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode   = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "oc-2") return

  var css = getItem("opencode-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent = ":root{color-scheme:"+mode+";--text-mix-blend-mode:"+(isDark?"plus-lighter":"multiply")+";"+css+"}"
    document.head.appendChild(style)
  }
})()`;

// Intercepts localStorage writes from the webview and syncs them back to the
// extension host so they survive reloads and are shared across panels.
const storagePreload = `;(function () {
  function allow(k) {
    return k==="settings.v3"||k.indexOf("opencode.global.dat:")===0||k.indexOf("opencode.settings.dat:")===0||k.indexOf("opencode-theme-")===0
  }

  function emit(k, v) {
    try { window.dispatchEvent(new StorageEvent("storage",{key:k,oldValue:null,newValue:v,storageArea:localStorage,url:location.href})) }
    catch { try { var e=document.createEvent("StorageEvent"); e.initStorageEvent("storage",false,false,k,null,v,location.href,localStorage); window.dispatchEvent(e) } catch {} }
  }

  function sync(k, v) { var send=window.__OPENCODE_VSCODE_SYNC_STORAGE__; if(typeof send==="function") send(k,v) }

  var cfg = window.__OPENCODE_VSCODE_CONFIG__ || {}
  var shared = (cfg.sharedStorage && typeof cfg.sharedStorage === "object") ? cfg.sharedStorage : null
  if (shared) {
    for (var k in shared) {
      if (!Object.prototype.hasOwnProperty.call(shared,k)||!allow(k)) continue
      var sv=shared[k]; if(typeof sv!=="string") continue
      try { localStorage.setItem(k,sv) } catch {}
    }
  }

  var proto=Storage.prototype, origSet=proto.setItem, origRemove=proto.removeItem, muted=false

  proto.setItem = function(k,v) {
    if (this!==localStorage) return origSet.call(this,k,v)
    var next=String(v)
    origSet.call(localStorage,k,next)
    if(!muted&&allow(k)) sync(k,next)
    emit(k,next)
  }

  proto.removeItem = function(k) {
    if (this!==localStorage) return origRemove.call(this,k)
    origRemove.call(localStorage,k)
    if(!muted&&allow(k)) sync(k,null)
    emit(k,null)
  }

  window.addEventListener("message", function(event) {
    var msg=event.data
    if(!msg||msg.type!=="storageSync"||!allow(msg.key)) return
    muted=true
    try { if(msg.value===null) origRemove.call(localStorage,msg.key); else origSet.call(localStorage,msg.key,msg.value) } catch {}
    muted=false
    emit(msg.key,msg.value)
  })
})()`;

const freeBadgePreload = `;(function () {
  function styleFreeBadges() {
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    )

    var node
    while (node = walker.nextNode()) {
      if (node.textContent.trim() === "Free" || node.textContent.includes("Free")) {
        var parent = node.parentElement
        if (parent && !parent.classList.contains("opencoder-free-badge")) {
          parent.classList.add("opencoder-free-badge")
          parent.style.cssText = [
            "background: linear-gradient(135deg, rgba(74, 222, 128, 0.15), rgba(34, 197, 94, 0.1)) !important",
            "color: #4ade80 !important",
            "padding: 2px 8px !important",
            "border-radius: 4px !important",
            "border: 1px solid rgba(74, 222, 128, 0.3) !important",
            "font-size: 11px !important",
            "font-weight: 500 !important",
            "letter-spacing: 0.3px !important",
            "white-space: nowrap !important",
            "display: inline-block !important"
          ].join(";")
        }
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", styleFreeBadges, { once: true })
  } else {
    styleFreeBadges()
  }

  var observer = new MutationObserver(styleFreeBadges)
  observer.observe(document.body, { childList: true, subtree: true })
})()`;

const statusActionsPreload = `;(function () {
  var cfg = window.__OPENCODE_VSCODE_CONFIG__ || {}
  if (cfg.settingsMode) return

  function send(action) {
    window.postMessage({ type: "hostAction", action: action }, "*")
  }

  var icons = { add: "add", refresh: "refresh", settings: "gear", history: "history" }

  function makeButton(action, icon, label) {
    var button = document.createElement("button")
    button.type = "button"
    button.className = "opencoder-status-action"
    button.setAttribute("aria-label", label)
    button.title = label
    button.addEventListener("click", function(event) {
      event.preventDefault()
      event.stopPropagation()
      send(action)
    })

    var iconEl = document.createElement("span")
    iconEl.className = "opencoder-status-action-icon codicon codicon-" + (icons[icon] || icon)
    iconEl.setAttribute("aria-hidden", "true")

    var labelEl = document.createElement("span")
    labelEl.className = "opencoder-status-action-label"
    labelEl.textContent = label

    button.append(iconEl, labelEl)
    return button
  }

  function installTitlebarActions() {
    if (document.querySelector(".opencoder-titlebar-actions")) return
    var statusTrigger = document.querySelector('[data-slot="popover-trigger"].titlebar-icon, .titlebar-icon[aria-label]')
    var right = document.getElementById("opencode-titlebar-right") || (statusTrigger && statusTrigger.parentElement)
    if (!right) return

    var row = document.createElement("div")
    row.className = "opencoder-titlebar-actions"
    row.append(
      makeButton("newSession", "add", "New Session"),
      makeButton("history", "history", "History"),
      makeButton("refresh", "refresh", "Refresh"),
      makeButton("openSettings", "settings", "Settings"),
    )
    if (statusTrigger && statusTrigger.parentNode === right) right.insertBefore(row, statusTrigger)
    else right.prepend(row)
  }

  function commonAncestor(nodes) {
    if (!nodes.length) return null
    var node = nodes[0]
    while (node) {
      var found = true
      for (var index = 1; index < nodes.length; index += 1) {
        if (!node.contains(nodes[index])) {
          found = false
          break
        }
      }
      if (found) return node
      node = node.parentElement
    }
    return null
  }

  function installPromptMarkers() {
    var controls = [
      document.querySelector('[data-component="prompt-model-control"]'),
      document.querySelector('[data-component="prompt-agent-control"]'),
      document.querySelector('[data-component="prompt-variant-control"]'),
    ].filter(Boolean)
    if (controls.length < 3) return

    var row = commonAncestor(controls)
    if (!(row instanceof HTMLElement)) return

    row.setAttribute("data-opencoder-prompt-controls", "true")
    controls[0].setAttribute("data-opencoder-prompt-first-control", "true")

    var parent = row.parentElement
    var depth = 0
    while (parent && depth < 4) {
      parent.setAttribute("data-opencoder-prompt-controls-wrap", "true")
      if (parent.matches('[data-component="dock-prompt"]')) break
      parent = parent.parentElement
      depth += 1
    }
  }

  function isStatusPopoverTabs(element) {
    if (!(element instanceof HTMLElement)) return false
    if (element.querySelector(".opencoder-status-actions")) return false
    var tablist = element.querySelector('[data-slot="tablist"]')
    if (!tablist) return false
    var tabText = (tablist.textContent || "").toLowerCase()
    if (tabText.indexOf("mcp") === -1 || tabText.indexOf("lsp") === -1) return false
    if (tabText.indexOf("servers") === -1 && tabText.indexOf("plugins") === -1) return false
    return true
  }

  function isStatusPopoverDataTabs(element) {
    if (!(element instanceof HTMLElement)) return false
    var active = element.getAttribute("data-active")
    if (active !== "servers" && active !== "mcp" && active !== "lsp" && active !== "plugins") return false
    return element.querySelectorAll('[data-slot="tab"]').length >= 3
  }

  function installActions() {
    installTitlebarActions()
    installPromptMarkers()

    var tabs = Array.prototype.find.call(document.querySelectorAll('[data-component="tabs"]'), isStatusPopoverDataTabs)
      || Array.prototype.find.call(document.querySelectorAll('[data-slot="tablist"]'), function(tablist) {
        return isStatusPopoverTabs(tablist.parentElement)
      })?.parentElement
    if (!tabs || tabs.querySelector(".opencoder-status-actions")) return
    tabs.setAttribute("data-opencoder-status-actions", "true")

    var row = document.createElement("div")
    row.className = "opencoder-status-actions"
    row.append(
      makeButton("newSession", "add", "New Session"),
      makeButton("history", "history", "History"),
      makeButton("refresh", "refresh", "Refresh"),
      makeButton("openSettings", "settings", "Settings"),
    )

    var tablist = tabs.querySelector('[data-slot="tablist"]')
    if (tablist && tablist.parentNode === tabs) tabs.insertBefore(row, tablist.nextSibling)
    else tabs.prepend(row)
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installActions, { once: true })
  } else {
    installActions()
  }

  var observer = new MutationObserver(installActions)
  observer.observe(document.documentElement, { childList: true, subtree: true })
})()`;

// CSS that maps the OpenCode app colours to VS Code's CSS variables so the
// webview automatically matches whatever theme the user has active — light,
// dark, high-contrast, etc. — without any hardcoded palette.
function buildSystemThemeCSS(colorScheme: "light" | "dark"): string {
  return `
    :root {
      color-scheme: ${colorScheme} !important;

      --oc-vscode-bg:       var(--vscode-sideBar-background, var(--vscode-editor-background)) !important;
      --oc-vscode-editor:   var(--vscode-editor-background) !important;
      --oc-vscode-fg:       var(--vscode-sideBar-foreground, var(--vscode-editor-foreground)) !important;
      --oc-vscode-muted:    var(--vscode-descriptionForeground, var(--vscode-disabledForeground)) !important;
      --oc-vscode-border:   var(--vscode-sideBar-border, var(--vscode-panel-border, var(--vscode-widget-border))) !important;
      --oc-vscode-accent:   var(--vscode-button-background, var(--vscode-textLink-foreground)) !important;
      --oc-vscode-accent-fg: var(--vscode-button-foreground, var(--vscode-editor-background)) !important;
      --oc-vscode-danger:   var(--vscode-errorForeground) !important;
      --oc-vscode-warning:  var(--vscode-editorWarning-foreground, var(--vscode-list-warningForeground)) !important;
      --oc-vscode-success:  var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen)) !important;
      --oc-vscode-info:     var(--vscode-editorInfo-foreground, var(--vscode-textLink-foreground)) !important;

      --background-base:    var(--oc-vscode-bg) !important;
      --background-weak:    color-mix(in srgb, var(--oc-vscode-bg) 96%, var(--oc-vscode-fg)) !important;
      --background-strong:  var(--oc-vscode-editor) !important;
      --background-stronger: color-mix(in srgb, var(--oc-vscode-editor) 92%, var(--oc-vscode-fg)) !important;
      --base:               var(--oc-vscode-fg) !important;
      --base2:              var(--oc-vscode-muted) !important;
      --base3:              var(--vscode-disabledForeground, var(--oc-vscode-muted)) !important;

      --surface-base:       var(--oc-vscode-bg) !important;
      --surface-base-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--oc-vscode-bg) 88%, var(--oc-vscode-fg))) !important;
      --surface-base-active: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground, color-mix(in srgb, var(--oc-vscode-bg) 82%, var(--oc-vscode-accent)))) !important;
      --surface-inset-base: var(--vscode-input-background, var(--oc-vscode-editor)) !important;
      --surface-inset-base-hover: color-mix(in srgb, var(--surface-inset-base) 90%, var(--oc-vscode-fg)) !important;
      --surface-raised-base: var(--vscode-editorWidget-background, var(--vscode-dropdown-background, var(--oc-vscode-bg))) !important;
      --surface-raised-base-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--surface-raised-base) 88%, var(--oc-vscode-fg))) !important;
      --surface-raised-base-active: var(--vscode-list-activeSelectionBackground, var(--vscode-list-inactiveSelectionBackground, color-mix(in srgb, var(--surface-raised-base) 82%, var(--oc-vscode-accent)))) !important;
      --surface-raised-strong: var(--vscode-menu-background, var(--surface-raised-base)) !important;
      --surface-raised-stronger: var(--vscode-quickInput-background, var(--surface-raised-base)) !important;
      --surface-raised-stronger-non-alpha: var(--surface-raised-stronger) !important;
      --surface-float-base: var(--vscode-editorHoverWidget-background, var(--surface-raised-base)) !important;
      --surface-weak:      color-mix(in srgb, var(--oc-vscode-bg) 94%, var(--oc-vscode-fg)) !important;
      --surface-strong:    color-mix(in srgb, var(--oc-vscode-bg) 88%, var(--oc-vscode-fg)) !important;
      --surface-stronger-non-alpha: color-mix(in srgb, var(--oc-vscode-bg) 78%, var(--oc-vscode-fg)) !important;
      --surface-interactive-base: var(--oc-vscode-accent) !important;
      --surface-interactive-hover: var(--vscode-button-hoverBackground, color-mix(in srgb, var(--oc-vscode-accent) 88%, var(--oc-vscode-fg))) !important;
      --surface-interactive-weak: color-mix(in srgb, var(--oc-vscode-accent) 18%, transparent) !important;
      --surface-interactive-weak-hover: color-mix(in srgb, var(--oc-vscode-accent) 26%, transparent) !important;
      --surface-disabled:  var(--vscode-input-background, color-mix(in srgb, var(--oc-vscode-bg) 94%, var(--oc-vscode-fg))) !important;
      --surface-info-base: color-mix(in srgb, var(--oc-vscode-info) 18%, transparent) !important;
      --surface-info-weak: color-mix(in srgb, var(--oc-vscode-info) 10%, transparent) !important;
      --surface-info-strong: color-mix(in srgb, var(--oc-vscode-info) 34%, transparent) !important;
      --surface-warning-base: color-mix(in srgb, var(--oc-vscode-warning) 20%, transparent) !important;
      --surface-warning-weak: color-mix(in srgb, var(--oc-vscode-warning) 10%, transparent) !important;
      --surface-warning-strong: color-mix(in srgb, var(--oc-vscode-warning) 42%, transparent) !important;
      --surface-success-base: color-mix(in srgb, var(--oc-vscode-success) 18%, transparent) !important;
      --surface-success-weak: color-mix(in srgb, var(--oc-vscode-success) 10%, transparent) !important;
      --surface-success-strong: color-mix(in srgb, var(--oc-vscode-success) 34%, transparent) !important;
      --surface-critical-base: color-mix(in srgb, var(--oc-vscode-danger) 18%, transparent) !important;
      --surface-critical-weak: color-mix(in srgb, var(--oc-vscode-danger) 10%, transparent) !important;
      --surface-critical-strong: color-mix(in srgb, var(--oc-vscode-danger) 34%, transparent) !important;

      --border-base:       var(--oc-vscode-border) !important;
      --border-hover:      var(--vscode-focusBorder, var(--oc-vscode-border)) !important;
      --border-active:     var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --border-focus:      var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --border-selected:   var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --border-disabled:   color-mix(in srgb, var(--oc-vscode-border) 55%, transparent) !important;
      --border-weak-base:  var(--vscode-widget-border, color-mix(in srgb, var(--oc-vscode-border) 70%, transparent)) !important;
      --border-weak-selected: var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --border-weaker-base: color-mix(in srgb, var(--oc-vscode-border) 45%, transparent) !important;
      --border-strong-base: var(--vscode-contrastBorder, var(--vscode-focusBorder, var(--oc-vscode-border))) !important;
      --border-interactive-base: var(--oc-vscode-accent) !important;
      --border-interactive-focus: var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --border-info-base:  var(--oc-vscode-info) !important;
      --border-warning-base: var(--oc-vscode-warning) !important;
      --border-success-base: var(--oc-vscode-success) !important;
      --border-critical-base: var(--oc-vscode-danger) !important;
      --border-critical-weak: color-mix(in srgb, var(--oc-vscode-danger) 45%, transparent) !important;

      --text-base:         var(--oc-vscode-fg) !important;
      --text-strong:       var(--oc-vscode-fg) !important;
      --text-stronger:     var(--oc-vscode-fg) !important;
      --text-weak:         var(--oc-vscode-muted) !important;
      --text-weaker:       var(--vscode-disabledForeground, var(--oc-vscode-muted)) !important;
      --text-interactive-base: var(--vscode-textLink-foreground, var(--oc-vscode-accent)) !important;
      --text-on-interactive-base: var(--oc-vscode-accent-fg) !important;
      --text-on-interactive-weak: var(--oc-vscode-fg) !important;
      --text-error:        var(--oc-vscode-danger) !important;
      --text-on-critical-base: var(--vscode-editor-background, var(--oc-vscode-bg)) !important;
      --text-on-critical-weak: var(--oc-vscode-danger) !important;
      --text-diff-add-base: var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) !important;
      --text-diff-delete-base: var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) !important;
      --text-diff-add-strong: var(--text-diff-add-base) !important;
      --text-diff-delete-strong: var(--text-diff-delete-base) !important;

      --icon-base:         var(--oc-vscode-fg) !important;
      --icon-weak-base:    var(--oc-vscode-muted) !important;
      --icon-weak:         var(--oc-vscode-muted) !important;
      --icon-weaker:       var(--vscode-disabledForeground, var(--oc-vscode-muted)) !important;
      --icon-strong-base:  var(--oc-vscode-fg) !important;
      --icon-interactive-base: var(--vscode-textLink-foreground, var(--oc-vscode-accent)) !important;
      --icon-on-interactive-base: var(--oc-vscode-accent-fg) !important;
      --icon-info-base:    var(--oc-vscode-info) !important;
      --icon-info-active:  var(--oc-vscode-info) !important;
      --icon-warning-base: var(--oc-vscode-warning) !important;
      --icon-success-base: var(--oc-vscode-success) !important;
      --icon-critical-base: var(--oc-vscode-danger) !important;
      --icon-diff-add-base: var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) !important;
      --icon-diff-delete-base: var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) !important;
      --icon-diff-modified-base: var(--vscode-gitDecoration-modifiedResourceForeground, var(--oc-vscode-info)) !important;
      --icon-disabled:     var(--vscode-disabledForeground, var(--oc-vscode-muted)) !important;

      --input-base:        var(--vscode-input-background, var(--surface-inset-base)) !important;
      --input-background:  var(--vscode-input-background, var(--surface-inset-base)) !important;
      --input-foreground:  var(--vscode-input-foreground, var(--oc-vscode-fg)) !important;
      --input-border:      var(--vscode-input-border, var(--border-weak-base)) !important;
      --input-focus:       var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;

      --button-primary-base: var(--vscode-button-background, var(--oc-vscode-accent)) !important;
      --button-secondary-base: var(--vscode-button-secondaryBackground, var(--surface-raised-base)) !important;
      --button-secondary-hover: var(--vscode-button-secondaryHoverBackground, var(--surface-raised-base-hover)) !important;

      --syntax-property:   var(--vscode-symbolIcon-propertyForeground, var(--vscode-charts-blue, var(--oc-vscode-info))) !important;
      --syntax-type:       var(--vscode-symbolIcon-classForeground, var(--vscode-charts-purple, var(--oc-vscode-accent))) !important;
      --syntax-string:     var(--vscode-symbolIcon-stringForeground, var(--vscode-terminal-ansiGreen, var(--oc-vscode-success))) !important;
      --syntax-keyword:    var(--vscode-symbolIcon-keywordForeground, var(--vscode-charts-purple, var(--oc-vscode-accent))) !important;
      --syntax-variable:   var(--vscode-symbolIcon-variableForeground, var(--oc-vscode-fg)) !important;
      --syntax-comment:    var(--vscode-editorLineNumber-foreground, var(--oc-vscode-muted)) !important;
      --syntax-critical:   var(--oc-vscode-danger) !important;
      --syntax-warning:    var(--oc-vscode-warning) !important;
      --syntax-success:    var(--oc-vscode-success) !important;
      --syntax-info:       var(--oc-vscode-info) !important;

      --surface-diff-add-base: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) 18%, transparent) !important;
      --surface-diff-add-weak: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) 10%, transparent) !important;
      --surface-diff-add-strong: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) 28%, transparent) !important;
      --surface-diff-add-stronger: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, var(--oc-vscode-success)) 38%, transparent) !important;
      --surface-diff-delete-base: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) 18%, transparent) !important;
      --surface-diff-delete-weak: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) 10%, transparent) !important;
      --surface-diff-delete-strong: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) 28%, transparent) !important;
      --surface-diff-delete-stronger: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, var(--oc-vscode-danger)) 38%, transparent) !important;
      --surface-diff-hidden-base: var(--surface-weak) !important;
      --surface-diff-hidden-strong: var(--surface-strong) !important;
      --surface-diff-skip-base: var(--surface-weak) !important;
      --surface-diff-unchanged-base: transparent !important;

      --accent-base:       var(--oc-vscode-accent) !important;
      --accent-foreground: var(--oc-vscode-accent-fg) !important;
      --accent-hover:      var(--vscode-button-hoverBackground, var(--oc-vscode-accent)) !important;
      --focus-border:      var(--vscode-focusBorder, var(--oc-vscode-accent)) !important;
      --selection-bg:      var(--vscode-editor-selectionBackground) !important;
      --scrollbar-bg:      var(--vscode-scrollbarSlider-background) !important;
      --scrollbar-hover:   var(--vscode-scrollbarSlider-hoverBackground) !important;
      --code-background:   var(--vscode-textCodeBlock-background, var(--oc-vscode-editor)) !important;

      --shadow-xs-border:  0 0 0 1px var(--border-weak-base) !important;
      --shadow-xs-border-base: 0 0 0 1px var(--border-weak-base) !important;
      --shadow-xs-border-hover: 0 0 0 1px var(--border-hover) !important;
      --shadow-xs-border-focus: 0 0 0 1px var(--focus-border) !important;
      --shadow-xs-border-select: 0 0 0 1px var(--border-selected) !important;
      --shadow-xs-border-critical-base: 0 0 0 1px var(--border-critical-base) !important;
      --shadow-lg-border-base: 0 0 0 1px var(--border-base), 0 8px 24px color-mix(in srgb, var(--vscode-widget-shadow, #000) 28%, transparent) !important;
      --inline-input-shadow: 0 0 0 1px var(--input-border) !important;
      --text-mix-blend-mode: normal !important;
    }

    /* Make the root element use the VS Code background so there is no colour
       mismatch between the sidebar chrome and the webview content. */
    html, body, #root {
      background-color: var(--background-base);
      color: var(--text-base);
    }
  `.trim();
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  config: {
    serverUrl: string;
    version: string;
    workspaceDirectory: string | null;
    colorScheme: "light" | "dark";
    disableHealthCheck: boolean;
    settingsMode?: boolean;
    sharedStorage?: Record<string, string>;
    nativeSettings?: Record<string, unknown>;
  },
) {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "app", "app.js"));
  const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "app", "app.css"));
  const codiconStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "codicons", "codicon.css"));

  const systemThemeCSS = `<style nonce="${nonce}">${buildSystemThemeCSS(config.colorScheme)}</style>`;

  const codeBlockCSS = `<style nonce="${nonce}">
    [data-component="markdown"] :not(pre) > code {
      font-size: 13px;
      padding: 2px 4px;
      margin: 0 1.5px;
      border-radius: 2px;
      background: var(--code-background);
      box-shadow: 0 0 0 0.5px var(--border-weak-base);
    }
  </style>`;

  const statusActionsCSS = `<style nonce="${nonce}">
    :root {
      --opencoder-header-surface: var(--background-base, var(--vscode-sideBar-background, #342815));
      --opencoder-darker-theme-surface: var(--opencoder-header-surface);
      --opencoder-prompt-surface: var(--surface-raised-base, #3f311a);
      --opencoder-prompt-border: var(--border-weak-base, #6a5230);
      --opencoder-control-surface: var(--opencoder-darker-theme-surface);
      --opencoder-control-surface-hover: var(--opencoder-darker-theme-surface);
      --background-strong: var(--opencoder-header-surface) !important;
      --background-stronger: var(--opencoder-header-surface) !important;
      --color-background-strong: var(--opencoder-header-surface) !important;
      --color-background-stronger: var(--opencoder-header-surface) !important;
      --surface-stronger-non-alpha: var(--opencoder-darker-theme-surface) !important;
      --surface-interactive-weak: var(--opencoder-darker-theme-surface) !important;
      --surface-interactive-weak-hover: var(--opencoder-darker-theme-surface) !important;
      --surface-weak: var(--opencoder-darker-theme-surface) !important;
      --surface-strong: var(--opencoder-darker-theme-surface) !important;
    }

    html,
    body,
    #root {
      background-color: var(--opencoder-darker-theme-surface) !important;
    }

    [data-component="popover-content"]:has(.opencoder-status-actions) [data-component="tabs"],
    [data-component="popover-content"]:has(.opencoder-status-actions) .tabs,
    [data-opencoder-status-actions="true"] {
      background: var(--opencoder-darker-theme-surface) !important;
      box-shadow: 0 8px 24px color-mix(in srgb, var(--vscode-widget-shadow, #000) 28%, transparent) !important;
    }

    .opencoder-status-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 12px 8px;
    }

    .opencoder-titlebar-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-right: 4px;
    }

    .opencoder-status-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 0;
      height: 28px;
      padding: 0 8px;
      border: 0;
      border-radius: 6px;
      background: var(--vscode-button-secondaryBackground, var(--surface-raised-stronger-non-alpha));
      color: var(--text-base);
      font: inherit;
      font-size: 12px;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
    }

    .opencoder-titlebar-actions .opencoder-status-action {
      width: 32px;
      height: 24px;
      padding: 0;
      border-radius: 6px;
      background: transparent !important;
    }

    .opencoder-titlebar-actions .opencoder-status-action-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .opencoder-status-action:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--surface-raised-base-hover));
    }

    .opencoder-titlebar-actions .opencoder-status-action:hover {
      background: var(--vscode-toolbar-hoverBackground, var(--surface-raised-base-hover)) !important;
    }

    .opencoder-status-action:focus-visible {
      outline: 1px solid var(--focus-border);
      outline-offset: 1px;
    }

    .opencoder-status-action-icon {
      display: inline-flex;
      width: 16px;
      height: 16px;
      justify-content: center;
      align-items: center;
      color: var(--text-strong);
      flex: 0 0 auto;
      font-size: 16px;
      line-height: 1;
    }

    [data-component="session-prompt-dock"],
    [data-component="dock-prompt"] {
      background: var(--opencoder-darker-theme-surface) !important;
    }

    .bg-background-stronger,
    .bg-background-base {
      background-color: var(--opencoder-darker-theme-surface) !important;
    }

    [data-component="session-prompt-dock"],
    [data-component="session-prompt-dock"] > *,
    [data-component="session-prompt-dock"] :where(
      [data-component="dock-prompt"],
      [data-component="dock-prompt"] > *,
      [data-component="dock-prompt"] [data-slot$="-header"],
      [data-component="dock-prompt"] [data-slot$="-content"],
      [data-component="dock-prompt"] [data-slot$="-footer"]
    ) {
      background: transparent !important;
      box-shadow: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      outline: 0 !important;
    }

    [data-component="dock-prompt"] > .relative,
    [data-component="session-prompt-dock"] [data-component="dock-prompt"] > .relative {
      background: transparent !important;
      box-shadow: none !important;
      overflow: visible;
      border: 0 !important;
      border-radius: 0 !important;
      outline: 0 !important;
    }

    [data-component="dock-prompt"] {
      border: 0 !important;
      box-shadow: none !important;
      outline: 0 !important;
    }

    [data-component="dock-prompt"] .relative:has(> .relative > [data-component="prompt-input"]) {
      background: var(--opencoder-prompt-surface) !important;
      border: 1px solid var(--opencoder-prompt-border) !important;
      border-radius: 8px !important;
      box-shadow: none !important;
      outline: 0 !important;
      overflow: hidden !important;
    }

    [data-component="dock-prompt"] .relative:has(> [data-component="prompt-input"]) {
      background: transparent !important;
      box-shadow: none !important;
      border: 0 !important;
      border-radius: 0 !important;
      overflow: auto !important;
    }

    [data-component="prompt-input"] {
      min-height: 92px;
      padding: 12px 14px 56px !important;
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      color: var(--text-strong) !important;
      caret-color: var(--vscode-focusBorder, var(--oc-vscode-accent));
    }

    [data-component="prompt-input"]:focus {
      outline: 1px solid var(--focus-border);
      outline-offset: 1px;
    }

    [data-component="prompt-input"] + [aria-hidden="true"] {
      display: none !important;
      background: none !important;
    }

    [data-action="prompt-attach"],
    [data-action="prompt-submit"],
    [data-component="dock-prompt"] [data-action="prompt-attach"],
    [data-component="dock-prompt"] [data-action="prompt-submit"] {
      width: 24px !important;
      height: 24px !important;
      min-width: 24px !important;
      min-height: 24px !important;
      padding: 0 !important;
      border-radius: 5px !important;
      box-shadow: none !important;
    }

    [data-action="prompt-submit"],
    [data-component="dock-prompt"] [data-action="prompt-submit"] {
      background: color-mix(in srgb, var(--opencoder-prompt-surface) 68%, var(--text-strong) 4%) !important;
      border: 1px solid color-mix(in srgb, var(--opencoder-prompt-border) 55%, transparent) !important;
      color: var(--text-strong) !important;
    }

    [data-action="prompt-submit"]:hover,
    [data-component="dock-prompt"] [data-action="prompt-submit"]:hover {
      background: color-mix(in srgb, var(--opencoder-prompt-surface) 70%, transparent) !important;
      color: var(--text-strong) !important;
    }

    [data-action="prompt-attach"] [data-component="icon"],
    [data-action="prompt-submit"] [data-component="icon"],
    [data-component="dock-prompt"] [data-action="prompt-attach"] [data-component="icon"],
    [data-component="dock-prompt"] [data-action="prompt-submit"] [data-component="icon"] {
      width: 14px !important;
      height: 14px !important;
      min-width: 14px !important;
      min-height: 14px !important;
    }

    [data-action="prompt-attach"] [data-component="icon"] svg,
    [data-action="prompt-submit"] [data-component="icon"] svg,
    [data-action="prompt-attach"] [data-slot="icon-svg"],
    [data-action="prompt-submit"] [data-slot="icon-svg"] {
      width: 14px !important;
      height: 14px !important;
      min-width: 14px !important;
      min-height: 14px !important;
      stroke-width: 1.6 !important;
    }

    [data-component="session-prompt-dock"] :where(div):has([data-component="prompt-model-control"]),
    [data-component="session-prompt-dock"] :where(div):has([data-component="prompt-agent-control"]),
    [data-component="session-prompt-dock"] :where(div):has([data-component="prompt-variant-control"]) {
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      outline: 0 !important;
    }

    [data-opencoder-prompt-controls="true"] {
      width: 100% !important;
      max-width: 100% !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      overflow-x: auto !important;
      overflow-y: visible !important;
      flex-wrap: nowrap !important;
      justify-content: flex-start !important;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    [data-opencoder-prompt-controls-wrap="true"] {
      left: 0 !important;
      padding-left: 0 !important;
      margin-left: 0 !important;
      transform: none !important;
    }

    [data-component="dock-prompt"] .pointer-events-none.absolute.bottom-2.left-2:has([data-opencoder-prompt-controls="true"]),
    [data-component="dock-prompt"] [data-slot$="-footer"]:has([data-opencoder-prompt-controls="true"]) {
      left: 0 !important;
      right: 0 !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    [data-component="session-prompt-dock"] :where(div):has(> [data-opencoder-prompt-controls="true"]) {
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    [data-opencoder-prompt-controls="true"]::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }

    [data-opencoder-prompt-controls="true"] > * {
      flex: 0 0 auto;
      margin-left: 0 !important;
    }

    [data-opencoder-prompt-first-control="true"] {
      margin-left: 0 !important;
    }

    [data-component="prompt-model-control"],
    [data-component="prompt-agent-control"],
    [data-component="prompt-variant-control"] {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      max-width: 100%;
      border: 1px solid var(--opencoder-prompt-border);
      border-radius: 8px;
      background: var(--opencoder-control-surface) !important;
      box-shadow: none;
    }

    [data-component="prompt-model-control"]:hover,
    [data-component="prompt-agent-control"]:hover,
    [data-component="prompt-variant-control"]:hover {
      background: var(--opencoder-control-surface-hover) !important;
    }

    /* Green badge styling for Free tier models */
    [data-component="dialog"] [role="option"] span,
    [data-component="popover"] [role="option"] span {
      transition: all 0.2s ease;
    }

    /* Target badge elements in model/option lists */
    [data-component="dialog"] [role="option"] span[style*="background"],
    [data-component="popover"] [role="option"] span[style*="background"],
    [data-component="dialog"] span.badge,
    [data-component="popover"] span.badge,
    [data-component="dialog"] span[class*="badge"],
    [data-component="popover"] span[class*="badge"],
    [data-component="dialog"] span[class*="tag"],
    [data-component="popover"] span[class*="tag"],
    [data-component="dialog"] div[class*="pill"],
    [data-component="popover"] div[class*="pill"] {
      background: linear-gradient(135deg, rgba(74, 222, 128, 0.15), rgba(34, 197, 94, 0.1)) !important;
      color: #4ade80 !important;
      padding: 2px 8px !important;
      border-radius: 4px !important;
      border: 1px solid rgba(74, 222, 128, 0.3) !important;
      font-size: 11px !important;
      font-weight: 500 !important;
      letter-spacing: 0.3px !important;
      white-space: nowrap !important;
      display: inline-block !important;
    }
  </style>`;

  const settingsModeCSS = config.settingsMode
    ? `<style nonce="${nonce}">
    #root[data-settings-ready="false"] { opacity: 0; }
    #root[data-settings-ready="true"]  { opacity: 1; }
    [data-tauri-drag-region],
    [data-component="sidebar-nav-desktop"],
    [data-component="sidebar-nav-mobile"],
    [data-component="sidebar-rail"]      { display: none !important; }
    [data-component="dialog-overlay"]    { display: none !important; pointer-events: none !important; }
    [data-component="dialog"][data-transition] [data-slot="dialog-content"] {
      animation: none !important; transition: none !important;
    }
  </style>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data: blob:; font-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; connect-src ${webview.cspSource} http: https: ws: wss:; worker-src ${webview.cspSource} blob:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <link href="${codiconStyleUri}" rel="stylesheet" />
    ${systemThemeCSS}
    ${codeBlockCSS}
    ${statusActionsCSS}
    ${settingsModeCSS}
    <script nonce="${nonce}">window.__OPENCODE_VSCODE_CONFIG__ = ${JSON.stringify(config)};</script>
    <script nonce="${nonce}">${storagePreload}</script>
    <script nonce="${nonce}">${themePreload}</script>
    <script nonce="${nonce}">${freeBadgePreload}</script>
    <script nonce="${nonce}">${statusActionsPreload}</script>
    <title>Opencoder</title>
  </head>
  <body class="antialiased overscroll-none overflow-hidden">
    <div id="root" class="flex flex-col h-dvh p-px"></div>
    <script type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}
