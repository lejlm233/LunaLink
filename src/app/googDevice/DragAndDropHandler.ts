export type DroppedFile = {
    file: File;
    /**
     * 拖入文件夹时的相对路径（含文件名，如 "photos/cat.png"）；
     * 普通文件拖拽为 ''。用于在设备端保持目录结构。
     */
    relativePath: string;
};

export interface DragEventListener {
    onDragEnter: () => boolean;
    onDragLeave: () => boolean;
    onFilesDrop: (files: DroppedFile[]) => boolean;
    getElement: () => HTMLElement;
}

export class DragAndDropHandler {
    private static readonly listeners: Set<DragEventListener> = new Set();
    private static dropHandler = (ev: DragEvent): void => {
        if (!ev.dataTransfer) {
            return;
        }
        // dragover 已阻止默认行为；这里同步阻止 drop 默认行为（如浏览器打开文件）
        ev.preventDefault();
        const currentTarget = ev.currentTarget;
        if (!currentTarget) {
            return;
        }
        const matched = Array.from(DragAndDropHandler.listeners).filter(
            (listener) => listener.getElement() === currentTarget,
        );
        if (!matched.length) {
            return;
        }
        // webkitGetAsEntry 必须在事件处理同步阶段读取，
        // 因此先同步收集 FileSystemEntry，再异步递归遍历目录内容
        const collected = DragAndDropHandler.collectEntriesSync(ev.dataTransfer);
        DragAndDropHandler.collectFiles(collected.entries, collected.files).then((files) => {
            if (!files.length) {
                return;
            }
            matched.forEach((listener) => {
                listener.onFilesDrop(files);
            });
        });
    };
    private static dragOverHandler = (ev: DragEvent): void => {
        ev.preventDefault();
    };
    private static dragLeaveHandler = (ev: DragEvent): boolean => {
        let handled = false;
        DragAndDropHandler.listeners.forEach((listener) => {
            const element = listener.getElement();
            if (element === ev.currentTarget) {
                handled = handled || listener.onDragLeave();
            }
        });
        if (handled) {
            ev.preventDefault();
            return true;
        }
        return false;
    };
    private static dragEnterHandler = (ev: DragEvent): boolean => {
        let handled = false;
        DragAndDropHandler.listeners.forEach((listener) => {
            const element = listener.getElement();
            if (element === ev.currentTarget) {
                handled = handled || listener.onDragEnter();
            }
        });
        if (handled) {
            ev.preventDefault();
            return true;
        }
        return false;
    };

    /** 同步阶段：从 dataTransfer 中取出 FileSystemEntry（目录遍历用）与 File 兜底 */
    private static collectEntriesSync(dataTransfer: DataTransfer): { entries: FileSystemEntry[]; files: File[] } {
        const entries: FileSystemEntry[] = [];
        const files: File[] = [];
        if (dataTransfer.items) {
            for (let i = 0; i < dataTransfer.items.length; i++) {
                const item = dataTransfer.items[i];
                if (item.kind !== 'file') {
                    continue;
                }
                const getter = item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null };
                const entry = typeof getter.webkitGetAsEntry === 'function' ? getter.webkitGetAsEntry() : null;
                if (entry) {
                    entries.push(entry);
                    continue;
                }
                const file = item.getAsFile();
                if (file) {
                    files.push(file);
                }
            }
        } else {
            for (let i = 0; i < dataTransfer.files.length; i++) {
                files.push(dataTransfer.files[i]);
            }
        }
        return { entries, files };
    }

    /** 递归遍历拖入的目录树，返回全部文件（含相对路径） */
    private static async collectFiles(entries: FileSystemEntry[], fallbackFiles: File[]): Promise<DroppedFile[]> {
        const result: DroppedFile[] = [];
        for (const entry of entries) {
            await walkEntry(entry, '');
        }
        if (!entries.length) {
            // 浏览器不支持 webkitGetAsEntry（或非拖拽来源）时的兜底
            for (const file of fallbackFiles) {
                result.push({ file, relativePath: file.webkitRelativePath || '' });
            }
        }
        return result;

        async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<void> {
            if (entry.isFile) {
                const fileEntry = entry as FileSystemFileEntry;
                await new Promise<void>((resolve) => {
                    fileEntry.file(
                        (file) => {
                            const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
                            result.push({ file, relativePath });
                            resolve();
                        },
                        () => resolve(),
                    );
                });
                return;
            }
            if (!entry.isDirectory) {
                return;
            }
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
            const children: FileSystemEntry[] = [];
            // readEntries 每次调用最多返回一批（通常 100 条），需循环读尽
            for (;;) {
                const batch = await new Promise<FileSystemEntry[]>((resolve) => {
                    reader.readEntries(
                        (list) => resolve(list),
                        () => resolve([]),
                    );
                });
                if (!batch.length) {
                    break;
                }
                children.push(...batch);
            }
            for (const child of children) {
                await walkEntry(child, dirPrefix);
            }
        }
    }

    private static attachListeners(element: HTMLElement): void {
        element.addEventListener('drop', this.dropHandler);
        element.addEventListener('dragover', this.dragOverHandler);
        element.addEventListener('dragleave', this.dragLeaveHandler);
        element.addEventListener('dragenter', this.dragEnterHandler);
    }
    private static detachListeners(element: HTMLElement): void {
        element.removeEventListener('drop', this.dropHandler);
        element.removeEventListener('dragover', this.dragOverHandler);
        element.removeEventListener('dragleave', this.dragLeaveHandler);
        element.removeEventListener('dragenter', this.dragEnterHandler);
    }

    public static addEventListener(listener: DragEventListener): void {
        if (this.listeners.has(listener)) {
            return;
        }
        this.attachListeners(listener.getElement());
        this.listeners.add(listener);
    }
    public static removeEventListener(listener: DragEventListener): void {
        if (!this.listeners.has(listener)) {
            return;
        }
        this.detachListeners(listener.getElement());
        this.listeners.delete(listener);
    }
}
