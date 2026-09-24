import { SERVER_PORT } from '../../../common/Constants';

export class LanDeviceConnector {
    private static instance?: LanDeviceConnector;
    private searchButton?: HTMLButtonElement;
    private connectButton?: HTMLButtonElement;
    private ipInput?: HTMLInputElement;
    private portInput?: HTMLInputElement;
    private statusIndicator?: HTMLDivElement;
    private searchResultsContainer?: HTMLDivElement;
    private isSearching = false;

    // 单例模式：私有空构造，阻止外部实例化
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    private constructor() {}

    public static getInstance(): LanDeviceConnector {
        if (!this.instance) {
            this.instance = new LanDeviceConnector();
        }
        return this.instance;
    }

    public init(): void {
        const container = document.createElement('details');
        container.id = 'lan-connector';
        container.className = 'lan-connector';

        container.innerHTML = `
            <summary class="lan-connector-summary">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 16v-4"></path>
                    <path d="M12 8h.01"></path>
                </svg>
                <span>局域网连接</span>
                <span class="lan-chevron" aria-hidden="true">▸</span>
            </summary>
            <div class="lan-connector-body">
                <div class="lan-search-section">
                    <button id="lan-search-btn" class="lan-search-btn">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="m21 21-4.35-4.35"></path>
                        </svg>
                        Search Devices
                    </button>
                    <div id="lan-status" class="lan-status"></div>
                </div>
                
                <div class="lan-manual-section">
                    <div class="lan-input-group">
                        <label for="lan-ip">IP Address</label>
                        <input id="lan-ip" type="text" placeholder="e.g., 192.168.1.100" />
                    </div>
                    <div class="lan-input-group">
                        <label for="lan-port">Port</label>
                        <input id="lan-port" type="number" value="${SERVER_PORT}" min="1" max="65535" />
                    </div>
                    <button id="lan-connect-btn" class="lan-connect-btn">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 19V5"></path>
                            <path d="m5 12 7-7 7 7"></path>
                        </svg>
                        Connect
                    </button>
                </div>
                
                <div id="lan-results" class="lan-search-results"></div>
            </div>
        `;

        const devicesElement = document.getElementById('devices');
        if (devicesElement) {
            devicesElement.insertBefore(container, devicesElement.firstChild);
        }

        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        this.searchButton = document.getElementById('lan-search-btn') as HTMLButtonElement;
        this.connectButton = document.getElementById('lan-connect-btn') as HTMLButtonElement;
        this.ipInput = document.getElementById('lan-ip') as HTMLInputElement;
        this.portInput = document.getElementById('lan-port') as HTMLInputElement;
        this.statusIndicator = document.getElementById('lan-status') as HTMLDivElement;
        this.searchResultsContainer = document.getElementById('lan-results') as HTMLDivElement;

        this.searchButton?.addEventListener('click', this.onSearchClick);
        this.connectButton?.addEventListener('click', this.onConnectClick);
    }

    private onSearchClick = async (): Promise<void> => {
        if (this.isSearching) return;

        this.isSearching = true;
        this.updateSearchButton(true);
        this.setStatus('Searching LAN...', 'info');
        this.searchResultsContainer!.innerHTML = '';

        try {
            const devices = await this.scanLanDevices();
            this.displaySearchResults(devices);
            this.setStatus(`Found ${devices.length} device(s)`, 'success');
        } catch (error) {
            console.error('LAN scan error:', error);
            this.setStatus('Search failed', 'error');
        } finally {
            this.isSearching = false;
            this.updateSearchButton(false);
        }
    };

    private onConnectClick = async (): Promise<void> => {
        const ip = this.ipInput?.value.trim();
        const port = parseInt(this.portInput?.value || `${SERVER_PORT}`, 10);

        if (!ip || !this.isValidIp(ip)) {
            this.setStatus('Please enter a valid IP address', 'error');
            return;
        }

        if (isNaN(port) || port < 1 || port > 65535) {
            this.setStatus('Please enter a valid port (1-65535)', 'error');
            return;
        }

        this.setStatus(`Connecting to ${ip}:${port}...`, 'info');

        try {
            await this.connectToDevice(ip, port);
            this.setStatus(`Connected to ${ip}:${port}`, 'success');
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } catch (error) {
            console.error('Connection error:', error);
            this.setStatus('Connection failed', 'error');
        }
    };

    private async scanLanDevices(): Promise<Array<{ ip: string; name?: string }>> {
        const devices: Array<{ ip: string; name?: string }> = [];
        const promises: Promise<void>[] = [];
        const timeout = 1500;

        const localIp = this.getLocalIp();
        const subnet = localIp.substring(0, localIp.lastIndexOf('.') + 1);

        for (let i = 1; i <= 254; i++) {
            const ip = `${subnet}${i}`;
            promises.push(
                new Promise<void>((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', `http://${ip}:${SERVER_PORT}/devices`, true);
                    xhr.timeout = timeout;

                    xhr.onload = () => {
                        if (xhr.status === 200) {
                            devices.push({ ip });
                        }
                        resolve();
                    };

                    xhr.onerror = () => resolve();
                    xhr.ontimeout = () => resolve();

                    xhr.send();
                }),
            );
        }

        await Promise.all(promises);
        return devices;
    }

    private getLocalIp(): string {
        return '192.168.1.1';
    }

    private displaySearchResults(devices: Array<{ ip: string; name?: string }>): void {
        if (!this.searchResultsContainer) return;

        if (devices.length === 0) {
            this.searchResultsContainer.innerHTML = `
                <div class="lan-result-empty">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M12 16v-4"></path>
                        <path d="M12 8h.01"></path>
                    </svg>
                    <p>No devices found on LAN</p>
                </div>
            `;
            return;
        }

        this.searchResultsContainer.innerHTML = `
            <div class="lan-results-header">
                <span>Found ${devices.length} device(s)</span>
            </div>
            <div class="lan-results-list">
                ${devices
                    .map(
                        (device) => `
                    <div class="lan-result-item">
                        <div class="lan-result-icon">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                                <line x1="8" y1="21" x2="16" y2="21"></line>
                                <line x1="12" y1="17" x2="12" y2="21"></line>
                            </svg>
                        </div>
                        <div class="lan-result-info">
                            <span class="lan-result-ip">${device.ip}</span>
                            ${device.name ? `<span class="lan-result-name">${device.name}</span>` : ''}
                        </div>
                        <button class="lan-result-connect" data-ip="${device.ip}" data-port="${SERVER_PORT}">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M12 19V5"></path>
                                <path d="m5 12 7-7 7 7"></path>
                            </svg>
                        </button>
                    </div>
                `,
                    )
                    .join('')}
            </div>
        `;

        const connectButtons = this.searchResultsContainer.querySelectorAll('.lan-result-connect');
        connectButtons.forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget as HTMLElement;
                const ip = target.getAttribute('data-ip');
                const port = target.getAttribute('data-port');
                if (ip && port) {
                    this.ipInput!.value = ip;
                    this.portInput!.value = port;
                    this.onConnectClick();
                }
            });
        });
    }

    private async connectToDevice(ip: string, port: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://${ip}:${port}/devices`);
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Connection timed out'));
            }, 3000);

            ws.onopen = () => {
                clearTimeout(timeout);
                ws.close();
                resolve();
            };

            ws.onerror = () => {
                clearTimeout(timeout);
                reject(new Error('Connection failed'));
            };

            ws.onclose = () => {
                clearTimeout(timeout);
            };
        });
    }

    private isValidIp(ip: string): boolean {
        const parts = ip.split('.');
        if (parts.length !== 4) return false;
        return parts.every((part) => {
            const num = parseInt(part, 10);
            return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
        });
    }

    private updateSearchButton(isSearching: boolean): void {
        if (!this.searchButton) return;

        if (isSearching) {
            this.searchButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M12 16v-4"></path>
                    <path d="M12 8h.01"></path>
                </svg>
                Searching...
            `;
        } else {
            this.searchButton.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                Search Devices
            `;
        }
    }

    private setStatus(message: string, type: 'success' | 'error' | 'info'): void {
        if (!this.statusIndicator) return;

        this.statusIndicator.textContent = message;
        this.statusIndicator.className = `lan-status lan-status-${type}`;

        if (type !== 'info') {
            setTimeout(() => {
                this.statusIndicator!.className = 'lan-status';
            }, 3000);
        }
    }
}
