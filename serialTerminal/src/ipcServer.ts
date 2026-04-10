import * as http from 'http';
import { serialPortTerminalManager } from './serialPortTerminalManager';
import { terminalNamePrefix } from './serialPortTerminal';
import * as vscode from 'vscode';

/**
 * IPC Server for MCP communication
 * 
 * This HTTP server runs inside the VS Code extension host and provides
 * an API for the standalone MCP server process to access terminal state.
 */
export class IPCServer {
    private server: http.Server | null = null;
    private port: number = 0;

    constructor() {}

    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res).catch(err => {
                    console.error('IPC request error:', err);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                });
            });

            // Listen on random available port
            this.server.listen(0, '127.0.0.1', () => {
                const address = this.server!.address();
                if (address && typeof address !== 'string') {
                    this.port = address.port;
                    console.log(`IPC Server started on port ${this.port}`);
                    resolve(this.port);
                } else {
                    reject(new Error('Failed to get server port'));
                }
            });

            this.server.on('error', (err) => {
                console.error('IPC Server error:', err);
                reject(err);
            });
        });
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // Set CORS headers (only allow localhost)
        res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const path = url.pathname;

        // Handle different API endpoints
        if (path === '/list-terminals' && req.method === 'GET') {
            await this.handleListTerminals(res);
        } else if (path === '/send-command' && req.method === 'POST') {
            await this.handleSendCommand(req, res);
        } else if (path === '/read-buffer' && req.method === 'POST') {
            await this.handleReadBuffer(req, res);
        } else if (path === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
        }
    }

    private async handleListTerminals(res: http.ServerResponse) {
        try {
            const terminals = vscode.window.terminals.filter(t =>
                t.name.startsWith(terminalNamePrefix)
            );

            const terminalList = terminals.map(t => {
                const portName = t.name.substring(terminalNamePrefix.length);
                const terminal = serialPortTerminalManager.getFromPortPath(portName);
                return {
                    name: t.name,
                    port: portName,
                    isOpen: terminal?.serialport.isOpen ?? false,
                    baudRate: terminal?.serialport.baudRate,
                };
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ terminals: terminalList }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    private async handleSendCommand(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.readRequestBody(req);
            const { port, command, addNewline = true, timeout = 500 } = JSON.parse(body);

            if (!port || !command) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing port or command' }));
                return;
            }

            const terminal = serialPortTerminalManager.getFromPortPath(port);

            if (!terminal) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: `Port ${port} is not open. Please open it in VS Code first.`
                }));
                return;
            }

            if (!terminal.serialport.isOpen) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Port ${port} is not connected.` }));
                return;
            }

            const dataToSend = addNewline && !command.endsWith('\n')
                ? command + '\n'
                : command;

            // Record buffer length before sending
            const totalBefore = terminal.getBufferInfo().totalLines;

            const success = terminal.sendData(dataToSend);

            if (!success) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Failed to send command to ${port}` }));
                return;
            }

            // Smart wait: poll until response data arrives and settles, or timeout
            const maxWait = Math.min(Math.max(timeout, 100), 10000);
            const deadline = Date.now() + maxWait;
            let lastGrowthTime = 0;
            let lastTotal = totalBefore;

            while (Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 25));
                const currentTotal = terminal.getBufferInfo().totalLines;
                if (currentTotal !== lastTotal) {
                    lastGrowthTime = Date.now();
                    lastTotal = currentTotal;
                }
                // Stop once data has settled for 80ms
                if (lastGrowthTime > 0 && Date.now() - lastGrowthTime > 80) {
                    break;
                }
            }

            // Fetch lines that arrived after the command (handle buffer wrap-around)
            const totalAfter = terminal.getBufferInfo().totalLines;
            const newLines = totalAfter >= totalBefore
                ? totalAfter - totalBefore
                : totalAfter; // buffer wrapped around
            const fetchLines = newLines > 0 ? Math.min(newLines + 5, 200) : 20;
            const recentData = terminal.getRecentData(fetchLines);
            const responseText = recentData.join('\n');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                port,
                command,
                recentOutput: responseText || '(No response)'
            }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    private async handleReadBuffer(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const body = await this.readRequestBody(req);
            const { port, lines = 50, offset = 0 } = JSON.parse(body);

            if (!port) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing port' }));
                return;
            }

            const terminal = serialPortTerminalManager.getFromPortPath(port);

            if (!terminal) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: `Port ${port} is not open. Please open it in VS Code first.`
                }));
                return;
            }

            const buffer = terminal.getRecentData(lines, offset);
            const bufferInfo = terminal.getBufferInfo();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                port,
                total_lines: bufferInfo.totalLines,
                returned_lines: buffer.length,
                offset: offset,
                has_more: offset + lines < bufferInfo.totalLines,
                buffer_size: bufferInfo.maxBufferLines,
                data: buffer,
                metadata: {
                    baud_rate: terminal.serialport.baudRate,
                    is_open: terminal.serialport.isOpen,
                }
            }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    private readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            req.on('end', () => {
                resolve(body);
            });
            req.on('error', reject);
        });
    }

    async stop() {
        if (this.server) {
            return new Promise<void>((resolve) => {
                this.server!.close(() => {
                    console.log('IPC Server stopped');
                    resolve();
                });
            });
        }
    }

    getPort(): number {
        return this.port;
    }
}

// Singleton instance
export const ipcServer = new IPCServer();
