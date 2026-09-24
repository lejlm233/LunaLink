import '../../../style/filelisting.css';
import { ParamsFileListing } from '../../../types/ParamsFileListing';
import { ManagerClient } from '../../client/ManagerClient';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import Util from '../../Util';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Entry } from '../Entry';
import { html } from '../../ui/HtmlTag';
import * as path from 'path';
import { ChannelCode } from '../../../common/ChannelCode';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import FilePushHandler, { DragAndPushListener, PushUpdateParams } from '../filePush/FilePushHandler';
import { AdbkitFilePushStream } from '../filePush/AdbkitFilePushStream';

const TAG = '[FileListing]';

const parentDirLinkBox = 'parentDirLinkBox';
const rootDirLinkBox = 'rootDirLinkBox';
const tempDirLinkBox = 'tempDirLinkBox';
const storageDirLinkBox = 'storageDirLinkBox';
const crumbBox = 'crumbBox';
const searchBox = 'searchBox';
const fileInputId = 'fl_file_input';
const dirInputId = 'fl_dir_input';

const rootPath = '/';
const tempPath = '/data/local/tmp';
const storagePath = '/storage';

type SortKey = 'name' | 'size' | 'mtime';
type SortDir = 'asc' | 'desc';

const SORT_KEY_STORAGE = 'fl_sort';
const SORT_DIR_STORAGE = 'fl_sortdir';

type Download = {
    receivedBytes: number;
    entry?: Entry;
    progressEl?: HTMLElement;
    anchor?: HTMLElement;
    chunks: Uint8Array[];
    path: string;
    pathToLoadAfter: string;
};
type Upload = { row: HTMLElement; progressEl: HTMLElement; anchor: HTMLElement; timeout: number | null };

enum Foreground {
    Drop = 'drop-target',
    Connect = 'connect',
}

const Message: Record<Foreground, string> = {
    [Foreground.Drop]: 'Drop files here',
    [Foreground.Connect]: 'Connection lost',
};

export class FileListingClient extends ManagerClient<ParamsFileListing, never> implements DragAndPushListener {
    public static readonly ACTION = ACTION.FILE_LISTING;
    public static readonly PARENT_DIR = '..';
    public static readonly PROPERTY_NAME = 'data-name';
    public static readonly PROPERTY_ENTRY_ID = 'data-entry-id';
    public static REMOVE_ROW_TIMEOUT = 2000;

    public static start(params: ParamsFileListing): FileListingClient {
        return new FileListingClient(params);
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        if (descriptor.state !== 'device') {
            return;
        }
        const entry = document.createElement('div');
        entry.classList.add('file-listing', blockClass);
        entry.appendChild(
            BaseDeviceTracker.buildLink(
                {
                    action: ACTION.FILE_LISTING,
                    udid: descriptor.udid,
                    path: `${tempPath}/`,
                },
                '文件',
                params,
            ),
        );
        return entry;
    }

    private static readonly IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic'];
    private static readonly VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'];
    private static readonly AUDIO_EXTS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'];
    private static readonly ARCHIVE_EXTS = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'];
    private static readonly DOC_EXTS = ['doc', 'docx', 'odt', 'rtf'];
    private static readonly SHEET_EXTS = ['xls', 'xlsx', 'csv', 'ods'];
    private static readonly SLIDE_EXTS = ['ppt', 'pptx', 'odp'];
    private static readonly TEXT_EXTS = ['txt', 'md', 'log', 'json', 'xml', 'ini', 'conf'];
    private static readonly EXEC_EXTS = ['apk', 'exe', 'msi', 'deb', 'rpm', 'dmg'];
    private static readonly CODE_EXTS = [
        'kt',
        'java',
        'py',
        'js',
        'ts',
        'c',
        'cpp',
        'h',
        'go',
        'rs',
        'html',
        'css',
        'sh',
        'sql',
    ];

    private static iconFor(name: string, typeClass: string): string {
        if (typeClass === 'dir') {
            return '📁';
        }
        if (typeClass === 'link') {
            return '🔗';
        }
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        if (FileListingClient.IMAGE_EXTS.includes(ext)) {
            return '🖼️';
        }
        if (FileListingClient.VIDEO_EXTS.includes(ext)) {
            return '🎬';
        }
        if (FileListingClient.AUDIO_EXTS.includes(ext)) {
            return '🎵';
        }
        if (FileListingClient.ARCHIVE_EXTS.includes(ext)) {
            return '📦';
        }
        if (ext === 'pdf') {
            return '📕';
        }
        if (FileListingClient.DOC_EXTS.includes(ext)) {
            return '📘';
        }
        if (FileListingClient.SHEET_EXTS.includes(ext)) {
            return '📗';
        }
        if (FileListingClient.SLIDE_EXTS.includes(ext)) {
            return '📙';
        }
        if (FileListingClient.TEXT_EXTS.includes(ext)) {
            return '📄';
        }
        if (FileListingClient.EXEC_EXTS.includes(ext)) {
            return '⚙️';
        }
        if (FileListingClient.CODE_EXTS.includes(ext)) {
            return '🧩';
        }
        return '📄';
    }

    private static fmtSize(size: number): string {
        if (size < 1024) {
            return `${size} B`;
        }
        if (size < 1048576) {
            return `${(size / 1024).toFixed(1)} KB`;
        }
        if (size < 1073741824) {
            return `${(size / 1048576).toFixed(1)} MB`;
        }
        return `${(size / 1073741824).toFixed(2)} GB`;
    }

    private static fmtTime(date: Date): string {
        const p = (x: number): string => (x < 10 ? '0' : '') + x;
        return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(
            date.getMinutes(),
        )}`;
    }

    private readonly serial: string;
    private readonly name: string;
    private readonly tableBodyId: string;
    private readonly wrapperId: string;
    private readonly filePushHandler?: FilePushHandler;
    private readonly parent: HTMLElement;
    private enterCount = 0;
    private entries: Entry[] = [];
    private path: string;
    private requireClean = false;
    private requestedPath = '';
    private downloads: Map<Multiplexer, Download> = new Map();
    private uploads: Map<string, Upload> = new Map();
    private tableBody: HTMLElement;
    private tableHead: HTMLElement;
    private crumbs: HTMLElement;
    private search: HTMLInputElement;
    private channels: Set<Multiplexer> = new Set();
    private sortKey: SortKey = 'name';
    private sortDir: SortDir = 'asc';
    private listComplete = false;
    constructor(params: ParamsFileListing) {
        super(params);
        this.parent = document.body;
        this.serial = this.params.udid;
        this.path = this.params.path;
        this.openNewConnection();
        this.setTitle(`Listing ${this.serial}`);
        this.setBodyClass('file-listing');
        this.name = `${TAG} [${this.serial}]`;
        this.tableBodyId = `${Util.escapeUdid(this.serial)}_list`;
        this.wrapperId = `wrapper_${this.tableBodyId}`;
        const storedSort = this.readStorage(SORT_KEY_STORAGE, 'name');
        this.sortKey = storedSort === 'size' || storedSort === 'mtime' ? storedSort : 'name';
        const storedDir = this.readStorage(SORT_DIR_STORAGE, 'asc');
        this.sortDir = storedDir === 'desc' ? 'desc' : 'asc';
        const fragment = html`<div id="${this.wrapperId}" class="listing">
            <div class="toolbar">
                <div id="${crumbBox}" class="crumbs"></div>
                <input id="${searchBox}" type="search" class="search" placeholder="搜索文件..." />
                <div class="upload-box">
                    <label class="upload-btn" title="上传文件"
                        >⬆ 文件<input id="${fileInputId}" type="file" multiple hidden
                    /></label>
                    <label class="upload-btn" title="上传文件夹（保持目录结构）"
                        >⬆ 文件夹<input id="${dirInputId}" type="file" webkitdirectory hidden
                    /></label>
                </div>
            </div>
            <div id="${parentDirLinkBox}" class="quick-link-box">
                <a class="icon up" href="#!" ${FileListingClient.PROPERTY_NAME}=".."> [parent] </a>
            </div>
            <div id="${rootDirLinkBox}" class="quick-link-box">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${rootPath}"> [root] </a>
            </div>
            <div id="${storageDirLinkBox}" class="quick-link-box">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${storagePath}/"> [storage] </a>
            </div>
            <div id="${tempDirLinkBox}" class="quick-link-box">
                <a class="icon dir" href="#!" ${FileListingClient.PROPERTY_NAME}="${tempPath}/"> [temp] </a>
            </div>
            <table>
                <thead>
                    <tr>
                        <th class="sortable" data-sort-key="name">Name</th>
                        <th class="sortable" data-sort-key="size">Size</th>
                        <th class="sortable" data-sort-key="mtime">MTime</th>
                    </tr>
                </thead>
                <tbody id="${this.tableBodyId}"></tbody>
            </table>
        </div>`.content;
        this.tableBody = fragment.getElementById(this.tableBodyId) as HTMLElement;
        this.tableHead = fragment.querySelector('thead') as HTMLElement;
        this.crumbs = fragment.getElementById(crumbBox) as HTMLElement;
        this.search = fragment.getElementById(searchBox) as HTMLInputElement;
        const wrapper = fragment.getElementById(this.wrapperId);
        if (wrapper) {
            wrapper.addEventListener('click', (e) => {
                if (!e.target || !(e.target instanceof HTMLElement)) {
                    return;
                }
                const name = e.target.getAttribute(FileListingClient.PROPERTY_NAME);
                if (!name) {
                    return;
                }
                e.preventDefault();
                e.cancelBubble = true;
                const newPath = path.resolve(this.path, name);
                if (newPath !== this.path) {
                    const entryIdString = e.target.getAttribute(FileListingClient.PROPERTY_ENTRY_ID);
                    let entry: Entry | undefined;
                    let anchor: HTMLElement | undefined;
                    if (entryIdString) {
                        const entryId = parseInt(entryIdString, 10);
                        if (!isNaN(entryId) && this.entries[entryId]) {
                            entry = this.entries[entryId];
                            anchor = e.target;
                        }
                    }
                    this.loadContent(newPath, entry, anchor);
                }
            });
            this.tableHead.addEventListener('click', (e) => {
                if (!e.target || !(e.target instanceof HTMLElement)) {
                    return;
                }
                const th = e.target.closest('th[data-sort-key]');
                if (!th) {
                    return;
                }
                this.toggleSort(th.getAttribute('data-sort-key') as SortKey);
            });
            this.search.addEventListener('input', () => {
                this.applySortAndFilter();
            });

            if (this.ws instanceof Multiplexer) {
                this.filePushHandler = new FilePushHandler(this.parent, new AdbkitFilePushStream(this.ws, this));
                this.filePushHandler.setTargetDir(this.path);
                this.filePushHandler.addEventListener(this);
            }

            const fileInput = fragment.getElementById(fileInputId) as HTMLInputElement;
            const dirInput = fragment.getElementById(dirInputId) as HTMLInputElement;
            const handlePicked = (input: HTMLInputElement): void => {
                const dropped = Array.from(input.files || []).map((file) => ({
                    file,
                    relativePath: file.webkitRelativePath || '',
                }));
                if (dropped.length && this.filePushHandler) {
                    this.filePushHandler.onFilesDrop(dropped);
                }
                input.value = '';
            };
            fileInput.addEventListener('change', () => handlePicked(fileInput));
            dirInput.addEventListener('change', () => handlePicked(dirInput));
        }
        this.parent.appendChild(fragment);
        this.renderCrumbs(this.path);
        this.updateSortIndicators();
    }

    private readStorage(key: string, fallback: string): string {
        try {
            return localStorage.getItem(key) || fallback;
        } catch (e) {
            return fallback;
        }
    }

    private writeStorage(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // ignore, e.g. private mode
        }
    }

    private toggleSort(key: SortKey): void {
        if (this.sortKey === key) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortKey = key;
            this.sortDir = 'asc';
        }
        this.writeStorage(SORT_KEY_STORAGE, this.sortKey);
        this.writeStorage(SORT_DIR_STORAGE, this.sortDir);
        this.updateSortIndicators();
        this.applySortAndFilter();
    }

    private updateSortIndicators(): void {
        const ths = this.tableHead.querySelectorAll('th[data-sort-key]');
        ths.forEach((th) => {
            const el = th as HTMLElement;
            el.classList.remove('asc', 'desc');
            if (el.getAttribute('data-sort-key') === this.sortKey) {
                el.classList.add(this.sortDir);
            }
        });
    }

    private renderCrumbs(currentPath: string): void {
        const box = this.crumbs;
        if (!box) {
            return;
        }
        box.textContent = '';
        const home = document.createElement('a');
        home.className = 'crumb';
        home.setAttribute(FileListingClient.PROPERTY_NAME, rootPath);
        home.title = rootPath;
        home.innerText = '🏠';
        box.appendChild(home);
        const parts = currentPath.split('/').filter(Boolean);
        let acc = '';
        parts.forEach((part, index) => {
            const sep = document.createElement('span');
            sep.className = 'sep';
            sep.innerText = '/';
            box.appendChild(sep);
            acc += `/${part}`;
            if (index === parts.length - 1) {
                const current = document.createElement('span');
                current.className = 'crumb current';
                current.innerText = part;
                box.appendChild(current);
            } else {
                const crumb = document.createElement('a');
                crumb.className = 'crumb';
                crumb.setAttribute(FileListingClient.PROPERTY_NAME, acc);
                crumb.title = acc;
                crumb.innerText = part;
                box.appendChild(crumb);
            }
        });
    }

    private applySortAndFilter(): void {
        const q = this.search.value.trim().toLowerCase();
        const rows = Array.from(this.tableBody.children) as HTMLElement[];
        const pushRows: HTMLElement[] = [];
        const normalRows: { row: HTMLElement; name: string; entry?: Entry }[] = [];
        rows.forEach((row) => {
            if (row.classList.contains('push-row')) {
                pushRows.push(row);
                return;
            }
            const link = row.querySelector(`a[${FileListingClient.PROPERTY_NAME}]`);
            const name = link ? link.getAttribute(FileListingClient.PROPERTY_NAME) || '' : '';
            let entry: Entry | undefined;
            if (link) {
                const entryIdString = link.getAttribute(FileListingClient.PROPERTY_ENTRY_ID);
                if (entryIdString) {
                    const entryId = parseInt(entryIdString, 10);
                    if (!isNaN(entryId) && this.entries[entryId]) {
                        entry = this.entries[entryId];
                    }
                }
            }
            normalRows.push({ row, name, entry });
        });
        let visibleCount = 0;
        normalRows.forEach(({ row, name }) => {
            const visible = !q || name.toLowerCase().includes(q);
            row.classList.toggle('filtered-out', !visible);
            if (visible) {
                visibleCount++;
            }
        });
        const dirDir = this.sortDir === 'desc' ? -1 : 1;
        normalRows.sort((a, b) => {
            const aDir = !!a.entry && a.entry.isDirectory();
            const bDir = !!b.entry && b.entry.isDirectory();
            if (aDir !== bDir) {
                return aDir ? -1 : 1;
            }
            if (this.sortKey === 'size') {
                const aSize = a.entry ? a.entry.size : 0;
                const bSize = b.entry ? b.entry.size : 0;
                return (aSize - bSize) * dirDir;
            }
            if (this.sortKey === 'mtime') {
                const aTime = a.entry ? a.entry.mtime.getTime() : 0;
                const bTime = b.entry ? b.entry.mtime.getTime() : 0;
                return (aTime - bTime) * dirDir;
            }
            return a.name.localeCompare(b.name, 'zh-Hans-CN') * dirDir;
        });
        pushRows.forEach((row) => this.tableBody.appendChild(row));
        normalRows.forEach(({ row }) => this.tableBody.appendChild(row));
        this.updateEmptyState(q, visibleCount);
    }

    private updateEmptyState(q: string, visibleCount: number): void {
        const oldEmpty = this.tableBody.querySelector('.empty-row');
        if (oldEmpty) {
            this.tableBody.removeChild(oldEmpty);
        }
        if (!this.listComplete || visibleCount > 0) {
            return;
        }
        const row = document.createElement('tr');
        row.className = 'empty-row';
        const td = document.createElement('td');
        td.colSpan = 3;
        td.innerText = q ? '没有匹配的文件' : '🗂️ 此文件夹是空的';
        row.appendChild(td);
        this.tableBody.appendChild(row);
    }

    public onDragEnter(): boolean {
        if (this.enterCount === 0) {
            this.addForeground(Foreground.Drop);
        }
        this.enterCount++;
        return true;
    }

    public onDragLeave(): boolean {
        this.enterCount--;
        if (this.enterCount < 0) {
            this.enterCount = 0;
        }
        if (this.enterCount === 0) {
            this.removeForeground(Foreground.Drop);
        }
        return true;
    }

    public onDrop(): boolean {
        this.enterCount = 0;
        this.removeForeground(Foreground.Drop);
        return true;
    }

    private findOrCreateEntryRow(fileName: string): HTMLElement {
        const row = document.getElementById(`entry-${fileName}`);
        if (row) {
            return row;
        }
        return this.addRow(true, fileName, 'file');
    }

    public onFilePushUpdate(data: PushUpdateParams): void {
        const { fileName, progress, error, message, finished } = data;
        // fileName 为设备端完整路径，界面上只显示文件名
        const displayName = fileName.split('/').pop() || fileName;
        let upload = this.uploads.get(fileName);
        if (!upload || document.getElementById(upload.anchor.id) !== upload.anchor) {
            const row = this.findOrCreateEntryRow(displayName);
            const anchor = row.getElementsByTagName('a')[0];
            if (!anchor.id) {
                anchor.id = `upload_${fileName}`;
            }
            const progressEl = this.appendProgressElement(anchor);
            upload = { row, progressEl, anchor, timeout: null };
            this.uploads.set(fileName, upload);
        }
        const { row, progressEl, anchor } = upload;
        if (error) {
            this.uploads.delete(fileName);
            progressEl.style.width = `100%`;
            progressEl.classList.add('error');
            if (!anchor.classList.contains('error')) {
                anchor.classList.add('error');
                anchor.innerText = `${displayName}. ${message}`;
            }
            if (!upload.timeout) {
                upload.timeout = window.setTimeout(() => {
                    const parent = row.parentElement;
                    if (parent) {
                        parent.removeChild(row);
                        this.reload();
                    }
                }, FileListingClient.REMOVE_ROW_TIMEOUT);
            }
        } else {
            anchor.innerText = `${displayName}. ${message}`;
            progressEl.style.width = `${progress}%`;
        }
        if (finished && !error) {
            this.uploads.delete(fileName);
            this.reload();
        }
        this.updateTransferBadge();
    }
    public onError(error: string | Error): void {
        console.error(this.name, 'FIXME: implement', error);
    }

    private addForeground(type: Foreground): void {
        const fragment = html`<div class="foreground ${type}">
            <div class="foreground-message ${type}-message">${Message[type]}</div>
        </div>`.content;
        this.parent.appendChild(fragment);
    }

    private removeForeground(type: Foreground): void {
        const els = this.parent.getElementsByClassName(type);
        Array.from(els).forEach((el) => {
            this.parent.removeChild(el);
        });
    }

    public static parseParameters(params: URLSearchParams): ParamsFileListing {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.FILE_LISTING) {
            throw Error('Incorrect action');
        }
        const pathParam = params.get('path');
        const path = pathParam || '/data/local/tmp';
        return { ...typedParams, action, udid: Util.parseString(params, 'udid', true), path };
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        localUrl.searchParams.set('action', ACTION.MULTIPLEX);
        return localUrl;
    }

    protected onSocketClose(event: CloseEvent): void {
        if (this.filePushHandler) {
            this.filePushHandler.release();
        }
        console.error(this.name, 'socket closed', event.reason);
        this.addForeground(Foreground.Connect);
    }

    protected onSocketMessage(_e: MessageEvent): void {
        // We create separate channel for each request
        // Don't expect any messages on this level
    }

    protected onSocketOpen(): void {
        this.loadContent(this.path);
    }

    protected loadContent(path: string, entry?: Entry, anchor?: HTMLElement, pathToLoadAfter = ''): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !(this.ws instanceof Multiplexer)) {
            return;
        }
        if (!entry && (this.channels.size || this.uploads.size)) {
            return;
        }
        this.requireClean = true;
        this.requestedPath = path;
        this.listComplete = false;
        let cmd: string;
        if (!entry) {
            cmd = Protocol.STAT;
        } else if (entry.isFile()) {
            cmd = Protocol.RECV;
        } else {
            cmd = Protocol.LIST;
        }
        const len = Buffer.byteLength(path, 'utf-8');
        const payload = Buffer.alloc(cmd.length + 4 + len);
        let pos = payload.write(cmd, 0);
        pos = payload.writeUInt32LE(len, pos);
        payload.write(path, pos);
        const channel = this.ws.createChannel(payload);
        this.channels.add(channel);
        const download: Download = {
            receivedBytes: 0,
            path,
            entry,
            anchor,
            chunks: [],
            pathToLoadAfter,
        };
        this.downloads.set(channel, download);
        this.updateTransferBadge();
        const onMessage = (event: MessageEvent): void => {
            this.handleReply(channel, event);
        };
        const onClose = (): void => {
            this.channels.delete(channel);
            this.downloads.delete(channel);
            this.updateTransferBadge();
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
            const isListing = !download.entry || download.entry.isDirectory();
            if (isListing) {
                this.listComplete = true;
                this.applySortAndFilter();
            }
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
    }

    protected clean(): void {
        this.tableBody.innerHTML = '';
        this.renderCrumbs(this.path);
        this.toggleQuickLinks(this.path);
        if (this.filePushHandler) {
            this.filePushHandler.setTargetDir(this.path);
        }

        // FIXME: should do over way around: load content on hash change
        const hash = location.hash.replace(/#!/, '');
        const params = new URLSearchParams(hash);
        if (params.get('action') === ACTION.FILE_LISTING) {
            params.set('path', this.path);
            location.hash = `#!${params.toString()}`;
        }
    }

    protected toggleQuickLinks(path: string): void {
        const isRoot = path === rootPath;
        const parentEl = document.getElementById(parentDirLinkBox);
        if (parentEl) {
            parentEl.classList.toggle('hidden', isRoot);
        }
        const rootEl = document.getElementById(rootDirLinkBox);
        if (rootEl) {
            rootEl.classList.toggle('hidden', isRoot);
        }
        const isTemp = path === tempPath;
        const tempEl = document.getElementById(tempDirLinkBox);
        if (tempEl) {
            tempEl.classList.toggle('hidden', isTemp);
        }
        const isStorage = path === storagePath;
        const storageEl = document.getElementById(storageDirLinkBox);
        if (storageEl) {
            storageEl.classList.toggle('hidden', isStorage);
        }
    }

    protected handleReply(channel: Multiplexer, e: MessageEvent): void {
        const data = Buffer.from(e.data);
        const reply = data.slice(0, 4).toString('ascii');
        switch (reply) {
            case Protocol.DENT:
                const stat = data.slice(4);
                const mode = stat.readUInt32LE(0);
                const size = stat.readUInt32LE(4);
                const mtime = stat.readUInt32LE(8);
                const namelen = stat.readUInt32LE(12);
                const name = Util.utf8ByteArrayToString(stat.slice(16, 16 + namelen));
                this.addEntry(new Entry(name, mode, size, mtime));
                return;
            case Protocol.DONE:
                this.finishDownload(channel);
                return;
            case Protocol.STAT: {
                const download = this.downloads.get(channel);
                if (!download) {
                    return;
                }
                const stat = data.slice(4);
                const mode = stat.readUInt32LE(0);
                const size = stat.readUInt32LE(4);
                const mtime = stat.readUInt32LE(8);
                const nameString = path.basename(download.path);
                if (mode === 0) {
                    console.error('FIXME: show error in UI');
                    console.error(`Error: no entity "${download.path}"`);
                    this.channels.delete(channel);
                    this.loadContent(tempPath);
                    return;
                }
                const entry = new Entry(nameString, mode, size, mtime);
                let anchor: HTMLElement | undefined;
                let nextPath = '';
                if (!entry.isDirectory()) {
                    nextPath = this.requestedPath = path.dirname(download.path);
                    const row = this.addEntry(entry);
                    anchor = row ? row.getElementsByTagName('a')[0] : undefined;
                }
                this.loadContent(download.path, entry, anchor, nextPath);
                break;
            }
            case Protocol.FAIL:
                const length = data.readUInt32LE(4);
                const message = Util.utf8ByteArrayToString(data.slice(8, 8 + length));
                console.error(TAG, `FAIL: ${message}`);
                return;
            case Protocol.DATA:
                const download = this.downloads.get(channel);
                if (!download) {
                    return;
                }
                download.chunks.push(data.slice(4));
                download.receivedBytes += data.length - 4;
                if (download.anchor) {
                    let progressElement = download.progressEl;
                    if (!progressElement) {
                        progressElement = this.appendProgressElement(download.anchor);
                        download.progressEl = progressElement;
                    }
                    if (download.entry) {
                        const { size } = download.entry;
                        const percent = (download.receivedBytes * 100) / size;
                        progressElement.style.width = `${percent}%`;
                    }
                }
                return;
            default:
                console.error(`Unexpected "${reply}"`);
        }
    }

    protected appendProgressElement(anchor: HTMLElement): HTMLElement {
        const progressElement = document.createElement('span');
        progressElement.className = 'background-progress';
        const parent = anchor.parentElement;
        if (parent) {
            parent.appendChild(progressElement);
        }
        return progressElement;
    }

    protected addEntry(entry: Entry): HTMLElement | undefined {
        if (this.requireClean) {
            this.path = this.requestedPath;
            this.requestedPath = '';
            this.clean();
            this.requireClean = false;
            this.listComplete = false;
            this.entries.length = 0;
        }
        this.entries.push(entry);
        const entryId = (this.entries.length - 1).toString();
        if (entry.name === '.') {
            return;
        }
        if (entry.name === FileListingClient.PARENT_DIR) {
            const el = document.getElementById(parentDirLinkBox);
            if (el) {
                const a = el.children[0];
                if (a) {
                    a.setAttribute(FileListingClient.PROPERTY_ENTRY_ID, entryId);
                }
            }
            return;
        }
        const type = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : entry.isFile() ? 'file' : 'else';
        return this.addRow(false, entry.name, type, entry, entryId);
    }

    protected addRow(push: boolean, name: string, typeClass: string, entry?: Entry, entryId = ''): HTMLElement {
        const row = document.createElement('tr');
        row.id = `entry-${name}`;
        row.classList.add('entry-row');
        if (push) {
            row.classList.add('push-row');
        }
        const nameTd = document.createElement('td');
        nameTd.classList.add('entry-name');
        const icon = document.createElement('span');
        icon.className = 'ic';
        icon.innerText = FileListingClient.iconFor(name, typeClass);
        const link = document.createElement('a');
        link.classList.add('icon', typeClass);
        link.setAttribute(FileListingClient.PROPERTY_NAME, name);
        if (entryId) {
            link.setAttribute(FileListingClient.PROPERTY_ENTRY_ID, entryId);
        }
        link.innerText = name;
        nameTd.appendChild(icon);
        nameTd.appendChild(link);
        row.appendChild(nameTd);
        if (push) {
            nameTd.colSpan = 3;
            link.classList.add('push');
        } else {
            const href = new URL(location.href);
            const hash = new URLSearchParams(href.hash.replace(/^#!/, ''));
            hash.set('path', path.join(this.path, name));
            href.hash = `#!${hash.toString()}`;
            link.href = href.toString();
            const sizeTd = document.createElement('td');
            sizeTd.classList.add('entry-size');
            sizeTd.innerText = entry && entry.isDirectory() ? '—' : entry ? FileListingClient.fmtSize(entry.size) : '';
            row.appendChild(sizeTd);
            const mtimeTd = document.createElement('td');
            mtimeTd.classList.add('entry-time');
            mtimeTd.innerText = entry ? FileListingClient.fmtTime(entry.mtime) : '';
            row.appendChild(mtimeTd);
        }
        if (push || !this.tableBody.children.length) {
            this.tableBody.insertBefore(row, this.tableBody.firstChild);
        } else {
            this.tableBody.appendChild(row);
        }
        return row;
    }

    protected finishDownload(channel: Multiplexer): void {
        const download = this.downloads.get(channel);
        if (!download) {
            return;
        }
        this.downloads.delete(channel);
        const el = download.progressEl;
        if (el) {
            this.cleanProgress(el);
        }
        let name: string;
        if (download.entry && download.entry.isFile()) {
            name = download.entry.name;
        } else {
            // we always should have `download.entry` and never be here
            name = path.basename(this.path);
        }
        if (download.pathToLoadAfter) {
            this.channels.delete(channel);
            this.loadContent(download.pathToLoadAfter);
        }
        const file = new File(download.chunks, name, { type: 'application/octet-stream' });
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        if (FileListingClient.IMAGE_EXTS.includes(ext) || FileListingClient.VIDEO_EXTS.includes(ext)) {
            // 图片/视频：打开预览弹层（下载入口在弹层内），而不是直接触发下载
            this.openPreview(file, FileListingClient.VIDEO_EXTS.includes(ext));
            return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = `${name}`;
        a.click();
    }

    /** 图片/视频预览弹层：遮罩 + 顶部工具条（文件名 / 下载 / 关闭） */
    private openPreview(file: File, video: boolean): void {
        const url = URL.createObjectURL(file);
        const overlay = document.createElement('div');
        overlay.className = 'fl-preview-overlay';
        const close = (): void => {
            URL.revokeObjectURL(url);
            if (overlay.parentElement) {
                overlay.parentElement.removeChild(overlay);
            }
            document.removeEventListener('keydown', onKey);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                close();
            }
        };
        document.addEventListener('keydown', onKey);

        const media = video ? document.createElement('video') : document.createElement('img');
        media.className = 'fl-preview-media';
        media.setAttribute('src', url);
        if (video) {
            (media as HTMLVideoElement).controls = true;
            (media as HTMLVideoElement).autoplay = true;
        }

        const bar = document.createElement('div');
        bar.className = 'fl-preview-bar';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'fl-preview-name';
        nameSpan.innerText = file.name;
        const dl = document.createElement('a');
        dl.className = 'fl-preview-download';
        dl.innerText = '⬇ 下载';
        dl.href = url;
        dl.download = file.name;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fl-preview-close';
        closeBtn.setAttribute('aria-label', '关闭预览');
        closeBtn.innerText = '✕';
        closeBtn.addEventListener('click', close);
        bar.appendChild(nameSpan);
        bar.appendChild(dl);
        bar.appendChild(closeBtn);

        overlay.appendChild(bar);
        overlay.appendChild(media);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                close();
            }
        });
        document.body.appendChild(overlay);
    }

    /** 右下角传输状态徽章：显示进行中的上传/下载数量 */
    private transferBadge?: HTMLElement;
    private updateTransferBadge(): void {
        const downloading = Array.from(this.downloads.values()).filter(
            (download) => download.entry && download.entry.isFile(),
        ).length;
        const uploading = this.uploads.size;
        if (!this.transferBadge) {
            this.transferBadge = document.createElement('div');
            this.transferBadge.className = 'fl-transfer-badge hidden';
            document.body.appendChild(this.transferBadge);
        }
        if (uploading + downloading === 0) {
            this.transferBadge.classList.add('hidden');
            return;
        }
        this.transferBadge.classList.remove('hidden');
        this.transferBadge.innerText = `⬆ ${uploading} 上传中　⬇ ${downloading} 下载中`;
    }

    protected cleanProgress(el: HTMLElement): void {
        el.classList.add('finished');
        setTimeout(() => {
            const parent = el.parentElement;
            if (parent) {
                parent.removeChild(el);
            }
        });
    }

    public getPath(): string {
        return this.path;
    }

    public reload(): void {
        this.loadContent(this.path);
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const serial = Util.stringToUtf8ByteArray(this.serial);
        const buffer = Buffer.alloc(4 + 4 + serial.byteLength);
        buffer.write(ChannelCode.FSLS, 'ascii');
        buffer.writeUInt32LE(serial.length, 4);
        buffer.set(serial, 8);
        return buffer;
    }
}
