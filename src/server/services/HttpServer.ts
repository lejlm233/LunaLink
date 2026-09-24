import * as http from 'http';
import * as https from 'https';
import path from 'path';
import { Service } from './Service';
import { Utils } from '../Utils';
import express, { Express } from 'express';
import { Config } from '../Config';
import { TypedEmitter } from '../../common/TypedEmitter';
import * as process from 'process';
import { EnvName } from '../EnvName';
import { ControlCenter } from '../goog-device/services/ControlCenter';
import { resizeWindowByTitle } from './windowApi';
import { Auth } from './Auth';

const DEFAULT_STATIC_DIR = path.join(__dirname, './public');

const PATHNAME = process.env[EnvName.LUNALINK_PATHNAME] || __PATHNAME__;

export type ServerAndPort = {
    server: https.Server | http.Server;
    port: number;
};

interface HttpServerEvents {
    started: boolean;
}

export class HttpServer extends TypedEmitter<HttpServerEvents> implements Service {
    private static instance: HttpServer;
    private static PUBLIC_DIR = DEFAULT_STATIC_DIR;
    private static SERVE_STATIC = true;
    private servers: ServerAndPort[] = [];
    private mainApp?: Express;
    private started = false;

    protected constructor() {
        super();
    }

    public static getInstance(): HttpServer {
        if (!this.instance) {
            this.instance = new HttpServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static setPublicDir(dir: string): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.PUBLIC_DIR = dir;
    }

    public static setServeStatic(enabled: boolean): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.SERVE_STATIC = enabled;
    }

    public async getServers(): Promise<ServerAndPort[]> {
        if (this.started) {
            return [...this.servers];
        }
        return new Promise<ServerAndPort[]>((resolve) => {
            this.once('started', () => {
                resolve([...this.servers]);
            });
        });
    }

    public getName(): string {
        return `HTTP(s) Server Service`;
    }

    public async start(): Promise<void> {
        this.mainApp = express();
        // 登录表单为原生 form 提交（application/x-www-form-urlencoded），必须挂 urlencoded 中间件
        this.mainApp.use(express.json());
        this.mainApp.use(express.urlencoded({ extended: false }));

        // ---- 访问认证（配置 accessToken 后启用；未配置时全部放行，行为与之前一致）----
        const basePath = PATHNAME === '/' ? '' : PATHNAME.replace(/\/$/, '');
        const loginPath = `${basePath}/login`;
        const homePath = `${basePath}/`;

        this.mainApp.get(loginPath, (req, res) => {
            if (!Auth.isEnabled()) {
                res.redirect(homePath);
                return;
            }
            const next = Auth.sanitizeNext(req.query.next, homePath);
            res.status(200).send(Auth.renderLoginPage(next, false));
        });
        this.mainApp.post(loginPath, (req, res) => {
            if (!Auth.isEnabled()) {
                res.status(404).json({ success: false, message: 'Authentication is not enabled' });
                return;
            }
            const next = Auth.sanitizeNext(req.query.next, homePath);
            const token = req.body && typeof req.body.token === 'string' ? req.body.token : '';
            if (!Auth.check(token)) {
                res.status(401).send(Auth.renderLoginPage(next, true));
                return;
            }
            res.setHeader('Set-Cookie', Auth.buildCookie(token));
            res.redirect(303, next);
        });

        this.mainApp.use((req, res, next) => {
            if (!Auth.isEnabled()) {
                next();
                return;
            }
            const url = new URL(req.url, 'https://example.org/');
            // ?token= 正确时顺手种 cookie，方便书签/无法交互的客户端使用
            const queryToken = url.searchParams.get('token');
            if (Auth.check(queryToken) && queryToken) {
                res.setHeader('Set-Cookie', Auth.buildCookie(queryToken));
                next();
                return;
            }
            const cookies = Auth.parseCookies(req.headers.cookie);
            if (Auth.check(cookies[Auth.COOKIE_NAME])) {
                next();
                return;
            }
            const wantsJson =
                url.pathname.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
            if (wantsJson) {
                res.status(401).json({ success: false, message: 'Unauthorized' });
            } else {
                res.redirect(302, `${loginPath}?next=${encodeURIComponent(url.pathname + url.search)}`);
            }
        });
        // ---- 认证结束 ----

        this.mainApp.post('/api/device/:udid/turn-off-screen', async (req, res) => {
            try {
                const { udid } = req.params;
                const cc = ControlCenter.getInstance();
                const device = cc.getDevice(udid);
                if (!device) {
                    res.status(404).json({ success: false, message: `Device not found: ${udid}` });
                    return;
                }
                const result = await device.turnOffScreen();
                console.log(`[ScreenOff] turn-off result: ${result}`);
                res.json({ success: true, message: 'Screen turned off', result });
            } catch (error: any) {
                console.error(`[ScreenOff] turn-off error: ${error?.message}`);
                res.status(500).json({ success: false, message: error?.message || 'Failed to turn off screen' });
            }
        });

        this.mainApp.post('/api/device/:udid/wake-up-screen', async (req, res) => {
            try {
                const { udid } = req.params;
                const cc = ControlCenter.getInstance();
                const device = cc.getDevice(udid);
                if (!device) {
                    res.status(404).json({ success: false, message: `Device not found: ${udid}` });
                    return;
                }
                const result = await device.wakeUpScreen();
                console.log(`[ScreenOff] wake-up result: ${result}`);
                res.json({ success: true, message: 'Screen woken up', result });
            } catch (error: any) {
                console.error(`[ScreenOff] wake-up error: ${error?.message}`);
                res.status(500).json({ success: false, message: error?.message || 'Failed to wake up screen' });
            }
        });

        // 窗口级控制：Chromium（Chrome/Edge）会忽略页面脚本的 window.resizeTo，
        // 弹窗窗口尺寸改由服务端通过 Win32 API（EnumWindows + MoveWindow）按窗口标题
        // 直接调整。前端在设备旋转（及首次拿分辨率）时调用本接口，窗口真实变横/变竖。
        this.mainApp.post('/api/window/resize', async (req, res) => {
            try {
                const body = req.body || {};
                const title = typeof body.title === 'string' ? body.title : '';
                if (!/^LunaLink-[A-Za-z0-9_.:\-]+$/.test(title)) {
                    res.status(400).json({ success: false, message: '非法窗口标题' });
                    return;
                }
                const num = (v: unknown): number | undefined => {
                    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
                    return Number.isFinite(n) ? n : undefined;
                };
                const width = num(body.width);
                const height = num(body.height);
                const left = num(body.left);
                const top = num(body.top);
                if (!width || !height || width < 100 || height < 100 || width > 10000 || height > 10000) {
                    res.status(400).json({ success: false, message: '窗口尺寸超出合理范围' });
                    return;
                }
                const result = await resizeWindowByTitle({
                    title,
                    width,
                    height,
                    left: left ?? 0,
                    top: top ?? 0,
                });
                if (result.ok) {
                    res.json({ success: true, message: result.reason });
                } else {
                    res.status(404).json({ success: false, message: result.reason });
                }
            } catch (error: any) {
                console.error(`[WindowResize] error: ${error?.message}`);
                res.status(500).json({ success: false, message: error?.message || 'Failed to resize window' });
            }
        });

        if (HttpServer.SERVE_STATIC && HttpServer.PUBLIC_DIR) {
            // 禁用前端静态资源（index.html / bundle.js / css 等）的缓存：确保改了前端代码后，
            // 用户普通刷新（F5）即可拿到最新 bundle.js，避免「明明修了 BUG、浏览器却还在跑旧 JS」的
            // 困惑——前端静态资源需禁用缓存，否则改了代码刷新仍可能跑旧 JS。
            this.mainApp.use(
                PATHNAME,
                express.static(HttpServer.PUBLIC_DIR, {
                    setHeaders: (res) => {
                        res.setHeader('Cache-Control', 'no-cache');
                    },
                }),
            );

            /// #if USE_WDA_MJPEG_SERVER

            const { MjpegProxyFactory } = await import('../mw/MjpegProxyFactory');
            this.mainApp.get('/mjpeg/:udid', new MjpegProxyFactory().proxyRequest);
            /// #endif
        }
        const config = Config.getInstance();
        config.servers.forEach((serverItem) => {
            const { secure, port, redirectToSecure } = serverItem;
            let proto: string;
            let server: http.Server | https.Server;
            if (secure) {
                if (!serverItem.options) {
                    throw Error('Must provide option for secure server configuration');
                }
                server = https.createServer(serverItem.options, this.mainApp);
                proto = 'https';
            } else {
                const options = serverItem.options ? { ...serverItem.options } : {};
                proto = 'http';
                let currentApp = this.mainApp;
                let host = '';
                let port = 443;
                let doRedirect = false;
                if (redirectToSecure === true) {
                    doRedirect = true;
                } else if (typeof redirectToSecure === 'object') {
                    doRedirect = true;
                    if (typeof redirectToSecure.port === 'number') {
                        port = redirectToSecure.port;
                    }
                    if (typeof redirectToSecure.host === 'string') {
                        host = redirectToSecure.host;
                    }
                }
                if (doRedirect) {
                    currentApp = express();
                    currentApp.use(function (req, res) {
                        const url = new URL(`https://${host ? host : req.headers.host}${req.url}`);
                        if (port && port !== 443) {
                            url.port = port.toString();
                        }
                        return res.redirect(301, url.toString());
                    });
                }
                server = http.createServer(options, currentApp);
            }
            this.servers.push({ server, port });
            server.listen(port, () => {
                Utils.printListeningMsg(proto, port, PATHNAME);
            });
        });
        this.started = true;
        this.emit('started', true);
    }

    public release(): void {
        this.servers.forEach((item) => {
            item.server.close();
        });
    }
}
