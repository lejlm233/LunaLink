import '../../../style/morebox.css';
import { BasePlayer } from '../../player/BasePlayer';
import { TextControlMessage } from '../../controlMessage/TextControlMessage';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import Size from '../../Size';
import DeviceMessage from '../DeviceMessage';
import VideoSettings from '../../VideoSettings';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';

const TAG = '[GoogMoreBox]';

export class GoogMoreBox {
    private static defaultSize = new Size(480, 480);
    private onStop?: () => void;
    private readonly holder: HTMLElement;
    private readonly input: HTMLTextAreaElement;
    private readonly bitrateInput?: HTMLInputElement;
    private readonly maxFpsInput?: HTMLInputElement;
    private readonly iFrameIntervalInput?: HTMLInputElement;
    private readonly maxWidthInput?: HTMLInputElement;
    private readonly maxHeightInput?: HTMLInputElement;
    private toastEl?: HTMLElement;
    private toastTimer?: ReturnType<typeof setTimeout>;

    constructor(udid: string, private player: BasePlayer, private client: StreamClientScrcpy) {
        const playerName = player.getName();
        const videoSettings = player.getVideoSettings();
        const { displayId } = videoSettings;
        const preferredSettings = player.getPreferredVideoSetting();
        const moreBox = document.createElement('div');
        moreBox.className = 'more-box';
        const header = document.createElement('div');
        header.className = 'more-box-header';
        const nameBox = document.createElement('span');
        nameBox.innerText = `${udid}（${playerName}）`;
        nameBox.className = 'more-box-title';
        header.appendChild(nameBox);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'more-box-close';
        closeBtn.setAttribute('aria-label', '关闭');
        closeBtn.innerHTML = '&times;';
        closeBtn.onclick = () => {
            moreBox.style.display = 'none';
            const moreCb = document.getElementById(`input_show_more_${udid}_${playerName}_${displayId}`);
            if (moreCb) {
                moreCb.click();
            }
        };
        header.appendChild(closeBtn);
        moreBox.appendChild(header);
        // 分区：发送文本
        const textSection = document.createElement('div');
        textSection.className = 'more-box-section';
        const textTitle = document.createElement('div');
        textTitle.className = 'more-box-section-title';
        textTitle.innerText = '发送文本';
        textSection.appendChild(textTitle);

        const input = (this.input = document.createElement('textarea'));
        input.classList.add('text-area');
        input.placeholder = '输入文字，作为按键逐字发送到设备';
        textSection.appendChild(input);

        const sendButton = document.createElement('button');
        sendButton.className = 'more-box-btn more-box-btn-block';
        sendButton.innerText = '作为按键发送';
        sendButton.onclick = () => {
            if (input.value) {
                client.sendMessage(new TextControlMessage(input.value));
            }
        };
        textSection.appendChild(sendButton);
        moreBox.appendChild(textSection);

        const commands: HTMLElement[] = [];
        let videoSpoiler: HTMLElement | undefined;
        const codes = CommandControlMessage.Commands;
        for (const [action, command] of codes.entries()) {
            const btn = document.createElement('button');
            let bitrateInput: HTMLInputElement;
            let maxFpsInput: HTMLInputElement;
            let iFrameIntervalInput: HTMLInputElement;
            let maxWidthInput: HTMLInputElement;
            let maxHeightInput: HTMLInputElement;
            if (action === ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS) {
                const spoiler = document.createElement('div');
                const spoilerLabel = document.createElement('label');
                const spoilerCheck = document.createElement('input');

                const innerDiv = document.createElement('div');
                const id = `spoiler_video_${udid}_${playerName}_${displayId}_${action}`;

                spoiler.className = 'spoiler';
                spoilerCheck.type = 'checkbox';
                spoilerCheck.id = id;
                spoilerLabel.htmlFor = id;
                spoilerLabel.innerText = command;
                innerDiv.className = 'box';
                spoiler.appendChild(spoilerCheck);
                spoiler.appendChild(spoilerLabel);
                spoiler.appendChild(innerDiv);

                const bitrateLabel = document.createElement('label');
                bitrateLabel.innerText = '码率：';
                bitrateInput = document.createElement('input');
                bitrateInput.placeholder = `${preferredSettings.bitrate} bps`;
                bitrateInput.value = videoSettings.bitrate.toString();
                GoogMoreBox.wrap('div', [bitrateLabel, bitrateInput], innerDiv);
                this.bitrateInput = bitrateInput;

                const maxFpsLabel = document.createElement('label');
                maxFpsLabel.innerText = '最大帧率：';
                maxFpsInput = document.createElement('input');
                maxFpsInput.placeholder = `${preferredSettings.maxFps} fps`;
                maxFpsInput.value = videoSettings.maxFps.toString();
                GoogMoreBox.wrap('div', [maxFpsLabel, maxFpsInput], innerDiv);
                this.maxFpsInput = maxFpsInput;

                const iFrameIntervalLabel = document.createElement('label');
                iFrameIntervalLabel.innerText = 'I 帧间隔：';
                iFrameIntervalInput = document.createElement('input');
                iFrameIntervalInput.placeholder = `${preferredSettings.iFrameInterval} 秒`;
                iFrameIntervalInput.value = videoSettings.iFrameInterval.toString();
                GoogMoreBox.wrap('div', [iFrameIntervalLabel, iFrameIntervalInput], innerDiv);
                this.iFrameIntervalInput = iFrameIntervalInput;

                const { width, height } = videoSettings.bounds || client.getMaxSize() || GoogMoreBox.defaultSize;
                const pWidth = preferredSettings.bounds?.width || width;
                const pHeight = preferredSettings.bounds?.height || height;

                const maxWidthLabel = document.createElement('label');
                maxWidthLabel.innerText = '最大宽度：';
                maxWidthInput = document.createElement('input');
                maxWidthInput.placeholder = `${pWidth} px`;
                maxWidthInput.value = width.toString();
                GoogMoreBox.wrap('div', [maxWidthLabel, maxWidthInput], innerDiv);
                this.maxWidthInput = maxWidthInput;

                const maxHeightLabel = document.createElement('label');
                maxHeightLabel.innerText = '最大高度：';
                maxHeightInput = document.createElement('input');
                maxHeightInput.placeholder = `${pHeight} px`;
                maxHeightInput.value = height.toString();
                GoogMoreBox.wrap('div', [maxHeightLabel, maxHeightInput], innerDiv);
                this.maxHeightInput = maxHeightInput;

                innerDiv.appendChild(btn);
                const fitButton = document.createElement('button');
                fitButton.innerText = '适配';
                fitButton.onclick = this.fit;
                innerDiv.insertBefore(fitButton, innerDiv.firstChild);
                const resetButton = document.createElement('button');
                resetButton.innerText = '重置';
                resetButton.onclick = this.reset;
                innerDiv.insertBefore(resetButton, innerDiv.firstChild);
                videoSpoiler = spoiler;
            } else if (
                action === CommandControlMessage.TYPE_SET_CLIPBOARD ||
                action === ControlMessage.TYPE_GET_CLIPBOARD
            ) {
                // 剪贴板命令单独放到「剪贴板」分区，不进快捷命令网格
            } else {
                commands.push(btn);
            }
            btn.innerText = command;
            if (action === ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS) {
                btn.onclick = () => {
                    const bitrate = parseInt(bitrateInput.value, 10);
                    const maxFps = parseInt(maxFpsInput.value, 10);
                    const iFrameInterval = parseInt(iFrameIntervalInput.value, 10);
                    if (isNaN(bitrate) || isNaN(maxFps)) {
                        return;
                    }
                    const width = parseInt(maxWidthInput.value, 10) & ~15;
                    const height = parseInt(maxHeightInput.value, 10) & ~15;
                    const bounds = new Size(width, height);
                    const current = player.getVideoSettings();
                    const { lockedVideoOrientation, sendFrameMeta, displayId, codecOptions, encoderName } = current;
                    const videoSettings = new VideoSettings({
                        bounds,
                        bitrate,
                        maxFps,
                        iFrameInterval,
                        lockedVideoOrientation,
                        sendFrameMeta,
                        displayId,
                        codecOptions,
                        encoderName,
                    });
                    client.sendNewVideoSetting(videoSettings);
                };
            } else if (action === CommandControlMessage.TYPE_SET_CLIPBOARD) {
                btn.onclick = () => {
                    const text = input.value;
                    if (text) {
                        client.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
                    }
                };
            } else {
                btn.onclick = () => {
                    client.sendMessage(new CommandControlMessage(action));
                };
            }
        }
        // 分区：快捷命令
        const cmdSection = document.createElement('div');
        cmdSection.className = 'more-box-section';
        const cmdTitle = document.createElement('div');
        cmdTitle.className = 'more-box-section-title';
        cmdTitle.innerText = '快捷命令';
        cmdSection.appendChild(cmdTitle);
        const cmdGrid = document.createElement('div');
        cmdGrid.className = 'more-box-cmd-grid';
        commands.forEach((b) => cmdGrid.appendChild(b));
        cmdSection.appendChild(cmdGrid);
        moreBox.appendChild(cmdSection);

        // 分区：剪贴板（独立出来，避免和快捷命令混淆，并有反馈提示）
        const clipSection = document.createElement('div');
        clipSection.className = 'more-box-section';
        const clipTitle = document.createElement('div');
        clipTitle.className = 'more-box-section-title';
        clipTitle.innerText = '剪贴板';
        clipSection.appendChild(clipTitle);
        const clipHint = document.createElement('div');
        clipHint.className = 'more-box-hint';
        clipHint.innerText = '获取：把手机剪贴板拉到电脑；设置：把上方输入框的文字写入手机剪贴板。';
        clipSection.appendChild(clipHint);
        const clipGrid = document.createElement('div');
        clipGrid.className = 'more-box-cmd-grid';
        const getClipBtn = document.createElement('button');
        getClipBtn.className = 'more-box-btn';
        getClipBtn.innerText = '获取剪贴板';
        getClipBtn.onclick = () => {
            client.sendMessage(CommandControlMessage.createGetClipboardCommand());
            this.showToast('已向手机请求剪贴板…');
        };
        const setClipBtn = document.createElement('button');
        setClipBtn.className = 'more-box-btn';
        setClipBtn.innerText = '设置剪贴板';
        setClipBtn.onclick = () => {
            const text = input.value;
            if (!text) {
                this.showToast('请先在上方输入框填入要发送的文字');
                return;
            }
            client.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
            this.showToast('已发送到手机剪贴板');
        };
        clipGrid.appendChild(getClipBtn);
        clipGrid.appendChild(setClipBtn);
        clipSection.appendChild(clipGrid);

        // 自动同步开关：开启后电脑复制 → 自动写入手机；手机复制 → 自动写入电脑
        const AUTOSYNC_KEY = 'lunalink.clipboardAutosync';
        const autosyncRow = document.createElement('label');
        autosyncRow.className = 'more-box-autosync';
        const autosyncCheck = document.createElement('input');
        autosyncCheck.type = 'checkbox';
        autosyncCheck.checked = localStorage.getItem(AUTOSYNC_KEY) === '1';
        const autosyncLabel = document.createElement('span');
        autosyncLabel.innerText = '自动同步剪贴板（双向）';
        autosyncRow.appendChild(autosyncCheck);
        autosyncRow.appendChild(autosyncLabel);
        const autosyncHint = document.createElement('div');
        autosyncHint.className = 'more-box-hint';
        autosyncHint.innerText = '开启后：电脑复制→手机、手机复制→电脑，自动同步。';
        autosyncRow.appendChild(autosyncHint);
        autosyncCheck.onchange = () => {
            const enabled = autosyncCheck.checked;
            localStorage.setItem(AUTOSYNC_KEY, enabled ? '1' : '0');
            client.setClipboardAutosync(enabled);
            this.showToast(enabled ? '已开启剪贴板自动同步' : '已关闭剪贴板自动同步');
        };
        // 页面加载时恢复开关状态
        if (autosyncCheck.checked) {
            client.setClipboardAutosync(true);
        }
        clipSection.appendChild(autosyncRow);
        moreBox.appendChild(clipSection);

        // 分区：视频设置
        if (videoSpoiler) {
            const videoSection = document.createElement('div');
            videoSection.className = 'more-box-section';
            const videoTitle = document.createElement('div');
            videoTitle.className = 'more-box-section-title';
            videoTitle.innerText = '视频设置';
            videoSection.appendChild(videoTitle);
            videoSection.appendChild(videoSpoiler);
            moreBox.appendChild(videoSection);
        }

        // 分区：屏幕电源模式
        const spmSection = document.createElement('div');
        spmSection.className = 'more-box-section';
        const spmTitle = document.createElement('div');
        spmTitle.className = 'more-box-section-title';
        spmTitle.innerText = '屏幕电源模式';
        spmSection.appendChild(spmTitle);
        const spmHint = document.createElement('div');
        spmHint.className = 'more-box-hint';
        spmHint.innerText = '关闭手机实体屏幕后，电脑上的投屏画面仍会继续（省电、防烧屏）。';
        spmSection.appendChild(spmHint);
        const spmRow = document.createElement('div');
        spmRow.className = 'more-box-row';
        // 实测：本设备 scrcpy-server 把 mode=1 当作「点亮」、mode=0 当作「关闭」，与通用协议相反，故此处对调
        const lightBtn = document.createElement('button');
        lightBtn.className = 'more-box-btn';
        lightBtn.innerText = '点亮屏幕';
        lightBtn.onclick = () => {
            client.sendMessage(CommandControlMessage.createSetScreenPowerModeCommand(true));
        };
        const offBtn = document.createElement('button');
        offBtn.className = 'more-box-btn';
        offBtn.innerText = '关闭屏幕';
        offBtn.onclick = () => {
            client.sendMessage(CommandControlMessage.createSetScreenPowerModeCommand(false));
        };
        spmRow.appendChild(lightBtn);
        spmRow.appendChild(offBtn);
        spmSection.appendChild(spmRow);
        moreBox.appendChild(spmSection);

        // 分区：画质统计
        const qualityId = `show_video_quality_${udid}_${playerName}_${displayId}`;
        const qualityLabel = document.createElement('label');
        const qualityCheck = document.createElement('input');
        qualityCheck.type = 'checkbox';
        qualityCheck.checked = BasePlayer.DEFAULT_SHOW_QUALITY_STATS;
        qualityCheck.id = qualityId;
        qualityLabel.htmlFor = qualityId;
        qualityLabel.innerText = '显示画质统计（码率 / 帧率）';
        const qualitySection = document.createElement('div');
        qualitySection.className = 'more-box-section';
        const qualityTitle = document.createElement('div');
        qualityTitle.className = 'more-box-section-title';
        qualityTitle.innerText = '画质统计';
        qualitySection.appendChild(qualityTitle);
        const qualityRow = document.createElement('div');
        qualityRow.className = 'more-box-row more-box-row-check';
        qualityRow.appendChild(qualityCheck);
        qualityRow.appendChild(qualityLabel);
        qualitySection.appendChild(qualityRow);
        qualityCheck.onchange = () => {
            player.setShowQualityStats(qualityCheck.checked);
        };
        moreBox.appendChild(qualitySection);

        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            const parent = moreBox.parentElement;
            if (parent) {
                parent.removeChild(moreBox);
            }
            player.off('video-view-resize', this.onViewVideoResize);
            if (this.onStop) {
                this.onStop();
                delete this.onStop;
            }
        };

        const stopBtn = document.createElement('button') as HTMLButtonElement;
        stopBtn.className = 'more-box-btn more-box-btn-danger more-box-btn-block';
        stopBtn.innerText = `断开连接`;
        stopBtn.onclick = stop;

        const stopSection = document.createElement('div');
        stopSection.className = 'more-box-section more-box-section-danger';
        stopSection.appendChild(stopBtn);
        moreBox.appendChild(stopSection);
        player.on('video-view-resize', this.onViewVideoResize);
        player.on('video-settings', this.onVideoSettings);
        this.holder = moreBox;
    }

    private onViewVideoResize = (size: Size): void => {
        // padding: 10px
        this.holder.style.width = `${size.width - 2 * 10}px`;
    };

    private onVideoSettings = (videoSettings: VideoSettings): void => {
        if (this.bitrateInput) {
            this.bitrateInput.value = videoSettings.bitrate.toString();
        }
        if (this.maxFpsInput) {
            this.maxFpsInput.value = videoSettings.maxFps.toString();
        }
        if (this.iFrameIntervalInput) {
            this.iFrameIntervalInput.value = videoSettings.iFrameInterval.toString();
        }
        if (videoSettings.bounds) {
            const { width, height } = videoSettings.bounds;
            if (this.maxWidthInput) {
                this.maxWidthInput.value = width.toString();
            }
            if (this.maxHeightInput) {
                this.maxHeightInput.value = height.toString();
            }
        }
    };

    private fit = (): void => {
        const { width, height } = this.client.getMaxSize() || GoogMoreBox.defaultSize;
        if (this.maxWidthInput) {
            this.maxWidthInput.value = width.toString();
        }
        if (this.maxHeightInput) {
            this.maxHeightInput.value = height.toString();
        }
    };

    private reset = (): void => {
        const preferredSettings = this.player.getPreferredVideoSetting();
        this.onVideoSettings(preferredSettings);
    };

    public OnDeviceMessage(ev: DeviceMessage): void {
        if (ev.type !== DeviceMessage.TYPE_CLIPBOARD) {
            return;
        }
        this.input.value = ev.getText();
        this.input.select();
        document.execCommand('copy');
        const raw = this.input.value;
        const snippet = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
        this.showToast(`已获取手机剪贴板：${snippet}`);
    }

    private showToast(message: string): void {
        if (!this.toastEl) {
            const el = document.createElement('div');
            el.className = 'more-box-toast';
            this.holder.appendChild(el);
            this.toastEl = el;
        }
        this.toastEl.textContent = message;
        this.toastEl.classList.add('show');
        if (this.toastTimer) {
            clearTimeout(this.toastTimer);
        }
        this.toastTimer = setTimeout(() => {
            this.toastEl?.classList.remove('show');
        }, 2400);
    }

    private static wrap(
        tagName: string,
        elements: HTMLElement[],
        parent: HTMLElement,
        opt_classes?: string[],
    ): HTMLElement {
        const wrap = document.createElement(tagName);
        if (opt_classes) {
            wrap.classList.add(...opt_classes);
        }
        elements.forEach((e) => {
            wrap.appendChild(e);
        });
        parent.appendChild(wrap);
        return wrap;
    }

    public getHolderElement(): HTMLElement {
        return this.holder;
    }

    public setOnStop(listener: () => void): void {
        this.onStop = listener;
    }
}
