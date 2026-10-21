export const toolNames = {
  openWorkspace: "open_workspace",
  js: "js",
} as const;

export type ToolName = (typeof toolNames)[keyof typeof toolNames];
export type ToolCategory = "workspace" | "mutation" | "navigation" | "process" | "git" | "workflow" | "diagnostics";
export type ToolConcurrencyClass =
  | "shared-read"
  | "heavy-read"
  | "workspace-write"
  | "git-write"
  | "process-start"
  | "process-session"
  | "global-exclusive";

export interface ToolCatalogEntry {
  name: ToolName;
  category: ToolCategory;
  concurrencyClass: ToolConcurrencyClass;
  summary: string;
}

const catalog: Record<ToolName, ToolCatalogEntry> = {
  open_workspace: {
    name: "open_workspace",
    category: "workspace",
    concurrencyClass: "shared-read",
    summary: "打开本地工作区并返回总纲。",
  },
  js: {
    name: "js",
    category: "mutation",
    concurrencyClass: "workspace-write",
    summary: "运行平铺的异步 JavaScript 程序。",
  },
};

export function toolCatalogEntry(name: string): ToolCatalogEntry {
  const entry = catalog[name as ToolName];
  if (!entry) {
    return {
      name: "js",
      category: "mutation",
      concurrencyClass: "workspace-write",
      summary: name,
    };
  }
  return entry;
}

export function toolSummary(name: ToolName): string {
  return toolCatalogEntry(name).summary;
}

export function toolNamesForMode(): ToolName[] {
  return ["open_workspace", "js"];
}

export function toolAvailable(name: string): boolean {
  return name === "open_workspace" || name === "js";
}

export function renderToolSurfacesMarkdown(): string {
  return "# LocalSpace JS 工具面\n\n- `open_workspace`\n- `js`\n";
}

export const toolCatalog: readonly ToolCatalogEntry[] = Object.values(catalog);
