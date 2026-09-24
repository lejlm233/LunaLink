import { WDAMethod } from './WDAMethod';

export class ControlCenterCommand {
    public static KILL_SERVER = 'kill_server';
    public static START_SERVER = 'start_server';
    public static UPDATE_INTERFACES = 'update_interfaces';
    public static CONFIGURE_STREAM = 'configure_stream';
    public static RUN_WDA = 'run-wda';
    public static REQUEST_WDA = 'request-wda';
    public static CONNECT = 'connect';
    public static PAIR = 'pair';
    public static TURN_OFF_SCREEN = 'turn_off_screen';
    public static REMOVE_OFFLINE_DEVICES = 'remove_offline';
    public static REFRESH = 'refresh';

    private id = -1;
    private type = '';
    private pid = 0;
    private udid = '';
    private method = '';
    private args?: any;
    private data?: any;
    private host = '';
    private port = 0;
    private code = '';

    public static fromJSON(json: string): ControlCenterCommand {
        const body = JSON.parse(json);
        if (!body) {
            throw new Error('Invalid input');
        }
        const command = new ControlCenterCommand();
        const data = (command.data = body.data);
        command.id = body.id;
        command.type = body.type;

        if (typeof data.udid === 'string') {
            command.udid = data.udid;
        }
        switch (body.type) {
            case this.KILL_SERVER:
                if (typeof data.pid !== 'number' && data.pid <= 0) {
                    throw new Error('Invalid "pid" value');
                }
                command.pid = data.pid;
                return command;
            case this.REQUEST_WDA:
                if (typeof data.method !== 'string') {
                    throw new Error('Invalid "method" value');
                }
                command.method = data.method;
                command.args = data.args;
                return command;
            case this.CONNECT:
                if (typeof data.host !== 'string' || !data.host) {
                    throw new Error('Invalid "host" value');
                }
                command.host = data.host;
                command.port = typeof data.port === 'number' && data.port > 0 ? data.port : 5555;
                return command;
            case this.PAIR:
                if (typeof data.host !== 'string' || !data.host) {
                    throw new Error('Invalid "host" value');
                }
                command.host = data.host;
                command.port = typeof data.port === 'number' && data.port > 0 ? data.port : 5555;
                if (typeof data.code !== 'string' || !data.code) {
                    throw new Error('Invalid "code" value');
                }
                command.code = data.code;
                return command;
            case this.START_SERVER:
            case this.UPDATE_INTERFACES:
            case this.CONFIGURE_STREAM:
            case this.RUN_WDA:
            case this.TURN_OFF_SCREEN:
            case this.REMOVE_OFFLINE_DEVICES:
            case this.REFRESH:
                return command;
            default:
                throw new Error(`Unknown command "${body.command}"`);
        }
    }

    public getType(): string {
        return this.type;
    }
    public getPid(): number {
        return this.pid;
    }
    public getUdid(): string {
        return this.udid;
    }
    public getId(): number {
        return this.id;
    }
    public getMethod(): WDAMethod | string {
        return this.method;
    }
    public getData(): any {
        return this.data;
    }
    public getArgs(): any {
        return this.args;
    }
    public getHost(): string {
        return this.host;
    }
    public getPort(): number {
        return this.port;
    }
    public getCode(): string {
        return this.code;
    }
}
