import * as child_process from "child_process";
import * as fs from "fs";
import * as crypto from "crypto";
import * as net from "net";
import * as path from "path";
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, RevealOutputChannelOn, ServerOptions, StreamInfo } from "vscode-languageclient/node";
import { LOG } from './util/logger';
import { isOSUnixoid, correctScriptName, isOSWindows } from './util/osUtils';
import { ServerDownloader } from './serverDownloader';
import { JarClassContentProvider } from "./jarClassContentProvider";
import { KotlinApi } from "./lspExtensions";
import { fsExists } from "./util/fsUtils";
import { ServerSetupParams } from "./setupParams";
import { RunDebugCodeLens } from "./runDebugCodeLens";
import { MainClassRequest, OverrideMemberRequest } from "./lspExtensions";
import { resolveEffectiveProjectRoot } from "./projectRoot";

/** Downloads and starts the language server. */
export async function activateLanguageServer({ context, status, config, javaInstallation, javaOpts }: ServerSetupParams): Promise<KotlinApi> {
    LOG.info('Activating Kotlin Language Server...');
    status.update("Activating Kotlin Language Server...");
    const activeDocument = vscode.window.activeTextEditor?.document;
    const sourceWorkspaceFolder = activeDocument
        ? vscode.workspace.getWorkspaceFolder(activeDocument.uri) ?? vscode.workspace.workspaceFolders?.[0]
        : vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = sourceWorkspaceFolder?.uri.fsPath;
    const effectiveProjectRoot = workspaceRoot
        ? resolveEffectiveProjectRoot(workspaceRoot, activeDocument?.uri.scheme === "file" ? activeDocument.uri.fsPath : undefined)
        : undefined;
    const effectiveWorkspaceFolder = effectiveProjectRoot && sourceWorkspaceFolder
        ? {
            uri: vscode.Uri.file(effectiveProjectRoot),
            name: path.basename(effectiveProjectRoot),
            index: sourceWorkspaceFolder.index
        }
        : sourceWorkspaceFolder;
    
    // Prepare language server
    const langServerInstallDir = path.join(context.globalStorageUri.fsPath, "langServerInstall");
    const customPath: string = config.get("languageServer.path");
    
    if (!customPath) {
        const langServerDownloader = new ServerDownloader("Kotlin Language Server", "kotlin-language-server", "server.zip", "server", langServerInstallDir);
        
        try {
            await langServerDownloader.downloadServerIfNeeded(status);
        } catch (error) {
            console.error(error);
            vscode.window.showWarningMessage(`Could not update/download Kotlin Language Server: ${error}`);
            return;
        }
    }

    const outputChannel = vscode.window.createOutputChannel("Kotlin Flutter (moatbitX)");
    context.subscriptions.push(outputChannel);
    if (effectiveProjectRoot) {
        outputChannel.appendLine(`[moatbitX] Kotlin project root: ${effectiveProjectRoot}`);
    }
    
    const transportLayer = config.get("languageServer.transport");
    let tcpPort: number | undefined;
    const env: NodeJS.ProcessEnv = { ...process.env };

    if (javaInstallation.javaHome) {
        env['JAVA_HOME'] = javaInstallation.javaHome;
    }

    if (javaOpts) {
        env['JAVA_OPTS'] = javaOpts;
    }

    if (transportLayer == "tcp") {
        tcpPort = config.get("languageServer.port");
        
        LOG.info(`Connecting via TCP, port: ${tcpPort}`);
    } else if (transportLayer == "stdio") {
        LOG.info("Connecting via Stdio.");

        if (config.get("languageServer.debugAttach.enabled")) {
            const autoSuspend = config.get("languageServer.debugAttach.autoSuspend");
            const attachPort = config.get("languageServer.debugAttach.port");
            env['KOTLIN_LANGUAGE_SERVER_OPTS'] = `-Xdebug -agentlib:jdwp=transport=dt_socket,address=${attachPort},server=y,quiet=y,suspend=${autoSuspend ? "y" : "n"}`;
        }
    } else {
        LOG.info(`Unknown transport layer: ${transportLayer}`);
    }

    status.dispose();
    
    const startScriptPath = customPath || path.resolve(langServerInstallDir, "server", "bin", correctScriptName("kotlin-language-server"));

    const projectStorageKey = effectiveProjectRoot
        ? crypto.createHash("sha256").update(effectiveProjectRoot).digest("hex").substring(0, 16)
        : "default";
    const storagePath = path.join(context.storageUri.fsPath, "projects", projectStorageKey);
    if (!(await fsExists(storagePath))) {
        await fs.promises.mkdir(storagePath, { recursive: true });
    }

    const customFileEventsGlobPatterns: string[] = config.get("languageServer.watchFiles")
    const fileEventsGlobPatterns = customFileEventsGlobPatterns || [
        "**/*.kt",
        "**/*.kts",
        "**/*.java",
        "**/pom.xml",
        "**/build.gradle",
        "**/settings.gradle"
    ];

    const options = {
        outputChannel,
        startScriptPath,
        tcpPort,
        env,
        storagePath,
        fileEventsGlobPatterns,
        workspaceFolder: effectiveWorkspaceFolder,
        projectRoot: effectiveProjectRoot
    };
    const languageClient = createLanguageClient(options);

    // Create the language client and start the client.
    const languageClientPromise = languageClient.start();
    
    // Register a content provider for the 'kls' scheme
    const contentProvider = new JarClassContentProvider(languageClient);
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("kls", contentProvider));

    // register override members command
    vscode.commands.registerCommand("kotlin.overrideMember", async() => {
        const activeEditor = vscode.window.activeTextEditor;
        const currentDocument = activeEditor?.document;
        // TODO: seems like we cant interact with the inner edit-fields as if it were a WorkspaceEdit object?? See if there is a way to solve this
        const overrideOptions = await languageClient.sendRequest(OverrideMemberRequest.type, {
            textDocument: {
                uri: currentDocument.uri.toString()
            },
            position: activeEditor?.selection.start
        });

        // show an error message if nothing is found
        if(0 == overrideOptions.length) {
            vscode.window.showWarningMessage("No overrides found for class");
            return;
        }
        
        const selected = await vscode.window.showQuickPick(overrideOptions.map(elem => ({
            label: elem.title,
            data: elem.edit.changes[currentDocument.uri.toString()]
        })), {
            canPickMany: true,
            placeHolder: 'Select overrides'
        });

        // TODO: find out why we can't use vscode.workspace.applyEdit directly with the results. Probably related to the issue mentioned above
        // we know all the edits are in the current document, and that each one only contain one edit, so this hack works
        activeEditor.edit(editBuilder => {
            selected.forEach(elem => {
                const textEdit = elem.data[0];
                editBuilder.insert(textEdit.range.start, textEdit.newText);
            });
        });
    });

    // Activating run/debug code lens if the debug adapter is enabled
    // and we are using 'kotlin-language-server' (other language servers
    // might not support the non-standard 'kotlin/mainClass' request)
    const debugAdapterEnabled = config.get("debugAdapter.enabled");
    const usesStandardLanguageServer = startScriptPath.endsWith("kotlin-language-server");
    if (debugAdapterEnabled && usesStandardLanguageServer) {
        vscode.languages.registerCodeLensProvider("kotlin", new RunDebugCodeLens())
    
        vscode.commands.registerCommand("kotlin.resolveMain", async(fileUri) => {
            return await languageClient.sendRequest(MainClassRequest.type, {
                uri: fileUri
            })
        });
    
        vscode.commands.registerCommand("kotlin.runMain", async(mainClass, projectRoot) => {
            vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot)), {
                type: "kotlin",
                name: "Run Kotlin main",
                request: "launch",
                noDebug: true,
                mainClass,
                projectRoot,
            }) 
        });
        
        vscode.commands.registerCommand("kotlin.debugMain", async(mainClass, projectRoot) => {
            vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectRoot)), {
                type: "kotlin",
                name: "Debug Kotlin main",
                request: "launch",
                mainClass,
                projectRoot,
            }) 
        });
    }

    await languageClientPromise;

    return new KotlinApi(languageClient);
}

function createLanguageClient(options: {
    outputChannel: vscode.OutputChannel,
    startScriptPath: string,
    tcpPort?: number,
    env?: NodeJS.ProcessEnv,
    storagePath: string,
    fileEventsGlobPatterns: string[],
    workspaceFolder?: vscode.WorkspaceFolder,
    projectRoot?: string
}): LanguageClient {
    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        workspaceFolder: options.workspaceFolder,
        // Register the server for Kotlin documents
        documentSelector: [
            { language: 'kotlin', scheme: 'file' },
            { language: 'kotlin', scheme: 'kls' }
        ],
        synchronize: {
            // Synchronize the setting section 'kotlin' to the server
            // NOTE: this currently doesn't do anything
            configurationSection: 'kotlin',
            // Notify the server about file changes to 'javaconfig.json' files contain in the workspace
            // TODO this should be registered from the language server side
            fileEvents: options.fileEventsGlobPatterns.map(
                function (globPattern: string): vscode.FileSystemWatcher {
                    const watcherPattern = options.workspaceFolder
                        ? new vscode.RelativePattern(options.workspaceFolder, globPattern)
                        : globPattern;
                    return vscode.workspace.createFileSystemWatcher(watcherPattern);
                }
            )
        },
        progressOnInitialization: true,
        outputChannel: options.outputChannel,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        initializationOptions: {
            storagePath: options.storagePath
        }
    }
    
    // Ensure that start script can be executed
    if (isOSUnixoid()) {
        child_process.exec(`chmod +x ${options.startScriptPath}`);
    }

    // Start the child Java process
    let serverOptions: ServerOptions;
    
    if (options.tcpPort) {
        serverOptions = () => spawnLanguageServerProcessAndConnectViaTcp(options);
    } else {
        serverOptions = {
            command: options.startScriptPath,
            args: [],
            options: {
                shell: isOSWindows(),
                cwd: options.projectRoot,
                env: options.env
            }
        }
        LOG.info("Creating client at {}", options.startScriptPath);
    }

    return new LanguageClient("kotlin-flutter", "Kotlin Flutter Language Client", serverOptions, clientOptions);
}

export function spawnLanguageServerProcessAndConnectViaTcp(options: {
    outputChannel: vscode.OutputChannel,
    startScriptPath: string,
    tcpPort?: number,
    env?: NodeJS.ProcessEnv,
    projectRoot?: string
}): Promise<StreamInfo> {
    return new Promise((resolve, reject) => {
        LOG.info("Creating server.")
        const server = net.createServer(socket => {
            LOG.info("Closing server since client has connected.");
            server.close();
            resolve({ reader: socket, writer: socket });
        });
        // Wait for the first client to connect
        server.listen(options.tcpPort, () => {
            const tcpPort = (server.address() as net.AddressInfo).port.toString();
            const proc = child_process.spawn(options.startScriptPath, ["--tcpClientPort", tcpPort], {
                shell: isOSWindows(),
                cwd: options.projectRoot,
                env: options.env
            });
            LOG.info("Creating client at {} via TCP port {}", options.startScriptPath, tcpPort);
            
            const outputCallback = data => options.outputChannel.append(`${data}`);
            proc.stdout.on("data", outputCallback);
            proc.stderr.on("data", outputCallback);
            proc.on("exit", (code, sig) => options.outputChannel.appendLine(`The language server exited, code: ${code}, signal: ${sig}`))
        });
        server.on("error", e => reject(e));
    });
}

export function configureLanguage(): void {
    // Source: https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/src/typescriptMain.ts#L186
    // License: https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/OSSREADME.json
    vscode.languages.setLanguageConfiguration("kotlin", {
        indentationRules: {
            // ^(.*\*/)?\s*\}.*$
            decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
            // ^.*\{[^}"']*$
            increaseIndentPattern: /^.*\{[^}"']*$/
        },
        wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
        onEnterRules: [
            {
                // e.g. /** | */
                beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
                afterText: /^\s*\*\/$/,
                action: { indentAction: vscode.IndentAction.IndentOutdent, appendText: ' * ' }
            },
            {
                // e.g. /** ...|
                beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
                action: { indentAction: vscode.IndentAction.None, appendText: ' * ' }
            },
            {
                // e.g.  * ...|
                beforeText: /^(\t|(\ \ ))*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
                action: { indentAction: vscode.IndentAction.None, appendText: '* ' }
            },
            {
                // e.g.  */|
                beforeText: /^(\t|(\ \ ))*\ \*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            },
            {
                // e.g.  *-----*/|
                beforeText: /^(\t|(\ \ ))*\ \*[^/]*\*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            }
        ]
    });
}
