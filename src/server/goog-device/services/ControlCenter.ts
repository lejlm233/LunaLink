import { TrackerChangeSet } from '@dead50f7/adbkit/lib/TrackerChangeSet';
import { Device } from '../Device';
import { Service } from '../../services/Service';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import { AdbExtended } from '../adb';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import Tracker from '@dead50f7/adbkit/lib/adb/tracker';
import Timeout = NodeJS.Timeout;
import { BaseControlCenter } from '../../services/BaseControlCenter';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { DeviceState } from '../../../common/DeviceState';

export class ControlCenter extends BaseControlCenter<GoogDeviceDescriptor> implements Service {
    private static readonly defaultWaitAfterError = 1000;
    // 设备断开后，等待该时长（毫秒）再将其从列表中移除，避免短暂掉线造成列表闪烁
    private static readonly DISCONNECT_GRACE_PERIOD = 5000;
    private static instance?: ControlCenter;

    private initialized = false;
    private client: AdbKitClient = AdbExtended.createClient();
    private tracker?: Tracker;
    private waitAfterError = 1000;
    private restartTimeoutId?: Timeout;
    private deviceMap: Map<string, Device> = new Map();
    private descriptors: Map<string, GoogDeviceDescriptor> = new Map();
    private removalTimeouts: Map<string, Timeout> = new Map();
    private readonly id: string;

    protected constructor() {
        super();
        const idString = `goog|${os.hostname()}|${os.uptime()}`;
        this.id = crypto.createHash('md5').update(idString).digest('hex');
    }

    public static getInstance(): ControlCenter {
        if (!this.instance) {
            this.instance = new ControlCenter();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!ControlCenter.instance;
    }

    private restartTracker = (): void => {
        if (this.restartTimeoutId) {
            return;
        }
        console.log(`Device tracker is down. Will try to restart in ${this.waitAfterError}ms`);
        this.restartTimeoutId = setTimeout(() => {
            this.stopTracker();
            this.waitAfterError *= 1.2;
            this.init();
        }, this.waitAfterError);
    };

    private onChangeSet = (changes: TrackerChangeSet): void => {
        this.waitAfterError = ControlCenter.defaultWaitAfterError;
        if (changes.added.length) {
            for (const item of changes.added) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
        if (changes.removed.length) {
            for (const item of changes.removed) {
                const { id } = item;
                this.handleConnected(id, DeviceState.DISCONNECTED);
                this.scheduleRemoval(id);
            }
        }
        if (changes.changed.length) {
            for (const item of changes.changed) {
                const { id, type } = item;
                this.handleConnected(id, type);
            }
        }
    };

    private onDeviceUpdate = (device: Device): void => {
        const { udid, descriptor } = device;
        this.descriptors.set(udid, descriptor);
        this.emit('device', descriptor);
    };

    private handleConnected(udid: string, state: string): void {
        let device = this.deviceMap.get(udid);
        if (device) {
            device.setState(state);
        } else {
            device = new Device(udid, state);
            device.on('update', this.onDeviceUpdate);
            this.deviceMap.set(udid, device);
        }
    }

    private broadcastList(): void {
        this.emit('devicelist', this.getDevices());
    }

    private removeDevice(udid: string): void {
        const device = this.deviceMap.get(udid);
        if (device) {
            device.off('update', this.onDeviceUpdate);
        }
        this.deviceMap.delete(udid);
        this.descriptors.delete(udid);
        const timeout = this.removalTimeouts.get(udid);
        if (timeout) {
            clearTimeout(timeout);
            this.removalTimeouts.delete(udid);
        }
    }

    private scheduleRemoval(udid: string): void {
        const existing = this.removalTimeouts.get(udid);
        if (existing) {
            clearTimeout(existing);
        }
        const timeout = setTimeout(() => {
            this.removalTimeouts.delete(udid);
            const device = this.deviceMap.get(udid);
            // 宽限期内若设备重新连回（state 变回 device / connected === true），则保留
            if (device && !device.isConnected()) {
                this.removeDevice(udid);
                this.broadcastList();
            }
        }, ControlCenter.DISCONNECT_GRACE_PERIOD);
        this.removalTimeouts.set(udid, timeout);
    }

    public pruneDisconnectedDevices(): number {
        let count = 0;
        for (const udid of [...this.deviceMap.keys()]) {
            const device = this.deviceMap.get(udid);
            if (device && !device.isConnected()) {
                this.removeDevice(udid);
                count++;
            }
        }
        if (count > 0) {
            this.broadcastList();
        }
        return count;
    }

    public async refreshDevices(): Promise<number> {
        const list = await this.client.listDevices();
        const current = new Set(list.map((device) => device.id));
        // adb 已不再上报的设备：直接移除（它们确定已消失）
        for (const udid of [...this.deviceMap.keys()]) {
            if (!current.has(udid)) {
                this.removeDevice(udid);
            }
        }
        // 同步当前在线设备状态
        list.forEach((device) => {
            this.handleConnected(device.id, device.type);
        });
        this.broadcastList();
        return this.deviceMap.size;
    }

    public async init(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.tracker = await this.startTracker();
        const list = await this.client.listDevices();
        list.forEach((device) => {
            const { id, type } = device;
            this.handleConnected(id, type);
        });
        this.initialized = true;
    }

    private async startTracker(): Promise<Tracker> {
        if (this.tracker) {
            return this.tracker;
        }
        const tracker = await this.client.trackDevices();
        tracker.on('changeSet', this.onChangeSet);
        tracker.on('end', this.restartTracker);
        tracker.on('error', this.restartTracker);
        return tracker;
    }

    private stopTracker(): void {
        if (this.tracker) {
            this.tracker.off('changeSet', this.onChangeSet);
            this.tracker.off('end', this.restartTracker);
            this.tracker.off('error', this.restartTracker);
            this.tracker.end();
            this.tracker = undefined;
        }
        this.tracker = undefined;
        this.initialized = false;
        this.removalTimeouts.forEach((timeout) => clearTimeout(timeout));
        this.removalTimeouts.clear();
    }

    public getDevices(): GoogDeviceDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    public getDevice(udid: string): Device | undefined {
        return this.deviceMap.get(udid);
    }

    public getId(): string {
        return this.id;
    }

    public getName(): string {
        return 'LunaLink';
    }

    public start(): Promise<void> {
        return this.init().catch((e) => {
            console.error(`Error: Failed to init "${this.getName()}". ${e.message}`);
        });
    }

    public release(): void {
        this.stopTracker();
    }

    private pair(host: string, port: number, code: string): Promise<string> {
        const target = `${host}:${port}`;
        return new Promise((resolve, reject) => {
            const adbBin = process.env.ADB_BIN || 'adb';
            execFile(adbBin, ['pair', target, code], { timeout: 15000 }, (error, stdout, stderr) => {
                if (error) {
                    const msg = stderr?.trim() || stdout?.trim() || error.message;
                    reject(new Error(msg));
                    return;
                }
                const output = (stdout + stderr).trim();
                if (output.includes('Successfully paired') || output.includes('successfully paired')) {
                    resolve(output || 'Successfully paired');
                } else {
                    reject(new Error(output || 'Pairing failed'));
                }
            });
        });
    }

    public async runCommand(command: ControlCenterCommand): Promise<string | void> {
        const type = command.getType();
        if (type === ControlCenterCommand.CONNECT) {
            const host = command.getHost();
            const port = command.getPort();
            const result = await this.client.connect(host, port);
            return result;
        }
        if (type === ControlCenterCommand.PAIR) {
            const host = command.getHost();
            const port = command.getPort();
            const code = command.getCode();
            return this.pair(host, port, code);
        }
        if (type === ControlCenterCommand.REMOVE_OFFLINE_DEVICES) {
            const count = this.pruneDisconnectedDevices();
            return `已清除 ${count} 台离线设备`;
        }
        if (type === ControlCenterCommand.REFRESH) {
            const total = await this.refreshDevices();
            return `已刷新，当前共 ${total} 台设备`;
        }
        const udid = command.getUdid();
        const device = this.getDevice(udid);
        if (!device) {
            console.error(`Device with udid:"${udid}" not found`);
            return;
        }
        switch (type) {
            case ControlCenterCommand.KILL_SERVER:
                await device.killServer(command.getPid());
                return;
            case ControlCenterCommand.START_SERVER:
                await device.startServer();
                return;
            case ControlCenterCommand.UPDATE_INTERFACES:
                await device.updateInterfaces();
                return;
            case ControlCenterCommand.TURN_OFF_SCREEN:
                return device.turnOffScreen();
            default:
                throw new Error(`Unsupported command: "${type}"`);
        }
    }
}
