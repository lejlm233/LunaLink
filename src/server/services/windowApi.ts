import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 通过 Win32 API（EnumWindows + MoveWindow）直接调整浏览器弹窗窗口的大小与位置。
//
// 背景：Chromium（Chrome/Edge）会静默忽略页面脚本的 window.resizeTo（已知限制，
// 见 https://github.com/microsoft/playwright/issues/32141 等），导致「设备旋转后
// 弹窗窗口不跟随变横」。而浏览器弹窗本质是操作系统的顶层窗口，服务端可以用
// user32!EnumWindows 按窗口标题（前端设置为 LunaLink-<udid>）找到句柄，
// 再 MoveWindow 直接改尺寸/位置——不依赖浏览器 API、不重连、不闪烁。
//
// 仅支持 Windows（PowerShell + user32）。其它平台返回失败，由前端降级处理。
// 标题只允许 LunaLink-<udid> 这类安全字符，防止 PowerShell 注入。

const PS1_TEMPLATE = `
param(
  [string]\$Title,
  [int]\$Width,
  [int]\$Height,
  [int]\$Left,
  [int]\$Top
)
\$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LunaLinkWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
'@
\$script:found = [IntPtr]::Zero
[LunaLinkWin]::EnumWindows({
  param(\$hwnd, \$lParam)
  \$sb = New-Object System.Text.StringBuilder 512
  [void][LunaLinkWin]::GetWindowText(\$hwnd, \$sb, 512)
  if (\$sb.Length -gt 0 -and \$sb.ToString() -eq \$Title) {
    \$script:found = \$hwnd
    return \$false
  }
  return \$true
}, [IntPtr]::Zero) | Out-Null
if (\$script:found -ne [IntPtr]::Zero) {
  \$ok = [LunaLinkWin]::MoveWindow(\$script:found, \$Left, \$Top, \$Width, \$Height, \$true)
  if (\$ok) { Write-Output "OK \$(\$script:found)" } else { Write-Output 'MOVE_FAIL' }
} else {
  Write-Output 'NOT_FOUND'
}
`;

export interface ResizeWindowParams {
    title: string;
    width: number;
    height: number;
    left: number;
    top: number;
}

export interface ResizeWindowResult {
    ok: boolean;
    reason: string;
}

export async function resizeWindowByTitle(params: ResizeWindowParams): Promise<ResizeWindowResult> {
    const { title, width, height, left, top } = params;
    if (process.platform !== 'win32') {
        return { ok: false, reason: '非 Windows 平台，不支持窗口级控制' };
    }
    // 标题仅允许 LunaLink-<udid> 这类安全字符，防止 PowerShell 参数注入
    if (!/^LunaLink-[A-Za-z0-9_.:\-]+$/.test(title)) {
        return { ok: false, reason: '非法窗口标题' };
    }
    let ps1Path = '';
    try {
        ps1Path = path.join(os.tmpdir(), `lunalink-window-${process.pid}-${Date.now()}.ps1`);
        fs.writeFileSync(ps1Path, PS1_TEMPLATE, 'utf-8');
        const output = await new Promise<string>((resolve, reject) => {
            const ps = path.join(
                process.env.SystemRoot || 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
            );
            const args = [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                ps1Path,
                '-Title',
                title,
                '-Width',
                String(Math.round(width)),
                '-Height',
                String(Math.round(height)),
                '-Left',
                String(Math.round(left)),
                '-Top',
                String(Math.round(top)),
            ];
            execFile(ps, args, { timeout: 20000, windowsHide: true }, (err, stdout) => {
                if (err) {
                    reject(new Error(`powershell 执行失败: ${err.message}`));
                    return;
                }
                resolve(stdout || '');
            });
        });
        const out = output.trim();
        if (out.startsWith('OK')) {
            return { ok: true, reason: out };
        }
        if (out === 'NOT_FOUND') {
            return { ok: false, reason: '未找到匹配窗口标题（弹窗未打开或标题不符）' };
        }
        return { ok: false, reason: `未知结果: ${out || '<空输出>'}` };
    } catch (e: any) {
        return { ok: false, reason: e?.message || String(e) };
    } finally {
        if (ps1Path) {
            try {
                fs.unlinkSync(ps1Path);
            } catch {
                // 忽略临时文件清理失败
            }
        }
    }
}
