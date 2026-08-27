import { t, tf } from "./../i18n/zh-CN.js";
import type { BootstrapSnapshot, ServerPushMessage } from '@openlab/protocol';
export class RuntimeClient {
    #connection: OpenLabConnection | undefined;
    replaceConnection(connection: OpenLabConnection): void {
        this.#connection = connection;
    }
    resetConnection(): void {
        this.#connection = undefined;
    }
    async connect(): Promise<OpenLabConnection> {
        if (this.#connection)
            return this.#connection;
        if (window.openlab)
            this.#connection = await window.openlab.getConnection();
        else {
            const baseUrl = import.meta.env.VITE_RUNTIME_URL as string | undefined;
            const token = import.meta.env.VITE_RUNTIME_TOKEN as string | undefined;
            if (!baseUrl || !token)
                throw new Error(t("copy265"));
            this.#connection = { baseUrl, token, projectRoot: '', projectFolderSelected: false };
        }
        return this.#connection;
    }
    async bootstrap(): Promise<BootstrapSnapshot> {
        return await this.request<BootstrapSnapshot>('/api/bootstrap');
    }
    async request<T>(path: string, init?: RequestInit): Promise<T> {
        const connection = await this.connect();
        const response = await fetch(`${connection.baseUrl}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', ...init?.headers },
        });
        const value = await response.json() as T | {
            error?: {
                message?: string;
            };
        };
        if (!response.ok)
            throw new Error(('error' in (value as object) ? (value as {
                error?: {
                    message?: string;
                };
            }).error?.message : undefined) ?? tf("copy266", response.status));
        return value as T;
    }
    async requestText(path: string): Promise<string> {
        const connection = await this.connect();
        const response = await fetch(`${connection.baseUrl}${path}`, { headers: { Authorization: `Bearer ${connection.token}` } });
        const value = await response.text();
        if (!response.ok) {
            try {
                throw new Error((JSON.parse(value) as {
                    error?: {
                        message?: string;
                    };
                }).error?.message ?? tf("copy266", response.status));
            }
            catch (error) {
                if (error instanceof SyntaxError)
                    throw new Error(tf("copy266", response.status));
                throw error;
            }
        }
        return value;
    }
    async authorizedResource(path: string): Promise<{ url: string; headers: Record<string, string> }> {
        const connection = await this.connect();
        return { url: `${connection.baseUrl}${path}`, headers: { Authorization: `Bearer ${connection.token}` } };
    }
    async requestBytes(path: string, start: number, end: number): Promise<Uint8Array> {
        const connection = await this.connect();
        const response = await fetch(`${connection.baseUrl}${path}`, {
            headers: { Authorization: `Bearer ${connection.token}`, Range: `bytes=${start}-${end}` },
        });
        if (!response.ok) {
            const value = await response.json().catch(() => ({})) as { error?: { message?: string } };
            throw new Error(value.error?.message ?? tf("copy266", response.status));
        }
        return new Uint8Array(await response.arrayBuffer());
    }
    async socket(onMessage: (message: ServerPushMessage) => void, onConnection: (connected: boolean) => void): Promise<() => void> {
        let closedByClient = false;
        let socket: WebSocket | undefined;
        let retry: number | undefined;
        const scheduleReconnect = () => {
            if (closedByClient || retry !== undefined)
                return;
            retry = window.setTimeout(() => {
                retry = undefined;
                void open();
            }, 800);
        };
        const open = async () => {
            if (closedByClient)
                return;
            try {
                const connection = await this.connect();
                const url = new URL(connection.baseUrl);
                url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                url.pathname = '/ws';
                url.searchParams.set('token', connection.token);
                const candidate = new WebSocket(url);
                socket = candidate;
                candidate.addEventListener('open', () => {
                    if (socket === candidate)
                        onConnection(true);
                });
                candidate.addEventListener('message', (event) => {
                    if (socket !== candidate)
                        return;
                    try {
                        onMessage(JSON.parse(String(event.data)) as ServerPushMessage);
                    }
                    catch { /* ignore malformed local frames */ }
                });
                candidate.addEventListener('close', () => {
                    if (socket !== candidate)
                        return;
                    socket = undefined;
                    onConnection(false);
                    this.#connection = undefined;
                    scheduleReconnect();
                });
                candidate.addEventListener('error', () => candidate.close());
            }
            catch {
                onConnection(false);
                this.#connection = undefined;
                scheduleReconnect();
            }
        };
        void open();
        return () => {
            closedByClient = true;
            if (retry !== undefined)
                window.clearTimeout(retry);
            const activeSocket = socket;
            socket = undefined;
            activeSocket?.close();
        };
    }
}
