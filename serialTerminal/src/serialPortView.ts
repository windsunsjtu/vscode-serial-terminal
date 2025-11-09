import * as vscode from "vscode";
import { getConfigurations, configurationsReg, configurationsSettingId, getRecentConfiguration, setRecentConfiguration } from "./settingManager";
import { Event, ProviderResult, ThemeIcon, TreeDataProvider, TreeItem, l10n } from "vscode";
import { listSerialPort, serialPortInfo2String } from "./serialPortTerminal";

let extensionContext: vscode.ExtensionContext;

function registerSerialPortView(context: vscode.ExtensionContext) {
    extensionContext = context;
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("serialport.serialportView", serialPortProvider)
    );
}

const serialPortProvider = new (class implements TreeDataProvider<TreeItem> {
    updateEmitter = new vscode.EventEmitter<void>();
    onDidChangeTreeData: Event<void | TreeItem | TreeItem[] | null | undefined> | undefined = this.updateEmitter.event;
    update() {
        this.updateEmitter.fire();
    }

    getTreeItem(element: TreeItem): TreeItem | Thenable<TreeItem> {
        return element;
    }
    getChildren(element?: TreeItem | undefined): ProviderResult<TreeItem[]> {
        return new Promise((resolve, reject) => {
            // Use serialport module to get available serial ports
            listSerialPort()
                .then((ports) => {
                    const treeItem = ports.map((port) => {
                        return {
                            label: port.path,
                            description: (port as any).friendlyName || port.manufacturer,
                            tooltip: serialPortInfo2String(port),
                            iconPath: new ThemeIcon("plug"),
                        };
                    });
                    resolve(treeItem);
                })
                .catch((error) => {
                    reject(error);
                });
        });
    }
})();


interface CommandQuickPickItem extends vscode.QuickPickItem {
    label: string;
    kind?: vscode.QuickPickItemKind | undefined;
    description?: string | undefined;
    detail?: string | undefined;
    picked?: boolean | undefined;
    alwaysShow?: boolean | undefined;
    buttons?: readonly vscode.QuickInputButton[] | undefined;
    command?: vscode.Command;
}

function updateSerialPortProvider() {
    serialPortProvider.update();
}

async function pickSerialPort(): Promise<string | undefined> {
    const serialPortItems: Thenable<vscode.QuickPickItem[]> = new Promise((resolve, reject) => {
        listSerialPort().then((ports) => {
            const portItems: vscode.QuickPickItem[] = ports.map((port) => {
                return { label: port.path, description: port.manufacturer };
            });
            resolve(portItems);
        }).catch((error) => {
            reject(error);
        });
    });

    let port = await vscode.window.showQuickPick(serialPortItems, { placeHolder: l10n.t("please select a serial port") });
    return port ? port.label : undefined;
}

interface SerialPortConfiguration {
    baudrate: number,
    parity: 'none' | 'even' | 'odd' | undefined,
    dataBits: 5 | 6 | 7 | 8 | undefined,
    stopBits: 1 | 1.5 | 2 | undefined,
}

async function pickConfiguration(): Promise<
    SerialPortConfiguration | undefined> {
    let selection = await vscode.window.showQuickPick(serialPortConfigurations(), { placeHolder: l10n.t("please select a options") });
    if (selection?.command) {
        if (selection.command.arguments) {
            vscode.commands.executeCommand(selection.command.command, ...(selection.command.arguments));
        } else {
            vscode.commands.executeCommand(selection.command.command);
        }

        return;
    }

    let matches = selection?.label.match(configurationsReg);
    if (matches && selection) {
        // Save recently used configuration
        if (extensionContext) {
            setRecentConfiguration(extensionContext, selection.label);
        }
        const [, baudrateStr, parityStr, dataBitsStr, stopBitsStr] = matches;
        let baudrate: number;
        let parity: 'none' | 'even' | 'odd' | undefined;
        let dataBits: 5 | 6 | 7 | 8 | undefined;
        let stopBits: 1 | 1.5 | 2 | undefined;

        baudrate = parseInt(baudrateStr);
        switch (parityStr) {
            case 'n':
                parity = 'none';
                break;
            case 'e':
                parity = 'even';
                break;
            case 'o':
                parity = 'odd';
                break;
            default:
                parity = undefined;
                break;
        }
        switch (parseInt(dataBitsStr)) {
            case 5:
                dataBits = 5;
                break;
            case 6:
                dataBits = 6;
                break;
            case 7:
                dataBits = 7;
                break;
            case 8:
                dataBits = 8;
                break;
            default:
                dataBits = undefined;
                break;
        }
        switch (parseFloat(stopBitsStr)) {
            case 1:
                stopBits = 1;
                break;
            case 1.5:
                break;
            case 2:
                break;
            default:
                break;
        }
        return {
            baudrate: baudrate,
            parity: parity,
            dataBits: dataBits,
            stopBits: stopBits,
        };
    }
}

function serialPortConfigurations(): Thenable<CommandQuickPickItem[]> {
    return new Promise((resolve, reject) => {
        const configs = getConfigurations();
        const recentConfig = extensionContext ? getRecentConfiguration(extensionContext) : undefined;
        
        // Put recently used configuration first
        const sortedConfigs = [...configs];
        if (recentConfig && configs.includes(recentConfig)) {
            const index = sortedConfigs.indexOf(recentConfig);
            sortedConfigs.splice(index, 1);
            sortedConfigs.unshift(recentConfig);
        }
        
        const items: CommandQuickPickItem[] = sortedConfigs.map((value, index) => { 
            return { 
                label: value,
                description: index === 0 && value === recentConfig ? l10n.t("Recently used") : undefined
            }; 
        });

        let separator: CommandQuickPickItem[] = [{
            label: "",
            kind: vscode.QuickPickItemKind.Separator,
        },
        {
            label: `$(add) ${l10n.t("Adding a new serial port configuration")}`,
            command: {
                title: "add",
                command: "workbench.action.openSettings",
                arguments: [
                    configurationsSettingId
                ]
            }
        },
        ];

        items.push(...separator);
        resolve(items);
    });
}

export {
    SerialPortConfiguration,
    pickConfiguration,
    pickSerialPort,
    registerSerialPortView,
    updateSerialPortProvider,
};