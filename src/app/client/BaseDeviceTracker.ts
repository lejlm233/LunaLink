import { ManagerClient } from './ManagerClient';
import { Message } from '../../types/Message';
import { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import { DeviceTrackerEvent } from '../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../types/DeviceTrackerEventList';
import { html } from '../ui/HtmlTag';
import { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';
import { HostItem } from '../../types/Configuration';
import { Tool } from './Tool';
import Util from '../Util';
import { EventMap } from '../../common/TypedEmitter';

const TAG = '[BaseDeviceTracker]';

export abstract class BaseDeviceTracker<DD extends BaseDeviceDescriptor, TE extends EventMap> extends ManagerClient<
    ParamsDeviceTracker,
    TE
> {
    public static readonly ACTION_LIST = 'devicelist';
    public static readonly ACTION_DEVICE = 'device';
    public static readonly HOLDER_ELEMENT_ID = 'devices';
    public static readonly AttributePrefixInterfaceSelectFor = 'interface_select_for_';
    public static readonly AttributePlayerFullName = 'data-player-full-name';
    public static readonly AttributePlayerCodeName = 'data-player-code-name';
    public static readonly AttributePrefixPlayerFor = 'player_for_';
    protected static tools: Set<Tool> = new Set();
    protected static instanceId = 0;

    public static registerTool(tool: Tool): void {
        this.tools.add(tool);
    }

    public static buildUrl(item: HostItem): URL {
        const { secure, port, hostname } = item;
        const pathname = item.pathname ?? '/';
        const protocol = secure ? 'wss:' : 'ws:';
        const url = new URL(`${protocol}//${hostname}${pathname}`);
        if (port) {
            url.port = port.toString();
        }
        return url;
    }

    public static buildUrlForTracker(params: HostItem): URL {
        const wsUrl = this.buildUrl(params);
        wsUrl.searchParams.set('action', this.ACTION);
        return wsUrl;
    }

    public static buildLink(q: any, text: string, params: ParamsDeviceTracker): HTMLSpanElement {
        let { hostname } = params;
        let port: string | number | undefined = params.port;
        let pathname = params.pathname ?? location.pathname;
        let protocol = params.secure ? 'https:' : 'http:';
        if (params.useProxy) {
            q.hostname = hostname;
            q.port = port;
            q.pathname = pathname;
            q.secure = params.secure;
            q.useProxy = true;
            protocol = location.protocol;
            hostname = location.hostname;
            port = location.port;
            pathname = location.pathname;
        }
        const hash = `#!${new URLSearchParams(q).toString()}`;
        const url = `${protocol}//${hostname}:${port}${pathname}${hash}`;
        const span = document.createElement('span');
        span.classList.add(`link-${q.action}`, 'popup-link');
        span.innerText = text;
        span.style.cursor = 'pointer';
        span.addEventListener('click', (e) => {
            e.preventDefault();
            const popupName = `ws_${q.action}_${q.udid || 'tool'}`;
            const popupWidth = 400;
            const popupHeight = 750;
            // 投屏/工具弹窗固定出现在屏幕左下角（任务栏上方）
            const popupLeft = 0;
            const popupTop = Math.max(0, (window.screen.availHeight || popupHeight) - popupHeight);
            const popup = window.open(
                url,
                popupName,
                `width=${popupWidth},height=${popupHeight},left=${popupLeft},top=${popupTop},resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`,
            );
            if (!popup) {
                // Popup blocked, fall back to new tab (attach to DOM for mobile browsers)
                // 提示：标签页模式下脚本无法自动调整窗口大小，旋转后窗口不会自动跟随
                console.warn(
                    '[Popup] window.open 被浏览器拦截，已退回新标签页打开。',
                    '标签页模式无法脚本调整窗口大小（旋转不自动适配）；建议在地址栏左侧允许本站弹窗后重试。',
                );
                const a = document.createElement('a');
                a.setAttribute('href', url);
                a.setAttribute('rel', 'noopener noreferrer');
                a.setAttribute('target', '_blank');
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => a.remove(), 100);
            }
        });
        return span;
    }

    protected title = 'Device list';
    protected tableId = 'base_device_list';
    protected descriptors: DD[] = [];
    protected elementId: string;
    protected trackerName = '';
    protected id = '';
    private created = false;
    private messageId = 0;

    protected constructor(params: ParamsDeviceTracker, protected readonly directUrl: string) {
        super(params);
        this.elementId = `tracker_instance${++BaseDeviceTracker.instanceId}`;
        this.trackerName = `Unavailable. Host: ${params.hostname}, type: ${params.type}`;
        this.setBodyClass('list');
        this.setTitle();
    }

    public static parseParameters(params: URLSearchParams): ParamsDeviceTracker {
        const typedParams = super.parseParameters(params);
        const type = Util.parseString(params, 'type', true);
        if (type !== 'android' && type !== 'ios') {
            throw Error('Incorrect type');
        }
        return { ...typedParams, type };
    }

    protected getNextId(): number {
        return ++this.messageId;
    }

    protected buildDeviceTable(): void {
        const data = this.descriptors;
        const devices = this.getOrCreateTableHolder();
        const tbody = this.getOrBuildTableBody(devices);

        const block = this.getOrCreateTrackerBlock(tbody, this.trackerName);
        data.forEach((item) => {
            this.buildDeviceRow(block, item);
        });
    }

    private setNameValue(parent: Element | null, name: string): void {
        if (!parent) {
            return;
        }
        const nameBlockId = `${this.elementId}_name`;
        let nameEl = document.getElementById(nameBlockId);
        if (!nameEl) {
            nameEl = document.createElement('div');
            nameEl.id = nameBlockId;
            nameEl.className = 'tracker-name';

            const nameText = document.createElement('span');
            nameText.className = 'tracker-name-text';
            nameText.innerText = name;
            nameEl.appendChild(nameText);

            if (this.params.type === 'android') {
                const connectForm = this.createConnectForm();
                nameEl.appendChild(connectForm);
            }
        } else {
            const nameText = nameEl.querySelector('.tracker-name-text');
            if (nameText) {
                nameText.textContent = name;
            }
        }
        parent.insertBefore(nameEl, parent.firstChild);
    }

    private getOrCreateTrackerBlock(parent: Element, controlCenterName: string): Element {
        let el = document.getElementById(this.elementId);
        if (!el) {
            el = document.createElement('div');
            el.id = this.elementId;
            parent.appendChild(el);
            this.created = true;
        } else {
            const nameBlockId = `${this.elementId}_name`;
            const nameEl = document.getElementById(nameBlockId);
            const elRef = el;
            Array.from(el.children).forEach((child) => {
                if (child !== nameEl) {
                    elRef.removeChild(child);
                }
            });
        }
        this.setNameValue(el, controlCenterName);
        return el;
    }

    private createConnectForm(): HTMLElement {
        const form = document.createElement('div');
        form.className = 'tracker-connect-form';

        // IP address label
        const ipLabel = document.createElement('span');
        ipLabel.className = 'connect-label';
        ipLabel.innerText = 'IP地址';
        form.appendChild(ipLabel);

        // 4 segmented IP octet inputs
        const ipInputs: HTMLInputElement[] = [];
        const ipContainer = document.createElement('div');
        ipContainer.className = 'connect-ip-segments';

        for (let i = 0; i < 4; i++) {
            const octet = document.createElement('input');
            octet.type = 'text';
            octet.className = 'connect-input connect-ip-octet';
            octet.maxLength = 3;
            octet.inputMode = 'numeric';
            octet.pattern = '[0-9]*';
            octet.placeholder = i === 0 ? '192' : i === 1 ? '168' : i === 2 ? '1' : '100';

            const nextIdx = i + 1;
            const prevIdx = i - 1;

            octet.addEventListener('input', () => {
                // Strip non-digits
                const val = octet.value.replace(/\D/g, '');
                octet.value = val;
                // Auto-advance when 3 digits entered (or value >= 25 for 2nd char like 192.168...)
                if (val.length >= 3) {
                    const next = ipInputs[nextIdx];
                    if (next) {
                        next.focus();
                        next.select();
                    }
                }
            });

            octet.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && octet.value === '') {
                    const prev = ipInputs[prevIdx];
                    if (prev) {
                        prev.focus();
                        prev.select();
                    }
                } else if (e.key === '.' || e.key === 'ArrowRight') {
                    const next = ipInputs[nextIdx];
                    if (next) {
                        e.preventDefault();
                        next.focus();
                        next.select();
                    }
                } else if (e.key === 'ArrowLeft' && octet.selectionStart === 0) {
                    const prev = ipInputs[prevIdx];
                    if (prev) {
                        e.preventDefault();
                        prev.focus();
                        prev.select();
                    }
                }
            });

            octet.addEventListener('paste', (e) => {
                e.preventDefault();
                const pasteData = e.clipboardData?.getData('text') || '';
                const parts = pasteData.split('.');
                for (let j = 0; j < Math.min(parts.length, 4); j++) {
                    const digits = parts[j].replace(/\D/g, '').substring(0, 3);
                    if (j < ipInputs.length) {
                        ipInputs[j].value = digits;
                    }
                }
                // Focus the next empty one after pasting
                for (let j = 0; j < 4; j++) {
                    if (!ipInputs[j].value && j > 0) {
                        ipInputs[j].focus();
                        break;
                    }
                }
            });

            ipContainer.appendChild(octet);
            ipInputs.push(octet);
        }
        form.appendChild(ipContainer);

        // Connection port
        const connPortInput = document.createElement('input');
        connPortInput.type = 'number';
        connPortInput.className = 'connect-input connect-port';
        connPortInput.placeholder = '连接端口';
        connPortInput.value = '5555';
        connPortInput.title = '设备连接端口号';
        form.appendChild(connPortInput);

        // Pairing port
        const pairPortInput = document.createElement('input');
        pairPortInput.type = 'number';
        pairPortInput.className = 'connect-input connect-pair-port';
        pairPortInput.placeholder = '配对端口';
        pairPortInput.title = '无线调试配对端口号';
        form.appendChild(pairPortInput);

        // Pairing code
        const pairCodeInput = document.createElement('input');
        pairCodeInput.type = 'text';
        pairCodeInput.className = 'connect-input connect-pair-code';
        pairCodeInput.placeholder = '配对码';
        pairCodeInput.maxLength = 6;
        pairCodeInput.inputMode = 'numeric';
        pairCodeInput.pattern = '[0-9]*';
        pairCodeInput.title = '无线调试配对码（6位数字）';
        form.appendChild(pairCodeInput);

        // Pair button
        const pairBtn = document.createElement('button');
        pairBtn.className = 'pair-btn';
        pairBtn.type = 'button';
        pairBtn.innerText = '配对';
        pairBtn.onclick = (e: MouseEvent) => {
            e.preventDefault();
            this.onPairDevice(ipInputs, pairPortInput, pairCodeInput, pairBtn);
        };
        form.appendChild(pairBtn);

        // Connect button
        const connectBtn = document.createElement('button');
        connectBtn.className = 'do-connect-btn';
        connectBtn.type = 'button';
        connectBtn.innerText = '连接设备';
        connectBtn.title = '直接连接设备（部分设备无需配对）';
        connectBtn.onclick = (e: MouseEvent) => {
            e.preventDefault();
            const ip = ipInputs.map((inp) => inp.value).join('.');
            if (ip.split('.').filter(Boolean).length !== 4) {
                return;
            }
            this.onConnectDevice(ip, connPortInput.value.trim(), connectBtn);
        };
        form.appendChild(connectBtn);

        // 整理设备按钮：重新从 adb 发现设备，并移除已断开的离线设备。
        // 服务端的 refresh 命令本身已包含清除离线逻辑，故合并为一个按钮，节省标题栏宽度。
        const tidyBtn = document.createElement('button');
        tidyBtn.className = 'refresh-btn';
        tidyBtn.type = 'button';
        tidyBtn.innerText = '整理设备';
        tidyBtn.title = '重新从 adb 拉取设备列表，并移除已断开连接的设备';
        tidyBtn.onclick = (e: MouseEvent) => {
            e.preventDefault();
            this.onSendCommand('refresh', tidyBtn);
        };
        form.appendChild(tidyBtn);

        const statusEl = document.createElement('span');
        statusEl.className = 'connect-status';
        form.appendChild(statusEl);

        // 用原生 <details> 包裹表单：移动端默认收起（点 summary 展开），桌面端默认展开
        const details = document.createElement('details');
        details.className = 'connect-details';
        const summary = document.createElement('summary');
        summary.className = 'connect-details-summary';
        summary.innerText = '添加设备';
        details.appendChild(summary);
        details.appendChild(form);

        // 关键修复：<details> 未 open 时浏览器原生隐藏内容，仅 CSS !important 难覆盖。
        // 故桌面端（>768px）直接 open=true 常显，移动端默认收起；跨断点切换视口时同步。
        const mq = window.matchMedia('(max-width: 768px)');
        const syncOpenState = (): void => {
            details.open = !mq.matches;
        };
        syncOpenState();
        mq.addEventListener('change', syncOpenState);

        return details;
    }

    private onSendCommand(type: string, btn: HTMLButtonElement): void {
        const data: Message = {
            id: this.getNextId(),
            type,
            data: {},
        };
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
            const original = btn.innerText;
            btn.innerText = '处理中...';
            btn.setAttribute('disabled', 'true');
            setTimeout(() => {
                btn.innerText = original;
                btn.removeAttribute('disabled');
            }, 3000);
        }
    }

    private onPairDevice(
        ipInputs: HTMLInputElement[],
        pairPortInput: HTMLInputElement,
        pairCodeInput: HTMLInputElement,
        pairBtn: HTMLButtonElement,
    ): void {
        const ip = ipInputs.map((inp) => inp.value).join('.');
        if (ip.split('.').filter(Boolean).length !== 4) {
            return;
        }
        const pairPort = parseInt(pairPortInput.value, 10);
        if (isNaN(pairPort) || pairPort <= 0) {
            return;
        }
        const code = pairCodeInput.value.trim();
        if (!code) {
            return;
        }
        const data: Message = {
            id: this.getNextId(),
            type: 'pair',
            data: {
                host: ip,
                port: pairPort,
                code,
            },
        };
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
            pairBtn.innerText = '配对中...';
        }
    }

    private onPairResult(result: { success: boolean; message: string }): void {
        const nameEl = document.getElementById(`${this.elementId}_name`);
        if (!nameEl) {
            return;
        }
        const statusEl = nameEl.querySelector('.connect-status') as HTMLElement;
        const pairBtn = nameEl.querySelector('.pair-btn') as HTMLButtonElement;
        if (pairBtn) {
            pairBtn.innerText = '配对';
        }
        if (statusEl) {
            if (result.success) {
                statusEl.textContent = '\u2713 ' + (result.message || '配对成功');
                statusEl.className = 'connect-status connect-status-success';
            } else {
                statusEl.textContent = '\u2717 ' + (result.message || '配对失败');
                statusEl.className = 'connect-status connect-status-error';
            }
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.className = 'connect-status';
            }, 5000);
        }
    }

    private onConnectDevice(ip: string, port: string, btn: HTMLButtonElement): void {
        if (!ip) {
            return;
        }
        const portNum = parseInt(port, 10) || 5555;
        const data: Message = {
            id: this.getNextId(),
            type: 'connect',
            data: {
                host: ip,
                port: portNum,
            },
        };
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
            btn.innerText = '连接中...';
        }
    }

    private onConnectResult(result: { success: boolean; message: string }): void {
        const nameEl = document.getElementById(`${this.elementId}_name`);
        if (!nameEl) {
            return;
        }
        const statusEl = nameEl.querySelector('.connect-status') as HTMLElement;
        const btn = nameEl.querySelector('.do-connect-btn') as HTMLButtonElement;
        if (btn) {
            btn.innerText = '连接设备';
        }
        if (statusEl) {
            if (result.success) {
                statusEl.textContent = '\u2713 ' + (result.message || '连接成功');
                statusEl.className = 'connect-status connect-status-success';
            } else {
                statusEl.textContent = '\u2717 ' + (result.message || '连接失败');
                statusEl.className = 'connect-status connect-status-error';
            }
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.className = 'connect-status';
            }, 5000);
        }
    }

    private onCommandResult(result: { success: boolean; message: string }): void {
        const nameEl = document.getElementById(`${this.elementId}_name`);
        if (!nameEl) {
            return;
        }
        const statusEl = nameEl.querySelector('.connect-status') as HTMLElement;
        if (statusEl) {
            if (result.success) {
                statusEl.textContent = '\u2713 ' + (result.message || '完成');
                statusEl.className = 'connect-status connect-status-success';
            } else {
                statusEl.textContent = '\u2717 ' + (result.message || '失败');
                statusEl.className = 'connect-status connect-status-error';
            }
            setTimeout(() => {
                statusEl.textContent = '';
                statusEl.className = 'connect-status';
            }, 5000);
        }
    }

    protected abstract buildDeviceRow(tbody: Element, device: DD): void;

    protected onSocketClose(event: CloseEvent): void {
        if (this.destroyed) {
            return;
        }
        console.log(TAG, `Connection closed: ${event.reason}`);
        setTimeout(() => {
            this.openNewConnection();
        }, 2000);
    }

    protected onSocketMessage(event: MessageEvent): void {
        let message: Message;
        try {
            message = JSON.parse(event.data);
        } catch (error: any) {
            console.error(TAG, error.message);
            console.log(TAG, error.data);
            return;
        }
        switch (message.type) {
            case BaseDeviceTracker.ACTION_LIST: {
                const event = message.data as DeviceTrackerEventList<DD>;
                this.descriptors = event.list;
                this.setIdAndHostName(event.id, event.name);
                this.buildDeviceTable();
                break;
            }
            case BaseDeviceTracker.ACTION_DEVICE: {
                const event = message.data as DeviceTrackerEvent<DD>;
                this.setIdAndHostName(event.id, event.name);
                this.updateDescriptor(event.device);
                this.buildDeviceTable();
                break;
            }
            case 'connect_result': {
                this.onConnectResult(message.data);
                break;
            }
            case 'pair_result': {
                this.onPairResult(message.data);
                break;
            }
            case 'command_result': {
                this.onCommandResult(message.data);
                break;
            }
            default:
                console.log(TAG, `Unknown message type: ${message.type}`);
        }
    }

    protected setIdAndHostName(id: string, trackerName: string): void {
        if (this.id === id && this.trackerName === trackerName) {
            return;
        }
        this.id = id;
        this.trackerName = trackerName;
        this.setNameValue(document.getElementById(this.elementId), trackerName);
    }

    protected getOrCreateTableHolder(): HTMLElement {
        const id = BaseDeviceTracker.HOLDER_ELEMENT_ID;
        let devices = document.getElementById(id);
        if (!devices) {
            devices = document.createElement('div');
            devices.id = id;
            devices.className = 'table-wrapper';
            document.body.appendChild(devices);
        }
        return devices;
    }

    protected updateDescriptor(descriptor: DD): void {
        const idx = this.descriptors.findIndex((item: DD) => {
            return item.udid === descriptor.udid;
        });
        if (idx !== -1) {
            this.descriptors[idx] = descriptor;
        } else {
            this.descriptors.push(descriptor);
        }
    }

    protected getOrBuildTableBody(parent: HTMLElement): Element {
        const className = 'device-list';
        let tbody = document.querySelector(
            `#${BaseDeviceTracker.HOLDER_ELEMENT_ID} #${this.tableId}.${className}`,
        ) as Element;
        if (!tbody) {
            const fragment = html`<div id="${this.tableId}" class="${className}"></div>`.content;
            parent.appendChild(fragment);
            const last = parent.children.item(parent.children.length - 1);
            if (last) {
                tbody = last;
            }
        }
        return tbody;
    }

    public getDescriptorByUdid(udid: string): DD | undefined {
        if (!this.descriptors.length) {
            return;
        }
        return this.descriptors.find((descriptor: DD) => {
            return descriptor.udid === udid;
        });
    }

    public destroy(): void {
        super.destroy();
        if (this.created) {
            const el = document.getElementById(this.elementId);
            if (el) {
                const { parentElement } = el;
                el.remove();
                if (parentElement && !parentElement.children.length) {
                    parentElement.remove();
                }
            }
        }
        const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
        if (holder && !holder.children.length) {
            holder.remove();
        }
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelCode(): string {
        throw Error('Not implemented. Must override');
    }

    protected getChannelInitData(): Buffer {
        const code = this.getChannelCode();
        const buffer = Buffer.alloc(code.length);
        buffer.write(code, 'ascii');
        return buffer;
    }
}
