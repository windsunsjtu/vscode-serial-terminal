import * as vscode from 'vscode';
import { ISerialPortTerminal, SerialPortConfiguration, SerialPortTerminal, terminalNamePrefix } from './serialPortTerminal';
import { TerminalProfile } from 'vscode';
import { getOpenTerminals, addOpenTerminal, removeOpenTerminal, configurationsReg } from './settingManager';

const serialPortTerminalManager = new (class {
    private serialPortTerminals = new Map<string, ISerialPortTerminal>();
    private extensionContext?: vscode.ExtensionContext;

    setContext(context: vscode.ExtensionContext): void {
        this.extensionContext = context;
    }

    async showSerialPortTerminal(portPath: string, cfg: SerialPortConfiguration, closeCallback?: () => void): Promise<void> {
        var exist = this.getFromPortPath(portPath);
        if (exist) {
            /* Actually, the whole OPTION should be judged here, but the only interface parameter for update is baudrate, so that's it! */
            if (exist.serialport.baudRate !== cfg.baudrate) {
                exist.serialport.update({ baudRate: cfg.baudrate });
            }
            if (!exist.serialport.isOpen) {
                exist.open();
            }
            exist.terminal.show();
        } else {
            var serialPortTerminal = await SerialPortTerminal.new(portPath, cfg);
            serialPortTerminal.setCloseCallback(() => {
                this.remove(serialPortTerminal.terminal.name);
                // Remove from saved terminal list
                if (this.extensionContext) {
                    removeOpenTerminal(this.extensionContext, portPath);
                }
            });
            this.serialPortTerminals.set(serialPortTerminal.terminal.name, serialPortTerminal);
            serialPortTerminal.terminal.show();
            
            // Save to open terminals list
            if (this.extensionContext) {
                const configStr = this.serializeConfig(cfg);
                addOpenTerminal(this.extensionContext, portPath, configStr);
            }
        }
    }

    private serializeConfig(cfg: SerialPortConfiguration): string {
        return `${cfg.baudrate}${cfg.parity === 'none' ? 'n' : cfg.parity === 'even' ? 'e' : cfg.parity === 'odd' ? 'o' : ''}${cfg.dataBits || ''}${cfg.stopBits || ''}`;
    }

    private parseConfig(configStr: string): SerialPortConfiguration | undefined {
        const matches = configStr.match(configurationsReg);
        if (!matches) { return undefined; }
        
        const [, baudrateStr, parityStr, dataBitsStr, stopBitsStr] = matches;
        let parity: 'none' | 'even' | 'odd' | undefined;
        let dataBits: 5 | 6 | 7 | 8 | undefined;
        let stopBits: 1 | 1.5 | 2 | undefined;

        switch (parityStr) {
            case 'n': parity = 'none'; break;
            case 'e': parity = 'even'; break;
            case 'o': parity = 'odd'; break;
            default: parity = undefined; break;
        }
        
        const dataBitsNum = parseInt(dataBitsStr);
        if ([5, 6, 7, 8].includes(dataBitsNum)) {
            dataBits = dataBitsNum as 5 | 6 | 7 | 8;
        }
        
        const stopBitsNum = parseFloat(stopBitsStr);
        if ([1, 1.5, 2].includes(stopBitsNum)) {
            stopBits = stopBitsNum as 1 | 1.5 | 2;
        }

        return {
            baudrate: parseInt(baudrateStr),
            parity,
            dataBits,
            stopBits,
        };
    }

    getSerialPortTerminalProfile(): Promise<TerminalProfile> {
        return new Promise<TerminalProfile>(async (resolve, reject) => {
            const serialPortTerminal = await SerialPortTerminal.newOpt();
            const opts = serialPortTerminal.terminal.options;
            if (opts) {
                this.serialPortTerminals.set(serialPortTerminal.terminal.name, serialPortTerminal);
                serialPortTerminal.setCloseCallback(() => {
                    this.remove(serialPortTerminal.terminal.name);
                });
                resolve(new TerminalProfile(opts));
            } else {
                reject();
            }
        });
    }

    getFromTerminal(terminal: vscode.Terminal): ISerialPortTerminal | undefined {
        return this.serialPortTerminals.get(terminal.name);
    }

    getFromPortPath(portPath: string): ISerialPortTerminal | undefined {
        return this.serialPortTerminals.get(terminalNamePrefix + portPath);
    }

    remove(terminalName: string): boolean {
        return this.serialPortTerminals.delete(terminalName);
    }
})();

async function restoreSerialTerminals(context: vscode.ExtensionContext): Promise<void> {
    serialPortTerminalManager.setContext(context);
    const savedTerminals = getOpenTerminals(context);
    
    if (savedTerminals.length === 0) {
        return;
    }

    // Delay to wait for VS Code to fully start
    setTimeout(async () => {
        for (const saved of savedTerminals) {
            const cfg = serialPortTerminalManager['parseConfig'](saved.configuration);
            if (cfg) {
                try {
                    await serialPortTerminalManager.showSerialPortTerminal(saved.portPath, cfg);
                } catch (error) {
                    console.error(`Failed to restore terminal ${saved.portPath}:`, error);
                }
            }
        }
    }, 1000);
}

export { serialPortTerminalManager, restoreSerialTerminals };