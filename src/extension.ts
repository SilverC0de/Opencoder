import * as vscode from "vscode";
import { OpenCodeService } from "./opencodeService";
import { OpenCodeSidebarProvider } from "./sidebarProvider";
import { OpenCodeSettingsPanel } from "./settingsPanel";
import { sameWorkspace } from "./pathUtils";

export async function activate(context: vscode.ExtensionContext) {
  const service       = new OpenCodeService(context);
  const sidebar       = new OpenCodeSidebarProvider(context, service);
  const settingsPanel = new OpenCodeSettingsPanel(context, service);

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "opencoder-ui.focus";
  context.subscriptions.push(
    statusBar,
    service.onDidChangeState((state) => {
      const { connection } = state;
      if (connection.status === "connected") {
        statusBar.text = "$(check)";
        statusBar.tooltip = `Connected to ${connection.baseUrl}`;
        statusBar.backgroundColor = undefined;
        statusBar.command = "opencoder-ui.focus";
      } else if (connection.status === "connecting") {
        statusBar.text = "$(sync~spin)";
        statusBar.tooltip = connection.error ?? "Connecting...";
        statusBar.backgroundColor = undefined;
        statusBar.command = "opencoder-ui.focus";
      } else {
        statusBar.text = "$(warning)";
        statusBar.tooltip = connection.error ?? "Connection error";
        statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        statusBar.command = "opencoder-ui.openSettings";
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
      if (!event.affectsConfiguration("opencoder-ui")) return;
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
    vscode.commands.registerCommand("opencoder-ui.focus", async () => {
      await sidebar.reveal();
    }),
    vscode.commands.registerCommand("opencoder-ui.newSession", async () => {
      await sidebar.reveal();
      sidebar.dispatchAction("newSession");
    }),
    vscode.commands.registerCommand("opencoder-ui.refresh", async () => {
      await sidebar.reload();
      await sidebar.reveal();
    }),
    vscode.commands.registerCommand("opencoder-ui.openSettings", async () => {
      await settingsPanel.open();
    }),
    vscode.commands.registerCommand("opencoder-ui.restartServer", async () => {
      await service.ensureServerReady(true);
      await sidebar.reload();
      await settingsPanel.reload();
    }),
    vscode.commands.registerCommand("opencoder-ui.openTerminal", async () => {
      const settings = vscode.workspace.getConfiguration("opencoder-ui");
      const opencodePath = settings.get<string>("opencodePath", "opencode");
      const cwd = service.getWorkspaceContext().directory;
      const terminal = vscode.window.createTerminal({ name: "Opencoder", cwd });
      terminal.sendText(opencodePath);
      terminal.show();
    }),
    vscode.commands.registerCommand("opencoder-ui.installCli", async () => {
      await service.installCli();
    }),
    vscode.commands.registerCommand("opencoder-ui.switchSession", async () => {
      const state = service.getState();
      const all = await vscode.window.withProgress(
        { location: { viewId: "opencoder-ui.sidebar" } },
        () => service.listAllSessions().catch(() => []),
      );

      const projectDir = state.workspace.directory;
      const scoped = projectDir
        ? all.filter((s) => s.directory && sameWorkspace(s.directory, projectDir))
        : all;

      if (scoped.length === 0) {
        void vscode.window.showInformationMessage("No OpenCode sessions available for this project.");
        return;
      }

      const items = scoped.map((s) => ({
        label: s.title || "Untitled session",
        detail: new Date(s.updated).toLocaleString(),
        picked: s.id === state.activeSessionId,
        sessionId: s.id,
        directory: s.directory,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a session",
        canPickMany: false,
      });

      if (!selected) return;
      await service.selectSession(selected.sessionId);
      await sidebar.reveal();
      const directory = selected.directory ?? service.getActiveSessionDirectory();
      if (directory) {
        const bytes = new TextEncoder().encode(directory);
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        const encoded = Buffer.from(bin, "binary").toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        sidebar.navigate(`/${encoded}/session/${selected.sessionId}`);
      }
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
