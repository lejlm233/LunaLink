import { ControlMessage, ControlMessageInterface } from './ControlMessage';
import Position, { PositionInterface } from '../Position';

export interface ScrollControlMessageInterface extends ControlMessageInterface {
    position: PositionInterface;
    hScroll: number;
    vScroll: number;
    buttons: number;
}

export class ScrollControlMessage extends ControlMessage {
    // type(1) + position(12) + hScroll(2) + vScroll(2) + buttons(4)
    public static PAYLOAD_LENGTH = 20;

    constructor(
        readonly position: Position,
        readonly hScroll: number,
        readonly vScroll: number,
        readonly buttons: number,
    ) {
        super(ControlMessage.TYPE_SCROLL);
    }

    /**
     * @override
     * 官方 scrcpy v3.x 格式：position(12) + hScroll(2, 定点数) + vScroll(2, 定点数) + buttons(4)
     */
    public toBuffer(): Buffer {
        const buffer = Buffer.alloc(ScrollControlMessage.PAYLOAD_LENGTH + 1);
        let offset = 0;
        offset = buffer.writeUInt8(this.type, offset);
        offset = buffer.writeUInt32BE(this.position.point.x, offset);
        offset = buffer.writeUInt32BE(this.position.point.y, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.width, offset);
        offset = buffer.writeUInt16BE(this.position.screenSize.height, offset);
        offset = buffer.writeInt16BE(this.hScroll, offset);
        offset = buffer.writeInt16BE(this.vScroll, offset);
        buffer.writeInt32BE(this.buttons, offset);
        return buffer;
    }

    public toString(): string {
        return `ScrollControlMessage{hScroll=${this.hScroll}, vScroll=${this.vScroll}, position=${this.position}, buttons=${this.buttons}}`;
    }

    public toJSON(): ScrollControlMessageInterface {
        return {
            type: this.type,
            position: this.position.toJSON(),
            hScroll: this.hScroll,
            vScroll: this.vScroll,
            buttons: this.buttons,
        };
    }
}
