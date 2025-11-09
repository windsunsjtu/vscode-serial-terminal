import * as vscode from 'vscode';
import * as path from 'path';

/**
 * MCP Server Definition Provider
 * 
 * This provides the serial terminal MCP server to VS Code's built-in MCP infrastructure (1.105+).
 * VS Code will automatically manage the server lifecycle and make it available to
 * AI assistants like GitHub Copilot.
 */
export class SerialTerminalMcpProvider {
    private _onDidChangeMcpServerDefinitions = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChangeMcpServerDefinitions.event;

    constructor(private context: vscode.ExtensionContext) {}

    provideMcpServerDefinitions(
        _token: vscode.CancellationToken
    ): any[] {
        // Path to the compiled MCP server entry point
        const serverPath = path.join(this.context.extensionPath, 'out', 'mcpServerMain.js');

        // Create the server definition using the proposed API
        // Note: This requires VS Code 1.105+ with MCP support
        const McpStdioServerDefinition = (vscode as any).McpStdioServerDefinition;
        
        if (!McpStdioServerDefinition) {
            console.warn('MCP API not available. Please upgrade to VS Code 1.105 or later.');
            return [];
        }

        const server = new McpStdioServerDefinition(
            'Serial Terminal',           // Human-readable label
            process.execPath,             // Node.js executable (same as VS Code)
            [serverPath],                 // Args: path to our MCP server script
            {},                           // Environment variables (none needed)
            '0.1.0'                       // Version
        );

        return [server];
    }

    resolveMcpServerDefinition(
        server: any,
        _token: vscode.CancellationToken
    ): any {
        // No additional resolution needed, return as-is
        return server;
    }

    /**
     * Call this method when the availability of MCP servers changes
     * (e.g., when extension is installed/updated)
     */
    refresh() {
        this._onDidChangeMcpServerDefinitions.fire();
    }
}

/**
 * Register the MCP server provider with VS Code
 */
export function registerMcpProvider(context: vscode.ExtensionContext): vscode.Disposable | undefined {
    // Check if MCP API is available (VS Code 1.105+)
    const lm = (vscode as any).lm;
    if (!lm || !lm.registerMcpServerDefinitionProvider) {
        console.log('MCP API not available (requires VS Code 1.105+). Skipping MCP server registration.');
        console.log('For external MCP clients, you can still use the standalone server with mcpServerMain.js');
        return undefined;
    }

    const provider = new SerialTerminalMcpProvider(context);
    
    try {
        // Register the provider with VS Code's MCP infrastructure
        const disposable = lm.registerMcpServerDefinitionProvider(
            'serial-terminal.mcp-servers',  // Must match package.json contribution point
            provider
        );

        console.log('Serial Terminal MCP server registered successfully with VS Code built-in MCP.');
        return disposable;
    } catch (error) {
        console.error('Failed to register MCP server provider:', error);
        return undefined;
    }
}
