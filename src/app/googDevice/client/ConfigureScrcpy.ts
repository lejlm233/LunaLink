import '../../../style/dialog.css';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { DisplayCombinedInfo } from '../../client/StreamReceiver';
import VideoSettings from '../../VideoSettings';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import Util from '../../Util';
import { DisplayInfo } from '../../DisplayInfo';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import SvgImage from '../../ui/SvgImage';
import { PlayerClass } from '../../player/BasePlayer';
import { DeviceTracker } from './DeviceTracker';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { BaseClient } from '../../client/BaseClient';

interface ConfigureScrcpyEvents {
    closed: { dialog: ConfigureScrcpy; result: boolean };
}

type Range = {
    max: number;
    min: number;
    step: number;
    formatter?: (value: number) => string;
};

export class ConfigureScrcpy extends BaseClient<ParamsStreamScrcpy, ConfigureScrcpyEvents> {
    private readonly TAG: string;
    private readonly udid: string;
    private readonly escapedUdid: string;
    private readonly playerStorageKey: string;
    private deviceName: string;
    private streamReceiver?: StreamReceiverScrcpy;
    private displayInfo?: DisplayInfo;
    private background: HTMLElement;
    private dialogBody?: HTMLElement;
    private autoScreenOffCheckbox?: HTMLInputElement;
    private autoScreenOffStorageKey: string;
    private scalePercentStorageKey: string;
    private resetSettingsButton?: HTMLButtonElement;
    private loadSettingsButton?: HTMLButtonElement;
    private saveSettingsButton?: HTMLButtonElement;
    private playerSelectElement?: HTMLSelectElement;
    private displayIdSelectElement?: HTMLSelectElement;
    private encoderSelectElement?: HTMLSelectElement;
    private connectionStatusElement?: HTMLElement;
    private dialogContainer?: HTMLElement;
    private statusText = '';
    private connectionCount = 0;

    constructor(private readonly tracker: DeviceTracker, descriptor: GoogDeviceDescriptor, params: ParamsStreamScrcpy) {
        super(params);
        this.udid = descriptor.udid;
        this.escapedUdid = Util.escapeUdid(this.udid);
        this.playerStorageKey = `configure_stream::${this.escapedUdid}::player`;
        this.autoScreenOffStorageKey = `configure_stream::${this.escapedUdid}::autoScreenOff`;
        this.scalePercentStorageKey = `configure_stream::${this.escapedUdid}::scalePercent`;
        this.deviceName = descriptor['ro.product.model'];
        this.TAG = `ConfigureScrcpy[${this.udid}]`;
        this.createStreamReceiver(params);
        this.setTitle(`${this.deviceName}. Configure stream`);
        this.background = this.createUI();
    }

    public getTracker(): DeviceTracker {
        return this.tracker;
    }

    private createStreamReceiver(params: ParamsStreamScrcpy): void {
        if (this.streamReceiver) {
            this.detachEventsListeners(this.streamReceiver);
            this.streamReceiver.stop();
        }
        this.streamReceiver = new StreamReceiverScrcpy(params);
        this.attachEventsListeners(this.streamReceiver);
    }

    private attachEventsListeners(streamReceiver: StreamReceiverScrcpy): void {
        streamReceiver.on('encoders', this.onEncoders);
        streamReceiver.on('displayInfo', this.onDisplayInfo);
        streamReceiver.on('connected', this.onConnected);
        streamReceiver.on('disconnected', this.onDisconnected);
    }

    private detachEventsListeners(streamReceiver: StreamReceiverScrcpy): void {
        streamReceiver.off('encoders', this.onEncoders);
        streamReceiver.off('displayInfo', this.onDisplayInfo);
        streamReceiver.off('connected', this.onConnected);
        streamReceiver.off('disconnected', this.onDisconnected);
    }

    private updateStatus(): void {
        if (!this.connectionStatusElement) {
            return;
        }
        let text = this.statusText;
        if (this.connectionCount) {
            text = `${text}. Other clients: ${this.connectionCount}.`;
        }
        this.connectionStatusElement.innerText = text;
    }

    private onEncoders = (encoders: string[]): void => {
        // console.log(this.TAG, 'Encoders', encoders);
        const select = this.encoderSelectElement || document.createElement('select');
        let child;
        while ((child = select.firstChild)) {
            select.removeChild(child);
        }
        encoders.unshift('');
        encoders.forEach((value) => {
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', value);
            // 空值代表「自动选择」，显式标注避免看起来像没加载
            optionElement.innerText = value || '（自动）';
            select.appendChild(optionElement);
        });
        this.encoderSelectElement = select;
    };

    private onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        // console.log(this.TAG, 'Received info');
        this.statusText = 'Ready';
        this.updateStatus();
        this.dialogContainer?.classList.add('ready');
        const select = this.displayIdSelectElement || document.createElement('select');
        let child;
        while ((child = select.firstChild)) {
            select.removeChild(child);
        }
        let selectedOptionIdx = -1;
        infoArray.forEach((value: DisplayCombinedInfo, idx: number) => {
            const { displayInfo } = value;
            const { displayId, size } = displayInfo;
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', displayId.toString());
            optionElement.innerText = `ID: ${displayId}; ${size.width}x${size.height}`;
            select.appendChild(optionElement);
            if (
                (this.displayInfo && this.displayInfo.displayId === displayId) ||
                (!this.displayInfo && displayId === DisplayInfo.DEFAULT_DISPLAY)
            ) {
                selectedOptionIdx = idx;
            }
        });
        if (selectedOptionIdx > -1) {
            select.selectedIndex = selectedOptionIdx;
            const { videoSettings, connectionCount, displayInfo } = infoArray[selectedOptionIdx];
            this.displayInfo = displayInfo;
            if (connectionCount > 0 && videoSettings) {
                // console.log(this.TAG, 'Apply other clients settings');
                this.fillInputsFromVideoSettings(videoSettings);
            } else {
                // console.log(this.TAG, 'Apply settings for current player');
                this.updateVideoSettingsForPlayer();
            }
            this.connectionCount = connectionCount;
            this.updateStatus();
        }
        this.displayIdSelectElement = select;
        if (this.dialogBody) {
            this.dialogBody.classList.remove('hidden');
            this.dialogBody.classList.add('visible');
        }
    };

    private onConnected = (): void => {
        // console.log(this.TAG, 'Connected');
        this.statusText = 'Waiting for info...';
        this.updateStatus();
    };

    private onDisconnected = (): void => {
        // console.log(this.TAG, 'Disconnected');
        this.statusText = 'Disconnected';
        this.updateStatus();
        if (this.dialogBody) {
            this.dialogBody.classList.remove('visible');
            this.dialogBody.classList.add('hidden');
        }
    };

    private onPlayerChange = (): void => {
        this.updateVideoSettingsForPlayer();
    };

    private onDisplayIdChange = (): void => {
        const select = this.displayIdSelectElement;
        if (!select || !this.streamReceiver) {
            return;
        }
        const value = select.options[select.selectedIndex].value;
        const displayId = parseInt(value, 10);
        if (!isNaN(displayId)) {
            this.displayInfo = this.streamReceiver.getDisplayInfo(displayId);
        }
        this.updateVideoSettingsForPlayer();
    };

    private getPlayer(): PlayerClass | undefined {
        if (!this.playerSelectElement) {
            return;
        }
        const playerName = this.playerSelectElement.options[this.playerSelectElement.selectedIndex].value;
        return StreamClientScrcpy.getPlayers().find((playerClass) => {
            return playerClass.playerFullName === playerName;
        });
    }

    private updateVideoSettingsForPlayer(): void {
        const player = this.getPlayer();
        if (player) {
            const storedOrPreferred = player.loadVideoSettings(this.udid, this.displayInfo);
            this.fillInputsFromVideoSettings(storedOrPreferred);
        }
    }

    private getBasicInput(id: string): HTMLInputElement | null {
        const element = document.getElementById(`${id}_${this.escapedUdid}`);
        if (!element) {
            return null;
        }
        return element as HTMLInputElement;
    }

    private fillInputsFromVideoSettings(videoSettings: VideoSettings): void {
        if (this.displayInfo && this.displayInfo.displayId !== videoSettings.displayId) {
            console.error(this.TAG, `Display id from VideoSettings and DisplayInfo don't match`);
        }
        this.fillBasicInput({ id: 'bitrate' }, videoSettings);
        this.fillBasicInput({ id: 'maxFps' }, videoSettings);
        this.fillBasicInput({ id: 'iFrameInterval' }, videoSettings);
        // this.fillBasicInput({ id: 'displayId' }, videoSettings);
        this.fillBasicInput({ id: 'codecOptions' }, videoSettings);
        if (this.encoderSelectElement) {
            const encoderName = videoSettings.encoderName || '';
            const option = Array.from(this.encoderSelectElement.options).find((element) => {
                return element.value === encoderName;
            });
            if (option) {
                this.encoderSelectElement.selectedIndex = option.index;
            }
        }
    }

    private fillBasicInput(opts: { id: keyof VideoSettings }, videoSettings: VideoSettings): void {
        const input = this.getBasicInput(opts.id);
        const value = videoSettings[opts.id];
        if (input) {
            if (typeof value !== 'undefined' && value !== '-' && value !== 0 && value !== null) {
                input.value = value.toString(10);
                if (input.getAttribute('type') === 'range') {
                    input.dispatchEvent(new Event('input'));
                }
            } else {
                input.value = '';
            }
        }
    }

    private appendBasicInput(
        parent: HTMLElement,
        opts: { label: string; id: string; range?: Range },
    ): HTMLInputElement {
        const label = document.createElement('label');
        label.classList.add('label');
        label.innerText = `${opts.label}:`;
        label.id = `label_${opts.id}_${this.escapedUdid}`;
        parent.appendChild(label);
        const input = document.createElement('input');
        input.classList.add('input');
        input.id = label.htmlFor = `${opts.id}_${this.escapedUdid}`;
        const { range } = opts;
        if (range) {
            label.setAttribute('title', opts.label);
            input.oninput = () => {
                const value = range.formatter ? range.formatter(parseInt(input.value, 10)) : input.value;
                label.innerText = `${opts.label} (${value}):`;
            };
            input.setAttribute('type', 'range');
            input.setAttribute('max', range.max.toString());
            input.setAttribute('min', range.min.toString());
            input.setAttribute('step', range.step.toString());
        }
        parent.appendChild(input);
        return input;
    }

    private getNumberValueFromInput(name: string): number {
        const value = (document.getElementById(`${name}_${this.escapedUdid}`) as HTMLInputElement).value;
        return parseInt(value, 10);
    }

    private getStringValueFromInput(name: string): string {
        return (document.getElementById(`${name}_${this.escapedUdid}`) as HTMLInputElement).value;
    }

    private getValueFromSelect(name: string): string {
        const select = document.getElementById(`${name}_${this.escapedUdid}`) as HTMLSelectElement;
        return select.options[select.selectedIndex].value;
    }

    private buildVideoSettings(): VideoSettings | null {
        try {
            const bitrate = this.getNumberValueFromInput('bitrate');
            const maxFps = this.getNumberValueFromInput('maxFps');
            const iFrameInterval = this.getNumberValueFromInput('iFrameInterval');
            const displayId = this.getNumberValueFromInput('displayId');
            const codecOptions = this.getStringValueFromInput('codecOptions') || undefined;
            // 「适应屏幕」常开：不限制编码分辨率上限，由窗口尺寸（scalePercent）决定显示大小
            const encoderName = this.getValueFromSelect('encoderName') || undefined;
            return new VideoSettings({
                bitrate,
                maxFps,
                iFrameInterval,
                displayId,
                codecOptions,
                encoderName,
            });
        } catch (error: any) {
            console.error(this.TAG, error.message);
            return null;
        }
    }

    private getPreviouslyUsedPlayer(): string {
        if (!window.localStorage) {
            return '';
        }
        const result = window.localStorage.getItem(this.playerStorageKey);
        if (result) {
            return result;
        } else {
            return '';
        }
    }

    private getPreviouslyUsedAutoScreenOff(): boolean {
        if (!window.localStorage) {
            return false;
        }
        return window.localStorage.getItem(this.autoScreenOffStorageKey) === '1';
    }

    private setPreviouslyUsedAutoScreenOff(value: boolean): void {
        if (!window.localStorage) {
            return;
        }
        window.localStorage.setItem(this.autoScreenOffStorageKey, value ? '1' : '0');
    }

    private getPreviouslyUsedScalePercent(): number {
        if (!window.localStorage) {
            return 90;
        }
        const raw = window.localStorage.getItem(this.scalePercentStorageKey);
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (isNaN(parsed) || parsed <= 0 || parsed > 100) {
            return 90;
        }
        return parsed;
    }

    private setPreviouslyUsedScalePercent(value: number): void {
        if (!window.localStorage) {
            return;
        }
        window.localStorage.setItem(this.scalePercentStorageKey, String(value));
    }

    private createUI(): HTMLElement {
        const dialogName = 'configureDialog';
        const blockClass = 'dialog-block';
        const background = document.createElement('div');
        background.classList.add('dialog-background', dialogName);
        const dialogContainer = (this.dialogContainer = document.createElement('div'));
        dialogContainer.classList.add('dialog-container', dialogName);
        const dialogHeader = document.createElement('div');
        dialogHeader.classList.add('dialog-header', dialogName, 'control-wrapper');
        const deviceName = document.createElement('span');
        deviceName.classList.add('dialog-title', 'main-title');
        deviceName.innerText = this.deviceName;
        dialogHeader.appendChild(deviceName);

        // 关闭按钮（X）放在标题栏右侧
        const closeButton = new ToolBoxButton('关闭', SvgImage.Icon.CANCEL);
        closeButton.addEventListener('click', () => {
            this.cancel();
        });
        closeButton.getAllElements().forEach((el) => {
            dialogHeader.appendChild(el);
        });
        const dialogBody = (this.dialogBody = document.createElement('div'));
        dialogBody.classList.add('dialog-body', blockClass, dialogName, 'hidden');
        const playerWrapper = document.createElement('div');
        playerWrapper.classList.add('controls');
        const playerLabel = document.createElement('label');
        playerLabel.classList.add('label');
        playerLabel.innerText = '播放器:';
        playerWrapper.appendChild(playerLabel);
        const playerSelect = (this.playerSelectElement = document.createElement('select'));
        playerSelect.classList.add('input');
        playerSelect.id = playerLabel.htmlFor = `player_${this.escapedUdid}`;
        playerWrapper.appendChild(playerSelect);
        dialogBody.appendChild(playerWrapper);
        const previouslyUsedPlayer = this.getPreviouslyUsedPlayer();
        const players = StreamClientScrcpy.getPlayers();
        if (players.length <= 1) {
            playerWrapper.style.display = 'none';
        }
        players.forEach((playerClass, index) => {
            const { playerFullName } = playerClass;
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', playerFullName);
            optionElement.innerText = playerFullName;
            playerSelect.appendChild(optionElement);
            if (playerFullName === previouslyUsedPlayer) {
                playerSelect.selectedIndex = index;
            }
        });
        playerSelect.onchange = this.onPlayerChange;
        this.updateVideoSettingsForPlayer();

        const controls = document.createElement('div');
        controls.classList.add('controls', 'control-wrapper');
        const displayIdLabel = document.createElement('label');
        displayIdLabel.classList.add('label');
        displayIdLabel.innerText = '显示屏:';
        controls.appendChild(displayIdLabel);
        if (!this.displayIdSelectElement) {
            this.displayIdSelectElement = document.createElement('select');
        }
        controls.appendChild(this.displayIdSelectElement);
        this.displayIdSelectElement.classList.add('input');
        this.displayIdSelectElement.id = displayIdLabel.htmlFor = `displayId_${this.escapedUdid}`;
        this.displayIdSelectElement.onchange = this.onDisplayIdChange;

        this.appendBasicInput(controls, {
            label: 'Bitrate',
            id: 'bitrate',
            range: { min: 524288, max: 8388608, step: 524288, formatter: Util.prettyBytes },
        });
        this.appendBasicInput(controls, {
            label: '最大帧率',
            id: 'maxFps',
            range: { min: 1, max: 60, step: 1 },
        });
        this.appendBasicInput(controls, { label: 'I帧间隔', id: 'iFrameInterval' });
        const scaleInput = this.appendBasicInput(controls, {
            label: '窗口缩放',
            id: 'scalePercent',
            range: { min: 10, max: 100, step: 1, formatter: (v: number) => `${v}%` },
        });
        scaleInput.value = String(this.getPreviouslyUsedScalePercent());
        scaleInput.addEventListener('change', () => {
            this.setPreviouslyUsedScalePercent(parseInt(scaleInput.value, 10) || 90);
        });
        // 始终显示当前缩放百分比（不只是拖动时），触发一次 label 刷新
        scaleInput.dispatchEvent(new Event('input'));
        this.appendBasicInput(controls, { label: '编解码器选项', id: 'codecOptions' });

        const encoderLabel = document.createElement('label');
        encoderLabel.classList.add('label');
        encoderLabel.innerText = '编码器:';
        controls.appendChild(encoderLabel);
        if (!this.encoderSelectElement) {
            this.encoderSelectElement = document.createElement('select');
        }
        controls.appendChild(this.encoderSelectElement);
        this.encoderSelectElement.classList.add('input');
        this.encoderSelectElement.id = encoderLabel.htmlFor = `encoderName_${this.escapedUdid}`;

        const autoScreenOffLabel = document.createElement('label');
        autoScreenOffLabel.classList.add('label');
        autoScreenOffLabel.innerText = '连接后自动关闭屏幕';
        const autoScreenOffInput = document.createElement('input');
        autoScreenOffInput.type = 'checkbox';
        autoScreenOffInput.id = `auto_screen_off_${this.escapedUdid}`;
        autoScreenOffInput.classList.add('input');
        autoScreenOffInput.checked = this.getPreviouslyUsedAutoScreenOff();
        autoScreenOffLabel.htmlFor = autoScreenOffInput.id;
        controls.appendChild(autoScreenOffLabel);
        controls.appendChild(autoScreenOffInput);
        this.autoScreenOffCheckbox = autoScreenOffInput;
        autoScreenOffInput.addEventListener('change', () => {
            this.setPreviouslyUsedAutoScreenOff(autoScreenOffInput.checked);
        });

        dialogBody.appendChild(controls);

        // 重置 / 加载：水平排成一行（只占一行），「保存」按钮挪到下方 Ready 状态栏
        const buttonsWrapper = document.createElement('div');
        buttonsWrapper.classList.add('controls', 'buttons-row');

        const resetSettingsButton = (this.resetSettingsButton = document.createElement('button'));
        resetSettingsButton.classList.add('button');
        resetSettingsButton.innerText = '重置设置';
        resetSettingsButton.addEventListener('click', this.resetSettings);
        buttonsWrapper.appendChild(resetSettingsButton);

        const loadSettingsButton = (this.loadSettingsButton = document.createElement('button'));
        loadSettingsButton.classList.add('button');
        loadSettingsButton.innerText = '加载设置';
        loadSettingsButton.addEventListener('click', this.loadSettings);
        buttonsWrapper.appendChild(loadSettingsButton);

        dialogBody.appendChild(buttonsWrapper);

        // 「保存」按钮放在底部 Ready 状态栏右侧，绿色；点击后保存配置并关闭配置窗口
        const dialogFooter = document.createElement('div');
        dialogFooter.classList.add('dialog-footer', blockClass, dialogName);
        const statusElement = document.createElement('span');
        statusElement.classList.add('subtitle');
        this.connectionStatusElement = statusElement;
        dialogFooter.appendChild(statusElement);
        const saveSettingsButton = (this.saveSettingsButton = document.createElement('button'));
        saveSettingsButton.classList.add('button', 'button-green');
        saveSettingsButton.innerText = '保存';
        saveSettingsButton.addEventListener('click', this.saveAndClose);
        dialogFooter.appendChild(saveSettingsButton);
        this.statusText = `Connecting...`;
        this.updateStatus();
        dialogBody.appendChild(dialogFooter);
        dialogContainer.appendChild(dialogHeader);
        dialogContainer.appendChild(dialogBody);
        dialogContainer.appendChild(dialogFooter);
        background.appendChild(dialogContainer);
        background.addEventListener('click', this.onBackgroundClick);
        document.body.appendChild(background);
        return background;
    }

    private removeUI(): void {
        document.body.removeChild(this.background);
        this.resetSettingsButton?.removeEventListener('click', this.resetSettings);
        this.loadSettingsButton?.removeEventListener('click', this.loadSettings);
        this.saveSettingsButton?.removeEventListener('click', this.saveAndClose);
        this.background.removeEventListener('click', this.onBackgroundClick);
    }

    private onBackgroundClick = (event: MouseEvent): void => {
        if (event.target !== event.currentTarget) {
            return;
        }
        this.cancel();
    };

    private close = (result: boolean): void => {
        if (this.streamReceiver) {
            this.detachEventsListeners(this.streamReceiver);
            this.streamReceiver.stop();
        }
        this.emit('closed', { dialog: this, result });
        this.removeUI();
    };

    private cancel = (): void => {
        this.close(false);
    };

    private saveAndClose = (): void => {
        this.saveSettings();
        this.close(true);
    };

    private resetSettings = (): void => {
        const player = this.getPlayer();
        if (player) {
            this.fillInputsFromVideoSettings(player.getPreferredVideoSetting());
        }
        if (this.autoScreenOffCheckbox) {
            this.autoScreenOffCheckbox.checked = this.getPreviouslyUsedAutoScreenOff();
        }
        const scaleInput = this.getBasicInput('scalePercent');
        if (scaleInput) {
            scaleInput.value = String(this.getPreviouslyUsedScalePercent());
            scaleInput.dispatchEvent(new Event('input'));
        }
    };

    private loadSettings = (): void => {
        this.updateVideoSettingsForPlayer();
        if (this.autoScreenOffCheckbox) {
            this.autoScreenOffCheckbox.checked = this.getPreviouslyUsedAutoScreenOff();
        }
        const scaleInput = this.getBasicInput('scalePercent');
        if (scaleInput) {
            scaleInput.value = String(this.getPreviouslyUsedScalePercent());
            scaleInput.dispatchEvent(new Event('input'));
        }
    };

    private saveSettings = (): void => {
        const videoSettings = this.buildVideoSettings();
        const player = this.getPlayer();
        const autoScreenOff = this.autoScreenOffCheckbox?.checked ?? false;
        this.setPreviouslyUsedAutoScreenOff(autoScreenOff);
        const scalePercent = this.getNumberValueFromInput('scalePercent') || 90;
        this.setPreviouslyUsedScalePercent(scalePercent);
        if (videoSettings && player) {
            // 「适应屏幕」已默认常开，始终以 true 保存
            player.saveVideoSettings(this.udid, videoSettings, true, this.displayInfo);
            window.localStorage.setItem(this.playerStorageKey, player.playerFullName);
        }
    };
}
