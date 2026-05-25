import * as vscode from "vscode";
import { OpenCodeService } from "./opencodeService";
import type {
  ExtensionSettingKey,
  ExtensionSettings,
  HostToWebviewMessage,
  WebviewToHostMessage,
} from "./webviewProtocol";

export type NativeSettings = {
  language: string;
  uiColorScheme: "system" | "light" | "dark";
  themeId: string;
  uiFont: string;
  codeFont: string;
  autoSave: boolean;
  fontSize: number;
  showReasoningSummaries: boolean;
  shellToolPartsExpanded: boolean;
  editToolPartsExpanded: boolean;
  releaseNotes: boolean;
  checkUpdatesOnStartup: boolean;
  notifyAgent: boolean;
  notifyPermissions: boolean;
  notifyErrors: boolean;
  soundAgentEnabled: boolean;
  soundAgent: string;
  soundPermissionsEnabled: boolean;
  soundPermissions: string;
  soundErrorsEnabled: boolean;
  soundErrors: string;
  autoAcceptWorkspacePermissions: boolean;
  customKeybinds: Record<string, string> | null;
  modelVisibility: Record<string, "show" | "hide"> | null;
};

export function getNativeSettings(): NativeSettings {
  const c = vscode.workspace.getConfiguration("opencoder");
  return {
    language: c.get("language", "auto"),
    uiColorScheme: c.get("uiColorScheme", "system"),
    themeId: c.get("themeId", "oc-2"),
    uiFont: c.get("uiFont", ""),
    codeFont: c.get("codeFont", ""),
    autoSave: c.get("autoSave", true),
    fontSize: c.get("fontSize", 14),
    showReasoningSummaries: c.get("showReasoningSummaries", false),
    shellToolPartsExpanded: c.get("shellToolPartsExpanded", false),
    editToolPartsExpanded: c.get("editToolPartsExpanded", false),
    releaseNotes: c.get("releaseNotes", true),
    checkUpdatesOnStartup: c.get("checkUpdatesOnStartup", true),
    notifyAgent: c.get("notifyAgent", true),
    notifyPermissions: c.get("notifyPermissions", true),
    notifyErrors: c.get("notifyErrors", false),
    soundAgentEnabled: c.get("soundAgentEnabled", true),
    soundAgent: c.get("soundAgent", "staplebops-01"),
    soundPermissionsEnabled: c.get("soundPermissionsEnabled", true),
    soundPermissions: c.get("soundPermissions", "staplebops-02"),
    soundErrorsEnabled: c.get("soundErrorsEnabled", true),
    soundErrors: c.get("soundErrors", "nope-03"),
    autoAcceptWorkspacePermissions: c.get("autoAcceptWorkspacePermissions", false),
    customKeybinds: c.get("customKeybinds", null),
    modelVisibility: c.get("modelVisibility", null),
  };
}

export function getExtensionSettings(): ExtensionSettings {
  const c = vscode.workspace.getConfiguration("opencoder");
  return {
    opencodePath: c.get("opencodePath", "opencode"),
    serverBaseUrl: c.get("serverBaseUrl", "http://127.0.0.1:4096"),
    autoStartServer: c.get("autoStartServer", true),
    debugServerLogs: c.get("debugServerLogs", false),
  };
}

export async function setExtensionSetting(key: ExtensionSettingKey, value: string | boolean) {
  const c = vscode.workspace.getConfiguration("opencoder");

  if ((key === "opencodePath" || key === "serverBaseUrl") && typeof value !== "string") {
    throw new Error(`Invalid value for ${key}`);
  }
  if ((key === "autoStartServer" || key === "debugServerLogs") && typeof value !== "boolean") {
    throw new Error(`Invalid value for ${key}`);
  }

  await c.update(key, value, vscode.ConfigurationTarget.Global);
  return getExtensionSettings();
}

export async function shouldDisableHealthCheck(serverUrl: string): Promise<boolean> {
  let target: string;
  try {
    target = new URL("/global/health", serverUrl).toString();
  } catch {
    return true;
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2500);

  try {
    const response = await fetch(target, { method: "GET", signal: abort.signal });
    if (response.status === 404 || response.status === 405 || response.status === 501) return true;
    if (response.ok) return false;
    const text = await response.text().catch(() => "");
    return /not found|unknown route|cannot\s+\w+\s+\/global\/health/i.test(text);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function getColorScheme(): "light" | "dark" {
  const kind = vscode.window.activeColorTheme.kind;
  if (kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight) {
    return "light";
  }
  return "dark";
}

export function resolveFetchUrl(input: string, service: OpenCodeService): string {
  try {
    const url = new URL(input);
    if (url.hostname === "opencode.localhost") {
      const base = service.getResolvedServerBaseUrl();
      try {
        const target = new URL(base);
        url.protocol = target.protocol;
        url.hostname = target.hostname;
        url.port = target.port;
      } catch {
        url.hostname = "127.0.0.1";
      }
    }
    return url.toString();
  } catch {
    return input;
  }
}

export function isLocalHostname(hostname: string) {
  const n = hostname.toLowerCase();
  return n === "opencode.localhost" || n === "localhost" || n === "127.0.0.1" || n === "::1" || n === "[::1]";
}

export function buildFetchCandidates(input: string, service: OpenCodeService): string[] {
  const primary = resolveFetchUrl(input, service);
  try {
    const url = new URL(primary);
    if (!isLocalHostname(url.hostname)) return [primary];
    const candidates = [url.toString()];
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      const c = new URL(url.toString());
      c.hostname = host;
      const v = c.toString();
      if (!candidates.includes(v)) candidates.push(v);
    }
    return candidates;
  } catch {
    return [primary];
  }
}

export function isNetworkFailure(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /econnrefused|econnreset|econnaborted|fetch failed|timed out|enotfound|eai_again|socket|network error/i.test(text);
}

export async function handleFetch(
  message: Extract<WebviewToHostMessage, { type: "fetchRequest" }>,
  service: OpenCodeService,
  fetches: Map<string, AbortController>,
  postMessage: (msg: HostToWebviewMessage) => void,
) {
  const abort = new AbortController();
  fetches.set(message.requestId, abort);

  try {
    let response: Response | undefined;
    let finalUrl = resolveFetchUrl(message.url, service);
    let lastError: unknown;

    for (const candidateUrl of buildFetchCandidates(message.url, service)) {
      finalUrl = candidateUrl;
      try {
        response = await fetch(candidateUrl, {
          method: message.method,
          headers: message.headers,
          body: message.body ? Buffer.from(message.body, "base64") : undefined,
          signal: abort.signal,
        });
        break;
      } catch (error) {
        lastError = error;
        if (abort.signal.aborted || !isNetworkFailure(error)) throw error;
      }
    }

    if (!response) throw lastError ?? new Error(`Failed to fetch ${finalUrl}`);

    postMessage({
      type: "fetchResponse",
      requestId: message.requestId,
      url: response.url,
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
    });

    const reader = response.body?.getReader();
    if (!reader) {
      postMessage({ type: "fetchEnd", requestId: message.requestId });
      return;
    }

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      postMessage({ type: "fetchChunk", requestId: message.requestId, chunk: Buffer.from(result.value).toString("base64") });
    }

    postMessage({ type: "fetchEnd", requestId: message.requestId });
  } catch (error) {
    if (!abort.signal.aborted) {
      const msg = error instanceof Error ? error.message : String(error);
      const name = error instanceof Error ? error.name : undefined;
      postMessage({ type: "fetchError", requestId: message.requestId, message: msg, name });
      service.reportNetworkIssue(`method=${message.method} url=${message.url} error=${name ?? "Error"}: ${msg}`);
    }
  } finally {
    fetches.delete(message.requestId);
  }
}

export async function pickDirectory(
  requestId: string,
  title: string | undefined,
  multiple: boolean,
  postMessage: (msg: HostToWebviewMessage) => void,
) {
  try {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: multiple,
      openLabel: title ?? "Select folder",
    });

    if (!result || result.length === 0) {
      postMessage({ type: "pickDirectoryResult", requestId, value: null });
      return;
    }

    const paths = result.map((uri) => uri.fsPath);
    postMessage({ type: "pickDirectoryResult", requestId, value: multiple ? paths : paths[0] });
  } catch {
    postMessage({ type: "pickDirectoryResult", requestId, value: null });
  }
}
