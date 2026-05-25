import * as vscode from "vscode";
import { OpenCodeService } from "./opencodeService";
import { OpenCodeSidebarProvider } from "./sidebarProvider";
import { OpenCodeSettingsPanel } from "./settingsPanel";

export async function activate(context: vscode.ExtensionContext) {
  const service       = new OpenCodeService(context);
  const sidebar       = new OpenCodeSidebarProvider(context, service);
  const settingsPanel = new OpenCodeSettingsPanel(context, service);

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "opencoder.focus";
  context.subscriptions.push(
    statusBar,
    service.onDidChangeState((state) => {
      const { connection } = state;
      if (connection.status === "connected") {
        statusBar.text = "$(check) Opencoder";
        statusBar.tooltip = `Connected to ${connection.baseUrl}`;
        statusBar.backgroundColor = undefined;
        statusBar.command = "opencoder.focus";
      } else if (connection.status === "connecting") {
        statusBar.text = "$(sync~spin) Opencoder";
        statusBar.tooltip = connection.error ?? "Connecting...";
        statusBar.backgroundColor = undefined;
        statusBar.command = "opencoder.focus";
      } else {
        statusBar.text = "$(warning) Opencoder";
        statusBar.tooltip = connection.error ?? "Connection error";
        statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        statusBar.command = "opencoder.openSettings";
      }
      statusBar.show();
    }),
  );

  context.subscriptions.push(service, sidebar, settingsPanel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OpenCodeSidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Workspace sync
  const syncWorkspace = (reloadOnChange: boolean) => {
    void service.syncWorkspaceContext()
      .then(async (changed) => { if (reloadOnChange && changed) await sidebar.reload(); })
      .catch((error) => {
        service.logOutput(`[syncWorkspace] ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => syncWorkspace(false)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => syncWorkspace(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("opencoder")) return;
      void sidebar.reload();
      void settingsPanel.reload();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => syncWorkspace(false)),
    vscode.window.onDidChangeActiveColorTheme(() => {
      sidebar.notifyTheme();
      settingsPanel.notifyTheme();
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("opencoder.focus", async () => {
      await sidebar.reveal();
    }),
    vscode.commands.registerCommand("opencoder.newSession", async () => {
      await sidebar.reveal();
      sidebar.dispatchAction("newSession");
    }),
    vscode.commands.registerCommand("opencoder.refresh", async () => {
      await sidebar.reload();
      await sidebar.reveal();
    }),
    vscode.commands.registerCommand("opencoder.openSettings", async () => {
      await settingsPanel.open();
    }),
    vscode.commands.registerCommand("opencoder.restartServer", async () => {
      await service.ensureServerReady(true);
      await sidebar.reload();
      await settingsPanel.reload();
    }),
    vscode.commands.registerCommand("opencoder.openTerminal", async () => {
      const settings = vscode.workspace.getConfiguration("opencoder");
      const opencodePath = settings.get<string>("opencodePath", "opencode");
      const cwd = service.getWorkspaceContext().directory;
      const terminal = vscode.window.createTerminal({ name: "Opencoder", cwd });
      terminal.sendText(opencodePath);
      terminal.show();
    }),
    vscode.commands.registerCommand("opencoder.installCli", async () => {
      await service.installCli();
    }),
    vscode.commands.registerCommand("opencoder.switchSession", async () => {
      const state = service.getState();
      if (state.sessions.length === 0) {
        void vscode.window.showInformationMessage("No OpenCode sessions available.");
        return;
      }

      const items = state.sessions.map((s) => ({
        label: s.title || "Untitled session",
        description: s.id,
        picked: s.id === state.activeSessionId,
        sessionId: s.id,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session",
        canPickMany: false,
      });

      if (!selected) return;
      await service.selectSession(selected.sessionId);
      await sidebar.reveal();
    }),
  );

  // Boot
  const cliAvailable = await service.ensureCliInstalled();
  if (cliAvailable) {
    void service.ensureServerReady().catch((error) => {
      service.logOutput(`[activate] ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

export function deactivate() {
  // VS Code disposes subscriptions registered during activation.
}
