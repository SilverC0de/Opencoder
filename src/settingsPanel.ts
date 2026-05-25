import * as vscode from "vscode";
import { getWebviewHtml } from "./webviewHtml";
import { OpenCodeService } from "./opencodeService";
import { storageBridge } from "./storageBridge";
import {
  getNativeSettings,
  getExtensionSettings,
  setExtensionSetting,
  shouldDisableHealthCheck,
  getColorScheme,
  handleFetch,
  pickDirectory,
} from "./webviewHostUtils";
import type { HostAction, HostToWebviewMessage, WebviewToHostMessage } from "./webviewProtocol";

export class OpenCodeSettingsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private readonly pendingMessages: HostToWebviewMessage[] = [];
  private readonly fetches = new Map<string, AbortController>();
  private panelDisposables: vscode.Disposable[] = [];
  private readonly stopBridge = storageBridge.register("settings", (msg) => this.postMessage(msg));

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: OpenCodeService,
  ) {}

  dispose() {
    this.stopBridge();
    for (const abort of this.fetches.values()) abort.abort();
    this.fetches.clear();
    this.disposePanel();
  }

  async open() {
    if (!this.panel) {
      await this.createPanel();
      this.dispatch("openSettings");
      return;
    }

    try {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      await this.render();
    } catch {
      this.panel = undefined;
      this.clearState();
      await this.createPanel();
    }

    this.dispatch("openSettings");
  }

  async reload() {
    if (!this.panel) return;
    try {
      await this.render();
    } catch (error) {
      if (this.isDisposed(error)) { this.resetDisposed(); return; }
      throw error;
    }
  }

  notifyTheme() {
    if (!this.panel) return;
    this.postMessage({ type: "hostTheme", colorScheme: getColorScheme() });
  }

  private async createPanel() {
    const panel = vscode.window.createWebviewPanel(
      "opencoder.settings",
      "Opencoder Settings",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")] },
    );

    this.panel = panel;
    this.ready = false;

    const onMessage = panel.webview.onDidReceiveMessage(async (msg: WebviewToHostMessage) => {
      await this.handleMessage(msg);
    });
    const onDispose = panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.clearState();
    });

    this.panelDisposables.push(onMessage, onDispose);
    await this.render();
  }

  private disposePanel() {
    const panel = this.panel;
    this.panel = undefined;
    this.clearState();
    panel?.dispose();
  }

  private clearState() {
    this.ready = false;
    this.pendingMessages.length = 0;
    for (const abort of this.fetches.values()) abort.abort();
    this.fetches.clear();
    vscode.Disposable.from(...this.panelDisposables).dispose();
    this.panelDisposables = [];
  }

  private isDisposed(error: unknown) {
    return /webview is disposed|disposed/i.test(error instanceof Error ? error.message : String(error ?? ""));
  }

  private resetDisposed() {
    this.panel = undefined;
    this.clearState();
  }

  private async handleMessage(message: WebviewToHostMessage) {
    try {
      switch (message.type) {
        case "webviewReady":
          this.ready = true;
          this.flushMessages();
          storageBridge.ready("settings");
          return;

        case "openLink":
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;

        case "openDiff":
          await this.openDiff(message.filePath, message.before, message.after);
          return;

        case "openSettings":
          this.dispatch("openSettings");
          return;

        case "pickDirectory":
          await pickDirectory(message.requestId, message.title, message.multiple, (msg) => this.postMessage(msg));
          return;

        case "fetchAbort":
          this.fetches.get(message.requestId)?.abort();
          this.fetches.delete(message.requestId);
          return;

        case "fetchRequest":
          await handleFetch(message, this.service, this.fetches, (msg) => this.postMessage(msg));
          return;

        case "getExtensionSettings":
          this.postMessage({ type: "extensionSettingsResult", requestId: message.requestId, value: getExtensionSettings() });
          return;

        case "setExtensionSetting":
          try {
            const value = await setExtensionSetting(message.key, message.value);
            this.postMessage({ type: "extensionSettingResult", requestId: message.requestId, value });
          } catch (error) {
            this.postMessage({ type: "extensionSettingResult", requestId: message.requestId, value: null, error: String(error instanceof Error ? error.message : error) });
          }
          return;

        case "storageSet":
        case "storageRemove":
          storageBridge.apply("settings", message);
          return;

        case "restartServer":
          try {
            await vscode.commands.executeCommand("opencoder.restartServer");
            this.postMessage({ type: "restartServerResult", requestId: message.requestId });
          } catch (error) {
            this.postMessage({ type: "restartServerResult", requestId: message.requestId, error: String(error instanceof Error ? error.message : error) });
          }
          return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
    }
  }

  private async render() {
    const panel = this.panel;
    if (!panel) return;

    this.ready = false;
    let serverUrl = this.service.getResolvedServerBaseUrl();
    let disableHealthCheck = false;

    try {
      serverUrl = await this.service.ensureServerReady();
      disableHealthCheck = await shouldDisableHealthCheck(serverUrl);
    } catch (error) {
      this.service.logOutput(`[settings render] ${error instanceof Error ? error.message : String(error)}`);
      disableHealthCheck = true;
      serverUrl = this.service.getResolvedServerBaseUrl();
    }

    if (this.panel !== panel) return;

    try {
      panel.webview.html = getWebviewHtml(panel.webview, this.context.extensionUri, {
        serverUrl,
        version: String(this.context.extension.packageJSON.version ?? "0.0.0"),
        workspaceDirectory: this.service.getWorkspaceContext().directory ?? null,
        colorScheme: getColorScheme(),
        disableHealthCheck,
        settingsMode: true,
        sharedStorage: storageBridge.snapshot(),
        nativeSettings: getNativeSettings(),
      });
    } catch (error) {
      if (this.isDisposed(error)) { this.resetDisposed(); return; }
      throw error;
    }
  }

  private async openDiff(filePath: string, before: string, after: string) {
    const left  = await vscode.workspace.openTextDocument({ content: before });
    const right = await vscode.workspace.openTextDocument({ content: after });
    await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, `Opencoder Diff: ${filePath}`, { preview: false });
  }

  private dispatch(action: HostAction) {
    this.postMessage({ type: "hostAction", action });
  }

  private postMessage(message: HostToWebviewMessage) {
    const panel = this.panel;
    if (!this.ready || !panel) { this.pendingMessages.push(message); return; }
    this.send(panel, message);
  }

  private flushMessages() {
    while (this.ready && this.panel && this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift();
      if (!msg) return;
      const panel = this.panel;
      if (!panel) return;
      this.send(panel, msg);
    }
  }

  private send(panel: vscode.WebviewPanel, message: HostToWebviewMessage) {
    try {
      void panel.webview.postMessage(message).then(undefined, (error) => {
        if (this.isDisposed(error)) { this.resetDisposed(); return; }
        void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
      });
    } catch (error) {
      if (this.isDisposed(error)) this.resetDisposed();
    }
  }
}
