export interface ControlMessageInterface {
    type: number;
}

export class ControlMessage {
    public static TYPE_KEYCODE = 0;
    public static TYPE_TEXT = 1;
    public static TYPE_TOUCH = 2;
    public static TYPE_SCROLL = 3;
    public static TYPE_BACK_OR_SCREEN_ON = 4;
    public static TYPE_EXPAND_NOTIFICATION_PANEL = 5;
    public static TYPE_EXPAND_SETTINGS_PANEL = 6;
    public static TYPE_COLLAPSE_PANELS = 7;
    public static TYPE_GET_CLIPBOARD = 8;
    public static TYPE_SET_CLIPBOARD = 9;
    public static TYPE_SET_SCREEN_POWER_MODE = 10;
    public static TYPE_ROTATE_DEVICE = 11;
    public static TYPE_REQUEST_KEY_FRAME = 12;
    public static TYPE_CHANGE_STREAM_PARAMETERS = 101;
    public static TYPE_PUSH_FILE = 102;

    // 官方 scrcpy v3.x GET_CLIPBOARD 的 copyKey 参数（0 = 不自动复制）
    public static COPY_KEY_NONE = 0;

    constructor(readonly type: number) {}

    public toBuffer(): Buffer {
        throw Error('Not implemented');
    }

    public toString(): string {
        return 'ControlMessage';
    }

    public toJSON(): ControlMessageInterface {
        return {
            type: this.type,
        };
    }
}
