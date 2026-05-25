import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createOpencodeClient,
  type Command,
  type Config,
  type Event,
  type FileDiff,
  type FilePartInput,
  type Message,
  type OpencodeClient,
  type Part,
  type Permission,
  type Session,
  type SessionStatus,
  type TextPartInput,
  type Todo,
} from "@opencode-ai/sdk";
import type {
  Agent as V2Agent,
  Project as V2Project,
  ProviderListResponse as V2ProviderListResponse,
  VcsInfo as V2VcsInfo,
} from "@opencode-ai/sdk/v2";
import { createOpencodeClient as createOpencodeV2Client } from "@opencode-ai/sdk/v2/client";
import type {
  ComposerAttachmentPayload,
  ComposerSelection,
  ModelOption,
  ProviderOption,
  SidebarState,
  ThreadEntry,
} from "./types";
import { sameWorkspace, workspaceKey } from "./pathUtils";

const REQUEST_OPTIONS = { responseStyle: "data" as const, throwOnError: true as const };

const ACTIVE_SESSION_KEY = "opencoder-ui.activeSession";
const LAST_SESSION_KEY = "opencoder-ui.lastSession";
const COMMAND_LOOKUP_TIMEOUT_MS = 2500;

type LocalServerHandle = { process: ChildProcessWithoutNullStreams; url: string };
type WorkspaceContext = { name: string; directory?: string; hasWorkspace: boolean };
type DataResult<T> = T | { data: T };
type ProviderCatalogModel = V2ProviderListResponse["all"][number]["models"][string];
type ResolvedConfig = Pick<Config, "model" | "small_model">;

export class OpenCodeService implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<SidebarState>();
  private readonly output = vscode.window.createOutputChannel("Opencoder");

  private client?: OpencodeClient;
  private server?: LocalServerHandle;
  private streamAbort?: AbortController;
  private busyPollTimer?: ReturnType<typeof setInterval>;
  private busyPollSessionId?: string;
  private busyPollPending = false;
  private networkNoticeUntil = 0;
  private currentDirectory?: string;
  private bootstrapPromise?: Promise<void>;
  private serverStartPromise?: Promise<LocalServerHandle> | null;

  private sessions: Session[] = [];
  private thread: ThreadEntry[] = [];
  private permissions = new Map<string, Permission>();
  private todos: Todo[] = [];
  private diffs: FileDiff[] = [];
  private commands: Command[] = [];
  private agents: V2Agent[] = [];
  private providers: ProviderOption[] = [];
  private models: ModelOption[] = [];
  private vcs?: V2VcsInfo;
  private project: V2Project | null = null;
  private sessionStatuses = new Map<string, SessionStatus>();
  private lastError?: string;
  private resolvedConfig: ResolvedConfig = {};
  private activeSessionId?: string;
  private composer: ComposerSelection = {};
  private connectionState: SidebarState["connection"];

  readonly onDidChangeState = this.stateEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.connectionState = {
      status: "connecting",
      baseUrl: this.getSettings().serverBaseUrl,
      managed: false,
    };
  }

  logOutput(message: string) {
    this.output.appendLine(message);
  }

  dispose() {
    this.stopStream();
    this.stopBusyPolling();
    this.stopServer();
    this.stateEmitter.dispose();
    this.output.dispose();
  }

  async bootstrap() {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.ensureReady()
        .then(() => undefined)
        .finally(() => { this.bootstrapPromise = undefined; });
    }
    await this.bootstrapPromise;
  }

  async ensureServerReady(forceRestart = false) {
    if (forceRestart) this.stopServer();
    if (this.server) return this.server.url;

    const settings = this.getSettings();
    const baseUrl = settings.serverBaseUrl;
    this.connectionState = { status: "connecting", baseUrl, managed: false };
    this.emitState();

    try {
      await this.pingServer(baseUrl);
      this.connectionState = { status: "connected", baseUrl, managed: false };
      this.emitState();
      return baseUrl;
    } catch {
      if (!settings.autoStartServer) {
        this.connectionState = { status: "error", baseUrl, managed: false, error: "Server unreachable." };
        this.emitState();
        throw new Error("Server unreachable.");
      }
    }

    const server = await this.startManagedServer();
    this.connectionState = { status: "connected", baseUrl: server.url, managed: true };
    this.emitState();
    return server.url;
  }

  getResolvedServerBaseUrl() {
    return this.server?.url ?? this.getSettings().serverBaseUrl;
  }

  async refresh() {
    await this.ensureReady(true);
  }

  reportNetworkIssue(detail: string) {
    this.output.appendLine(`[network] ${detail}`);
    const now = Date.now();
    if (now < this.networkNoticeUntil) return;
    this.networkNoticeUntil = now + 15000;

    void vscode.window
      .showWarningMessage(this.getNetworkHint(detail), "Open Settings", "Restart Server", "Show Output")
      .then((action) => {
        if (action === "Open Settings") void vscode.commands.executeCommand("opencoder-ui.openSettings");
        if (action === "Restart Server") void vscode.commands.executeCommand("opencoder-ui.restartServer");
        if (action === "Show Output") this.output.show(true);
      });
  }

  async syncWorkspaceContext() {
    const next = this.getWorkspaceContext().directory;
    if (!this.sameDirectory(next, this.currentDirectory)) {
      await this.ensureReady(true);
      return true;
    }
    this.emitState();
    return false;
  }

  getState(): SidebarState {
    return {
      connection: this.connectionState,
      lastError: this.lastError,
      workspace: this.getWorkspaceContext(),
      sessions: this.sessions,
      sessionStatuses: Object.fromEntries(this.sessionStatuses.entries()),
      activeSessionId: this.activeSessionId,
      thread: this.thread,
      permissions: this.getActivePermissions(),
      todos: this.todos,
      diffs: this.diffs,
      commands: this.commands,
      agents: this.agents,
      providers: this.providers,
      models: this.models,
      composer: this.composer,
      vcs: this.vcs,
      project: this.project,
      config: {
        model: this.resolvedConfig.model,
        smallModel: this.resolvedConfig.small_model,
      },
    };
  }

  async setComposerSelection(composer: ComposerSelection) {
    const providerID = composer.providerID ?? undefined;
    const providerModels = providerID ? this.models.filter((m) => m.providerID === providerID) : [];
    const providerDefaultModelID = providerID
      ? this.providers.find((p) => p.id === providerID)?.defaultModelID
      : undefined;
    const fallback = providerModels.find((m) => m.modelID === providerDefaultModelID) ?? providerModels[0];
    const selectedModel = composer.modelID && providerModels.some((m) => m.modelID === composer.modelID)
      ? composer.modelID
      : fallback?.modelID;
    const selectedModelOption = providerModels.find((m) => m.modelID === selectedModel) ?? fallback;

    this.composer = {
      providerID: providerID ?? fallback?.providerID,
      modelID: selectedModel,
      agent: this.normalizeComposerAgent(composer.agent),
      variant: this.normalizeComposerVariant(selectedModelOption, composer.variant),
    };
    this.emitState();
  }

  async createSession() {
    this.lastError = undefined;
    const client = await this.ensureReady();
    const session = this.unwrap(await client.session.create(REQUEST_OPTIONS));
    this.upsertSession(session);
    this.activeSessionId = session.id;
    this.persistActiveSessionId();
    this.updateBusyPolling();
    await this.loadActiveSession(session.id);
    this.emitState();
    return session;
  }

  async selectSession(sessionId: string) {
    this.lastError = undefined;
    this.activeSessionId = sessionId;
    this.persistActiveSessionId();
    this.updateBusyPolling();
    await this.loadActiveSession(sessionId);
    this.emitState();
  }

  async listAllSessions() {
    await this.ensureReady();
    const baseUrl = this.server?.url ?? this.getSettings().serverBaseUrl;
    const client = createOpencodeV2Client({ baseUrl, ...REQUEST_OPTIONS });
    const sessions = this.unwrap(await client.experimental.session.list({ limit: 500 }, REQUEST_OPTIONS));
    return sessions
      .map((s) => ({ id: s.id, title: s.title, directory: s.directory, updated: s.time.updated }))
      .sort((a, b) => b.updated - a.updated);
  }

  async deleteSession(sessionId: string) {
    this.lastError = undefined;
    const confirmed = await vscode.window.showWarningMessage(
      "Delete this OpenCode session?",
      { modal: false },
      "Delete",
    );
    if (confirmed !== "Delete") return;

    const client = await this.ensureReady();
    await client.session.delete({ ...REQUEST_OPTIONS, path: { id: sessionId } });

    if (this.activeSessionId === sessionId) {
      this.activeSessionId = undefined;
      this.updateBusyPolling();
    }
    await this.refreshState();
  }

  async renameSession(sessionId: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.lastError = undefined;
    const client = await this.ensureReady();
    await client.session.update({ ...REQUEST_OPTIONS, path: { id: sessionId }, body: { title: trimmed } });
    await this.refreshState();
  }

  async archiveSession(sessionId: string) {
    this.lastError = undefined;
    const directory = this.sessions.find((s) => s.id === sessionId)?.directory ?? this.currentDirectory;
    if (!directory) throw new Error("Open a workspace folder before archiving a session.");

    const v2 = this.createV2Client(this.server?.url ?? this.getSettings().serverBaseUrl, directory);
    await v2.session.update({ sessionID: sessionId, directory, time: { archived: Date.now() } }, REQUEST_OPTIONS);
    await this.refreshState();
  }

  async sendPrompt(text: string, attachments: FilePartInput[]) {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;

    this.lastError = undefined;
    await this.ensureReady();
    const session = await this.ensureSessionForPrompt(trimmed || "OpenCode session");
    const sessionId = session.id;
    const directory = session.directory ?? this.currentDirectory;
    if (!directory) throw new Error("Open a workspace folder before sending prompts.");

    const v2 = this.createV2Client(this.server?.url ?? this.getSettings().serverBaseUrl, directory);
    const variant = this.composer.variant ?? undefined;

    if (trimmed.startsWith("/")) {
      const commandText = trimmed.slice(1).trim();
      const spaceIdx = commandText.indexOf(" ");
      const command = spaceIdx === -1 ? commandText : commandText.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : commandText.slice(spaceIdx + 1);
      if (!command) return;

      this.sessionStatuses.set(sessionId, { type: "busy" });
      this.updateBusyPolling();
      this.emitState();
      await v2.session.command({
        sessionID: sessionId, directory, command, arguments: args || undefined,
        agent: this.composer.agent || "build", model: this.getCommandModel(), variant,
      }, REQUEST_OPTIONS);
      await this.loadActiveSession(sessionId);
      return;
    }

    const parts: Array<TextPartInput | FilePartInput> = [];
    if (trimmed) parts.push({ type: "text", text: trimmed });
    parts.push(...attachments);

    this.sessionStatuses.set(sessionId, { type: "busy" });
    this.updateBusyPolling();
    this.emitState();

    await v2.session.promptAsync({
      sessionID: sessionId, directory, parts,
      agent: this.composer.agent || "build", model: this.getPromptModel(), variant,
    }, REQUEST_OPTIONS);

    await this.loadActiveSession(sessionId);
  }

  async replyToPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject") {
    const client = await this.ensureReady();
    await client.postSessionIdPermissionsPermissionId({
      ...REQUEST_OPTIONS,
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    });
    this.permissions.delete(permissionId);
    this.emitState();
  }

  async abortSession(sessionId: string) {
    const client = await this.ensureReady();
    await client.session.abort({ ...REQUEST_OPTIONS, path: { id: sessionId } });
  }

  async shareSession(sessionId: string) {
    const client = await this.ensureReady();
    const session = this.unwrap(await client.session.share({ ...REQUEST_OPTIONS, path: { id: sessionId } }));
    this.upsertSession(session);
    this.emitState();
    return session.share?.url;
  }

  async unshareSession(sessionId: string) {
    const client = await this.ensureReady();
    const session = this.unwrap(await client.session.unshare({ ...REQUEST_OPTIONS, path: { id: sessionId } }));
    this.upsertSession(session);
    this.emitState();
  }

  async revertSession(sessionId: string) {
    this.lastError = undefined;
    const client = await this.ensureReady();
    const target = this.thread.at(-1);
    if (!target) { vscode.window.showInformationMessage("No message to revert."); return; }
    const session = this.unwrap(await client.session.revert({
      ...REQUEST_OPTIONS, path: { id: sessionId }, body: { messageID: target.info.id },
    }));
    this.upsertSession(session);
    await this.loadActiveSession(sessionId);
  }

  async unrevertSession(sessionId: string) {
    this.lastError = undefined;
    const client = await this.ensureReady();
    const session = this.unwrap(await client.session.unrevert({ ...REQUEST_OPTIONS, path: { id: sessionId } }));
    this.upsertSession(session);
    await this.loadActiveSession(sessionId);
  }

  async summarizeSession(sessionId: string) {
    this.lastError = undefined;
    const client = await this.ensureReady();
    const model = this.getPromptModel();
    if (!model) { vscode.window.showInformationMessage("Select a model before compacting."); return; }
    await client.session.summarize({ ...REQUEST_OPTIONS, path: { id: sessionId }, body: model });
    vscode.window.showInformationMessage("Session compacted.");
  }

  async runInit(sessionId: string) {
    this.lastError = undefined;
    const client = await this.ensureReady();
    const messages = this.unwrap(await client.session.messages({ ...REQUEST_OPTIONS, path: { id: sessionId } }));
    const userMsg = [...messages].reverse().find((m) => m.info.role === "user");
    const model = this.getPromptModel();
    if (!userMsg || !model) {
      vscode.window.showInformationMessage("Select a model and send at least one prompt before running init.");
      return;
    }
    await client.session.init({
      ...REQUEST_OPTIONS,
      path: { id: sessionId },
      body: { messageID: userMsg.info.id, providerID: model.providerID, modelID: model.modelID },
    });
    vscode.window.showInformationMessage("OpenCode init started.");
  }

  async captureEditorAttachment(selectionOnly: boolean): Promise<ComposerAttachmentPayload | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage("Open a file in the editor first."); return; }

    const doc = editor.document;
    if (selectionOnly && editor.selection.isEmpty) {
      vscode.window.showInformationMessage("Select some text first.");
      return;
    }

    const range = selectionOnly && !editor.selection.isEmpty
      ? editor.selection
      : new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const text = doc.getText(range);
    if (!text.trim()) { vscode.window.showInformationMessage("The file or selection is empty."); return; }

    const relativePath = vscode.workspace.asRelativePath(doc.uri, false);
    return {
      label: selectionOnly ? `${relativePath} (selection)` : relativePath,
      attachment: {
        type: "file",
        mime: "text/plain",
        filename: path.basename(doc.fileName || relativePath || "context.txt"),
        url: doc.uri.toString(),
        source: {
          type: "file",
          path: relativePath,
          text: { value: text, start: doc.offsetAt(range.start), end: doc.offsetAt(range.end) },
        },
      },
    };
  }

  async captureImageAttachment(): Promise<ComposerAttachmentPayload | undefined> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      openLabel: "Insert image",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
    });

    const imageUri = selected?.[0];
    if (!imageUri) return;

    const relativePath = vscode.workspace.asRelativePath(imageUri, false);
    return {
      label: relativePath || path.basename(imageUri.fsPath),
      attachment: {
        type: "file",
        mime: this.getImageMimeType(imageUri.fsPath),
        filename: path.basename(imageUri.fsPath),
        url: imageUri.toString(),
      },
    };
  }

  getActiveSessionDirectory() {
    const session = this.sessions.find((s) => s.id === this.activeSessionId);
    return session?.directory ?? this.currentDirectory;
  }

  getWorkspaceContext(): WorkspaceContext {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    const folder = activeFolder ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder) return { hasWorkspace: false, name: "No workspace" };
    return { hasWorkspace: true, name: folder.name, directory: folder.uri.fsPath };
  }

  async isCliAvailable(): Promise<boolean> {
    const settings = this.getSettings();
    const env = this.buildManagedServerEnv();
    try {
      const command = await this.resolveOpencodeCommand(settings.opencodePath, env.PATH);
      return Boolean(command);
    } catch {
      return false;
    }
  }

  async installCli(): Promise<boolean> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing OpenCode CLI...", cancellable: false },
      async (progress) => {
        try {
          progress.report({ message: "Running npm install -g opencode-ai..." });
          this.output.appendLine("[install] Installing opencode-ai via npm...");
          const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
          const result = await this.runCommand(npmCommand, ["install", "-g", "opencode-ai"], { timeout: 120000 });

          if (result.exitCode !== 0) throw new Error(`npm install failed: ${result.stderr || result.stdout}`);
          this.output.appendLine("[install] Done.");

          const available = await this.isCliAvailable();
          if (!available) {
            const npmBin = await this.getNpmGlobalBin();
            if (npmBin) {
              const candidate = process.platform === "win32"
                ? path.join(npmBin, "opencode.cmd")
                : path.join(npmBin, "opencode");
              if (await this.fileCanExecute(candidate)) {
                await vscode.workspace.getConfiguration("opencoder-ui").update("opencodePath", candidate, vscode.ConfigurationTarget.Global);
                return true;
              }
            }
            vscode.window.showInformationMessage("CLI installed but not in PATH. Restart VS Code or set opencoder-ui.opencodePath manually.");
            return true;
          }

          vscode.window.showInformationMessage("OpenCode CLI installed successfully!");
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[install] Failed: ${detail}`);
          const action = await vscode.window.showErrorMessage("Failed to install OpenCode CLI.", "Install Manually", "Retry");
          if (action === "Install Manually") void vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai"));
          if (action === "Retry") void vscode.commands.executeCommand("opencoder-ui.installCli");
          return false;
        }
      },
    );
  }

  async ensureCliInstalled(): Promise<boolean> {
    const available = await this.isCliAvailable();
    if (available) return true;

    const action = await vscode.window.showInformationMessage(
      "OpenCode CLI is not installed. Install it now?",
      "Install via npm",
      "Learn More",
    );
    if (action === "Install via npm") return this.installCli();
    if (action === "Learn More") void vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai"));
    return false;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private async ensureSessionForPrompt(titleSeed: string) {
    if (this.activeSessionId) {
      const existing = this.sessions.find((s) => s.id === this.activeSessionId);
      if (existing) return existing;
    }
    const session = await this.createSessionWithTitle(titleSeed);
    this.activeSessionId = session.id;
    this.persistActiveSessionId();
    this.updateBusyPolling();
    return session;
  }

  private async createSessionWithTitle(titleSeed: string) {
    const client = await this.ensureReady();
    const session = this.unwrap(await client.session.create({
      ...REQUEST_OPTIONS,
      body: { title: titleSeed.replace(/^\//, "").trim().slice(0, 80) || "OpenCode session" },
    }));
    this.upsertSession(session);
    return session;
  }

  private getImageMimeType(filePath: string) {
    switch (path.extname(filePath).toLowerCase()) {
      case ".jpg": case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".svg": return "image/svg+xml";
      default: return "image/png";
    }
  }

  private getPromptModel() {
    if (this.composer.providerID && this.composer.modelID) {
      return { providerID: this.composer.providerID, modelID: this.composer.modelID };
    }
    const fallback = this.models[0];
    if (!fallback) return undefined;
    return { providerID: fallback.providerID, modelID: fallback.modelID };
  }

  private getCommandModel() {
    const m = this.getPromptModel();
    return m ? `${m.providerID}/${m.modelID}` : undefined;
  }

  private normalizeComposerVariant(model: ModelOption | undefined, variant: string | null | undefined) {
    if (variant === null) return null;
    if (!variant || !model?.variants?.includes(variant)) return undefined;
    return variant;
  }

  private getAgentNames() {
    return this.agents.filter((a) => a.mode !== "primary" && !a.hidden).map((a) => a.name);
  }

  private normalizeComposerAgent(agent: string | undefined) {
    const names = this.getAgentNames();
    if (agent && names.includes(agent)) return agent;
    if (this.composer.agent && names.includes(this.composer.agent)) return this.composer.agent;
    if (names.includes("build")) return "build";
    return names[0] ?? "build";
  }

  private async ensureReady(forceRefresh = false, forceRestartServer = false) {
    const workspace = this.getWorkspaceContext();
    const directory = workspace.directory;
    this.connectionState = { ...this.connectionState, baseUrl: this.getSettings().serverBaseUrl };

    if (!directory) {
      this.currentDirectory = undefined;
      this.client = undefined;
      this.sessions = []; this.thread = []; this.todos = []; this.diffs = [];
      this.commands = []; this.agents = []; this.providers = []; this.models = [];
      this.vcs = undefined; this.project = null; this.lastError = undefined; this.resolvedConfig = {};
      this.connectionState = { status: "error", baseUrl: this.getSettings().serverBaseUrl, managed: false, error: "Open a workspace folder to use OpenCode." };
      this.emitState();
      throw new Error("No workspace folder is open.");
    }

    if (forceRestartServer) this.stopServer();

    const needsReconnect = !this.client || !this.sameDirectory(this.currentDirectory, directory) || forceRefresh;
    if (needsReconnect) {
      await this.connect(directory);
      await this.refreshState();
    }

    return this.client!;
  }

  private async connect(directory: string) {
    this.connectionState = { status: "connecting", baseUrl: this.getSettings().serverBaseUrl, managed: Boolean(this.server) };
    this.emitState();
    this.stopStream();
    this.currentDirectory = directory;
    const settings = this.getSettings();
    const baseUrl = settings.serverBaseUrl;

    try {
      this.client = this.createClient(baseUrl, directory);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.client.path.get(REQUEST_OPTIONS);
          break;
        } catch (pingError) {
          if (attempt < 2 && settings.autoStartServer) {
            await new Promise((r) => setTimeout(r, 1500));
            this.client = this.createClient(baseUrl, directory);
            continue;
          }
          throw pingError;
        }
      }
    } catch (error) {
      if (!settings.autoStartServer) {
        this.connectionState = { status: "error", baseUrl, managed: false, error: this.formatError(error) };
        this.emitState();
        throw error;
      }
      const server = await this.startManagedServer();
      this.client = this.createClient(server.url, directory);
      await this.client.path.get(REQUEST_OPTIONS);
    }

    this.connectionState = { status: "connected", baseUrl: this.server?.url ?? baseUrl, managed: Boolean(this.server) };
    this.emitState();
    await this.startStream();
  }

  private createClient(baseUrl: string, directory: string) {
    return createOpencodeClient({ baseUrl, directory, ...REQUEST_OPTIONS });
  }

  private createV2Client(baseUrl: string, directory: string) {
    return createOpencodeV2Client({ baseUrl, directory, ...REQUEST_OPTIONS });
  }

  private async pingServer(baseUrl: string) {
    const client = createOpencodeClient({ baseUrl, ...REQUEST_OPTIONS });
    await client.path.get(REQUEST_OPTIONS);
  }

  private async refreshState() {
    const client = this.client;
    const directory = this.currentDirectory;
    if (!client || !directory) return;

    const v2 = this.createV2Client(this.server?.url ?? this.getSettings().serverBaseUrl, directory);

    const [sessionsResult, statusesResult, providersResult, agentsResult, commandsResult, configResult, vcsResult, projectResult] =
      await Promise.all([
        client.session.list(REQUEST_OPTIONS),
        client.session.status(REQUEST_OPTIONS),
        v2.provider.list({ directory }, REQUEST_OPTIONS),
        v2.app.agents({ directory }, REQUEST_OPTIONS),
        client.command.list(REQUEST_OPTIONS),
        client.config.get(REQUEST_OPTIONS),
        v2.vcs.get({ directory }, REQUEST_OPTIONS).catch((e) => { this.output.appendLine(`[vcs] ${this.formatError(e)}`); return undefined; }),
        v2.project.current({ directory }, REQUEST_OPTIONS).catch((e) => { this.output.appendLine(`[project] ${this.formatError(e)}`); return undefined; }),
      ]);

    const sessions = this.unwrap(sessionsResult);
    const statuses = this.unwrap(statusesResult);
    const providers = this.unwrap(providersResult);
    const agents = this.unwrap(agentsResult);
    const commands = this.unwrap(commandsResult);
    const config = this.unwrap(configResult);
    const vcs = vcsResult ? this.unwrap(vcsResult) : undefined;
    const project = projectResult ? this.unwrap(projectResult) : null;

    this.sessions = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
    this.sessionStatuses = new Map(Object.entries(statuses));
    this.commands = commands;
    this.agents = agents;
    this.providers = this.buildProviders(providers);
    this.models = this.flattenModels(providers);
    this.vcs = vcs;
    this.project = project;
    this.resolvedConfig = { model: config.model, small_model: config.small_model };
    this.normalizeComposer(config.model, providers);
    this.lastError = undefined;

    if (!this.activeSessionId) {
      this.activeSessionId = this.getStoredActiveSessionId(this.currentDirectory)
        ?? this.getStoredLastSessionId(this.currentDirectory)
        ?? this.sessions[0]?.id;
    }

    if (this.activeSessionId && !this.sessions.some((s) => s.id === this.activeSessionId)) {
      this.activeSessionId = this.getStoredLastSessionId(this.currentDirectory) ?? this.sessions[0]?.id;
    }

    this.persistActiveSessionId();

    if (this.activeSessionId) {
      await this.loadActiveSession(this.activeSessionId);
    } else {
      this.thread = []; this.todos = []; this.diffs = [];
    }

    this.updateBusyPolling();
    this.emitState();
  }

  private normalizeComposer(configuredModel: Config["model"] | undefined, providers: V2ProviderListResponse) {
    const configured = this.parseConfiguredModel(configuredModel);
    const provider = this.resolveProviderChoice(configured, providers);

    if (!provider) {
      this.composer.providerID = undefined;
      this.composer.modelID = undefined;
      this.composer.agent = this.normalizeComposerAgent(this.composer.agent);
      this.composer.variant = undefined;
      return;
    }

    const model = this.resolveModelChoice(provider.id, configured, providers);
    this.composer.providerID = provider.id;
    this.composer.modelID = model?.modelID;
    this.composer.agent = this.normalizeComposerAgent(this.composer.agent);
    this.composer.variant = this.normalizeComposerVariant(model, this.composer.variant);
  }

  private parseConfiguredModel(modelRef: Config["model"] | undefined) {
    if (!modelRef) return undefined;
    const sep = modelRef.indexOf("/");
    if (sep === -1) return undefined;
    const providerID = modelRef.slice(0, sep).trim();
    const modelID = modelRef.slice(sep + 1).trim();
    if (!providerID || !modelID) return undefined;
    return { providerID, modelID };
  }

  private flattenModels(providers: V2ProviderListResponse): ModelOption[] {
    const connected = new Set(providers.connected);
    const output: ModelOption[] = [];
    for (const provider of providers.all) {
      if (!connected.has(provider.id)) continue;
      for (const model of Object.values(provider.models)) {
        output.push({ providerID: provider.id, providerName: provider.name, modelID: model.id, label: `${provider.name} / ${model.name}`, status: model.status, variants: this.getModelVariants(model) });
      }
    }
    return output.sort((a, b) => this.compareProviderIDs(a.providerID, b.providerID) || a.label.localeCompare(b.label));
  }

  private buildProviders(providers: V2ProviderListResponse): ProviderOption[] {
    const connected = new Set(providers.connected);
    return providers.all
      .filter((p) => connected.has(p.id))
      .map((p) => ({ id: p.id, name: p.name, modelCount: Object.keys(p.models).length, defaultModelID: this.resolveProviderDefaultModelID(p.id, providers) }))
      .sort((a, b) => this.compareProviderIDs(a.id, b.id) || a.name.localeCompare(b.name));
  }

  private getModelVariants(model: ProviderCatalogModel) {
    return Object.entries(model.variants ?? {})
      .filter(([, v]) => !(v && typeof v === "object" && "disabled" in v && Boolean((v as { disabled?: unknown }).disabled)))
      .map(([name]) => name)
      .sort((a, b) => {
        const order = ["low", "medium", "high", "xhigh", "max"];
        const ai = order.indexOf(a), bi = order.indexOf(b);
        if (ai !== -1 || bi !== -1) { if (ai === -1) return 1; if (bi === -1) return -1; return ai - bi; }
        return a.localeCompare(b);
      });
  }

  private resolveProviderChoice(configured: { providerID: string; modelID: string } | undefined, providers: V2ProviderListResponse) {
    const connected = new Set(providers.connected);
    if (this.composer.providerID && connected.has(this.composer.providerID)) {
      return this.providers.find((p) => p.id === this.composer.providerID);
    }
    if (configured && connected.has(configured.providerID)) {
      return this.providers.find((p) => p.id === configured.providerID);
    }
    return this.providers[0];
  }

  private resolveModelChoice(providerID: string, configured: { providerID: string; modelID: string } | undefined, providers: V2ProviderListResponse) {
    const providerModels = this.models.filter((m) => m.providerID === providerID);
    if (!providerModels.length) return undefined;

    if (this.composer.providerID === providerID) {
      const current = providerModels.find((m) => m.modelID === this.composer.modelID);
      if (current) return current;
    }

    if (configured?.providerID === providerID) {
      const configured_ = providerModels.find((m) => m.modelID === configured.modelID);
      if (configured_) return configured_;
    }

    const defaultID = this.resolveProviderDefaultModelID(providerID, providers);
    if (defaultID) {
      const defaultModel = providerModels.find((m) => m.modelID === defaultID);
      if (defaultModel) return defaultModel;
    }

    return providerModels[0];
  }

  private resolveProviderDefaultModelID(providerID: string, providers: V2ProviderListResponse) {
    const modelID = providers.default?.[providerID];
    if (!modelID) return undefined;
    const provider = providers.all.find((p) => p.id === providerID);
    if (!provider || !(modelID in provider.models)) return undefined;
    return modelID;
  }

  private compareProviderIDs(left: string, right: string) {
    const lr = left === "opencode" ? 0 : 1;
    const rr = right === "opencode" ? 0 : 1;
    if (lr !== rr) return lr - rr;
    return left.localeCompare(right);
  }

  private async loadActiveSession(sessionId: string) {
    const client = this.client;
    if (!client) return;

    const [messagesResult, todosResult, diffsResult] = await Promise.all([
      client.session.messages({ ...REQUEST_OPTIONS, path: { id: sessionId } }),
      client.session.todo({ ...REQUEST_OPTIONS, path: { id: sessionId } }).catch(() => [] as Todo[]),
      client.session.diff({ ...REQUEST_OPTIONS, path: { id: sessionId } }).catch(() => [] as FileDiff[]),
    ]);

    this.thread = this.unwrap(messagesResult);
    this.todos = this.unwrap(todosResult);
    this.diffs = this.unwrap(diffsResult);
    this.emitState();
  }

  private unwrap<T>(result: DataResult<T>): T {
    if (result && typeof result === "object" && "data" in result) return (result as { data: T }).data;
    return result as T;
  }

  private async startStream() {
    const client = this.client;
    if (!client) return;

    this.stopStream();
    const abort = new AbortController();
    this.streamAbort = abort;

    void (async () => {
      while (!abort.signal.aborted) {
        if (this.client !== client) return;
        try {
          const streamResult = await client.event.subscribe({
            ...REQUEST_OPTIONS,
            signal: abort.signal,
            onSseError: (error: unknown) => {
              if (!abort.signal.aborted) {
                const detail = `event stream transport error: ${this.formatError(error)}`;
                this.output.appendLine(`[event] ${detail}`);
                this.reportNetworkIssue(detail);
              }
            },
          });

          if (abort.signal.aborted || this.client !== client) return;

          if (this.connectionState.status !== "connected") {
            this.connectionState = { status: "connected", baseUrl: this.connectionState.baseUrl, managed: this.connectionState.managed };
            this.emitState();
          }

          for await (const event of streamResult.stream) {
            if (abort.signal.aborted || this.client !== client) return;
            await this.handleEvent(event as Event);
          }
        } catch (error) {
          if (abort.signal.aborted || this.client !== client) return;
          const detail = `event stream failed: ${this.formatError(error)}`;
          this.output.appendLine(`[event-loop] ${detail}`);
          this.reportNetworkIssue(detail);
        }

        if (abort.signal.aborted || this.client !== client) return;
        this.connectionState = { status: "connecting", baseUrl: this.connectionState.baseUrl, managed: this.connectionState.managed, error: "Reconnecting..." };
        this.emitState();
        await this.sleep(400, abort.signal);
      }
    })();
  }

  private stopStream() {
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.stopBusyPolling();
  }

  private updateBusyPolling() {
    const sessionId = this.activeSessionId;
    if (!sessionId) { this.stopBusyPolling(); return; }

    const status = this.sessionStatuses.get(sessionId);
    if (status?.type !== "busy") { this.stopBusyPolling(); return; }

    if (this.busyPollTimer && this.busyPollSessionId === sessionId) return;

    this.stopBusyPolling();
    this.busyPollSessionId = sessionId;
    this.busyPollTimer = setInterval(() => {
      if (this.busyPollSessionId) void this.pollBusySession(this.busyPollSessionId);
    }, 1200);
    void this.pollBusySession(sessionId);
  }

  private stopBusyPolling() {
    if (this.busyPollTimer) { clearInterval(this.busyPollTimer); this.busyPollTimer = undefined; }
    this.busyPollSessionId = undefined;
    this.busyPollPending = false;
  }

  private async pollBusySession(sessionId: string) {
    if (this.busyPollPending) return;
    if (sessionId !== this.activeSessionId || sessionId !== this.busyPollSessionId) { this.stopBusyPolling(); return; }
    if (this.sessionStatuses.get(sessionId)?.type !== "busy") { this.stopBusyPolling(); return; }

    this.busyPollPending = true;
    try { await this.loadActiveSession(sessionId); }
    catch (error) { this.output.appendLine(`[busy-poll] ${this.formatError(error)}`); }
    finally { this.busyPollPending = false; }
  }

  private sleep(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(t); resolve(); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async handleEvent(event: Event) {
    switch (event.type) {
      case "server.connected":
        this.connectionState = { status: "connected", baseUrl: this.connectionState.baseUrl, managed: this.connectionState.managed };
        break;
      case "session.created":
      case "session.updated":
        this.upsertSession(event.properties.info);
        break;
      case "session.deleted":
        this.sessions = this.sessions.filter((s) => s.id !== event.properties.info.id);
        if (this.activeSessionId === event.properties.info.id) {
          this.activeSessionId = this.sessions[0]?.id;
          this.updateBusyPolling();
          if (this.activeSessionId) await this.loadActiveSession(this.activeSessionId);
          else { this.thread = []; this.todos = []; this.diffs = []; }
        }
        break;
      case "session.status":
        this.sessionStatuses.set(event.properties.sessionID, event.properties.status);
        this.updateBusyPolling();
        break;
      case "session.idle":
        this.sessionStatuses.set(event.properties.sessionID, { type: "idle" });
        this.updateBusyPolling();
        if (event.properties.sessionID === this.activeSessionId) await this.loadActiveSession(event.properties.sessionID);
        break;
      case "message.updated":
        this.upsertMessage(event.properties.info);
        break;
      case "message.removed":
        if (event.properties.sessionID === this.activeSessionId) {
          this.thread = this.thread.filter((e) => e.info.id !== event.properties.messageID);
        }
        break;
      case "message.part.updated":
        this.upsertPart(event.properties.part, event.properties.delta);
        break;
      case "message.part.removed":
        if (event.properties.sessionID === this.activeSessionId) {
          this.thread = this.thread.map((entry) =>
            entry.info.id !== event.properties.messageID
              ? entry
              : { ...entry, parts: entry.parts.filter((p) => p.id !== event.properties.partID) },
          );
        }
        break;
      case "permission.updated":
        this.permissions.set(event.properties.id, event.properties);
        break;
      case "permission.replied":
        this.permissions.delete(event.properties.permissionID);
        break;
      case "todo.updated":
        if (event.properties.sessionID === this.activeSessionId) this.todos = event.properties.todos;
        break;
      case "session.diff":
        if (event.properties.sessionID === this.activeSessionId) this.diffs = event.properties.diff;
        break;
      case "session.error":
        this.lastError = this.formatSessionError(event.properties.error);
        if (event.properties.sessionID) {
          this.sessionStatuses.set(event.properties.sessionID, { type: "idle" });
          this.updateBusyPolling();
        }
        break;
      case "session.compacted":
        if (event.properties.sessionID === this.activeSessionId) await this.loadActiveSession(event.properties.sessionID);
        break;
    }
    this.emitState();
  }

  private formatSessionError(error: unknown) {
    if (!error || typeof error !== "object") return undefined;
    if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) return String((error.data as { message: unknown }).message);
    if ("name" in error) return String(error.name);
    return "OpenCode reported an error.";
  }

  private upsertSession(session: Session) {
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    this.sessions = idx === -1
      ? [session, ...this.sessions]
      : [...this.sessions.slice(0, idx), session, ...this.sessions.slice(idx + 1)];
    this.sessions = [...this.sessions].sort((a, b) => b.time.updated - a.time.updated);
  }

  private upsertMessage(message: Message) {
    if (message.sessionID !== this.activeSessionId) return;
    const idx = this.thread.findIndex((e) => e.info.id === message.id);
    if (idx === -1) { this.thread = [...this.thread, { info: message, parts: [] }]; return; }
    const current = this.thread[idx];
    this.thread = [...this.thread.slice(0, idx), { ...current, info: message }, ...this.thread.slice(idx + 1)];
  }

  private upsertPart(part: Part, delta?: string) {
    if (part.sessionID !== this.activeSessionId) return;
    const msgIdx = this.thread.findIndex((e) => e.info.id === part.messageID);
    if (msgIdx === -1) return;

    const message = this.thread[msgIdx];
    const partIdx = message.parts.findIndex((p) => p.id === part.id);

    if (typeof delta === "string" && delta && (part.type === "text" || part.type === "reasoning")) {
      const nextText = typeof part.text === "string" ? part.text : "";
      if (partIdx === -1) {
        if (!nextText) part = { ...part, text: delta };
      } else {
        const cur = message.parts[partIdx];
        if (cur?.type === "text" || cur?.type === "reasoning") {
          const curText = typeof cur.text === "string" ? cur.text : "";
          if (nextText === curText) part = { ...part, text: curText + delta };
        }
      }
    }

    const nextParts = partIdx === -1
      ? [...message.parts, part]
      : [...message.parts.slice(0, partIdx), part, ...message.parts.slice(partIdx + 1)];

    this.thread = [...this.thread.slice(0, msgIdx), { ...message, parts: nextParts }, ...this.thread.slice(msgIdx + 1)];
  }

  private getActivePermissions() {
    if (!this.activeSessionId) return [];
    return [...this.permissions.values()].filter((p) => p.sessionID === this.activeSessionId);
  }

  private getSettings() {
    const c = vscode.workspace.getConfiguration("opencoder-ui");
    return {
      opencodePath: c.get<string>("opencodePath", "opencode"),
      serverBaseUrl: c.get<string>("serverBaseUrl", "http://127.0.0.1:4096"),
      autoStartServer: c.get<boolean>("autoStartServer", true),
      debugServerLogs: c.get<boolean>("debugServerLogs", false),
    };
  }

  private async startManagedServer() {
    if (this.serverStartPromise) return this.serverStartPromise;
    this.serverStartPromise = this.doStartManagedServer();
    try { return await this.serverStartPromise; }
    finally { this.serverStartPromise = null; }
  }

  private async doStartManagedServer() {
    this.stopServer();
    const settings = this.getSettings();
    const targetUrl = new URL(settings.serverBaseUrl);
    const preferredPort = Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80));

    try {
      return await this.spawnManagedServer(targetUrl.hostname, preferredPort, settings);
    } catch (error) {
      const fallbackPort = await this.findAvailablePort(targetUrl.hostname);
      if (!fallbackPort || fallbackPort === preferredPort) throw error;
      this.output.appendLine(`[server] Retrying on free port ${fallbackPort}.`);
      return this.spawnManagedServer(targetUrl.hostname, fallbackPort, settings);
    }
  }

  private async spawnManagedServer(hostname: string, port: number, settings: ReturnType<OpenCodeService["getSettings"]>) {
    const args = ["serve", `--hostname=${hostname}`, `--port=${String(port)}`, "--print-logs"];
    const env = this.buildManagedServerEnv();
    const command = await this.resolveOpencodeCommand(settings.opencodePath, env.PATH);
    const proc = spawn(command, args, {
      cwd: this.currentDirectory,
      env,
      shell: process.platform === "win32" && (!this.looksLikeFilePath(command) || this.requiresWindowsShell(command)),
      stdio: "pipe",
    });

    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { this.killProcess(proc); reject(new Error("Timed out starting OpenCode server.")); }, 10000);
      let output = "";
      let resolved = false;

      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        output += text;
        if (settings.debugServerLogs) this.output.append(text);
        if (resolved) return;
        for (const line of output.split(/\r?\n/)) {
          const match = line.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/i);
          if (match) { resolved = true; clearTimeout(timeout); resolve(match[1]); return; }
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("error", (e) => { clearTimeout(timeout); reject(e); });
      proc.on("exit", (code) => {
        if (resolved) return;
        clearTimeout(timeout);
        reject(new Error(`OpenCode server exited early with code ${code}. ${output}`.trim()));
      });
    });

    this.server = { process: proc, url };
    return this.server;
  }

  private async findAvailablePort(hostname: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.on("error", reject);
      server.listen(0, hostname, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") { server.close(() => reject(new Error("No available port."))); return; }
        server.close((e) => { if (e) reject(e); else resolve(addr.port); });
      });
    });
  }

  private stopServer() {
    if (!this.server) return;
    this.killProcess(this.server.process);
    this.server = undefined;
  }

  private killProcess(proc: ChildProcessWithoutNullStreams) {
    if (proc.killed) return;
    if (process.platform === "win32" && proc.pid) {
      const result = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      if (result.error) proc.kill();
      return;
    }
    proc.kill();
  }

  private buildManagedServerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === "win32") return env;

    const current = this.splitPathEntries(env.PATH);
    for (const entry of this.getCommonBinaryDirectories()) {
      if (!current.includes(entry)) current.push(entry);
    }
    env.PATH = current.join(require("node:path").delimiter);
    return env;
  }

  private getCommonBinaryDirectories() {
    if (process.platform === "win32") return [];
    const home = os.homedir();
    return [
      "/opt/homebrew/sbin", "/opt/homebrew/bin", "/usr/local/sbin", "/usr/local/bin",
      "/usr/sbin", "/usr/bin", "/snap/bin", "/var/lib/snapd/snap/bin",
      home ? path.join(home, ".local", "bin") : "",
      home ? path.join(home, ".bun", "bin") : "",
      home ? path.join(home, ".cargo", "bin") : "",
      home ? path.join(home, "bin") : "",
    ].filter((e) => Boolean(e) && fs.existsSync(e));
  }

  private splitPathEntries(value: string | undefined) {
    return (value ?? "").split(path.delimiter).map((e) => e.trim()).filter(Boolean);
  }

  private looksLikeFilePath(value: string) {
    return value.startsWith("~") || path.isAbsolute(value) || value.includes("/") || value.includes("\\");
  }

  private requiresWindowsShell(value: string) {
    if (process.platform !== "win32") return false;
    const ext = path.extname(value).toLowerCase();
    return ext === ".cmd" || ext === ".bat";
  }

  private expandHome(value: string) {
    if (!value.startsWith("~")) return value;
    const home = os.homedir();
    if (!home) return value;
    if (value === "~") return home;
    if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
    return value;
  }

  private async resolveOpencodeCommand(configuredPath: string, envPath: string | undefined) {
    const configured = (configuredPath || "opencode").trim() || "opencode";
    const expanded = this.expandHome(configured);

    if (this.looksLikeFilePath(expanded)) {
      if (await this.fileCanExecute(expanded)) return expanded;
      throw new Error(`OpenCode executable not found at configured path: ${expanded}`);
    }

    const fromPath = await this.resolveCommandFromPath(expanded, envPath);
    if (fromPath) return fromPath;

    if (expanded === "opencode") {
      const fromWellKnown = await this.resolveFromWellKnownLocations();
      if (fromWellKnown) return fromWellKnown;
    }

    const fromShell = await this.resolveCommandFromLoginShell(expanded);
    if (fromShell) return fromShell;

    return expanded;
  }

  private async resolveCommandFromPath(command: string, pathValue: string | undefined) {
    const directories = this.splitPathEntries(pathValue);
    if (!directories.length) return undefined;

    const hasExt = path.extname(command).length > 0;
    let exts = process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.trim()).filter(Boolean)
      : [];

    if (process.platform === "win32" && !hasExt) {
      const preferred = [".CMD", ".EXE", ".BAT", ".COM"];
      exts = [...preferred, ...exts.filter((e) => !preferred.includes(e.toUpperCase()))];
    }

    for (const dir of directories) {
      const base = path.join(dir, command);
      const candidates = process.platform === "win32" && !hasExt ? exts.map((e) => `${base}${e}`) : [base];
      for (const candidate of candidates) {
        if (await this.fileCanExecute(candidate)) return candidate;
      }
    }
    return undefined;
  }

  private async fileCanExecute(filePath: string) {
    const mode = process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
    try { await fs.promises.access(filePath, mode); return true; }
    catch { return false; }
  }

  private async resolveFromWellKnownLocations() {
    const home = os.homedir();
    const candidates: string[] = process.platform === "win32"
      ? [
          process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "opencode.cmd") : "",
          process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "opencode", "opencode.exe") : "",
          home ? path.join(home, "scoop", "shims", "opencode.exe") : "",
        ].filter(Boolean)
      : [
          "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", "/usr/bin/opencode",
          "/snap/bin/opencode", "/var/lib/snapd/snap/bin/opencode",
          home ? path.join(home, ".local", "bin", "opencode") : "",
          home ? path.join(home, "bin", "opencode") : "",
        ].filter(Boolean);

    for (const c of candidates) {
      if (await this.fileCanExecute(c)) return c;
    }
    return undefined;
  }

  private async resolveCommandFromLoginShell(command: string) {
    if (process.platform === "win32" || !/^[A-Za-z0-9._-]+$/.test(command)) return undefined;
    const shell = process.env.SHELL;
    if (!shell) return undefined;

    const located = await new Promise<string | undefined>((resolve) => {
      const proc = spawn(shell, ["-ilc", `command -v ${command}`], { env: { ...process.env }, stdio: ["ignore", "pipe", "ignore"] });
      const timeout = setTimeout(() => { proc.kill(); resolve(undefined); }, COMMAND_LOOKUP_TIMEOUT_MS);
      let stdout = "";
      proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      proc.on("error", () => { clearTimeout(timeout); resolve(undefined); });
      proc.on("exit", () => {
        clearTimeout(timeout);
        const candidate = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("/") || /^[A-Za-z]:[\\/]/.test(l));
        resolve(candidate ? this.expandHome(candidate) : undefined);
      });
    });

    if (located && await this.fileCanExecute(located)) return located;
    return undefined;
  }

  private formatError(error: unknown) {
    const text = error instanceof Error ? error.message : String(error);
    if (/executable not found at configured path:/i.test(text)) return `${text}. Update opencoder-ui.opencodePath.`;
    if (/enoent|not recognized as an internal or external command|spawn\s+.*\s+enoent/i.test(text)) return "OpenCode CLI not found. Install OpenCode or set opencoder-ui.opencodePath.";
    if (/timed out while starting/i.test(text)) return "Timed out starting OpenCode server.";
    return text;
  }

  private getNetworkHint(detail: string) {
    if (/enoent|not found|spawn/i.test(detail)) return "OpenCode CLI not in PATH. Set opencoder-ui.opencodePath to the full path.";
    if (/econnrefused|econnreset|fetch failed|timed out|enotfound|socket/i.test(detail.toLowerCase())) return "OpenCode server unreachable. Check opencoder-ui.serverBaseUrl.";
    return "OpenCode request failed. Check the output channel for details.";
  }

  private emitState() {
    this.stateEmitter.fire(this.getState());
  }

  private persistActiveSessionId() {
    const key = this.getActiveSessionStorageKey(this.currentDirectory);
    if (!key) return;
    void this.context.workspaceState.update(key, this.activeSessionId ?? null);
    const last = this.getLastSessionStorageKey(this.currentDirectory);
    if (last) void this.context.workspaceState.update(last, this.activeSessionId ?? null);
  }

  private getStoredActiveSessionId(directory?: string) {
    const key = this.getActiveSessionStorageKey(directory);
    if (!key) return undefined;
    return this.context.workspaceState.get<string>(key);
  }

  private getStoredLastSessionId(directory?: string) {
    const key = this.getLastSessionStorageKey(directory);
    if (!key) return undefined;
    return this.context.workspaceState.get<string>(key);
  }

  private getActiveSessionStorageKey(directory?: string) {
    const n = this.normalizeDir(directory);
    if (!n) return undefined;
    return `${ACTIVE_SESSION_KEY}:${n}`;
  }

  private getLastSessionStorageKey(directory?: string) {
    if (!directory) return undefined;
    const root = this.projectRoot(directory);
    if (!root) return undefined;
    return `${LAST_SESSION_KEY}:${root}`;
  }

  private projectRoot(directory?: string) {
    if (!directory) return undefined;
    const project = this.project;
    if (!project?.worktree) return this.normalizeDir(directory);
    const roots = [project.worktree, ...(project.sandboxes ?? [])];
    const root = roots.find((r) => sameWorkspace(r, directory));
    return this.normalizeDir(root ?? directory);
  }

  private normalizeDir(directory?: string) {
    if (!directory) return undefined;
    const resolved = path.resolve(directory);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private sameDirectory(left?: string, right?: string) {
    return this.normalizeDir(left) === this.normalizeDir(right);
  }

  private async getNpmGlobalBin(): Promise<string | undefined> {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = await this.runCommand(npm, ["prefix", "-g"], { timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.trim()) {
      const prefix = result.stdout.trim();
      return process.platform === "win32" ? prefix : path.join(prefix, "bin");
    }
    return undefined;
  }

  private async runCommand(command: string, args: string[], options: { timeout?: number; cwd?: string } = {}) {
    return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn(command, args, {
        cwd: options.cwd ?? this.currentDirectory ?? process.cwd(),
        env: { ...process.env },
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
      proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
      const t = options.timeout ? setTimeout(() => { proc.kill(); resolve({ exitCode: -1, stdout, stderr: stderr + "\nTimed out" }); }, options.timeout) : undefined;
      proc.on("error", (e) => { if (t) clearTimeout(t); resolve({ exitCode: -1, stdout, stderr: stderr + "\n" + String(e) }); });
      proc.on("exit", (code) => { if (t) clearTimeout(t); resolve({ exitCode: code ?? -1, stdout, stderr }); });
    });
  }
}
