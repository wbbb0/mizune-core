export interface LocalFileItem {
  path: string;
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  updatedAtMs: number;
}

export interface LocalFileListResult {
  root: string;
  path: string;
  items: LocalFileItem[];
}

export interface LocalFilePreview {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface FileWorkspaceClient {
  listItems(path: string): Promise<LocalFileListResult>;
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<LocalFilePreview>;
  getContentUrl(path: string): string;
}
