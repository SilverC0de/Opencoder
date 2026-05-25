import * as path from "node:path";
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

const DIFF_SCHEME = "opencoder-diff";
const MAX_DIFF_ENTRIES = 200;

export class OpenCodeSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "opencoder.sidebar";

  private readonly disposables: vscode.Disposable[] = [];
  private readonly fetches = new Map<string, AbortController>();
  private readonly diffContent = new Map<string, string>();
  private view?: vscode.WebviewView;
  private ready = false;
  private readonly pendingMessages: HostToWebviewMessage[] = [];
  private readonly stopBridge = storageBridge.register("sidebar", (msg) => this.postMessage(msg));

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: OpenCodeService,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, {
        provideTextDocumentContent: (uri) => this.diffContent.get(uri.toString()) ?? "",
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === DIFF_SCHEME) this.diffContent.delete(doc.uri.toString());
      }),
    );
  }

  dispose() {
    this.stopBridge();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async reveal() {
    await vscode.commands.executeCommand("workbench.view.extension.opencoder");
    this.view?.show?.(true);
  }

  async reload() {
    await this.render();
  }

  dispatchAction(action: HostAction) {
    this.postMessage({ type: "hostAction", action });
  }

  notifyTheme() {
    this.postMessage({ type: "hostTheme", colorScheme: getColorScheme() });
  }

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    const onMessage = webviewView.webview.onDidReceiveMessage(async (msg: WebviewToHostMessage) => {
      await this.handleMessage(msg);
    });
    const onDispose = webviewView.onDidDispose(() => {
      this.view = undefined;
      onMessage.dispose();
    });

    this.disposables.push(onMessage, onDispose);
    await this.render();
  }

  private async handleMessage(message: WebviewToHostMessage) {
    try {
      switch (message.type) {
        case "webviewReady":
          this.ready = true;
          this.flushMessages();
          this.notifyTheme();
          storageBridge.ready("sidebar");
          return;

        case "hostAction":
          await this.handleHostAction(message.action);
          return;

        case "openLink":
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
          return;

        case "openFile":
          await this.openFile(message.filePath, message.range);
          return;

        case "openDiff":
          await this.openDiff(message.filePath, message.before, message.after);
          return;

        case "openSettings":
          await vscode.commands.executeCommand("opencoder.openSettings");
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
          storageBridge.apply("sidebar", message);
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
    if (!this.view) return;

    this.ready = false;
    let serverUrl = this.service.getResolvedServerBaseUrl();
    let disableHealthCheck = false;

    try {
      serverUrl = await this.service.ensureServerReady();
      disableHealthCheck = await shouldDisableHealthCheck(serverUrl);
    } catch (error) {
      this.service.logOutput(`[sidebar render] ${error instanceof Error ? error.message : String(error)}`);
      disableHealthCheck = true;
      serverUrl = this.service.getResolvedServerBaseUrl();
    }

    const workspaceDirectory = this.service.getWorkspaceContext().directory ?? null;
    this.view.webview.html = getWebviewHtml(this.view.webview, this.context.extensionUri, {
      serverUrl,
      version: String(this.context.extension.packageJSON.version ?? "0.0.0"),
      workspaceDirectory,
      colorScheme: getColorScheme(),
      disableHealthCheck,
      sharedStorage: storageBridge.snapshot(),
      nativeSettings: getNativeSettings(),
    });
  }

  private async openFile(
    filePath: string,
    range?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number },
  ) {
    const baseDir = this.service.getActiveSessionDirectory();
    const targetPath = path.isAbsolute(filePath) ? filePath : path.join(baseDir ?? "", filePath);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    if (range) {
      const selection = new vscode.Selection(
        new vscode.Position(range.startLine, range.startCharacter),
        new vscode.Position(range.endLine, range.endCharacter),
      );
      editor.selection = selection;
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
    }
  }

  private async handleHostAction(action: HostAction) {
    switch (action) {
      case "newSession":
        await vscode.commands.executeCommand("opencoder.newSession");
        return;
      case "refresh":
        await this.service.refresh();
        return;
      case "openSettings":
        await vscode.commands.executeCommand("opencoder.openSettings");
        return;
      case "history":
        await vscode.commands.executeCommand("opencoder.switchSession");
        return;
    }
  }

  private async openDiff(filePath: string, before: string, after: string) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const left = this.createDiffUri(filePath, "before", before, id);
    const right = this.createDiffUri(filePath, "after", after, id);
    await vscode.commands.executeCommand("vscode.diff", left, right, `Opencoder Diff: ${filePath}`, { preview: false });
  }

  private createDiffUri(filePath: string, side: "before" | "after", content: string, id: string) {
    const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "") || "untitled";
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${side}/${id}/${normalized}` });
    this.diffContent.set(uri.toString(), content);
    while (this.diffContent.size > MAX_DIFF_ENTRIES) {
      const key = this.diffContent.keys().next().value;
      if (key) this.diffContent.delete(key);
      else break;
    }
    return uri;
  }

  private flushMessages() {
    while (this.ready && this.view && this.pendingMessages.length > 0) {
      const msg = this.pendingMessages.shift();
      if (msg) void this.view.webview.postMessage(msg);
    }
  }

  private postMessage(message: HostToWebviewMessage) {
    if (!this.ready || !this.view) {
      this.pendingMessages.push(message);
      return;
    }
    void this.view.webview.postMessage(message);
  }
}
