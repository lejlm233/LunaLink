// node-pty 为可选依赖（见 package.json optionalDependencies）：
// 缺少本地 C++ 编译工具链（如 Windows 无 VS Build Tools）时 npm 会跳过其安装，
// 此声明用于保证类型检查不因模块缺失而中断。
// 仅覆盖 src/server/goog-device/mw/RemoteShell.ts 使用到的 API 子集；
// 若安装了真实 node-pty，以其自带类型为准（本声明不会与之冲突）。
declare module 'node-pty' {
    export interface IPty {
        readonly pid: number;
        readonly cols: number;
        readonly rows: number;
        on(eventName: string, callback: (data: any, exitCode?: number) => void): void;
        write(data: string): void;
        kill(): void;
    }

    export interface IPtyForkOptions {
        name?: string;
        cols?: number;
        rows?: number;
        cwd?: string;
        env?: Record<string, string | undefined>;
        encoding?: string | null;
    }

    export function spawn(file: string, args?: string[] | null, options?: IPtyForkOptions): IPty;
}
