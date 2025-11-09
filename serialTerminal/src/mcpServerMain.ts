#!/usr/bin/env node

/**
 * MCP Server Entry Point
 * 
 * This file is the entry point for the MCP server when launched as a standalone process.
 * It's designed to be called by MCP clients (like Claude Desktop) with stdio transport.
 * 
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "serial-terminal": {
 *       "command": "node",
 *       "args": ["path/to/mcpServerMain.js"]
 *     }
 *   }
 * }
 */

import { SerialTerminalMcpServer } from './mcpServer.js';

async function main() {
    const server = new SerialTerminalMcpServer();
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.error('Received SIGINT, shutting down...');
        await server.close();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.error('Received SIGTERM, shutting down...');
        await server.close();
        process.exit(0);
    });

    try {
        await server.run();
    } catch (error) {
        console.error('Fatal error in MCP server:', error);
        process.exit(1);
    }
}

main();
