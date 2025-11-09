# serial terminal extension for visual studio code

[HomePage](https://github.com/AWSXXF/vscode-serial-terminal/blob/main/serialTerminal/README.md)

---

This is a simple terminal interaction serial extension for vscode, it is still a simple prototype, I will make it the best serial extension for vscode in the future.

## Tutorials

### open a serial port

![open.gif](https://s2.loli.net/2023/12/24/cF2y9Rpo8ixEQVG.gif)

### add new configuration
![config.gif](https://s2.loli.net/2023/12/24/UR6txaOokhm3nYf.gif)

### start to save the log
![log.gif](https://s2.loli.net/2023/12/24/NA1ldMSxO4qF5m6.gif)

### using the script notebook
![script.gif](https://s2.loli.net/2023/12/24/gsVy3Up4jfPxKE2.gif)

---

## Features

- [x] Interact with the serial port like a terminal

- [x] Save and view the logs

- [x] Configuring a customised open baud rate

- [x] Nice script notebook

- [x] Time stamp

- [x] Add configurable items

- [x] MCP Server for AI assistant integration

- [x] Auto-reconnect support

- [x] Recent configurations prioritization

- [ ] Serial port to send and display hex data

- [ ] Support for X/Y/Zmodem protocols

---

## MCP Server Integration

This extension now includes an **MCP (Model Context Protocol) server** that allows AI assistants like Claude to interact with your serial port terminals.

### Key Features

- **AI-Assisted Debugging**: Let AI analyze serial data and suggest solutions
- **Automated Testing**: AI can send test commands and verify responses
- **Log Analysis**: AI can review and interpret large amounts of serial output
- **Human Control**: Only humans can open/close ports and configure settings

### Quick Start

1. Open a serial port terminal in VS Code (human action)
2. Configure Claude Desktop or other MCP client (see [MCP_README.md](./MCP_README.md))
3. AI can now list terminals, send commands, and read data

For detailed setup instructions and usage examples, see **[MCP_README.md](./MCP_README.md)**
