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
                this.port = 0; // Reset cache — VS Code may have restarted with a new port
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
                name: 'serial-terminal-mcp-server',
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
                    name: 'list_terminals',
                    description: 'List all currently open serial port terminals in VS Code with their status and configuration',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            terminals: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string', description: 'Terminal display name' },
                                        port: { type: 'string', description: 'Port path (e.g., COM13, /dev/ttyUSB0)' },
                                        isOpen: { type: 'boolean', description: 'Connection status' },
                                        baudRate: { type: 'number', description: 'Baud rate (e.g., 115200)' }
                                    }
                                }
                            }
                        }
                    },
                    annotations: {
                        readOnlyHint: true,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: true,
                    },
                },
                {
                    name: 'send_command',
                    description: 'Send a command string to an open serial port terminal and receive immediate response',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'string',
                                description: 'Port name (e.g., COM8 on Windows or /dev/ttyUSB0 on Linux)',
                            },
                            command: {
                                type: 'string',
                                description: 'Command string to send to the serial port',
                                minLength: 1,
                                maxLength: 1000,
                            },
                            add_newline: {
                                type: 'boolean',
                                description: 'Add newline character (\\n) at the end of command',
                                default: true,
                            },
                            timeout: {
                                type: 'number',
                                description: 'Max milliseconds to wait for device response. Use higher values (e.g. 2000) for slow devices or Modbus commands.',
                                default: 500,
                                minimum: 100,
                                maximum: 10000,
                            },
                        },
                        required: ['port', 'command'],
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            port: { type: 'string', description: 'Port name' },
                            command: { type: 'string', description: 'Command sent' },
                            newline_added: { type: 'boolean', description: 'Whether newline was added' },
                            recent_output: { type: 'string', description: 'Recent output from the device' }
                        }
                    },
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: true,
                    },
                },
                {
                    name: 'read_buffer',
                    description: 'Read recent data from a serial port terminal buffer with pagination support',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            port: {
                                type: 'string',
                                description: 'Port name (e.g., COM8 on Windows)',
                            },
                            limit: {
                                type: 'number',
                                description: 'Maximum number of lines to return',
                                default: 50,
                                minimum: 1,
                                maximum: 1000,
                            },
                            offset: {
                                type: 'number',
                                description: 'Number of lines to skip from the end (0 = most recent, 50 = skip latest 50 lines)',
                                default: 0,
                                minimum: 0,
                            },
                        },
                        required: ['port'],
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            port: { type: 'string', description: 'Port name' },
                            total_lines: { type: 'number', description: 'Total lines in buffer' },
                            returned_lines: { type: 'number', description: 'Number of lines returned' },
                            offset: { type: 'number', description: 'Offset used' },
                            limit: { type: 'number', description: 'Limit used' },
                            has_more: { type: 'boolean', description: 'Whether more data is available' },
                            buffer_size: { type: 'number', description: 'Maximum buffer capacity' },
                            metadata: {
                                type: 'object',
                                properties: {
                                    baud_rate: { type: 'number', description: 'Current baud rate' },
                                    is_open: { type: 'boolean', description: 'Connection status' }
                                }
                            },
                            data: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Array of text lines from buffer'
                            },
                            pagination: {
                                type: 'object',
                                properties: {
                                    next_offset: { type: 'number', description: 'Offset for next page' },
                                    suggestion: { type: 'string', description: 'Human-readable pagination hint' }
                                },
                                description: 'Pagination info (null if no more data)'
                            }
                        }
                    },
                    annotations: {
                        readOnlyHint: true,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: true,
                    },
                },
            ],
        }));

        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'list_terminals':
                        return await this.listTerminals();

                    case 'send_command':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.sendCommand(
                            args.port as string,
                            args.command as string,
                            (args.add_newline as boolean) ?? true,
                            (args.timeout as number) ?? 500
                        );

                    case 'read_buffer':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.readBuffer(
                            args.port as string,
                            args.limit as number ?? 50,
                            args.offset as number ?? 0
                        );

                    default:
                        throw new Error(`Unknown tool: ${name}. Available tools: list_terminals, send_command, read_buffer`);
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
            
            if (terminals.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: 'No serial port terminals are currently open. Open a serial port in VS Code Serial Terminal first.',
                    }],
                };
            }

            const terminalList = terminals.map((t: any) => 
                `  - ${t.port || t.name || t}${t.baudRate ? ` @ ${t.baudRate}` : ''}${t.isOpen === false ? ' (closed)' : ''}`
            ).join('\n');

            return {
                content: [{
                    type: 'text',
                    text: `Found ${terminals.length} serial port terminal${terminals.length > 1 ? 's' : ''}:\n${terminalList}`,
                }],
                _meta: {
                    terminals
                }
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Error connecting to Serial Terminal extension: ${error.message}\n\nNext steps:\n1. Ensure VS Code is running\n2. Verify Serial Terminal extension is installed and activated\n3. Open at least one serial port terminal`,
                }],
                isError: true,
            };
        }
    }

    private async sendCommand(port: string, command: string, addNewline: boolean, timeout: number = 500) {
        try {
            // Validate inputs
            if (!port || port.trim().length === 0) {
                throw new Error('Port name cannot be empty. Example: COM8 (Windows) or /dev/ttyUSB0 (Linux)');
            }
            if (!command || command.trim().length === 0) {
                throw new Error('Command cannot be empty');
            }
            if (command.length > 1000) {
                throw new Error('Command too long (max 1000 characters)');
            }

            const response = await this.ipcClient.request('/send-command', 'POST', {
                port,
                command,
                addNewline,
                timeout
            });

            const recentOutput: string = typeof response.recentOutput === 'string' ? response.recentOutput : '';
            const recentText = recentOutput && recentOutput !== '(No response yet)'
                ? `\n\nRecent output:\n${recentOutput}`
                : '\n\n(No output yet — use read_buffer to check later)';

            return {
                content: [{
                    type: 'text',
                    text: `Command "${command}" sent to ${port}${recentText}`,
                }],
                _meta: {
                    port,
                    command,
                    newline_added: addNewline,
                    recent_output: recentOutput
                }
            };
        } catch (error: any) {
            // Enhanced error handling
            let errorMessage = `Error sending command to ${port}: ${error.message}\n\n`;
            
            if (error.message.includes('not open')) {
                errorMessage += 'Next steps:\n';
                errorMessage += '1. Use `list_terminals` to see available ports\n';
                errorMessage += '2. Open the port in VS Code Serial Terminal first\n';
                errorMessage += '3. Check if the port name is correct (e.g., COM8 on Windows)';
            } else if (error.message.includes('IPC request failed')) {
                errorMessage += 'Next steps:\n';
                errorMessage += '1. Ensure VS Code is running\n';
                errorMessage += '2. Verify Serial Terminal extension is installed\n';
                errorMessage += '3. Try reloading VS Code window';
            }

            return {
                content: [{
                    type: 'text',
                    text: errorMessage,
                }],
                isError: true,
            };
        }
    }

    private async readBuffer(port: string, limit: number, offset: number) {
        try {
            // Validate inputs
            if (!port || port.trim().length === 0) {
                throw new Error('Port name cannot be empty. Use list_terminals to see available ports.');
            }
            if (limit < 1 || limit > 1000) {
                throw new Error('Limit must be between 1 and 1000 lines');
            }
            if (offset < 0) {
                throw new Error('Offset must be non-negative (0 = most recent data)');
            }

            const response = await this.ipcClient.request('/read-buffer', 'POST', {
                port,
                lines: limit,
                offset: offset
            });
            
            const buffer = response.data || [];
            
            if (buffer.length === 0 && offset === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `Buffer for ${port} is empty. Send a command to start receiving data.`,
                    }],
                };
            }

            if (buffer.length === 0 && offset > 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `No data at offset ${offset}. Total buffer has ${response.total_lines} lines. Try a smaller offset.`,
                    }],
                };
            }

            const paginationInfo = response.has_more ? {
                next_offset: offset + limit,
                suggestion: `Use offset=${offset + limit} and limit=${limit} to get next page`
            } : null;

            const dataText = buffer.join('\n');
            const summaryLine = `Retrieved ${buffer.length} lines from ${port} (${response.total_lines} total, offset ${offset})`;
            const fullText = `${summaryLine}\n\n${dataText}`;

            return {
                content: [{
                    type: 'text',
                    text: fullText,
                }],
                _meta: {
                    port,
                    total_lines: response.total_lines,
                    returned_lines: buffer.length,
                    offset,
                    limit,
                    has_more: response.has_more,
                    buffer_size: response.buffer_size,
                    metadata: response.metadata,
                    data: buffer,
                    pagination: paginationInfo
                }
            };
        } catch (error: any) {
            let errorMessage = `Error reading buffer from ${port}: ${error.message}\n\n`;
            
            if (error.message.includes('not open')) {
                errorMessage += 'Next steps:\n';
                errorMessage += '1. Use `list_terminals` to see available ports\n';
                errorMessage += '2. Open the port in VS Code first\n';
                errorMessage += '3. Verify the port name is correct';
            } else if (error.message.includes('IPC request failed')) {
                errorMessage += 'Next steps:\n';
                errorMessage += '1. Ensure Serial Terminal extension is running in VS Code\n';
                errorMessage += '2. Try reloading VS Code window';
            }

            return {
                content: [{
                    type: 'text',
                    text: errorMessage,
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
