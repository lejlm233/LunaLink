import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import VideoSettings from '../../VideoSettings';

const BUTTONS = [
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
];

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        moreBox?: HTMLElement,
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.code) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        const keyboard = new ToolBoxCheckbox(
            'Capture keyboard',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        elements.push(keyboard);

        // Fullscreen toggle button
        const fullscreenEnterSvg = SvgImage.create(SvgImage.Icon.FULLSCREEN);
        const fullscreenExitSvg = SvgImage.create(SvgImage.Icon.FULLSCREEN_EXIT);
        const fullscreenBtn = new ToolBoxButton('Fullscreen', SvgImage.Icon.FULLSCREEN);
        const fsEl = fullscreenBtn.getElement();
        fsEl.innerHTML = '';
        fsEl.appendChild(fullscreenEnterSvg.cloneNode(true));
        fsEl.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                document.documentElement.requestFullscreen();
            }
        });
        document.addEventListener('fullscreenchange', () => {
            fsEl.innerHTML = '';
            if (document.fullscreenElement) {
                fsEl.title = 'Exit fullscreen';
                fsEl.appendChild(fullscreenExitSvg.cloneNode(true));
            } else {
                fsEl.title = 'Fullscreen';
                fsEl.appendChild(fullscreenEnterSvg.cloneNode(true));
            }
        });
        elements.push(fullscreenBtn);

        // Quality toggle — switch between HD (high bitrate) and Smooth (low bitrate)
        const qualityBtn = new ToolBoxButton('HD mode', SvgImage.Icon.POWER);
        const qEl = qualityBtn.getElement();
        qEl.style.fontSize = '8px';
        qEl.style.fontWeight = 'bold';
        qEl.style.color = 'var(--text-secondary)';
        qEl.style.lineHeight = '1';
        qEl.style.display = 'flex';
        qEl.style.alignItems = 'center';
        qEl.style.justifyContent = 'center';
        qEl.innerHTML = 'HD';
        let isHD = true;
        qEl.addEventListener('click', () => {
            const settings = player.getVideoSettings();
            let newSettings;
            if (isHD) {
                // Switch to Smooth: lower bitrate, cap fps
                isHD = false;
                qEl.textContent = 'SM';
                qEl.title = 'Smooth mode (click for HD)';
                newSettings = new VideoSettings({
                    lockedVideoOrientation: settings.lockedVideoOrientation,
                    bitrate: 2000000,
                    maxFps: 30,
                    iFrameInterval: settings.iFrameInterval,
                    bounds: settings.bounds,
                    sendFrameMeta: settings.sendFrameMeta,
                    displayId: settings.displayId,
                    codecOptions: settings.codecOptions,
                    encoderName: settings.encoderName,
                });
            } else {
                // Switch to HD: higher bitrate, higher fps
                isHD = true;
                qEl.textContent = 'HD';
                qEl.title = 'HD mode (click for Smooth)';
                newSettings = new VideoSettings({
                    lockedVideoOrientation: settings.lockedVideoOrientation,
                    bitrate: 7340032,
                    maxFps: 60,
                    iFrameInterval: settings.iFrameInterval,
                    bounds: settings.bounds,
                    sendFrameMeta: settings.sendFrameMeta,
                    displayId: settings.displayId,
                    codecOptions: settings.codecOptions,
                    encoderName: settings.encoderName,
                });
            }
            client.sendNewVideoSetting(newSettings);
        });
        elements.push(qualityBtn);

        // More button — toggles the advanced settings panel (more-box)
        if (moreBox) {
            const displayId = player.getVideoSettings().displayId;
            const id = `show_more_${udid}_${playerName}_${displayId}`;
            const more = new ToolBoxCheckbox('More', SvgImage.Icon.MORE, id);
            more.addEventListener('click', (_, el) => {
                const element = el.getElement();
                moreBox.style.display = element.checked ? 'block' : 'none';
            });
            elements.unshift(more);
        }

        return new GoogToolBox(elements);
    }
}
