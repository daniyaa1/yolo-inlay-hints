import * as vscode from 'vscode';
import * as path from 'path';

class YoloInlayHintProvider implements vscode.InlayHintsProvider, vscode.DefinitionProvider {

    private _onDidChangeInlayHints = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this._onDidChangeInlayHints.event;
    private classCache: Map<string, string[]> = new Map();

    refresh(): void {
        this.classCache.clear();
        this._onDidChangeInlayHints.fire();
    }

    // Logic to find the mapping file based on user configuration
    private async findClassesFile(documentUri: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.Uri | null> {
        const config = vscode.workspace.getConfiguration('yoloInlayHints');
        const fileName = config.get<string>('mappingFileName') || 'classes.txt';
        
        let currentDir = vscode.Uri.joinPath(documentUri, '..');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        const rootUri = workspaceFolder?.uri;

        while (true) {
            if (token.isCancellationRequested) return null;
            const potentialUri = vscode.Uri.joinPath(currentDir, fileName);
            try {
                await vscode.workspace.fs.stat(potentialUri);
                return potentialUri;
            } catch {
                const parentDir = vscode.Uri.joinPath(currentDir, '..');
                if (parentDir.toString() === currentDir.toString() || (rootUri && !currentDir.toString().startsWith(rootUri.toString()))) break;
                currentDir = parentDir;
            }
        }

        const files = await vscode.workspace.findFiles(`**/${fileName}`, null, 1, token);
        return files.length > 0 ? files[0] : null;
    }

    private async getClassNames(fileUri: vscode.Uri): Promise<string[]> {
        const cacheKey = fileUri.toString();
        if (this.classCache.has(cacheKey)) return this.classCache.get(cacheKey)!;
        try {
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const content = Buffer.from(fileData).toString('utf8');
            const names = content.split(/\r?\n/).filter(line => line.trim() !== "");
            this.classCache.set(cacheKey, names);
            return names;
        } catch { return []; }
    }

    private isYoloFile(document: vscode.TextDocument): boolean {
        const lineCount = Math.min(document.lineCount, 3);
        const yoloRegex = /^\d+\s+\d+\.?\d*\s+\d+\.?\d*\s+\d+\.?\d*\s+\d+\.?\d*/;
        for (let i = 0; i < lineCount; i++) {
            const text = document.lineAt(i).text.trim();
            if (text.length > 0 && yoloRegex.test(text)) return true;
        }
        return false;
    }

    // FEATURE: Jump-to-Definition (Cmd+Click on ID to open classes.txt at that line)
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | null> {
        if (!this.isYoloFile(document)) return null;
        const line = document.lineAt(position.line);
        const match = /^(\d+)/.exec(line.text);
        if (!match) return null;

        const classesUri = await this.findClassesFile(document.uri, token);
        if (!classesUri) return null;

        const classId = parseInt(match[1]);
        return new vscode.Location(classesUri, new vscode.Position(classId, 0));
    }

    async provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.InlayHint[]> {
        const config = vscode.workspace.getConfiguration('yoloInlayHints');
        if (!config.get('enabled') || !this.isYoloFile(document)) return [];

        try {
            const classesUri = await this.findClassesFile(document.uri, token);
            if (!classesUri || token.isCancellationRequested) return [];

            const classNames = await this.getClassNames(classesUri);
            const regex = /^(\d+)(?=\s)/;
            const hints: vscode.InlayHint[] = [];

            for (let i = range.start.line; i <= range.end.line; i++) {
                if (token.isCancellationRequested) return [];
                const line = document.lineAt(i);
                const match = regex.exec(line.text);

                if (match) {
                    const classId = parseInt(match[1]);
                    const className = classNames[classId];
                    const pos = new vscode.Position(i, match[1].length);

                    if (className) {
                        const hint = new vscode.InlayHint(pos, ` [${className}]`);
                        const tooltip = new vscode.MarkdownString('', true);
                        tooltip.isTrusted = true;
                        const openCommand = vscode.Uri.parse(`command:vscode.open?${encodeURIComponent(JSON.stringify([classesUri]))}`);
                        
                        tooltip.appendMarkdown(`### 🏷️ YOLO Class Metadata\n---\n`);
                        tooltip.appendMarkdown(`- **ID:** \`${classId}\` | **Label:** **${className}**\n`);
                        tooltip.appendMarkdown(`- **Source:** [${path.basename(classesUri.fsPath)}](${openCommand})\n---\n`);
                        tooltip.appendMarkdown(`*Cmd+Click ID to jump to definition*`);
                        
                        hint.tooltip = tooltip;
                        hint.kind = vscode.InlayHintKind.Parameter;
                        hints.push(hint);
                    } 
                    // UPDATED: Now respects the 'showUnlabeledWarning' setting
                    else if (config.get('showUnlabeledWarning')) {
                        const hint = new vscode.InlayHint(pos, ` [ID: ${classId} - Unlabeled]`);
                        const warnTooltip = new vscode.MarkdownString();
                        warnTooltip.appendMarkdown(`### ⚠️ Warning: Missing Label\n`);
                        warnTooltip.appendMarkdown(`---\n`);
                        warnTooltip.appendMarkdown(`ID \`${classId}\` is not defined in **${path.basename(classesUri.fsPath)}**.`);
                        
                        hint.tooltip = warnTooltip;
                        hint.kind = vscode.InlayHintKind.Type;
                        hints.push(hint);
                    }
                }
            }
            return hints;
        } catch { return []; }
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new YoloInlayHintProvider();
    
    // Logic to create watcher based on current config
    let mappingFile = vscode.workspace.getConfiguration('yoloInlayHints').get<string>('mappingFileName') || 'classes.txt';
    let watcher = vscode.workspace.createFileSystemWatcher(`**/${mappingFile}`);
    
    const setupWatcher = (w: vscode.FileSystemWatcher) => {
        w.onDidChange(() => provider.refresh());
        w.onDidCreate(() => provider.refresh());
        w.onDidDelete(() => provider.refresh());
    };
    setupWatcher(watcher);

    const selector: vscode.DocumentSelector = { scheme: 'file' };
    context.subscriptions.push(
        watcher,
        vscode.languages.registerInlayHintsProvider(selector, provider),
        vscode.languages.registerDefinitionProvider(selector, provider)
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('yoloInlayHints')) {
                // If the mapping filename changed, recreate the watcher
                if (e.affectsConfiguration('yoloInlayHints.mappingFileName')) {
                    watcher.dispose();
                    mappingFile = vscode.workspace.getConfiguration('yoloInlayHints').get<string>('mappingFileName') || 'classes.txt';
                    watcher = vscode.workspace.createFileSystemWatcher(`**/${mappingFile}`);
                    setupWatcher(watcher);
                    context.subscriptions.push(watcher);
                }
                provider.refresh(); 
            }
        })
    );
}

export function deactivate() {}