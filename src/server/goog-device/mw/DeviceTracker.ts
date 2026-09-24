import WS from 'ws';
import { Mw, RequestParameters } from '../../mw/Mw';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { ControlCenter } from '../services/ControlCenter';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { DeviceTrackerEvent } from '../../../types/DeviceTrackerEvent';
import { DeviceTrackerEventList } from '../../../types/DeviceTrackerEventList';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';

export class DeviceTracker extends Mw {
    public static readonly TAG = 'DeviceTracker';
    public static readonly type = 'android';
    private adt: ControlCenter = ControlCenter.getInstance();
    private readonly id: string;

    public static processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.GTRC) {
            return;
        }
        return new DeviceTracker(ws);
    }

    public static processRequest(ws: WS, params: RequestParameters): DeviceTracker | undefined {
        if (params.action !== ACTION.GOOG_DEVICE_LIST) {
            return;
        }
        return new DeviceTracker(ws);
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);

        this.id = this.adt.getId();
        this.adt
            .init()
            .then(() => {
                this.adt.on('device', this.sendDeviceMessage);
                this.adt.on('devicelist', this.sendDeviceListMessage);
                this.buildAndSendMessage(this.adt.getDevices());
            })
            .catch((error: Error) => {
                console.error(`[${DeviceTracker.TAG}] Error: ${error.message}`);
            });
    }

    private sendDeviceMessage = (device: GoogDeviceDescriptor): void => {
        const data: DeviceTrackerEvent<GoogDeviceDescriptor> = {
            device,
            id: this.id,
            name: this.adt.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'device',
            data,
        });
    };

    private sendDeviceListMessage = (): void => {
        this.buildAndSendMessage(this.adt.getDevices());
    };

    private buildAndSendMessage = (list: GoogDeviceDescriptor[]): void => {
        const data: DeviceTrackerEventList<GoogDeviceDescriptor> = {
            list,
            id: this.id,
            name: this.adt.getName(),
        };
        this.sendMessage({
            id: -1,
            type: 'devicelist',
            data,
        });
    };

    protected onSocketMessage(event: WS.MessageEvent): void {
        let command: ControlCenterCommand;
        try {
            command = ControlCenterCommand.fromJSON(event.data.toString());
        } catch (error: any) {
            console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${error?.message}`);
            return;
        }
        const isConnectCommand = command.getType() === ControlCenterCommand.CONNECT;
        const isPairCommand = command.getType() === ControlCenterCommand.PAIR;
        const isRefreshCommand = command.getType() === ControlCenterCommand.REFRESH;
        const isRemoveOfflineCommand = command.getType() === ControlCenterCommand.REMOVE_OFFLINE_DEVICES;
        const isGenericCommand = isRefreshCommand || isRemoveOfflineCommand;
        this.adt
            .runCommand(command)
            .then((result) => {
                if (isConnectCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'connect_result',
                        data: {
                            success: true,
                            message: typeof result === 'string' ? result : 'Connected successfully',
                        },
                    });
                } else if (isPairCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'pair_result',
                        data: {
                            success: true,
                            message: typeof result === 'string' ? result : 'Paired successfully',
                        },
                    });
                } else if (isGenericCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'command_result',
                        data: {
                            success: true,
                            message: typeof result === 'string' ? result : 'Done',
                        },
                    });
                }
            })
            .catch((e) => {
                console.error(`[${DeviceTracker.TAG}], Received message: ${event.data}. Error: ${e.message}`);
                if (isConnectCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'connect_result',
                        data: {
                            success: false,
                            message: e.message,
                        },
                    });
                } else if (isPairCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'pair_result',
                        data: {
                            success: false,
                            message: e.message,
                        },
                    });
                } else if (isGenericCommand) {
                    this.sendMessage({
                        id: command.getId(),
                        type: 'command_result',
                        data: {
                            success: false,
                            message: e.message,
                        },
                    });
                }
            });
    }

    public release(): void {
        super.release();
        this.adt.off('device', this.sendDeviceMessage);
        this.adt.off('devicelist', this.sendDeviceListMessage);
    }
}
