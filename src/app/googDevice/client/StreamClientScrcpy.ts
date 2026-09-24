import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { GoogMoreBox } from '../toolbox/GoogMoreBox';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import VideoSettings from '../../VideoSettings';
import Size from '../../Size';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import Util from '../../Util';
import FilePushHandler from '../filePush/FilePushHandler';
import DragAndPushLogger from '../DragAndPushLogger';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { DeviceTracker } from './DeviceTracker';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { html } from '../../ui/HtmlTag';
import {
    FeaturedInteractionHandler,
    InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { Attribute } from '../../Attribute';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { ScrcpyFilePushStream } from '../filePush/ScrcpyFilePushStream';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement;
    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private joinedStream = false;
    private requestedVideoSettings?: VideoSettings;
    private touchHandler?: FeaturedInteractionHandler;
    private moreBox?: GoogMoreBox;
    private player?: BasePlayer;
    private filePushHandler?: FilePushHandler;
    private lastDeviceRotation = 0;
    private fitToScreen?: boolean;
    private autoScreenOff = false;
    private autoScreenOffApplied = false;
    private readonly streamReceiver: StreamReceiverScrcpy;
    private overlayEl?: HTMLElement;
    private clipboardAutosyncEnabled = false;
    private clipboardSyncTimer?: number;
    private lastSyncedClipboardText = '';
    private pendingDeviceClipboard = '';
    // 自愈机制：设备端 onOpen 时发送的 initial 信息（含 displayInfo）存在竞态失败的可能
    // （连接瞬间 DisplayManager 未就绪 → sendInitialInfo 抛异常被 server 静默吞掉），
    // 导致前端永远收不到 displayInfo：overlay 卡 Connecting、分辨率不切换（糊）。
    // 由于设备端收到 SET_VIDEO_SETTINGS 后会广播 screenInfo（同 initial 格式），
    // 这里定时重发设置直到收到 displayInfo，触发设备端重新回发，实现自愈。
    private settingsRetryTimer?: ReturnType<typeof setInterval>;
    private settingsRetryCount = 0;
    private gotDisplayInfo = false;
    private connectingOverlayTimer?: ReturnType<typeof setTimeout>;
    // 切分辨率自愈：displayInfo 已收到、原生 bounds 已下发，但设备端编码器可能未及时
    // 切换到新分辨率（重启编码器有延迟/偶发失败），导致视频流仍停留在首帧小分辨率、拉大窗口发糊。
    // 轮询实际接收的 screenInfo.videoSize，若一直未达到目标尺寸则重发设置 + 请求关键帧。
    private resolutionHealTimer?: ReturnType<typeof setTimeout>;
    private resolutionHealCount = 0;
    // 窗口自适应去重：记录最近一次按目标尺寸 resize 的 key（"WxH"），
    // 避免每次 displayInfo 都重复调用 resizeTo（Chrome 会忽略连发的同尺寸请求）。
    private lastResizedKey = '';
    // 窗口 resize 未生效时的页面内提示（只显示一次，可手动关闭）
    private windowResizeHintShown = false;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        let playerClass: PlayerClass | undefined;
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                playerClass = value;
            }
        }
        return playerClass;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return;
        }
        return new playerClass(udid, displayInfo);
    }

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return false;
        }
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ): StreamClientScrcpy {
        if (query instanceof URLSearchParams) {
            const params = StreamClientScrcpy.parseParameters(query);
            return new StreamClientScrcpy(params, streamReceiver, player, fitToScreen, videoSettings);
        } else {
            return new StreamClientScrcpy(query, streamReceiver, player, fitToScreen, videoSettings);
        }
    }

    private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
        return new VideoSettings({
            crop: old.crop,
            bitrate: old.bitrate,
            bounds: newBounds,
            maxFps: old.maxFps,
            iFrameInterval: old.iFrameInterval,
            sendFrameMeta: old.sendFrameMeta,
            lockedVideoOrientation: old.lockedVideoOrientation,
            displayId: old.displayId,
            codecOptions: old.codecOptions,
            encoderName: old.encoderName,
        });
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ) {
        super(params);
        if (streamReceiver) {
            this.streamReceiver = streamReceiver;
        } else {
            this.streamReceiver = new StreamReceiverScrcpy(this.params);
        }

        const { udid, player: playerName } = this.params;
        this.autoScreenOff =
            this.params.autoScreenOff ??
            window.localStorage.getItem(`configure_stream::${Util.escapeUdid(udid)}::autoScreenOff`) === '1';
        this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
        this.setBodyClass('stream');
        document.body.classList.add('popup-layout');
        // 弹窗标题唯一标识兜底（onClientsStats 到达前就设好，供服务端窗口定位）
        if (udid) {
            this.setTitle(`LunaLink-${udid}`);
        }
        console.log(
            TAG,
            `[Diag] stream page loaded: opener=${!!window.opener} name=${window.name} outer=${window.outerWidth}x${
                window.outerHeight
            } inner=${window.innerWidth}x${window.innerHeight}`,
        );
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('focus', this.onWindowFocus);
        // 首帧阶段（displayInfo 到达前）窗口被拉大时，按新窗口尺寸重发编码 bounds，
        // 避免「画面被拉大后仍停留在小分辨率而发糊」
        window.addEventListener('resize', this.onWindowResize);
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws', true),
        };
    }

    public OnDeviceMessage = (message: DeviceMessage): void => {
        // 剪贴板自动同步（手机 → 电脑）：设备剪贴板变化时 server 推送 CLIPBOARD 消息，
        // 若自动同步开启则写入电脑剪贴板。注意：手机复制时页面必然失焦，
        // navigator.clipboard.writeText 会因 "Document is not focused" 拒绝，
        // 因此先缓存 pending 文本，聚焦后（用户回到电脑）自动补写。
        if (message.type === DeviceMessage.TYPE_CLIPBOARD && this.clipboardAutosyncEnabled) {
            const text = message.getText();
            if (text) {
                this.pendingDeviceClipboard = text;
                navigator.clipboard
                    .writeText(text)
                    .then(() => {
                        if (this.pendingDeviceClipboard === text) {
                            this.pendingDeviceClipboard = '';
                        }
                        // 更新已同步标记，避免轮询把同一文本再发回手机
                        this.lastSyncedClipboardText = text;
                        console.log('[ClipboardAutosync] device → PC: 已写入电脑剪贴板');
                    })
                    .catch((e: Error) => {
                        // 页面失焦等情况：保留 pending，等 window focus 事件补写
                        console.warn('[ClipboardAutosync] 写入失败（页面失焦？），聚焦后自动重试:', e.message);
                    });
            }
        }
        if (this.moreBox) {
            this.moreBox.OnDeviceMessage(message);
        }
    };

    /**
     * 把缓存的手机→电脑剪贴板文本写入电脑剪贴板。
     * 手机复制常发生在浏览器失焦期间，writeText 会被拒绝，故先缓存 pending，
     * 在页面重新聚焦（window focus）或重新可见（切回投屏标签 visibilitychange）时补写。
     */
    private flushPendingClipboard = (): void => {
        if (!this.clipboardAutosyncEnabled || !this.pendingDeviceClipboard) {
            return;
        }
        const text = this.pendingDeviceClipboard;
        this.pendingDeviceClipboard = '';
        navigator.clipboard
            .writeText(text)
            .then(() => {
                this.lastSyncedClipboardText = text;
                console.log('[ClipboardAutosync] 聚焦/可见后补写剪贴板成功');
            })
            .catch((e: Error) => {
                this.pendingDeviceClipboard = text; // 保留，下次触发再试
                console.warn('[ClipboardAutosync] 聚焦/可见后补写仍失败:', e.message);
            });
    };

    private onWindowFocus = (): void => {
        this.flushPendingClipboard();
    };

    /**
     * 开启/关闭剪贴板自动同步（电脑 ↔ 手机双向）。
     * - PC → Device: 轮询 navigator.clipboard.readText()，文本变化时发送 SET_CLIPBOARD
     * - Device → PC: 由 OnDeviceMessage 收到 CLIPBOARD 设备消息时写入电脑剪贴板
     */
    public setClipboardAutosync(enabled: boolean): void {
        if (this.clipboardAutosyncEnabled === enabled) {
            return;
        }
        this.clipboardAutosyncEnabled = enabled;
        if (enabled) {
            // 立即读取一次，记录当前电脑剪贴板作为基线
            navigator.clipboard
                .readText()
                .then((text) => {
                    this.lastSyncedClipboardText = text || '';
                })
                .catch(() => {
                    // 无权限时忽略，轮询时会重试
                });
            this.clipboardSyncTimer = window.setInterval(() => {
                navigator.clipboard
                    .readText()
                    .then((text) => {
                        text = text || '';
                        if (text !== this.lastSyncedClipboardText) {
                            this.lastSyncedClipboardText = text;
                            this.sendMessage(CommandControlMessage.createSetClipboardCommand(text));
                            console.log('[ClipboardAutosync] PC → device: 已同步到手机剪贴板');
                        }
                    })
                    .catch((e: Error) => {
                        // 浏览器可能要求剪贴板读取权限，静默失败并等待下次重试
                        console.warn('[ClipboardAutosync] 读取电脑剪贴板失败:', e.message);
                    });
            }, 2000);
            console.log('[ClipboardAutosync] 已开启（2s 轮询）');
        } else {
            if (this.clipboardSyncTimer !== undefined) {
                window.clearInterval(this.clipboardSyncTimer);
                this.clipboardSyncTimer = undefined;
            }
            console.log('[ClipboardAutosync] 已关闭');
        }
    }

    private isBackgrounded = false;
    private onNeedKeyFrame = (): void => {
        // The player (e.g. MsePlayer) rebuilt its decode pipeline after a
        // background/foreground switch and needs a fresh I-frame to start
        // decoding. Request one from the device.
        this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
    };
    private onVisibilityChange = (): void => {
        if (document.hidden) {
            this.isBackgrounded = true;
        } else if (this.isBackgrounded) {
            this.isBackgrounded = false;
            // On return from background, ask the device for a fresh I-frame so
            // the player can recover. This covers all player types. MsePlayer
            // additionally rebuilds its own pipeline and emits 'need-key-frame',
            // which also triggers this request.
            if (this.player && this.player.getState() === BasePlayer.STATE.PLAYING) {
                if (!this.streamReceiver.hasConnection()) {
                    console.warn(
                        `${TAG} WebSocket disconnected during background, recovery will resume after reconnect`,
                    );
                }
                this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
            }
            // 切回投屏标签（visibilitychange）时补写未完成的手机→电脑剪贴板同步。
            // 这是最常见场景：手机复制时投屏标签在后台，回到该标签只触发 visibilitychange，
            // 不会触发 window focus，必须在此处补写，否则 PC 端永远收不到手机复制内容。
            this.flushPendingClipboard();
        }
    };

    public onVideo = (data: ArrayBuffer): void => {
        if (!this.player) {
            return;
        }
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE.PAUSED) {
            this.player.play();
        }
        if (this.player.getState() === STATE.PLAYING) {
            this.player.pushFrame(new Uint8Array(data));
        }
    };

    public onClientsStats = (stats: ClientsStats): void => {
        this.deviceName = stats.deviceName;
        this.clientId = stats.clientId;
        // 弹窗标题改为唯一标识 LunaLink-<udid>：Chromium 忽略页面脚本 resizeTo，
        // 服务端需按窗口标题（Win32 EnumWindows）定位弹窗窗口来调整尺寸。
        this.setTitle(`LunaLink-${this.params.udid}`);
        this.hideOverlay();
        // 连接建立后自动关闭设备实体屏幕（若用户在配置弹窗开启「连接后自动关闭屏幕」）
        this.applyAutoScreenOff();
    };

    // 连接后自动关闭设备实体屏幕：连接建立初期，设备端 control 通道可能尚未就绪，
    // 直接发送 SET_SCREEN_POWER_MODE 有概率被忽略（手动关屏按钮之所以有效，是因为
    // 它在投屏稳定后才由用户主动触发）。因此延迟一小段时间再下发，并确保只发送一次。
    private applyAutoScreenOff(): void {
        if (!this.autoScreenOff || this.autoScreenOffApplied) {
            return;
        }
        this.autoScreenOffApplied = true;
        const delay = 600;
        setTimeout(() => {
            console.log(`${TAG} 连接后自动关闭屏幕：延迟 ${delay}ms 发送 SET_SCREEN_POWER_MODE = off (mode 0)`);
            this.sendMessage(CommandControlMessage.createSetScreenPowerModeCommand(false));
        }, delay);
    }

    public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        // 收到 displayInfo 即说明 initial 链路正常，停止设置重试
        this.gotDisplayInfo = true;
        this.stopSettingsRetry();
        // 兜底：设备端已发送 displayInfo，control 通道更可能就绪，再尝试下发一次关屏
        this.applyAutoScreenOff();
        if (!this.player) {
            return;
        }
        let currentSettings = this.player.getVideoSettings();
        const displayId = currentSettings.displayId;
        const info = infoArray.find((value) => {
            return value.displayInfo.displayId === displayId;
        });
        if (!info) {
            return;
        }
        if (this.player.getState() === BasePlayer.STATE.PAUSED) {
            this.player.play();
        }
        const { videoSettings, screenInfo } = info;
        this.player.setDisplayInfo(info.displayInfo);
        // 「适应屏幕」已默认常开：窗口按「窗口缩放%」缩小显示，但编码分辨率保持设备原生，
        // 由浏览器把高清视频高质量缩放进小窗（降采样交给浏览器，质量高），清晰度不下降。
        // 即：缩放只改变显示窗口大小，不改变源分辨率，从而「缩小后依然清晰」。
        const fit = typeof this.fitToScreen === 'boolean' ? this.fitToScreen : true;
        if (fit && screenInfo) {
            // 关键：编码分辨率锁定为设备原生 videoSize，不再随窗口缩小而降码率，保证缩放后清晰度不变
            // （窗口显示尺寸由下方 resizePopupToFit(computeWindowSize(...)) 单独控制）
            currentSettings = StreamClientScrcpy.createVideoSettingsWithBounds(currentSettings, screenInfo.videoSize);
            this.player.setVideoSettings(currentSettings, fit, false);
        }
        if (!videoSettings || !screenInfo) {
            this.joinedStream = true;
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(currentSettings));
            return;
        }

        this.clientsCount = info.connectionCount;
        let min = VideoSettings.copy(videoSettings);
        const oldInfo = this.player.getScreenInfo();
        if (!screenInfo.equals(oldInfo)) {
            this.player.setScreenInfo(screenInfo);
        }

        // 计算「旋转后的逻辑显示尺寸」：无论 scrcpy 的 videoSize 是否在旋转时交换宽高，
        // 都按设备实际方向(deviceRotation)取其「长边 × 短边」作为窗口缩放依据的画面尺寸。
        // 否则窗口会一直按未旋转的竖屏 videoSize 计算，横屏时窗口不变横、画面被塞进竖窗变小。
        const dr = screenInfo.deviceRotation;
        const rotatedNow = dr === 1 || dr === 3;
        const vsz = screenInfo.videoSize;
        const logicalVideoSize = rotatedNow
            ? new Size(Math.max(vsz.width, vsz.height), Math.min(vsz.width, vsz.height))
            : new Size(Math.min(vsz.width, vsz.height), Math.max(vsz.width, vsz.height));

        // Rotate preview for landscape device orientation in popup/mobile layout.
        // 方向类与 CSS @media (orientation: portrait) 配合：旋转只对竖屏视口生效，
        // 宽屏视口（PC 窗口）直接 contain 适配，横屏画面自然占满窗口。
        if (this.lastDeviceRotation !== screenInfo.deviceRotation) {
            this.lastDeviceRotation = screenInfo.deviceRotation;
            const { deviceRotation } = screenInfo;
            const isLandscape = deviceRotation === 1 || deviceRotation === 3;
            const body = document.body;
            body.classList.toggle('landscape', isLandscape);
            // ROTATION_90 的内容顶边朝右、ROTATION_270 朝左，旋转方向相反，须分别转正
            body.classList.toggle('rotation-90', deviceRotation === 1);
            body.classList.toggle('rotation-270', deviceRotation === 3);
            console.log(
                TAG,
                `[Diag] deviceRotation 变化: ${this.lastDeviceRotation} -> ${deviceRotation}, logical=${logicalVideoSize.width}x${logicalVideoSize.height}`,
            );
            // 设备旋转后联动调整弹窗宽高比：窗口形状跟随设备方向（横屏↔竖屏）。
            // 窗口与设备同向时视频直接 contain 占满窗口；landscape 旋转仅作为窗口被
            // 手动拉成反方向（竖窗看横屏）时的兜底适配（由 CSS portrait 视口限定）。
            this.syncPopupSize(logicalVideoSize);
        }

        // 首次拿到设备分辨率时，按「窗口缩放%」把窗口缩放到可用屏幕区域内（弹窗处理）
        if (screenInfo && !oldInfo) {
            this.syncPopupSize(logicalVideoSize);
        }

        if (!videoSettings.equals(currentSettings)) {
            // 关键修复：必须把更新后的 currentSettings（其 bounds 已在上面「适应屏幕」
            // 分支改为设备原生分辨率）下发给设备端，而不是设备端旧值 videoSettings。
            // 否则设备端会被重新设置为低分辨率编码，表现为「刷新页面后视频流模糊」。
            this.applyNewVideoSettings(currentSettings, videoSettings.equals(this.requestedVideoSettings));
            // 切分辨率自愈：下发原生 bounds 后轮询实际收到的 screenInfo.videoSize，
            // 若设备端长时间未切换到新分辨率（编码器重启失败/滞后），自动重发设置+关键帧，
            // 避免画面停留在首帧小分辨率、拉大窗口后发糊。
            this.scheduleResolutionSelfHeal(screenInfo.videoSize);
        }
        if (!oldInfo) {
            const bounds = currentSettings.bounds;
            const videoSize: Size = screenInfo.videoSize;
            const onlyOneClient = this.clientsCount === 0;
            const smallerThenCurrent = bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
            if (onlyOneClient || smallerThenCurrent) {
                min = currentSettings;
            }
            const minBounds = currentSettings.bounds?.intersect(min.bounds);
            if (minBounds && !minBounds.equals(min.bounds)) {
                min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
            }
        }
        if (!min.equals(videoSettings) || !this.joinedStream) {
            this.joinedStream = true;
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
        }
    };

    public onDisconnected = (): void => {
        this.streamReceiver.off('deviceMessage', this.OnDeviceMessage);
        this.streamReceiver.off('video', this.onVideo);
        this.streamReceiver.off('clientsStats', this.onClientsStats);
        this.streamReceiver.off('displayInfo', this.onDisplayInfo);
        this.streamReceiver.off('disconnected', this.onDisconnected);

        // 断开连接时停止剪贴板自动同步并清理监听
        this.setClipboardAutosync(false);
        window.removeEventListener('focus', this.onWindowFocus);
        window.removeEventListener('resize', this.onWindowResize);
        this.pendingDeviceClipboard = '';
        // 清理自愈机制
        this.stopSettingsRetry();
        this.gotDisplayInfo = false;
        if (this.connectingOverlayTimer) {
            clearTimeout(this.connectingOverlayTimer);
            this.connectingOverlayTimer = undefined;
        }

        this.filePushHandler?.release();
        this.filePushHandler = undefined;
        this.touchHandler?.release();
        this.touchHandler = undefined;

        this.showOverlay('disconnected');
    };

    private showOverlay(state: 'connecting' | 'disconnected'): void {
        if (!this.overlayEl) {
            return;
        }
        this.overlayEl.style.display = 'flex';
        const textEl = this.overlayEl.querySelector('.stream-overlay-text');
        const spinnerEl = this.overlayEl.querySelector('.stream-overlay-spinner') as HTMLElement;
        if (state === 'disconnected') {
            if (textEl) {
                textEl.textContent = 'Disconnected. Refresh page to reconnect.';
            }
            if (spinnerEl) {
                spinnerEl.style.display = 'none';
            }
            this.overlayEl.classList.add('disconnected');
        }
    }

    private hideOverlay(): void {
        if (!this.overlayEl) {
            return;
        }
        this.overlayEl.style.display = 'none';
    }

    // 连接后定时重发 SET_VIDEO_SETTINGS + 请求关键帧，直到收到 displayInfo（或超时）。
    // 兼容设备端 initial 丢失/加入已有流不补发 displayInfo 的场景：设备端只在
    // 「视频尺寸变化（onScreenInfoChanged）」时广播 screenInfo，因此每轮重发必须用
    // 与上一轮不同的 bounds（递增序列），强制触发尺寸变化 → 设备端重新广播 → 恢复
    // onDisplayInfo 流程与高清分辨率。
    private scheduleSettingsRetry(): void {
        if (this.settingsRetryTimer) {
            return;
        }
        this.settingsRetryTimer = setInterval(() => {
            if (this.gotDisplayInfo || this.settingsRetryCount >= 5) {
                this.stopSettingsRetry();
                return;
            }
            this.settingsRetryCount++;
            const settings = this.player?.getVideoSettings();
            if (!settings) {
                return;
            }
            // 递增 bounds：每轮不同，确保触发设备端 onScreenInfoChanged → 广播 screenInfo
            const maxSize = this.getMaxSize();
            const baseW = maxSize?.width || 1280;
            const baseH = maxSize?.height || 1280;
            const factor = 0.7 + this.settingsRetryCount * 0.3; // 0.7 → 1.0 → 1.3 → 1.6 → 1.9
            const w = Math.max(Math.round((baseW * factor) & ~15), 16);
            const h = Math.max(Math.round((baseH * factor) & ~15), 16);
            const target = StreamClientScrcpy.createVideoSettingsWithBounds(settings, new Size(w, h));
            console.log(TAG, `Settings retry #${this.settingsRetryCount}: ${w}x${h}`);
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(target));
            this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
        }, 2000);
    }

    private stopSettingsRetry(): void {
        if (this.settingsRetryTimer) {
            clearInterval(this.settingsRetryTimer);
            this.settingsRetryTimer = undefined;
        }
        if (this.resolutionHealTimer) {
            clearTimeout(this.resolutionHealTimer);
            this.resolutionHealTimer = undefined;
        }
        this.resolutionHealCount = 0;
    }

    /**
     * 切分辨率自愈：把 bounds 切到设备原生分辨率后，设备端编码器重启存在滞后/失败的可能
     * （若失败，视频流停留在首帧小分辨率，窗口拉大后画面发糊）。这里轮询实际接收到的
     * screenInfo.videoSize：一旦设备端切换到目标分辨率（重新广播 screenInfo）即视为成功；
     * 若超过等待时间仍未切换，重发设置 + 请求关键帧，最多重试 3 轮。
     */
    private scheduleResolutionSelfHeal(target: Size): void {
        if (!this.player || this.resolutionHealCount >= 3) {
            return;
        }
        if (this.resolutionHealTimer !== undefined) {
            clearTimeout(this.resolutionHealTimer);
            this.resolutionHealTimer = undefined;
        }
        this.resolutionHealTimer = setTimeout(() => {
            this.resolutionHealTimer = undefined;
            const current = this.player?.getScreenInfo();
            if (current && current.videoSize.equals(target)) {
                // 已切换到目标分辨率，复位计数
                this.resolutionHealCount = 0;
                return;
            }
            this.resolutionHealCount++;
            const settings = this.player?.getVideoSettings();
            if (settings) {
                console.log(
                    TAG,
                    `Resolution self-heal #${this.resolutionHealCount}: 视频流仍为 ${
                        current?.videoSize ?? '未知'
                    }，重发 bounds=${target}`,
                );
                this.sendMessage(
                    CommandControlMessage.createSetVideoSettingsCommand(
                        StreamClientScrcpy.createVideoSettingsWithBounds(settings, target),
                    ),
                );
                this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
            }
            this.scheduleResolutionSelfHeal(target);
        }, 2000);
    }

    // 首帧阶段（尚未收到 displayInfo、视频流还是小分辨率）窗口被拉大时，按新窗口尺寸重发
    // bounds + 请求关键帧，让设备端编码分辨率跟上窗口，避免「拉大窗口后画面发糊」。
    // 收到 displayInfo 后 bounds 已锁定为设备原生分辨率（fit 模式上限），不再随窗口调整。
    private onWindowResize = (): void => {
        if (this.gotDisplayInfo || !this.player) {
            return;
        }
        const maxSize = this.getMaxSize();
        if (!maxSize) {
            return;
        }
        const settings = this.player.getVideoSettings();
        if (!settings) {
            return;
        }
        const bounds = settings.bounds;
        if (bounds && bounds.equals(maxSize)) {
            return;
        }
        console.log(TAG, `Window resized (pre-displayInfo): 重发 bounds=${maxSize}，提升编码分辨率`);
        this.sendMessage(
            CommandControlMessage.createSetVideoSettingsCommand(
                StreamClientScrcpy.createVideoSettingsWithBounds(settings, maxSize),
            ),
        );
        this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
    };

    // 「Connecting...」遮罩超时自动隐藏：设备端 initial/stats 消息可能因竞态丢失，
    // 不阻塞画面显示（视频帧仍在播放），超时后直接隐藏遮罩。
    private scheduleConnectingOverlayTimeout(): void {
        if (this.connectingOverlayTimer) {
            return;
        }
        this.connectingOverlayTimer = setTimeout(() => {
            this.connectingOverlayTimer = undefined;
            this.hideOverlay();
        }, 5000);
    }

    public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            let displayInfo: DisplayInfo | undefined;
            if (this.streamReceiver && videoSettings) {
                displayInfo = this.streamReceiver.getDisplayInfo(videoSettings.displayId);
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            // 「适应屏幕」已默认常开：始终按设备原生分辨率编码，窗口尺寸由「窗口缩放%」控制
            fitToScreen = true;
            player = p;
        }
        // 必须在 fitToScreen 解析完成后再赋值，否则实例字段会停留在 undefined，
        // 导致 onDisplayInfo 阶段把它重置为 false，从而抵消用户的「适应屏幕」偏好
        this.fitToScreen = fitToScreen;
        this.player = player;
        this.setTouchListeners(player);

        if (!videoSettings) {
            // 通过链接/弹窗起流时，从已保存的配置加载视频参数（与配置弹窗一致）
            videoSettings = (player.constructor as typeof BasePlayer).loadVideoSettings(udid);
        }

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view';
        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            let parent;
            parent = deviceView.parentElement;
            if (parent) {
                parent.removeChild(deviceView);
            }
            parent = moreBox.parentElement;
            if (parent) {
                parent.removeChild(moreBox);
            }
            this.streamReceiver.stop();
            if (this.player) {
                this.player.stop();
            }
        };

        const googMoreBox = (this.moreBox = new GoogMoreBox(udid, player, this));
        const moreBox = googMoreBox.getHolderElement();
        googMoreBox.setOnStop(stop);
        const googToolBox = GoogToolBox.createToolBox(udid, player, this, moreBox);
        this.controlButtons = googToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        const video = document.createElement('div');
        video.className = 'video';
        deviceView.appendChild(video);
        deviceView.appendChild(moreBox);

        // Loading overlay
        const overlay = document.createElement('div');
        overlay.className = 'stream-overlay';
        overlay.innerHTML = `<div class="stream-overlay-spinner"></div><div class="stream-overlay-text">Connecting...</div>`;
        deviceView.appendChild(overlay);
        this.overlayEl = overlay;

        // Auto-hide toolbar after inactivity
        let hideTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleHide = () => {
            if (hideTimer) {
                clearTimeout(hideTimer);
            }
            this.controlButtons?.classList.remove('auto-hidden');
            hideTimer = setTimeout(() => {
                if (!this.controlButtons?.classList.contains('collapsed')) {
                    this.controlButtons?.classList.add('auto-hidden');
                }
            }, 3000);
        };
        deviceView.addEventListener('mousemove', scheduleHide);
        scheduleHide();

        player.setParent(video);
        player.pause();

        document.body.appendChild(deviceView);

        if (fitToScreen) {
            // 「适应屏幕」：先用窗口物理尺寸 bounds 下发，让设备端尽快开始编码
            // （首帧小、传输快、出画面快）。onDisplayInfo 到达后会用设备原生 videoSize
            // 覆盖 bounds，MsePlayer 检测到分辨率变化会重建 MediaSource 并请求关键帧，
            // 画面自动切换为高清。此前「刷新后糊」正是该切换不生效（下发旧值 + 不重建
            // MediaSource），现已修复，故可放心用渐进式（先小后清晰）方案。
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, newBounds);
            }
        }
        this.applyNewVideoSettings(videoSettings, false);
        const element = player.getTouchableElement();
        const logger = new DragAndPushLogger(element);
        this.filePushHandler = new FilePushHandler(element, new ScrcpyFilePushStream(this.streamReceiver));
        this.filePushHandler.addEventListener(logger);

        const streamReceiver = this.streamReceiver;
        streamReceiver.on('deviceMessage', this.OnDeviceMessage);
        streamReceiver.on('video', this.onVideo);
        streamReceiver.on('clientsStats', this.onClientsStats);
        streamReceiver.on('displayInfo', this.onDisplayInfo);
        streamReceiver.on('disconnected', this.onDisconnected);
        this.player.on('need-key-frame', this.onNeedKeyFrame);
        // 自愈：设备端 initial 可能因竞态丢失（sendInitialInfo 失败被 server 静默），
        // 定时重发设置触发设备端重新广播 screenInfo；Connecting 遮罩超时自动隐藏。
        this.scheduleSettingsRetry();
        this.scheduleConnectingOverlayTimeout();
        console.log(TAG, player.getName(), udid);
    }

    public sendMessage(message: ControlMessage): void {
        this.streamReceiver.sendEvent(message);
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        this.requestedVideoSettings = videoSettings;
        this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
        // Request a key frame right after changing stream parameters so the encoder
        // immediately outputs an I-frame. Without this, the new MediaSource/SourceBuffer
        // (rebuilt by MsePlayer when maxFps changes) would wait indefinitely for an
        // I-frame + SPS/PPS, resulting in a black screen that never recovers.
        this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    public getMaxSize(): Size | undefined {
        if (!this.controlButtons) {
            return;
        }
        // 按「物理像素」计算编码尺寸上限：devicePixelRatio > 1 的高分屏上，
        // 若按 CSS 像素（clientWidth/clientHeight）编码，视频会被浏览器放大显示而发糊。
        const dpr = window.devicePixelRatio || 1;
        const body = document.body;
        // H.264 要求尺寸为 16 的倍数（& ~15 向下对齐），下限 16 防止 0/负尺寸
        const width = Math.max((body.clientWidth * dpr) & ~15, 16);
        const height = Math.max((body.clientHeight * dpr) & ~15, 16);
        return new Size(width, height);
    }

    // 读取「窗口缩放%」偏好（默认 90），与配置弹窗共享同一 localStorage 键，按 udid 区分设备
    private getScalePercent(): number {
        const udid = this.params.udid;
        if (!udid || !window.localStorage) {
            return 90;
        }
        const raw = window.localStorage.getItem(`configure_stream::${Util.escapeUdid(udid)}::scalePercent`);
        const parsed = raw ? parseInt(raw, 10) : NaN;
        if (isNaN(parsed) || parsed <= 0 || parsed > 100) {
            return 90;
        }
        return parsed;
    }

    // 将窗口尺寸计算为「占屏幕可用区的 scalePercent%」且保持设备宽高比。
    // 关键语义：始终把设备比例「等比 contain 进 屏幕×scalePercent% 的框」——
    // 既能缩小超屏设备，也能把小设备放大到占满 scalePercent%，
    // 从而竖屏(如 4:5)与横屏(如 5:4)都是同一「占屏百分比」、仅方向交换，旋转前后大小感一致。
    private computeWindowSize(videoSize: Size, scalePercent: number): Size {
        const ratio = Math.min(Math.max(scalePercent, 1), 100) / 100;
        const boxW = screen.availWidth * ratio;
        const boxH = screen.availHeight * ratio;
        // contain：取「刚好放进目标框」的等比缩放系数（min 保证不超出框，同时会放大到撑满框）
        const scale = Math.min(boxW / videoSize.width, boxH / videoSize.height);
        const w = Math.round(videoSize.width * scale);
        const h = Math.round(videoSize.height * scale);
        return new Size(w, h);
    }

    // 让窗口内容区尺寸尽量等于 videoSize（已按 scalePercent% 计算好的目标），并做超屏兜底。
    // 不再依赖 window.opener：弹窗与标签页都尝试脚本调整；标签页/受限环境会被浏览器
    // 静默忽略 resizeTo，此时显示页面内提示而非静默失败（用户可手动拖拽或允许弹窗）。
    private resizePopupToFit(videoSize: Size): void {
        const chromeWidth = window.outerWidth - window.innerWidth;
        const chromeHeight = window.outerHeight - window.innerHeight;
        const maxContentW = screen.availWidth - chromeWidth;
        const maxContentH = screen.availHeight - chromeHeight;
        let w = videoSize.width;
        let h = videoSize.height;
        // 安全上限：始终不超过屏幕可用区域
        if (w > maxContentW) {
            const s = maxContentW / w;
            w = maxContentW;
            h = Math.round(h * s);
        }
        if (h > maxContentH) {
            const s = maxContentH / h;
            h = maxContentH;
            w = Math.round(w * s);
        }
        const targetW = Math.round(w + chromeWidth);
        const targetH = Math.round(h + chromeHeight);
        console.log(
            TAG,
            `[Diag] resizePopupToFit opener=${!!window.opener} cur=${window.outerWidth}x${
                window.outerHeight
            } -> resizeTo(${targetW}x${targetH})`,
        );
        try {
            window.resizeTo(targetW, targetH);
        } catch (e: any) {
            console.warn(TAG, `[Diag] resizeTo 抛异常: ${e?.message || e}`);
        }
        // 重设尺寸后再次贴到「左下角」（left=0），与「连接」弹窗行为一致；
        // 若窗口比屏幕高，top 取 0 兜底。moveTo 可能被浏览器限制，失败忽略即可。
        try {
            window.moveTo(0, Math.max(0, screen.availHeight - window.outerHeight));
        } catch {
            // 某些环境下 moveTo 受限，忽略即可
        }
        // 调用后验证是否真的生效：Chromium（Chrome/Edge）会静默忽略脚本 resizeTo。
        // 若不生效，改由服务端通过 Win32 API 按窗口标题（LunaLink-<udid>）直接调整
        // 弹窗窗口尺寸；服务端也失败时再提示用户手动拖拽。
        setTimeout(() => {
            const ok = Math.abs(window.outerWidth - targetW) <= 24 && Math.abs(window.outerHeight - targetH) <= 24;
            if (!ok) {
                console.warn(
                    TAG,
                    `[Diag] resizeTo 未生效: outer=${window.outerWidth}x${window.outerHeight} 期望=${targetW}x${targetH}，改用服务端窗口 API`,
                );
                this.requestServerWindowResize(targetW, targetH);
            }
        }, 150);
    }

    // 服务端窗口级控制：Chromium 忽略前端 resizeTo，改由服务端 Win32 API 按弹窗标题
    // （LunaLink-<udid>，已在 onClientsStats/constructor 设置）找到窗口并 MoveWindow。
    private requestServerWindowResize(outerW: number, outerH: number): void {
        const udid = this.params.udid;
        if (!udid) {
            this.showWindowResizeHint();
            return;
        }
        // 触屏设备（平板/手机）没有对应的桌面弹窗窗口，服务端必然找不到，静默跳过
        const isTouchOnly = 'ontouchstart' in window && navigator.maxTouchPoints > 0;
        if (isTouchOnly) {
            console.log(TAG, '[WindowResize] 触屏设备，跳过桌面窗口调整');
            return;
        }
        const top = Math.max(0, screen.availHeight - outerH);
        fetch('/api/window/resize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `LunaLink-${udid}`,
                width: Math.round(outerW),
                height: Math.round(outerH),
                left: 0,
                top: Math.round(top),
            }),
        })
            .then((r) => r.json().catch(() => ({})))
            .then((data) => {
                if (!data || !data.success) {
                    console.warn(TAG, `[WindowResize] 服务端调整窗口失败: ${(data && data.message) || '未知错误'}`);
                    this.showWindowResizeHint();
                } else {
                    console.log(TAG, `[WindowResize] 服务端已调整窗口: ${(data && data.message) || 'OK'}`);
                }
            })
            .catch((e) => {
                console.warn(TAG, `[WindowResize] 请求失败: ${e?.message || e}`);
                this.showWindowResizeHint();
            });
    }

    // 期望窗口尺寸与当前实际内容区不一致时才调整：避免每次 displayInfo 都重复 resize，
    // 同时覆盖「旋转后 displayInfo 重发但 rotation 未变」等一切到达路径。
    private syncPopupSize(logicalVideoSize: Size): void {
        const target = this.computeWindowSize(logicalVideoSize, this.getScalePercent());
        const key = `${target.width}x${target.height}`;
        if (this.lastResizedKey === key) {
            return;
        }
        const curW = window.innerWidth;
        const curH = window.innerHeight;
        if (Math.abs(curW - target.width) <= 12 && Math.abs(curH - target.height) <= 12) {
            // 当前窗口已与目标一致（可能是用户手动调整过），记录 key 避免反复 resize 打扰
            this.lastResizedKey = key;
            return;
        }
        this.lastResizedKey = key;
        this.resizePopupToFit(target);
    }

    // 窗口 resize 未生效时的页面内提示（只显示一次）：告知是浏览器限制而非故障，
    // 并给出「手动拖拽调整 / 允许本站弹窗」两条出路。
    private showWindowResizeHint(): void {
        if (this.windowResizeHintShown) {
            return;
        }
        this.windowResizeHintShown = true;
        const div = document.createElement('div');
        div.style.cssText = [
            'position:fixed',
            'left:0',
            'right:0',
            'bottom:0',
            'z-index:2147483647',
            'background:rgba(230,150,20,0.95)',
            'color:#1c1c1c',
            'font:12px/1.6 system-ui,sans-serif',
            'padding:8px 28px 8px 12px',
            'box-shadow:0 -2px 8px rgba(0,0,0,0.35)',
            'white-space:normal',
        ].join(';');
        div.innerHTML =
            '当前浏览器不允许脚本自动调整窗口大小，设备旋转后窗口未能自动变横/变竖。' +
            '可<strong>手动拖拽窗口边缘</strong>调整大小（画面会自动适配），' +
            '或<strong>允许本站弹窗</strong>后重新以弹窗模式连接以获得自动适配。' +
            '<span style="position:absolute;right:8px;top:6px;cursor:pointer;font-weight:700">✕</span>';
        div.querySelector('span')?.addEventListener('click', () => div.remove());
        document.body.appendChild(div);
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) {
            return;
        }
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    private applyNewVideoSettings(videoSettings: VideoSettings, saveToStorage: boolean): void {
        let fitToScreen = false;

        // TODO: create control (switch/checkbox) instead
        if (videoSettings.bounds && videoSettings.bounds.equals(this.getMaxSize())) {
            fitToScreen = true;
        }
        if (this.player) {
            this.player.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
            // Player has just (re)built its decoder pipeline (e.g. MsePlayer recreates
            // MediaSource + SourceBuffer when maxFps changes). Request a fresh I-frame so
            // the new SourceBuffer receives a key frame + SPS/PPS and can start decoding,
            // otherwise playback stays black.
            this.sendMessage(CommandControlMessage.createRequestKeyFrameCommand());
        }
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        fullName: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        const hasPid = descriptor.pid !== -1;
        if (hasPid) {
            const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
            const e = html`<div class="stream ${blockClass}">
                <button
                    ${Attribute.UDID}="${descriptor.udid}"
                    ${Attribute.COMMAND}="${ControlCenterCommand.CONFIGURE_STREAM}"
                    ${Attribute.FULL_NAME}="${fullName}"
                    ${Attribute.SECURE}="${params.secure}"
                    ${Attribute.HOSTNAME}="${params.hostname}"
                    ${Attribute.PORT}="${params.port}"
                    ${Attribute.PATHNAME}="${params.pathname}"
                    ${Attribute.USE_PROXY}="${params.useProxy}"
                    id="${configureButtonId}"
                    class="active action-button"
                >
                    配置
                </button>
            </div>`;
            const a = e.content.getElementById(configureButtonId);
            a && (a.onclick = this.onConfigureStreamClick);
            return e.content;
        }
        return;
    }

    private static resolveDeviceFromClick(event: MouseEvent):
        | {
              tracker: DeviceTracker;
              descriptor: GoogDeviceDescriptor;
              options: ParamsStreamScrcpy;
          }
        | undefined {
        const button = event.currentTarget as HTMLAnchorElement;
        const udid = Util.parseStringEnv(button.getAttribute(Attribute.UDID) || '');
        const fullName = button.getAttribute(Attribute.FULL_NAME);
        const secure = Util.parseBooleanEnv(button.getAttribute(Attribute.SECURE) || undefined) || false;
        const hostname = Util.parseStringEnv(button.getAttribute(Attribute.HOSTNAME) || undefined) || '';
        const port = Util.parseIntEnv(button.getAttribute(Attribute.PORT) || undefined);
        const pathname = Util.parseStringEnv(button.getAttribute(Attribute.PATHNAME) || undefined) || '';
        const useProxy = Util.parseBooleanEnv(button.getAttribute(Attribute.USE_PROXY) || undefined);
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }
        if (typeof port !== 'number') {
            throw Error(`Invalid port type: ${typeof port}`);
        }
        const tracker = DeviceTracker.getInstance({
            type: 'android',
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        });
        const descriptor = tracker.getDescriptorByUdid(udid);
        if (!descriptor) {
            return;
        }
        event.preventDefault();
        const elements = document.getElementsByName(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`);
        if (!elements || !elements.length) {
            return;
        }
        const select = elements[0] as HTMLSelectElement;
        const optionElement = select.options[select.selectedIndex];
        const ws = optionElement.getAttribute(Attribute.URL);
        const name = optionElement.getAttribute(Attribute.NAME);
        if (!ws || !name) {
            return;
        }
        const options: ParamsStreamScrcpy = {
            udid,
            ws,
            player: '',
            action: ACTION.STREAM_SCRCPY,
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        };
        return { tracker, descriptor, options };
    }

    private static onConfigureStreamClick = (event: MouseEvent): void => {
        const resolved = StreamClientScrcpy.resolveDeviceFromClick(event);
        if (!resolved) {
            return;
        }
        const { tracker, descriptor, options } = resolved;
        const dialog = new ConfigureScrcpy(tracker, descriptor, options);
        dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
    };

    private static onConfigureDialogClosed = (event: { dialog: ConfigureScrcpy; result: boolean }): void => {
        // 仅清理监听，避免重复触发。保存（result=true）时只关闭弹窗即可，
        // 切勿销毁主页（HostTracker），否则设备列表会从页面上消失。
        event.dialog.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
    };
}
