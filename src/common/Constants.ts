export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_PORT = 8886;
// v3.1-ws fork（EucalyZ/scrcpy websocket 分支，官方 3.1 基础）
// 版本号需与 server 端 build.gradle 的 versionName 保持一致（含 -ws 后缀以通过 ServerVersion 兼容性检查）
export const SERVER_VERSION = '3.3.4-ws';

export const LOG_LEVEL = 'ERROR';

let SCRCPY_LISTENS_ON_ALL_INTERFACES;
/// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
SCRCPY_LISTENS_ON_ALL_INTERFACES = true;
/// #else
SCRCPY_LISTENS_ON_ALL_INTERFACES = false;
/// #endif

// v3.x server 的 Options.parse() 使用 key=value 参数格式（第一个参数必须是 server 构建时的版本号）
const ARGUMENTS = [
    SERVER_VERSION,
    `log_level=${LOG_LEVEL}`,
    `port_number=${SERVER_PORT}`,
    `listen_on_all_interfaces=${SCRCPY_LISTENS_ON_ALL_INTERFACES}`,
    // 关闭官方协议中的 device/frame/dummy/codec 元数据，直接输出裸 H264 NALU（与 ws-scrcpy 客户端解码器兼容）
    `send_device_meta=false`,
    `send_frame_meta=false`,
    `send_dummy_byte=false`,
    `send_codec_meta=false`,
];

export const SERVER_PROCESS_NAME = 'app_process';

export const ARGS_STRING = `/ ${SERVER_PACKAGE} ${ARGUMENTS.join(' ')} 2>&1 > /dev/null`;
