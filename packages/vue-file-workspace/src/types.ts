/** 文件树中的一个文件或目录。 */
export interface LocalFileItem {
  /** 业务 API 使用的稳定路径。 */
  path: string;
  /** 展示名称，通常为 basename。 */
  name: string;
  kind: "file" | "directory";
  /** 文件大小。目录可返回 0。 */
  sizeBytes: number;
  /** 更新时间，Unix epoch milliseconds。 */
  updatedAtMs: number;
}

/** 目录列表结果。 */
export interface LocalFileListResult {
  /** 当前 workspace 根路径展示值。 */
  root: string;
  /** 本次列出的目录路径。 */
  path: string;
  items: LocalFileItem[];
}

/** 文本文件预览结果。 */
export interface LocalFilePreview {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

/** 业务项目需要实现的文件工作区 API adapter。 */
export interface FileWorkspaceClient {
  /** 列出指定目录下的文件和子目录。 */
  listItems(path: string): Promise<LocalFileListResult>;
  /** 读取文本文件预览，可选行号范围。 */
  readFile(path: string, range?: { startLine?: number; endLine?: number }): Promise<LocalFilePreview>;
  /** 返回文件内容 URL，供图片、下载或媒体预览使用。 */
  getContentUrl(path: string): string;
}
