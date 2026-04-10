---
name: vscode-extension-cli
description: Manage VS Code extensions from the command line on Windows — install, uninstall, package, or verify VSIX files. Use this skill whenever you need to install or uninstall a VS Code extension, build a VSIX package, verify an extension was installed correctly, or troubleshoot why a CLI extension command produced no output or opened a new window instead of running. The most common pitfall on Windows is using `code` (opens a new window) instead of the full path to `code.cmd` (runs CLI commands). Always use this skill for any VS Code extension install/uninstall/package operation on Windows.
---

# VS Code Extension CLI (Windows)

## Critical: Use `code.cmd`, NOT `code`

On Windows, typing `code` in a terminal opens a **new VS Code window** and does nothing else — it does NOT run CLI commands. Even if `code` is in your PATH, it resolves to the GUI launcher.

Always use the full path:

```powershell
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
```

If the command produces **no output**, that is the symptom of using `code` instead of `code.cmd`.

---

## Common Operations

### Install a VSIX

```powershell
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
& $codePath --install-extension "D:\path\to\extension.vsix" --force
```

Expected output:
```
Installing extensions...
Extension 'extension.vsix' was successfully installed.
```

### Uninstall an Extension

```powershell
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
& $codePath --uninstall-extension publisher.extensionname
```

Expected output:
```
Uninstalling publisher.extensionname...
Extension 'publisher.extensionname' was successfully uninstalled!
```

### Uninstall then Re-install (sequential, not chained)

Run as two **separate** commands. Do NOT chain with `;` — run uninstall first, wait for confirmation, then install:

```powershell
$codePath = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
& $codePath --uninstall-extension publisher.extensionname
# Wait for "successfully uninstalled!" before continuing
& $codePath --install-extension "D:\path\to\extension.vsix" --force
```

### Package a VSIX (in the extension directory)

```powershell
cd D:\path\to\extension
vsce package --out ./out/ --no-dependencies
```

- `--no-dependencies`: skips bundling node_modules, much faster for development builds
- Output: `./out/extensionname-x.y.z.vsix`

---

## Verify Installation Succeeded

After installing, confirm the extension directory was updated:

```powershell
$extDir = "$env:USERPROFILE\.vscode\extensions"
Get-ChildItem $extDir | Where-Object { $_.Name -like "publisher.extensionname*" } | Select-Object Name, LastWriteTime
```

The `LastWriteTime` should match the current time. If it shows an old date, the install did not apply.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Command produces no output | Used `code` instead of `code.cmd` | Use full `code.cmd` path |
| New VS Code window opens | Same as above | Same fix |
| Extension still behaves like old version | VS Code window not reloaded after install | Ctrl+Shift+P → "Reload Window" |
| `vsce: command not found` | vsce not installed globally | `npm install -g @vscode/vsce` |
| Install says already installed, no update | Missing `--force` flag | Add `--force` |

---

## After Reinstallation

Always reload the VS Code window for the new extension code to take effect:

**Ctrl+Shift+P** → type `Reload Window` → Enter

For MCP server changes specifically, also run any "Refresh MCP Provider" command the extension exposes, since VS Code caches MCP tool definitions.
