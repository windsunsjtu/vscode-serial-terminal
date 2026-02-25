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
                    name: 'serial_terminal_list_terminals',
                    description: 'List all currently open serial port terminals in VS Code with their status and configuration',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            response_format: {
                                type: 'string',
                                enum: ['json', 'markdown'],
                                description: 'Response format (json for programmatic processing, markdown for human readability)',
                                default: 'json',
                            },
                        },
                    },
                    annotations: {
                        readOnlyHint: true,
                        destructiveHint: false,
                        idempotentHint: true,
                        openWorldHint: true,
                    },
                },
                {
                    name: 'serial_terminal_send_command',
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
                            response_format: {
                                type: 'string',
                                enum: ['json', 'markdown'],
                                description: 'Response format (json for programmatic processing, markdown for human readability)',
                                default: 'markdown',
                            },
                        },
                        required: ['port', 'command'],
                    },
                    annotations: {
                        readOnlyHint: false,
                        destructiveHint: false,
                        idempotentHint: false,
                        openWorldHint: true,
                    },
                },
                {
                    name: 'serial_terminal_read_buffer',
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
                            response_format: {
                                type: 'string',
                                enum: ['json', 'markdown'],
                                description: 'Response format (json for programmatic processing, markdown for human readability)',
                                default: 'json',
                            },
                        },
                        required: ['port'],
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
                    case 'serial_terminal_list_terminals':
                        return await this.listTerminals(
                            args?.response_format as string || 'json'
                        );

                    case 'serial_terminal_send_command':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.sendCommand(
                            args.port as string,
                            args.command as string,
                            args.add_newline as boolean ?? true,
                            args.response_format as string || 'markdown'
                        );

                    case 'serial_terminal_read_buffer':
                        if (!args) {
                            throw new Error('Missing arguments');
                        }
                        return await this.readBuffer(
                            args.port as string,
                            args.limit as number ?? 50,
                            args.offset as number ?? 0,
                            args.response_format as string || 'json'
                        );

                    default:
                        throw new Error(`Unknown tool: ${name}. Available tools: serial_terminal_list_terminals, serial_terminal_send_command, serial_terminal_read_buffer`);
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

    private async listTerminals(responseFormat: string = 'json') {
        try {
            const response = await this.ipcClient.request('/list-terminals', 'GET');
            const terminals = response.terminals || [];
            
            if (terminals.length === 0) {
                return {
                    content: [{
                        type: 'text',
                        text: 'No serial port terminals are currently open. Open a serial port in VS Code first using the Serial Terminal extension.',
                    }],
                };
            }

            let text: string;
            if (responseFormat === 'markdown') {
                text = '# Serial Port Terminals\n\n';
                terminals.forEach((t: any, index: number) => {
                    text += `## ${index + 1}. ${t.name}\n`;
                    text += `- **Port**: ${t.port}\n`;
                    text += `- **Status**: ${t.isOpen ? '🟢 Connected' : '🔴 Disconnected'}\n`;
                    text += `- **Baud Rate**: ${t.baudRate || 'N/A'}\n\n`;
                });
            } else {
                // JSON format
                text = JSON.stringify({
                    total: terminals.length,
                    terminals: terminals
                }, null, 2);
            }
            
            return {
                content: [{
                    type: 'text',
                    text: text,
                }],
            };
        } catch (error: any) {
            return {
                content: [{
                    type: 'text',
                    text: `Error connecting to Serial Terminal extension: ${error.message}\n\nMake sure:\n1. VS Code is running\n2. Serial Terminal extension is installed and activated\n3. At least one serial port terminal is open`,
                }],
                isError: true,
            };
        }
    }

    private async sendCommand(port: string, command: string, addNewline: boolean, responseFormat: string = 'markdown') {
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
                addNewline
            });
            
            let text: string;
            if (responseFormat === 'markdown') {
                text = `# Command Sent to ${port}\n\n`;
                text += `**Command**: \`${command}\`\n`;
                text += `**Newline Added**: ${addNewline ? 'Yes' : 'No'}\n\n`;
                text += `## Recent Output\n\n\`\`\`\n${response.recentOutput}\n\`\`\``;
            } else {
                // JSON format
                text = JSON.stringify({
                    success: true,
                    port: port,
                    command: command,
                    newline_added: addNewline,
                    recent_output: response.recentOutput
                }, null, 2);
            }

            return {
                content: [{
                    type: 'text',
                    text: text,
                }],
            };
        } catch (error: any) {
            // Enhanced error handling
            let errorMessage = `Error sending command to ${port}: ${error.message}\n\n`;
            
            if (error.message.includes('not open')) {
                errorMessage += '**Suggestions:**\n';
                errorMessage += '1. Use `serial_terminal_list_terminals` to see available ports\n';
                errorMessage += '2. Open the port in VS Code Serial Terminal extension first\n';
                errorMessage += '3. Check if the port name is correct (e.g., COM8 on Windows)';
            } else if (error.message.includes('IPC request failed')) {
                errorMessage += '**Suggestions:**\n';
                errorMessage += '1. Make sure VS Code is running\n';
                errorMessage += '2. Ensure Serial Terminal extension is installed\n';
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

    private async readBuffer(port: string, limit: number, offset: number, responseFormat: string = 'json') {
        try {
            // Validate inputs
            if (!port || port.trim().length === 0) {
                throw new Error('Port name cannot be empty. Use serial_terminal_list_terminals to see available ports.');
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
                        text: `Buffer for ${port} is empty. No data has been received yet. Send a command using serial_terminal_send_command to start receiving data.`,
                    }],
                };
            }

            if (buffer.length === 0 && offset > 0) {
                return {
                    content: [{
                        type: 'text',
                        text: `No data at offset ${offset}. Total lines in buffer: ${response.total_lines}. Try a smaller offset value.`,
                    }],
                };
            }

            let text: string;
            if (responseFormat === 'markdown') {
                text = `# Serial Buffer Data - ${port}\n\n`;
                text += `**Port**: ${port}\n`;
                text += `**Baud Rate**: ${response.metadata?.baud_rate || 'N/A'}\n`;
                text += `**Status**: ${response.metadata?.is_open ? '🟢 Connected' : '🔴 Disconnected'}\n`;
                text += `**Total Lines**: ${response.total_lines} / ${response.buffer_size} (max)\n`;
                text += `**Showing**: Lines ${offset + 1} to ${offset + buffer.length} (${buffer.length} lines)\n`;
                text += `**More Data**: ${response.has_more ? 'Yes' : 'No'}\n\n`;
                
                if (response.has_more) {
                    text += `*💡 Tip: Use offset=${offset + limit} to read the next ${limit} lines*\n\n`;
                }
                
                text += `## Data\n\n\`\`\`\n${buffer.join('\n')}\n\`\`\``;
            } else {
                // JSON format
                text = JSON.stringify({
                    port: port,
                    total_lines: response.total_lines,
                    returned_lines: buffer.length,
                    offset: offset,
                    limit: limit,
                    has_more: response.has_more,
                    buffer_size: response.buffer_size,
                    metadata: response.metadata,
                    data: buffer,
                    pagination: response.has_more ? {
                        next_offset: offset + limit,
                        suggestion: `Use offset=${offset + limit} and limit=${limit} to get next page`
                    } : null
                }, null, 2);
            }
            
            return {
                content: [{
                    type: 'text',
                    text: text,
                }],
            };
        } catch (error: any) {
            let errorMessage = `Error reading buffer from ${port}: ${error.message}\n\n`;
            
            if (error.message.includes('not open')) {
                errorMessage += '**Suggestions:**\n';
                errorMessage += '1. Use `serial_terminal_list_terminals` to see available ports\n';
                errorMessage += '2. Open the port in VS Code first\n';
                errorMessage += '3. Check if the port name is correct';
            } else if (error.message.includes('IPC request failed')) {
                errorMessage += '**Suggestions:**\n';
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
