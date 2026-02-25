import { PseudoTerminal } from "./PseudoTerminal";
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import * as colors from 'colors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SerialPort } from "serialport";
import { StringDecoder } from 'string_decoder';
import { EventEmitter } from 'events';
import { getLogDefaultAddingTimeStamp, getLogDirUri, getMcpBufferSize } from "./settingManager";
import { SerialPortConfiguration, pickConfiguration, pickSerialPort } from "./serialPortView";
import { execSync } from 'child_process';

const terminalNamePrefix = "PORT: ";

function isSerialPortTerminal(terminalName: String): boolean {
    return terminalName.match(`^${terminalNamePrefix}.*`) ? true : false;
}

/**
 * Check if a port is using CDC (Communications Device Class) default Windows driver
 * These devices typically show as "USB 串行设备" or "USB Serial Device" with generic info
 */
function isCDCDevice(port: import("@serialport/bindings-cpp").PortInfo): boolean {
    const portAny = port as any;
    
    // Must be a USB device (not Bluetooth, ACPI, etc.)
    const pnpId = portAny.pnpId?.toUpperCase() || '';
    if (!pnpId.startsWith('USB\\')) {
        return false;
    }
    
    // Exclude Bluetooth devices explicitly
    if (pnpId.startsWith('BTHENUM\\')) {
        return false;
    }
    
    // Check if friendlyName indicates CDC default driver (must contain "USB")
    const friendlyName = portAny.friendlyName?.toLowerCase() || '';
    const hasGenericUsbName = 
        (friendlyName.includes('usb') && friendlyName.includes('串行')) ||
        friendlyName.includes('usb serial device') ||
        friendlyName.includes('usb serial port');
    
    if (hasGenericUsbName) {
        return true;
    }
    
    // Check if manufacturer is empty or generic Microsoft (only for USB devices)
    const manufacturer = port.manufacturer?.toLowerCase() || '';
    if (!manufacturer || manufacturer === 'microsoft') {
        // Additional check: must have USB VID/PID to be considered CDC
        if (portAny.vendorId && portAny.productId) {
            return true;
        }
    }
    
    return false;
}

/**
 * Batch get Bus Reported Device Descriptions for multiple devices
 * Much faster than querying one by one (single PowerShell startup)
 */
async function getBusReportedDeviceDescBatch(pnpIds: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    
    if (pnpIds.length === 0 || process.platform !== 'win32') {
        return result;
    }

    let tempFile: string | null = null;
    
    try {
        // Create a temporary PowerShell script file
        tempFile = path.join(os.tmpdir(), `serial-terminal-${Date.now()}.ps1`);
        
        // Build PowerShell script content
        const scriptLines: string[] = [];
        pnpIds.forEach((pnpId, index) => {
            const escapedId = pnpId.replace(/'/g, "''");
            scriptLines.push(`try {`);
            scriptLines.push(`  $d = Get-PnpDeviceProperty -InstanceId '${escapedId}' -KeyName DEVPKEY_Device_BusReportedDeviceDesc -ErrorAction Stop`);
            scriptLines.push(`  if ($d -and $d.Data) { Write-Output "${index}|||$($d.Data)" }`);
            scriptLines.push(`} catch {}`);
        });
        
        fs.writeFileSync(tempFile, scriptLines.join('\n'), { encoding: 'utf8' });
        
        console.log(`[Serial Terminal] Batch querying ${pnpIds.length} CDC devices...`);
        
        const output = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, {
            encoding: 'utf8',
            timeout: 10000,
            windowsHide: true
        }).trim();

        // Parse results: format is "index|||description"
        if (output) {
            const lines = output.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                const match = trimmed.match(/^(\d+)\|\|\|(.+)$/);
                if (match) {
                    const index = parseInt(match[1]);
                    const desc = match[2].trim();
                    if (desc && pnpIds[index]) {
                        result.set(pnpIds[index], desc);
                        console.log(`[Serial Terminal] Found: ${pnpIds[index]} -> ${desc}`);
                    }
                }
            }
        }
        
        console.log(`[Serial Terminal] Batch query completed: ${result.size}/${pnpIds.length} devices found`);
    } catch (error) {
        console.error(`[Serial Terminal] Batch query error:`, error);
    } finally {
        // Clean up temp file
        if (tempFile && fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    }

    return result;
}

/**
 * Enhanced port info with Bus Reported Device Description
 */
type BasePortInfo = import("@serialport/bindings-cpp").PortInfo;

interface EnhancedPortInfo extends BasePortInfo {
    busReportedDeviceDesc?: string;
}

async function listSerialPort(): Promise<EnhancedPortInfo[]> {
    const ports = await SerialPort.list();
    
    // On Windows, batch query Bus Reported Device Description for CDC devices
    if (process.platform === 'win32') {
        // First, identify CDC devices and collect their PnpIds
        const cdcDevices = ports.filter(port => isCDCDevice(port));
        const pnpIds = cdcDevices
            .map(port => (port as any).pnpId)
            .filter(id => id);  // Remove undefined/null values
        
        // Batch query all CDC devices at once (much faster!)
        const busDescMap = await getBusReportedDeviceDescBatch(pnpIds);
        
        // Merge results
        const enhancedPorts = ports.map(port => {
            const portAny = port as any;
            if (isCDCDevice(port) && portAny.pnpId && busDescMap.has(portAny.pnpId)) {
                return {
                    ...port,
                    busReportedDeviceDesc: busDescMap.get(portAny.pnpId)
                } as EnhancedPortInfo;
            }
            return port as EnhancedPortInfo;
        });
        
        return enhancedPorts;
    }
    
    return ports as EnhancedPortInfo[];
}

function serialPortInfo2String(portInfo: EnhancedPortInfo): string {
    let info = new Map<string, string>();
    let portInfoAny = portInfo as any;

    if (portInfoAny.busReportedDeviceDesc) { info.set("BusReportedDeviceDesc", portInfoAny.busReportedDeviceDesc); }
    if (portInfoAny.friendlyName) { info.set("Name", portInfoAny.friendlyName); }
    if (portInfoAny.path) { info.set("Path", portInfoAny.path); }
    if (portInfoAny.manufacturer) { info.set("Manufacturer", portInfoAny.manufacturer); }
    if (portInfoAny.vendorId) { info.set("VendorId", portInfoAny.vendorId); }
    if (portInfoAny.productId) { info.set("ProductId", portInfoAny.productId); }
    if (portInfoAny.serialNumber) { info.set("SerialNumber", portInfoAny.serialNumber); }
    if (portInfoAny.pnpId) { info.set("PnpId", portInfoAny.pnpId); }
    if (portInfoAny.locationId) { info.set("LocationId", portInfoAny.locationId); }

    let maxWidth = 0;
    info.forEach((_, key) => {
        maxWidth = Math.max(key.length, maxWidth);
    });

    let infoString = "";
    info.forEach((value, key) => {
        infoString += `${l10n.t(key)}: ${value}\n`;
    });


    return infoString;
}

interface ISerialPortTerminal {
    readonly state: { loging: boolean; timeStamp: boolean; hex: boolean; };
    readonly serialport: SerialPort;
    readonly terminal: PseudoTerminal;
    open(): void;
    startLogging(timeStamp?: boolean): Promise<boolean>;
    stopLogging(): boolean;
    setCloseCallback(callback?: () => void): void;
    onData(callback: (data: string) => void): () => void;
    sendData(data: string): boolean;
    getRecentData(lines: number, offset?: number): string[];
    getBufferInfo(): { totalLines: number; maxBufferLines: number; };
}

class SerialPortTerminal implements ISerialPortTerminal {
    private decoder: StringDecoder;
    private logDecoder: StringDecoder;
    private waitingForReconnect: boolean = false;
    private portPath: string;
    private portConfig!: SerialPortConfiguration;
    private dataEmitter: EventEmitter;
    private dataBuffer: string[] = [];
    private readonly maxBufferLines: number;

    private constructor(serialPort: SerialPort, pseudo: boolean = false) {
        this.maxBufferLines = getMcpBufferSize();
        this.state = {
            loging: false,
            timeStamp: getLogDefaultAddingTimeStamp(),
            hex: false,
        };
        this.serialport = serialPort;
        this.portPath = serialPort.path;
        this.decoder = new StringDecoder('utf8');
        this.logDecoder = new StringDecoder('utf8');
        this.dataEmitter = new EventEmitter();
        let opts = pseudo ? { create: false } : undefined;
        this.terminal = new PseudoTerminal(terminalNamePrefix + serialPort.path, opts);
        this.init();
    }

    private init() {
        this.terminal.setOnInput((data) => {
            if (this.waitingForReconnect) {
                if (data.toLowerCase() === 'r') {
                    this.reconnect();
                } else if (data.toLowerCase() === 'q') {
                    this.terminal.close();
                }
                return;
            }
            this.serialport.write(data);
        });
        this.terminal.setOnOpen(() => {
            this.terminal.write(this.serialport.isOpen ?
                colors.green.bold(l10n.t('({0}) CONNECTED', this.serialport.path) + '\r\n\r\n')
                : colors.red.bold(l10n.t('({0}) OPEN FAILED!', this.serialport.path) + '\r\n\r\n'));
        });
        this.terminal.setOnClose(() => {
            this.serialport.close();
            if (this.closeCallback) { this.closeCallback(); };
        });

        this.serialport.addListener("data", (data: Buffer) => {
            const text = this.decoder.write(data);
            
            // 1. Send to terminal (existing functionality)
            this.terminal.write(text);
            
            // 2. Broadcast to MCP listeners
            this.dataEmitter.emit('data', text);
            
            // 3. Store in buffer for MCP access
            this.dataBuffer.push(...text.split('\n'));
            if (this.dataBuffer.length > this.maxBufferLines) {
                this.dataBuffer = this.dataBuffer.slice(-this.maxBufferLines);
            }
        });

        this.serialport.on("close", () => {
            this.terminal.write(colors.red.bold(
                "\n" + l10n.t("({0}) CLOSED!", this.serialport.path) + '\r\n\r\n'));
            this.terminal.write(colors.yellow(
                l10n.t("Press 'r' to reconnect or 'q' to close terminal") + '\r\n'));
            this.waitingForReconnect = true;
        }
        );
    }

    static async new(portPath: string, cfg: SerialPortConfiguration): Promise<ISerialPortTerminal> {
        return new Promise<SerialPortTerminal>((resolve, reject) => {
            let serialPort: SerialPort;
            let openCallBack = () => {
                const terminal = new SerialPortTerminal(serialPort);
                terminal.portConfig = cfg;
                resolve(terminal);
            };

            /* bug: If dataBits is assigned to undefined, opening the serial port fails, so... */
            if (cfg.dataBits) {
                serialPort = new SerialPort({
                    path: portPath,
                    baudRate: cfg.baudrate,
                    parity: cfg.parity,
                    dataBits: cfg.dataBits,
                    stopBits: cfg.stopBits,
                }, openCallBack);
            } else {
                serialPort = new SerialPort({
                    path: portPath,
                    baudRate: cfg.baudrate,
                    parity: cfg.parity,
                    stopBits: cfg.stopBits,
                }, openCallBack);
            }
        });
    }

    static async newOpt(): Promise<ISerialPortTerminal> {
        return new Promise<ISerialPortTerminal>(async (resolve, reject) => {
            const portPath = await pickSerialPort();
            if (!portPath) { reject(); return; }
            const cfg = await pickConfiguration();
            if (!cfg) { reject(); return; }
            let serialPort: SerialPort;
            let openCallBack = () => {
                const serialPortTerminal = new SerialPortTerminal(serialPort, true);
                serialPortTerminal.portConfig = cfg;
                if (serialPortTerminal.terminal.options) { resolve(serialPortTerminal); }
                else { reject(); }
            };

            /* bug: If dataBits is assigned to undefined, opening the serial port fails, so... */
            if (cfg.dataBits) {
                serialPort = new SerialPort({
                    path: portPath,
                    baudRate: cfg.baudrate,
                    parity: cfg.parity,
                    dataBits: cfg.dataBits,
                    stopBits: cfg.stopBits,
                }, openCallBack);
            } else {
                serialPort = new SerialPort({
                    path: portPath,
                    baudRate: cfg.baudrate,
                    parity: cfg.parity,
                    stopBits: cfg.stopBits,
                }, openCallBack);
            }
        });
    }

    setCloseCallback(callback?: () => void): void { this.closeCallback = callback; }

    state: { loging: boolean; timeStamp: boolean; hex: boolean; };

    open(): void {
        if (this.serialport.isOpen) { return; }
        this.serialport.open(() => {
            this.terminal.write(this.serialport.isOpen ?
                colors.green.bold(l10n.t('({0}) CONNECTED', this.serialport.path) + '\r\n\r\n')
                : colors.red.bold(l10n.t('({0}) OPEN FAILED!', this.serialport.path) + '\r\n\r\n'));
        });
    }

    private reconnect(): void {
        this.waitingForReconnect = false;
        this.terminal.write(colors.cyan(l10n.t('Reconnecting...') + '\r\n'));
        
        this.serialport.open((error) => {
            if (error) {
                this.terminal.write(colors.red.bold(
                    l10n.t('({0}) RECONNECTION FAILED: {1}', this.serialport.path, error.message) + '\r\n\r\n'));
                this.terminal.write(colors.yellow(
                    l10n.t("Press 'r' to reconnect or 'q' to close terminal") + '\r\n'));
                this.waitingForReconnect = true;
            } else {
                this.terminal.write(colors.green.bold(
                    l10n.t('({0}) RECONNECTED', this.serialport.path) + '\r\n\r\n'));
            }
        });
    }

    private getTime() {
        return new Date().toLocaleString('zh', {
            year: '2-digit',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    private getTimeStamp(): string { return `[${this.getTime()}] `; }

    private async getLogUri(): Promise<vscode.Uri | undefined> {
        let fileName = await vscode.window.showInputBox({
            title: l10n.t("Please enter the log file name"),
            value: "general_" + this.getTime().replace(/[\/:]/g, '').replace(/ /g, '_'),
            valueSelection: [0, 7],
            prompt: l10n.t("Only letters, numbers, `_` and `-` are allowed"),
            validateInput: (value: string) => {
                const result = value.match(/^[0-9a-zA-Z_-]*$/g)?.toString();
                return result ? undefined
                    : l10n.t("Only letters, numbers, `_` and `-` are allowed");
            }
        });
        if (fileName) {
            return vscode.Uri.joinPath(getLogDirUri(), fileName + ".log");
        } else { return undefined; }
    }

    private getLogCallBack(logUri: vscode.Uri) {
        fs.writeFileSync(logUri.fsPath, "");
        if (this.state.timeStamp) {
            return (data: Buffer) => {
                const text = this.logDecoder.write(data);
                fs.appendFileSync(
                    logUri.fsPath,
                    text.replace(/\r/g, '')
                        .replace(/\n/g, '\n' + this.getTimeStamp()));
            };
        } else {
            return (data: Buffer) => {
                const text = this.logDecoder.write(data);
                fs.appendFileSync(logUri.fsPath, text.replace(/\r/g, ''));
            };
        }
    }

    async startLogging(timeStamp?: boolean | undefined): Promise<boolean> {
        if (this.state.loging) { return this.state.loging; }
        const logUri = await this.getLogUri();
        if (!logUri) { return this.state.loging; } else {
            this.logUri = logUri;
        }
        if (timeStamp) { this.state.timeStamp = timeStamp; }
        this.logCallBack = this.getLogCallBack(this.logUri);
        this.serialport.addListener("data", this.logCallBack);
        this.state.loging = true;
        return this.state.loging;
    }

    stopLogging(): boolean {
        if (!this.state.loging) { return false; }
        this.serialport.removeListener("data", this.logCallBack);
        vscode.window.showInformationMessage(
            l10n.t("The logs have been saved in {0}", this.logUri.fsPath));
        this.state.loging = false;
        return this.state.loging;
    }

    // MCP Server access methods
    onData(callback: (data: string) => void): () => void {
        this.dataEmitter.on('data', callback);
        return () => this.dataEmitter.off('data', callback);
    }

    sendData(data: string): boolean {
        if (!this.serialport.isOpen || this.waitingForReconnect) {
            return false;
        }
        this.serialport.write(data);
        return true;
    }

    getRecentData(lines: number, offset: number = 0): string[] {
        // offset=0 means get the latest lines
        // offset=50 means skip the latest 50 lines and get the next 'lines' lines
        const totalLines = this.dataBuffer.length;
        const start = Math.max(0, totalLines - offset - lines);
        const end = totalLines - offset;
        return this.dataBuffer.slice(start, end);
    }

    getBufferInfo(): { totalLines: number; maxBufferLines: number; } {
        return {
            totalLines: this.dataBuffer.length,
            maxBufferLines: this.maxBufferLines,
        };
    }

    serialport: SerialPort;
    terminal: PseudoTerminal;

    private logUri: vscode.Uri = vscode.Uri.file("");
    private logCallBack: (data: Buffer) => void = () => { };
    private closeCallback?: () => void;
}

export {
    SerialPortConfiguration,
    ISerialPortTerminal,
    SerialPortTerminal,
    listSerialPort,
    isSerialPortTerminal,
    terminalNamePrefix,
    serialPortInfo2String,
    EnhancedPortInfo
};