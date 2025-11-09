import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerContextCallback } from './contextManager';
import { registerSerialPortView } from './serialPortView';
import { registerLogView } from './logView';
import { registerScriptView } from './scriptView';
import { registerReadOnlyDocument } from './readOnlyDcoument';
import { registerSerialPortTerminalProfile } from './SerialTerminalProfileProvider';
import { restoreSerialTerminals } from './serialPortTerminalManager';
import { registerMcpProvider } from './mcpProvider';
import { ipcServer } from './ipcServer';
import * as fs from 'fs';
import * as path from 'path';

export var extensionContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	registerCommands(context);
	registerSerialPortView(context);
	registerLogView(context);
	registerScriptView(context);
	registerContextCallback(context);
	registerReadOnlyDocument(context);
	registerSerialPortTerminalProfile(context);
	
	// Start IPC server for MCP communication
	try {
		const port = await ipcServer.start();
		console.log(`Serial Terminal IPC server started on port ${port}`);
		
		// Save port to a file that MCP server can read
		const portFile = path.join(context.globalStorageUri.fsPath, 'ipc-port.txt');
		await fs.promises.mkdir(path.dirname(portFile), { recursive: true });
		await fs.promises.writeFile(portFile, port.toString(), 'utf-8');
		console.log(`IPC port saved to ${portFile}`);
		
		context.subscriptions.push({
			dispose: () => {
				ipcServer.stop();
				// Clean up port file
				try {
					fs.unlinkSync(portFile);
				} catch (err) {
					// Ignore errors during cleanup
				}
			}
		});
	} catch (error) {
		console.error('Failed to start IPC server:', error);
	}
	
	// Register MCP server for AI assistant integration (VS Code 1.105+)
	const mcpDisposable = registerMcpProvider(context);
	if (mcpDisposable) {
		context.subscriptions.push(mcpDisposable);
	}
	
	// Restore previously opened serial terminals
	restoreSerialTerminals(context);
}

export function deactivate() { }
