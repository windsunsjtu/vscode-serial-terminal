import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * HTTP IPC Client for communicating with the VS Code extension's IPC server
 */
class IPCClient {
    private port: number = 0;
    private portFilePath: string;

    constructor() {
        // Path where extension saves the IPC port
        // VS Code global storage path: ~/.vscode/extensions/awsxxf.serialterminal-x.x.x/globalStorage
        const homeDir = os.homedir();
        const vscodeDir = path.join(homeDir, '.vscode', 'extensions');
        
        // Try to find the extension directory
        this.portFilePath = '';
        try {
            const extensionsDir = fs.readdirSync(vscodeDir);
            const serialTerminalDir = extensionsDir.find(d => d.startsWith('awsxxf.serialterminal'));
            if (serialTerminalDir) {
                // Global storage is in user data directory, not extension directory
                // For Windows: %APPDATA%/Code/User/globalStorage/awsxxf.serialterminal
                const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
                this.portFilePath = path.join(appData, 'Code', 'User', 'globalStorage', 'awsxxf.serialterminal', 'ipc-port.txt');
            }
        } catch (err) {
            console.error('Error finding extension directory:', err);
        }
    }

    async getPort(): Promise<number> {
        if (this.port > 0) {
            return this.port;
        }

        // Read port from file
        try {
            const portStr = await fs.promises.readFile(this.portFilePath, 'utf-8');
            this.port = parseInt(portStr.trim(), 10);
            return this.port;
        } catch (err) {
            throw new Error(`Failed to read IPC port from ${this.portFilePath}. Make sure the Serial Terminal extension is running in VS Code.`);
        }
    }

    async request(endpoint: string, method: 'GET' | 'POST' = 'GET', body?: any): Promise<any> {
        const port = await this.getPort();
        
        return new Promise((resolve, reject) => {
            const postData = body ? JSON.stringify(body) : '';
            
            const options: http.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: endpoint,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(postData && { 'Content-Length': Buffer.byteLength(postData) })
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            reject(new Error(json.error || `HTTP ${res.statusCode}`));
                        }
                    } catch (err) {
                        reject(new Error(`Failed to parse response: ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(new Error(`IPC request failed: ${err.message}. Make sure Serial Terminal extension is running.`));
            });

            if (postData) {
                req.write(postData);
            }
            
            req.end();
        });
    }
}

interface TerminalInfo {
    name: string;
    port: string;
    isOpen: boolean;
    baudRate?: number;
}

class SerialTerminalMcpServer {
    private server: Server;
    private ipcClient: IPCClient;

    constructor() {
        this.ipcClient = new IPCClient();
        this.server = new Server(
            {
                name: 'serial-terminal-mcp',
                version: '0.1.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupTools();
    }

    private setupTools() {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'list_serial_terminals',
                    description: 'List all currently open serial port terminals in VS Code',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'send_serial_command',
                    description: 'Send a command to an open serial port terminal',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'string',
                                description: 'Port name (e.g., COM8 or /dev/ttyUSB0)',
                            },
                            command: {
                                type: 'string',
                                description: 'Command to send to the serial port',
                            },
                            addNewline: {
                                type: 'boolean',
                                description: 'Add newline at the end of command',
                                default: true,
                            },
                        },
                        required: ['port', 'command'],
                    },
                },
                {
                    name: 'read_serial_buffer',
                    description: 'Read recent data from a serial port terminal buffer',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'string',
                                description: 'Port name (e.g., COM8)',
                            },
                            lines: {
                                type: 'number',
                                description: 'Number of recent lines to read',
                                default: 50,
                            },
                        },
                        required: ['port'],
                    },
                },
            ],
        }));

        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'list_serial_terminals':
                        return await this.listTerminals();

                    case 'send_serial_command':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.sendCommand(
                            args.port as string,
                            args.command as string,
                            args.addNewline as boolean ?? true
                        );

                    case 'read_serial_buffer':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.readBuffer(
                            args.port as string,
                            args.lines as number ?? 50
                        );

                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                return {
                    content: [{
                        type: 'text',
                        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                    isError: true,
                };
            }
        });
    }

    private async listTerminals() {
        try {
            const response = await this.ipcClient.request('/list-terminals', 'GET');
            const terminals = response.terminals || [];
            
            return {
                content: [{
                    type: 'text',
                    text: terminals.length > 0
                        ? JSON.stringify(terminals, null, 2)
                        : 'No serial port terminals are currently open.',
                }],
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${error.message}`,
                }],
                isError: true,
            };
        }
    }

    private async sendCommand(port: string, command: string, addNewline: boolean) {
        try {
            const response = await this.ipcClient.request('/send-command', 'POST', {
                port,
                command,
                addNewline
            });
            
            return {
                content: [{
                    type: 'text',
                    text: `Command sent to ${port}: ${command}\n\nRecent output:\n${response.recentOutput}`,
                }],
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${error.message}`,
                }],
                isError: true,
            };
        }
    }

    private async readBuffer(port: string, lines: number) {
        try {
            const response = await this.ipcClient.request('/read-buffer', 'POST', {
                port,
                lines
            });
            
            const buffer = response.data || [];
            
            if (buffer.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `Buffer for ${port} is empty. No data has been received yet.`,
                    }],
                };
            }
            
            return {
                content: [{
                    type: 'text',
                    text: `Recent ${buffer.length} lines from ${port}:\n\n${buffer.join('\n')}`,
                }],
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Error: ${error.message}`,
                }],
                isError: true,
            };
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('Serial Terminal MCP server running on stdio');
    }

    async close() {
        await this.server.close();
    }
}

// Export class for standalone entry point
export { SerialTerminalMcpServer };

// Standalone entry point for running as separate process
// Communicates with VS Code extension via HTTP IPC
if (require.main === module) {
    const server = new SerialTerminalMcpServer();
    server.run().catch(console.error);
}
