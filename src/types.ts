import type {
  Command,
  Config,
  FileDiff,
  FilePartInput,
  Message,
  Part,
  Permission,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk";
import type { Agent, Project, VcsInfo } from "@opencode-ai/sdk/v2";

export type ThreadEntry = {
  info: Message;
  parts: Part[];
};

export type ModelOption = {
  providerID: string;
  modelID: string;
  label: string;
  providerName: string;
  status?: string;
  variants?: string[];
};

export type ProviderOption = {
  id: string;
  name: string;
  modelCount: number;
  defaultModelID?: string;
};

export type ComposerSelection = {
  providerID?: string;
  modelID?: string;
  agent?: string;
  variant?: string | null;
};

export type SidebarState = {
  connection: {
    status: "connecting" | "connected" | "error";
    baseUrl: string;
    managed: boolean;
    error?: string;
  };
  lastError?: string;
  workspace: {
    hasWorkspace: boolean;
    name: string;
    directory?: string;
  };
  sessions: Session[];
  sessionStatuses: Record<string, SessionStatus>;
  activeSessionId?: string;
  thread: ThreadEntry[];
  permissions: Permission[];
  todos: Todo[];
  diffs: FileDiff[];
  commands: Command[];
  agents: Agent[];
  providers: ProviderOption[];
  models: ModelOption[];
  composer: ComposerSelection;
  vcs?: VcsInfo;
  project?: Project | null;
  config: {
    model?: Config["model"];
    smallModel?: Config["small_model"];
  };
};

export type ComposerAttachmentPayload = {
  label: string;
  attachment: FilePartInput;
};
