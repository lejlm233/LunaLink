import * as crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { Config } from '../Config';

const COOKIE_NAME = 'lunalink_token';
const TOKEN_QUERY_KEY = 'token';
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600; // 30 天

const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0d1117; color: #e6edf3; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .card { width: min(360px, 90vw); padding: 32px 28px; background: #161b22;
          border: 1px solid #30363d; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: .5px; }
  .tip { margin: 0 0 20px; color: #8b949e; font-size: 13px; }
  input { width: 100%; padding: 10px 12px; background: #0d1117; border: 1px solid #30363d;
          border-radius: 8px; color: #e6edf3; font-size: 14px; outline: none; }
  input:focus { border-color: #58a6ff; }
  button { width: 100%; margin-top: 14px; padding: 10px; background: #238636; border: none;
           border-radius: 8px; color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #2ea043; }
  .error { margin-top: 12px; color: #f85149; font-size: 13px; text-align: center; }
`;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 可选的 accessToken 访问认证。
 * - 未配置 accessToken 时全部放行，行为与未启用认证时完全一致；
 * - 已配置时：页面/静态资源/API 需携带认证 cookie（或 ?token= 查询参数），WebSocket 升级同样校验。
 */
export class Auth {
    public static readonly COOKIE_NAME = COOKIE_NAME;

    public static isEnabled(): boolean {
        return !!Config.getInstance().accessToken;
    }

    /** 常数时间比较，避免时序侧信道 */
    public static check(candidate: unknown): boolean {
        const expected = Config.getInstance().accessToken;
        if (!expected) {
            return true;
        }
        if (typeof candidate !== 'string' || candidate.length === 0) {
            return false;
        }
        const a = Buffer.from(candidate, 'utf8');
        const b = Buffer.from(expected, 'utf8');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    public static parseCookies(header: string | undefined): Record<string, string> {
        const result: Record<string, string> = {};
        if (!header) {
            return result;
        }
        for (const pair of header.split(';')) {
            const idx = pair.indexOf('=');
            if (idx < 0) {
                continue;
            }
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            if (!key) {
                continue;
            }
            try {
                result[key] = decodeURIComponent(value);
            } catch (e) {
                result[key] = value;
            }
        }
        return result;
    }

    /** HTTP 请求认证：cookie 优先，其次 ?token= 查询参数 */
    public static isAuthorized(req: IncomingMessage, url?: URL): boolean {
        if (!Auth.isEnabled()) {
            return true;
        }
        const cookies = Auth.parseCookies(req.headers.cookie);
        if (Auth.check(cookies[COOKIE_NAME])) {
            return true;
        }
        if (url) {
            return Auth.check(url.searchParams.get(TOKEN_QUERY_KEY));
        }
        return false;
    }

    public static buildCookie(token: string): string {
        return `${COOKIE_NAME}=${encodeURIComponent(
            token,
        )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
    }

    /** 防 open redirect：仅允许站内路径 */
    public static sanitizeNext(next: unknown, fallback: string): string {
        if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')) {
            return next;
        }
        return fallback;
    }

    public static renderLoginPage(nextPath: string, error = false): string {
        const action = `?next=${encodeURIComponent(nextPath)}`;
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LunaLink - 访问验证</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<form class="card" method="POST" action="${escapeHtml(action)}">
  <h1>LunaLink</h1>
  <p class="tip">此服务已开启访问验证，请输入访问令牌</p>
  <input type="password" name="token" placeholder="访问令牌" autofocus required />
  <button type="submit">进 入</button>
  ${error ? '<div class="error">令牌错误，请重试</div>' : ''}
</form>
</body>
</html>
`;
    }
}
