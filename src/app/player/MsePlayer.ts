import { BasePlayer } from './BasePlayer';
import VideoConverter, { setLogger, mimeType } from 'h264-converter';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { DisplayInfo } from '../DisplayInfo';

interface QualityStats {
    timestamp: number;
    decodedFrames: number;
    droppedFrames: number;
}

type Block = {
    start: number;
    end: number;
};

export class MsePlayer extends BasePlayer {
    public static readonly storageKeyPrefix = 'MseDecoder';
    public static readonly playerFullName = '连接';
    public static readonly playerCodeName = 'mse';
    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 7340032,
        maxFps: 60,
        iFrameInterval: 10,
        bounds: new Size(720, 720),
        sendFrameMeta: false,
    });
    private static DEFAULT_FRAMES_PER_FRAGMENT = 1;
    private static DEFAULT_FRAMES_PER_SECOND = 60;

    private isBackgrounded = false;
    // 浏览器对 muted autoplay 视频在「窗口未激活 / 元素尚未布局（尺寸为 0）」时，
    // 会推迟真正的渲染，play() 返回的 Promise 被 reject。此时 video 会停在黑屏，
    // 直到首个用户手势（点击）才恢复——表现为「每次都要点一下黑屏才出画面」。
    // 下面这组字段用于在 play 被拒后，监听首个手势/焦点/resize 重试，并在元素
    // 拿到非零尺寸后再真正 play。
    private playRetryScheduled = false;
    private gestureRetryHandler?: () => void;
    // 播放心跳定时器：浏览器在「窗口未激活 / 窗口 resize（如最大化）/ 元素尺寸变化」时，
    // 可能把 muted autoplay 视频的渲染挂起（paused=true 或 currentTime 不再推进但画面黑屏），
    // 且不再自动恢复。心跳每 1s 检查并主动 play()/seek 拉起渲染（后台 tab 中 setInterval
    // 仍会节流执行，rAF 则不会）。
    private playHeartbeatTimer?: ReturnType<typeof setInterval>;
    private lastHeartbeatTs = -1;
    private lastHeartbeatTime = -1;
    private resizeRecoverTimer?: ReturnType<typeof setTimeout>;

    public static createElement(id?: string): HTMLVideoElement {
        const tag = document.createElement('video') as HTMLVideoElement;
        tag.muted = true;
        tag.autoplay = true;
        tag.playsInline = true;
        tag.setAttribute('muted', 'muted');
        tag.setAttribute('autoplay', 'autoplay');
        tag.setAttribute('playsinline', 'playsinline');
        if (typeof id === 'string') {
            tag.id = id;
        }
        tag.className = 'video-layer';
        return tag;
    }

    private converter?: VideoConverter;
    private videoStats: QualityStats[] = [];
    private noDecodedFramesSince = -1;
    private currentTimeNotChangedSince = -1;
    private bigBufferSince = -1;
    private aheadOfBufferSince = -1;
    public fpf: number = MsePlayer.DEFAULT_FRAMES_PER_FRAGMENT;
    public readonly supportsScreenshot = true;
    private sourceBuffer?: SourceBuffer;
    private waitUntilSegmentRemoved = false;
    private blocks: Block[] = [];
    private frames: Uint8Array[] = [];
    private jumpEnd = -1;
    private lastTime = -1;
    protected canPlay = false;
    private seekingSince = -1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected readonly isSafari = !!(window as unknown as any)['safari'];
    protected readonly isChrome = navigator.userAgent.includes('Chrome');
    protected readonly isMac = navigator.platform.startsWith('Mac');
    private MAX_TIME_TO_RECOVER = 200; // ms
    private MAX_BUFFER = this.isSafari ? 2 : this.isChrome && this.isMac ? 0.9 : 0.2;
    private MAX_AHEAD = -0.2;

    public static isSupported(): boolean {
        return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType);
    }

    constructor(
        udid: string,
        displayInfo?: DisplayInfo,
        name = MsePlayer.playerFullName,
        protected tag: HTMLVideoElement = MsePlayer.createElement(),
    ) {
        super(udid, displayInfo, name, MsePlayer.storageKeyPrefix, tag);
        tag.oncontextmenu = function (event: MouseEvent): boolean {
            event.preventDefault();
            return false;
        };
        tag.addEventListener('canplay', this.onVideoCanPlay);
        tag.addEventListener('error', this.onVideoError);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        // 窗口尺寸变化（含最大化）可能挂起 video 渲染，resize 后主动检查/恢复
        window.addEventListener('resize', this.onWindowResize);
        // 尺寸/分辨率变化（如 onDisplayInfo 重设屏幕信息、窗口缩放）后，主动重绘当前帧，
        // 避免 video 元素停在旧分辨率/黑屏、需要用户点击才刷新。
        this.on('video-view-resize', this.onVideoViewResize);
        // 首个参数为有意的 no-op：禁用 setLogger 的常规日志输出
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        setLogger(() => {}, console.error);
    }

    onVideoCanPlay = (): void => {
        this.onCanPlayHandler();
    };

    onVideoError = (): void => {
        const error = this.tag.error;
        if (error) {
            console.error(`[${this.name}] Video error: code=${error.code}, message=${error.message || 'N/A'}`);
        }
        this.recoverFromError();
    };

    onVisibilityChange = (): void => {
        if (document.hidden) {
            this.isBackgrounded = true;
            // Explicitly pause the element while hidden. Browsers may keep it
            // "playing" but frozen; pausing avoids decoder churn on resume.
            if (!this.tag.paused) {
                this.tag.pause();
            }
        } else if (this.isBackgrounded) {
            this.isBackgrounded = false;
            this.recoverFromBackground();
        }
    };

    private recoverFromBackground(): void {
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        // The decoder/SourceBuffer can get into a *silently* stuck state while
        // the tab was hidden (appendBuffer throws without surfacing an error),
        // which freezes the picture while touch/control still works. Rebuild the
        // whole MSE pipeline unconditionally and ask the device for a fresh
        // I-frame so the new remuxer (which starts with no SPS/PPS) can produce
        // decodable fragments.
        this.rebuildPipeline();
    }

    private recoverFromError(): void {
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        this.rebuildPipeline();
    }

    private rebuildPipeline(): void {
        this.stopConverter();
        this.canPlay = false;
        this.frames = [];
        this.blocks = [];
        this.jumpEnd = -1;
        // Re-arm the canplay listener so the rebuilt pipeline resumes rendering
        // (it was removed after the first canplay in onCanPlayHandler).
        this.tag.addEventListener('canplay', this.onVideoCanPlay);
        // Wait a tick for the old MediaSource state to settle before creating a
        // new one (VideoConverter.reset() attaches a fresh MediaSource).
        setTimeout(() => {
            if (this.getState() === BasePlayer.STATE.PLAYING && !this.converter) {
                let fps = MsePlayer.DEFAULT_FRAMES_PER_SECOND;
                if (this.videoSettings) {
                    fps = this.videoSettings.maxFps;
                }
                this.converter = MsePlayer.createConverter(this.tag, fps, this.fpf);
                this.converter.play();
                this.resetStats();
                // 重建完 MediaSource 后立刻驱动 video 元素渲染，避免回到前台仍黑屏
                this.ensureVideoPlaying();
                // Ask the device for a fresh I-frame so the new remuxer can start
                // decoding. The client listens for this event and sends the request.
                this.emit('need-key-frame', undefined);
                console.log(`[${this.name}] MSE pipeline rebuilt after background return`);
            }
        }, 100);
    }

    private static createConverter(
        tag: HTMLVideoElement,
        fps: number = MsePlayer.DEFAULT_FRAMES_PER_SECOND,
        fpf: number = MsePlayer.DEFAULT_FRAMES_PER_FRAGMENT,
    ): VideoConverter {
        return new VideoConverter(tag, fps, fpf);
    }

    private getVideoPlaybackQuality(): QualityStats | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const video = this.tag as any;
        if (typeof video.mozDecodedFrames !== 'undefined') {
            return null;
        }
        const now = Date.now();
        if (typeof this.tag.getVideoPlaybackQuality == 'function') {
            const temp = this.tag.getVideoPlaybackQuality();
            return {
                timestamp: now,
                decodedFrames: temp.totalVideoFrames,
                droppedFrames: temp.droppedVideoFrames,
            };
        }

        // Webkit-specific properties
        if (typeof video.webkitDecodedFrameCount !== 'undefined') {
            return {
                timestamp: now,
                decodedFrames: video.webkitDecodedFrameCount,
                droppedFrames: video.webkitDroppedFrameCount,
            };
        }
        return null;
    }

    protected onCanPlayHandler(): void {
        this.canPlay = true;
        this.tag.removeEventListener('canplay', this.onVideoCanPlay);
        this.checkVideoResize();
        // 驱动 <video> 元素真正开始渲染（之前漏掉这步，导致 video 停在黑屏）。
        // 用 ensureVideoPlaying 处理「窗口未激活/元素 0 尺寸/autoplay 被拒」等情况。
        this.ensureVideoPlaying();
    }

    // 当屏幕信息或窗口尺寸变化（video-view-resize 事件）时，确保 video 元素重新渲染当前帧，
    // 避免画面停留在旧分辨率或黑屏、需要用户点击才刷新（同时改善「刷新后模糊」）。
    protected onVideoViewResize = (): void => {
        if (this.getState() === BasePlayer.STATE.PLAYING) {
            requestAnimationFrame(() => this.ensureVideoPlaying());
        }
    };

    // 主动让 <video> 元素播放并渲染。集中处理所有「play() 被推迟/拒绝」的情况：
    //  1. 元素尚无可尺寸（新窗口首次布局未完成）→ 等下一帧重试
    //  2. play() 的 Promise 被 reject（autoplay 策略）→ 等首个用户手势/焦点/resize 重试
    private ensureVideoPlaying(): void {
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        if (document.hidden) {
            return;
        }
        // 元素还没布局好（clientWidth/Height 为 0）时 play 不会出画面，延后重试
        if (this.tag.clientWidth === 0 || this.tag.clientHeight === 0) {
            if (!this.playRetryScheduled) {
                this.playRetryScheduled = true;
                requestAnimationFrame(() => {
                    this.playRetryScheduled = false;
                    this.ensureVideoPlaying();
                });
            }
            return;
        }
        if (this.tag.paused) {
            const p = this.tag.play();
            if (p && typeof p.catch === 'function') {
                p.catch(() => this.scheduleGestureRetry());
            }
        }
    }

    // play() 被浏览器 autoplay 策略拒绝后，注册一次性的「首个用户手势 / 窗口焦点 / resize」
    // 监听，触发后立即重试。这样即便新窗口打开时未能自动播放，用户首次点击（或窗口获得焦点）
    // 也会立即恢复画面，而不必每次都手动点黑屏。
    private scheduleGestureRetry(): void {
        if (this.gestureRetryHandler) {
            return;
        }
        const handler = (): void => {
            this.clearGestureRetry();
            this.ensureVideoPlaying();
        };
        this.gestureRetryHandler = handler;
        window.addEventListener('pointerdown', handler, { once: true } as EventListenerOptions);
        window.addEventListener('focus', handler, { once: true } as EventListenerOptions);
        window.addEventListener('resize', handler, { once: true } as EventListenerOptions);
    }

    private clearGestureRetry(): void {
        if (!this.gestureRetryHandler) {
            return;
        }
        window.removeEventListener('pointerdown', this.gestureRetryHandler);
        window.removeEventListener('focus', this.gestureRetryHandler);
        window.removeEventListener('resize', this.gestureRetryHandler);
        this.gestureRetryHandler = undefined;
    }

    private startPlayHeartbeat(): void {
        if (this.playHeartbeatTimer) {
            return;
        }
        this.playHeartbeatTimer = setInterval(() => {
            this.playHeartbeatTick();
        }, 1000);
    }

    private stopPlayHeartbeat(): void {
        if (this.playHeartbeatTimer) {
            clearInterval(this.playHeartbeatTimer);
            this.playHeartbeatTimer = undefined;
        }
    }

    // 播放心跳（见 playHeartbeatTimer 注释）。相比一次性事件重试，它不依赖特定事件时机，
    // 能覆盖「点窗口最大化按钮（不触发页面事件）→ 视频黑屏」等所有渲染挂起场景。
    private playHeartbeatTick(): void {
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        if (document.hidden) {
            return;
        }
        const tag = this.tag;
        if (tag.readyState < 1) {
            return; // 还没有可渲染数据，等 canplay/首帧
        }
        const now = performance.now();
        const dt = now - this.lastHeartbeatTs;
        if (tag.paused) {
            // 情况 1：明确处于暂停（如窗口未激活时 autoplay 被挂起）→ 直接拉起
            this.playVideoSafely();
        } else if (dt >= 1000 && tag.readyState >= 2 && !this.isTimeAdvancing(tag.currentTime)) {
            // 情况 2：看似在播放但 currentTime 停止推进（渲染/解码挂起，最大化后黑屏的典型状态）
            // → play() + 强制 seek 当前帧，让解码器重新输出一帧
            this.playVideoSafely();
            try {
                tag.currentTime = tag.currentTime;
            } catch (e) {
                // ignore: 某些状态下 seek 当前帧可能抛异常
            }
        }
        this.lastHeartbeatTs = now;
        this.lastHeartbeatTime = tag.currentTime;
    }

    private isTimeAdvancing(currentTime: number): boolean {
        if (this.lastHeartbeatTime === -1) {
            return true;
        }
        return Math.abs(currentTime - this.lastHeartbeatTime) >= 0.01;
    }

    private playVideoSafely(): void {
        const p = this.tag.play();
        if (p && typeof p.catch === 'function') {
            p.catch(() => {
                // 被 autoplay 策略拒绝（窗口未激活）：等下一次心跳再试
            });
        }
    }

    // 窗口 resize（含最大化按钮）后：等布局稳定（300ms）再主动检查/恢复渲染，
    // 覆盖「最大化瞬间 video 元素尺寸异常导致渲染挂起」的窗口期。
    private onWindowResize = (): void => {
        if (this.resizeRecoverTimer) {
            clearTimeout(this.resizeRecoverTimer);
        }
        this.resizeRecoverTimer = setTimeout(() => {
            this.resizeRecoverTimer = undefined;
            this.ensureVideoPlaying();
            this.playHeartbeatTick();
        }, 300);
    };

    protected calculateMomentumStats(): void {
        const stat = this.getVideoPlaybackQuality();
        if (!stat) {
            return;
        }

        const timestamp = Date.now();
        const oneSecondBefore = timestamp - 1000;
        this.videoStats.push(stat);

        while (this.videoStats.length && this.videoStats[0].timestamp < oneSecondBefore) {
            this.videoStats.shift();
        }
        while (this.inputBytes.length && this.inputBytes[0].timestamp < oneSecondBefore) {
            this.inputBytes.shift();
        }
        let inputBytes = 0;
        this.inputBytes.forEach((item) => {
            inputBytes += item.bytes;
        });
        const inputFrames = this.inputBytes.length;
        if (this.videoStats.length) {
            const oldest = this.videoStats[0];
            const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
            const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
            // const droppedFrames = inputFrames - decodedFrames;
            this.momentumQualityStats = {
                decodedFrames,
                droppedFrames,
                inputBytes,
                inputFrames,
                timestamp,
            };
        }
    }

    protected resetStats(): void {
        super.resetStats();
        this.videoStats = [];
    }

    public getImageDataURL(): string {
        const canvas = document.createElement('canvas');
        canvas.width = this.tag.clientWidth;
        canvas.height = this.tag.clientHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(this.tag, 0, 0, canvas.width, canvas.height);
        }

        return canvas.toDataURL();
    }

    public play(): void {
        super.play();
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        this.startPlayHeartbeat();
        if (!this.converter) {
            let fps = MsePlayer.DEFAULT_FRAMES_PER_SECOND;
            if (this.videoSettings) {
                fps = this.videoSettings.maxFps;
            }
            this.converter = MsePlayer.createConverter(this.tag, fps, this.fpf);
            this.canPlay = false;
            this.resetStats();
        }
        this.converter.play();
        // 同时驱动 <video> 元素本身的渲染（关键：之前从未调用 tag.play()，
        // 新窗口未完成布局时 video 会停在黑屏）
        this.ensureVideoPlaying();
    }

    public pause(): void {
        super.pause();
        this.stopPlayHeartbeat();
        this.stopConverter();
    }

    public stop(): void {
        super.stop();
        this.stopPlayHeartbeat();
        this.stopConverter();
        this.clearGestureRetry();
        window.removeEventListener('resize', this.onWindowResize);
        if (this.resizeRecoverTimer) {
            clearTimeout(this.resizeRecoverTimer);
            this.resizeRecoverTimer = undefined;
        }
    }

    public setVideoSettings(videoSettings: VideoSettings, fitToScreen: boolean, saveToStorage: boolean): void {
        const oldSettings = this.videoSettings;
        // 分辨率变化（bounds 不同）同样需要重建 MediaSource/SourceBuffer：
        // 设备端切换编码分辨率后，新尺寸的 H264 流（新 SPS/PPS）混入旧 SourceBuffer
        // 会解码失败/卡在旧低清帧，表现为「刷新后画面发糊且不恢复」。
        const resolutionChanged =
            !!oldSettings?.bounds && !!videoSettings.bounds && !Size.equals(oldSettings.bounds, videoSettings.bounds);
        if (oldSettings && (oldSettings.maxFps !== videoSettings.maxFps || resolutionChanged)) {
            const state = this.getState();
            if (this.converter) {
                this.stop();
                this.converter = MsePlayer.createConverter(this.tag, videoSettings.maxFps, this.fpf);
                this.canPlay = false;
                // Re-add canplay listener since it was removed after first fire
                this.tag.addEventListener('canplay', this.onVideoCanPlay);
                // Clear stale frames and buffers
                this.frames = [];
                this.blocks = [];
                this.jumpEnd = -1;
                // 请求设备端发送关键帧 + SPS/PPS，让新 SourceBuffer 能立即开始解码
                this.emit('need-key-frame', undefined);
            }
            if (state === BasePlayer.STATE.PLAYING) {
                this.play();
            }
        }
        super.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
    }

    public getPreferredVideoSetting(): VideoSettings {
        return MsePlayer.preferredVideoSettings;
    }

    checkVideoResize = (): void => {
        if (!this.tag) {
            return;
        }
        const { videoHeight, videoWidth } = this.tag;
        if (this.videoHeight !== videoHeight || this.videoWidth !== videoWidth) {
            this.calculateScreenInfoForBounds(videoWidth, videoHeight);
        }
    };
    cleanSourceBuffer = (): void => {
        if (!this.sourceBuffer) {
            return;
        }
        if (this.sourceBuffer.updating) {
            return;
        }
        if (this.blocks.length < 10) {
            return;
        }
        try {
            this.sourceBuffer.removeEventListener('updateend', this.cleanSourceBuffer);
            this.waitUntilSegmentRemoved = false;
            const removeStart = this.blocks[0].start;
            const removeEnd = this.blocks[4].end;
            this.blocks = this.blocks.slice(5);
            this.sourceBuffer.remove(removeStart, removeEnd);
            let frame = this.frames.shift();
            while (frame) {
                if (!this.checkForIFrame(frame)) {
                    this.frames.unshift(frame);
                    break;
                }
                frame = this.frames.shift();
            }
        } catch (error: any) {
            console.error(`[${this.name}]`, 'Failed to clean source buffer');
        }
    };

    jumpToEnd = (): void => {
        if (!this.sourceBuffer) {
            return;
        }
        if (this.sourceBuffer.updating) {
            return;
        }
        if (!this.tag.buffered.length) {
            return;
        }
        const end = this.tag.buffered.end(this.tag.seekable.length - 1);
        console.log(`[${this.name}]`, `Jumping to the end (${this.jumpEnd}, ${end - this.jumpEnd}).`);
        this.tag.currentTime = end;
        this.jumpEnd = -1;
        this.sourceBuffer.removeEventListener('updateend', this.jumpToEnd);
    };

    public pushFrame(frame: Uint8Array): void {
        // While the tab is hidden the <video> element does not render and
        // requestAnimationFrame is paused, so appending frames only bloats the
        // SourceBuffer and can drive it into a stuck state. Drop incoming
        // frames; we rebuild the pipeline and request a fresh I-frame on return.
        if (this.isBackgrounded) {
            return;
        }
        super.pushFrame(frame);
        if (!this.checkForIFrame(frame)) {
            this.frames.push(frame);
        } else {
            this.checkForBadState();
        }
    }

    protected checkForBadState(): void {
        // Workaround for stalled playback (`stalled` event is not fired, but the image freezes)
        const { currentTime } = this.tag;
        const now = Date.now();
        // let reasonToJump = '';
        let hasReasonToJump = false;
        if (this.momentumQualityStats) {
            if (this.momentumQualityStats.decodedFrames === 0 && this.momentumQualityStats.inputFrames > 0) {
                if (this.noDecodedFramesSince === -1) {
                    this.noDecodedFramesSince = now;
                } else {
                    const time = now - this.noDecodedFramesSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `No frames decoded for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.noDecodedFramesSince = -1;
            }
        }
        if (currentTime === this.lastTime && this.currentTimeNotChangedSince === -1) {
            this.currentTimeNotChangedSince = now;
        } else {
            this.currentTimeNotChangedSince = -1;
        }
        this.lastTime = currentTime;
        if (this.tag.buffered.length) {
            const end = this.tag.buffered.end(0);
            const buffered = end - currentTime;

            if ((end | 0) - currentTime > this.MAX_BUFFER) {
                if (this.bigBufferSince === -1) {
                    this.bigBufferSince = now;
                } else {
                    const time = now - this.bigBufferSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `Buffer is bigger then ${this.MAX_BUFFER} (${buffered.toFixed(
                        //     3,
                        // )}) for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.bigBufferSince = -1;
            }
            if (buffered < this.MAX_AHEAD) {
                if (this.aheadOfBufferSince === -1) {
                    this.aheadOfBufferSince = now;
                } else {
                    const time = now - this.aheadOfBufferSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `Current time is ahead of end (${buffered}) for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.aheadOfBufferSince = -1;
            }
            if (this.currentTimeNotChangedSince !== -1) {
                const time = now - this.currentTimeNotChangedSince;
                if (time > this.MAX_TIME_TO_RECOVER) {
                    // reasonToJump = `Current time not changed for ${time} ms.`;
                    hasReasonToJump = true;
                }
            }
            if (!hasReasonToJump) {
                return;
            }
            let waitingForSeekEnd = 0;
            if (this.seekingSince !== -1) {
                waitingForSeekEnd = now - this.seekingSince;
                if (waitingForSeekEnd < 1500) {
                    return;
                }
            }
            // console.info(`${reasonToJump} Jumping to the end. ${waitingForSeekEnd}`);

            const onSeekEnd = () => {
                this.seekingSince = -1;
                this.tag.removeEventListener('seeked', onSeekEnd);
                this.tag.play();
            };
            if (this.seekingSince !== -1) {
                console.warn(`[${this.name}]`, `Attempt to seek while already seeking! ${waitingForSeekEnd}`);
            }
            this.seekingSince = now;
            this.tag.addEventListener('seeked', onSeekEnd);
            this.tag.currentTime = this.tag.buffered.end(0);
        }
    }

    protected checkForIFrame(frame: Uint8Array): boolean {
        if (!this.converter) {
            return false;
        }
        this.sourceBuffer = this.converter.sourceBuffer;
        if (BasePlayer.isIFrame(frame)) {
            let start = 0;
            let end = 0;
            if (this.tag.buffered && this.tag.buffered.length) {
                start = this.tag.buffered.start(0);
                end = this.tag.buffered.end(0);
            }
            if (end !== 0 && start < end) {
                const block: Block = {
                    start,
                    end,
                };
                this.blocks.push(block);
                if (this.blocks.length > 10) {
                    this.waitUntilSegmentRemoved = true;

                    this.sourceBuffer.addEventListener('updateend', this.cleanSourceBuffer);
                    this.converter.appendRawData(frame);
                    return true;
                }
            }
            if (this.sourceBuffer) {
                this.sourceBuffer.onupdateend = this.checkVideoResize;
            }
        }
        if (this.waitUntilSegmentRemoved) {
            return false;
        }

        this.converter.appendRawData(frame);
        return true;
    }

    private stopConverter(): void {
        if (this.converter) {
            this.converter.appendRawData(new Uint8Array([]));
            this.converter.pause();
            delete this.converter;
        }
        this.sourceBuffer = undefined;
    }

    public getFitToScreenStatus(): boolean {
        return MsePlayer.getFitToScreenStatus(this.udid, this.displayInfo);
    }

    public loadVideoSettings(): VideoSettings {
        return MsePlayer.loadVideoSettings(this.udid, this.displayInfo);
    }
}
