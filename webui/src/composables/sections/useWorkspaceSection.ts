import { computed, ref, type ComputedRef, type Ref } from "vue";
import { onBeforeRouteLeave } from "vue-router";
import { RefreshCw, FolderOpen, Image as ImageIcon, FileText, File, Folder } from "lucide-vue-next";
import { fileApi, type ChatFileSummary, type LocalFilePreview, type LocalFileItem } from "@/api/workspace";
import { useWorkbenchRuntime } from "@/composables/workbench/useWorkbenchRuntime";

type Mode = "files" | "stored-files";

type WorkspaceSectionState = {
  mode: Ref<Mode>;
  loadingFiles: Ref<boolean>;
  loadingAssets: Ref<boolean>;
  itemsByPath: Ref<Record<string, LocalFileItem[]>>;
  expandedPaths: Ref<string[]>;
  selectedPath: Ref<string | null>;
  selectedItem: Ref<LocalFileItem | null>;
  selectedStoredFile: Ref<ChatFileSummary | null>;
  storedFileList: Ref<ChatFileSummary[]>;
  filePreview: Ref<LocalFilePreview | null>;
  previewError: Ref<string | null>;
  fileImageSrc: Ref<string | null>;
  dialogImageSrc: Ref<string | null>;
  currentRootItems: ComputedRef<LocalFileItem[]>;
  mobileHeaderTitle: ComputedRef<string>;
  selectedStoredFileImageUrl: ComputedRef<string | null>;
  initializeSection: () => Promise<void>;
  resetState: () => void;
  toggleDirectory: (path: string) => Promise<void>;
  selectItem: (item: LocalFileItem) => Promise<void>;
  selectStoredFile: (file: ChatFileSummary) => void;
  refreshCurrentMode: () => void;
  previewIcon: (item: LocalFileItem | null) => typeof FolderOpen;
  formatSize: (bytes: number) => string;
  formatTime: (ms: number) => string;
  openImageDialog: (src: string | null) => void;
  closeImageDialog: () => void;
};

let sharedState: WorkspaceSectionState | null = null;

export function useWorkspaceSection() {
  if (!sharedState) {
    const workbenchRuntime = useWorkbenchRuntime();
    const mode = ref<Mode>("files");
    const loadingFiles = ref(false);
    const loadingAssets = ref(false);
    const itemsByPath = ref<Record<string, LocalFileItem[]>>({});
    const expandedPaths = ref<string[]>([]);
    const selectedPath = ref<string | null>(null);
    const selectedItem = ref<LocalFileItem | null>(null);
    const selectedStoredFile = ref<ChatFileSummary | null>(null);
    const storedFileList = ref<ChatFileSummary[]>([]);
    const filePreview = ref<LocalFilePreview | null>(null);
    const previewError = ref<string | null>(null);
    const fileImageSrc = ref<string | null>(null);
    const dialogImageSrc = ref<string | null>(null);
    const initialized = ref(false);
    let stateVersion = 0;

    const currentRootItems = computed(() => itemsByPath.value["."] ?? []);
    const mobileHeaderTitle = computed(() =>
      selectedItem.value?.name ?? selectedStoredFile.value?.sourceName ?? selectedStoredFile.value?.fileId ?? "工作区"
    );
    const selectedStoredFileImageUrl = computed(() =>
      selectedStoredFile.value ? fileApi.getChatFileContentUrlById(selectedStoredFile.value.fileId) : null
    );

    function isStale(requestVersion: number) {
      return requestVersion !== stateVersion;
    }

    function resetState() {
      stateVersion += 1;
      initialized.value = false;
      mode.value = "files";
      loadingFiles.value = false;
      loadingAssets.value = false;
      itemsByPath.value = {};
      expandedPaths.value = [];
      selectedPath.value = null;
      selectedItem.value = null;
      selectedStoredFile.value = null;
      storedFileList.value = [];
      filePreview.value = null;
      previewError.value = null;
      fileImageSrc.value = null;
      dialogImageSrc.value = null;
    }

    function sortWorkspaceItems(items: LocalFileItem[]): LocalFileItem[] {
      return [...items].sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
      });
    }

    async function loadDirectory(path: string): Promise<void> {
      const requestVersion = stateVersion;
      loadingFiles.value = true;
      try {
        const result = await fileApi.listLocalItems(path);
        if (isStale(requestVersion)) {
          return;
        }
        itemsByPath.value = {
          ...itemsByPath.value,
          [path]: sortWorkspaceItems(result.items)
        };
      } finally {
        if (!isStale(requestVersion)) {
          loadingFiles.value = false;
        }
      }
    }

    async function loadStoredFiles(): Promise<void> {
      const requestVersion = stateVersion;
      loadingAssets.value = true;
      try {
        const result = await fileApi.listChatFiles();
        if (isStale(requestVersion)) {
          return;
        }
        storedFileList.value = result.files;
      } finally {
        if (!isStale(requestVersion)) {
          loadingAssets.value = false;
        }
      }
    }

    async function initializeSection() {
      if (initialized.value) {
        return;
      }
      initialized.value = true;
      await Promise.all([loadDirectory("."), loadStoredFiles()]);
    }

    async function toggleDirectory(path: string) {
      const next = new Set(expandedPaths.value);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        expandedPaths.value = [...next];
        if (!itemsByPath.value[path]) {
          await loadDirectory(path);
          return;
        }
      }
      expandedPaths.value = [...next];
    }

    function isImageFile(name: string): boolean {
      return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
    }

    async function selectItem(item: LocalFileItem) {
      const requestVersion = stateVersion;
      selectedPath.value = item.path;
      selectedItem.value = item;
      selectedStoredFile.value = null;
      filePreview.value = null;
      previewError.value = null;
      fileImageSrc.value = null;
      dialogImageSrc.value = null;

      if (item.kind === "directory") {
        if (!expandedPaths.value.includes(item.path)) {
          await toggleDirectory(item.path);
        }
        if (!isStale(requestVersion)) {
          workbenchRuntime.showMain();
        }
        return;
      }

      if (isImageFile(item.name)) {
        fileImageSrc.value = fileApi.getLocalFileContentUrl(item.path);
        if (!isStale(requestVersion)) {
          workbenchRuntime.showMain();
        }
        return;
      }

      try {
        const preview = await fileApi.readLocalFile(item.path, { startLine: 1, endLine: 240 });
        if (isStale(requestVersion) || selectedPath.value !== item.path) {
          return;
        }
        filePreview.value = preview;
      } catch (error: unknown) {
        if (isStale(requestVersion) || selectedPath.value !== item.path) {
          return;
        }
        previewError.value = error instanceof Error ? error.message : "暂不支持预览该文件";
      }

      if (!isStale(requestVersion)) {
        workbenchRuntime.showMain();
      }
    }

    function selectStoredFile(file: ChatFileSummary) {
      selectedStoredFile.value = file;
      selectedItem.value = null;
      selectedPath.value = null;
      filePreview.value = null;
      previewError.value = null;
      fileImageSrc.value = null;
      dialogImageSrc.value = null;
      workbenchRuntime.showMain();
    }

    function refreshCurrentMode() {
      if (mode.value === "files") {
        void loadDirectory(".");
      } else {
        void loadStoredFiles();
      }
    }

    function previewIcon(item: LocalFileItem | null) {
      if (!item) return FolderOpen;
      if (item.kind === "directory") return Folder;
      if (isImageFile(item.name)) return ImageIcon;
      if (/\.(txt|md|json|ya?ml|log|ts|tsx|js|jsx|vue|css|html)$/i.test(item.name)) return FileText;
      return File;
    }

    function formatSize(bytes: number): string {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    function formatTime(ms: number): string {
      return new Date(ms).toLocaleString("zh-CN");
    }

    function openImageDialog(src: string | null) {
      dialogImageSrc.value = src;
    }

    function closeImageDialog() {
      dialogImageSrc.value = null;
    }

    sharedState = {
      mode,
      loadingFiles,
      loadingAssets,
      itemsByPath,
      expandedPaths,
      selectedPath,
      selectedItem,
      selectedStoredFile,
      storedFileList,
      filePreview,
      previewError,
      fileImageSrc,
      dialogImageSrc,
      currentRootItems,
      mobileHeaderTitle,
      selectedStoredFileImageUrl,
      initializeSection,
      resetState,
      toggleDirectory,
      selectItem,
      selectStoredFile,
      refreshCurrentMode,
      previewIcon,
      formatSize,
      formatTime,
      openImageDialog,
      closeImageDialog
    };
  }

  onBeforeRouteLeave(() => {
    sharedState?.resetState();
  });

  return sharedState;
}

export type { ChatFileSummary, LocalFilePreview, LocalFileItem };
