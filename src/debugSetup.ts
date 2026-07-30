import * as vscode from "vscode";
import * as path from "path";
import * as child_process from "child_process";
import { ServerDownloader } from "./serverDownloader";
import { correctScriptName, isOSUnixoid } from "./util/osUtils";
import { ServerSetupParams } from "./setupParams";
import { fsExists } from "./util/fsUtils";

export async function registerDebugAdapter({ context, status, config, javaInstallation, javaOpts }: ServerSetupParams): Promise<void> {
    status.update("Registering Kotlin Debug Adapter...");
    
    // Prefer the adapter bundled with the VSIX to keep first activation
    // independent from GitHub API availability.
    const debugAdapterInstallDir = path.join(context.globalStorageUri.fsPath, "debugAdapterInstall");
    const bundledStartScriptPath = path.join(
        context.extensionPath,
        "resources",
        "debugAdapterInstall",
        "adapter",
        "bin",
        correctScriptName("kotlin-debug-adapter")
    );
    const hasBundledDebugAdapter = await fsExists(bundledStartScriptPath);
    const customPath: string = config.get("debugAdapter.path");
    
    if (!customPath && !hasBundledDebugAdapter) {
        const debugAdapterDownloader = new ServerDownloader("Kotlin Debug Adapter", "kotlin-debug-adapter", "adapter.zip", "adapter", debugAdapterInstallDir);
        
        try {
            await debugAdapterDownloader.downloadServerIfNeeded(status);
        } catch (error) {
            console.error(error);
            vscode.window.showWarningMessage(`Could not update/download Kotlin Debug Adapter: ${error}`);
            return;
        }
    }
    
    const startScriptPath = customPath
        || (hasBundledDebugAdapter
            ? bundledStartScriptPath
            : path.join(debugAdapterInstallDir, "adapter", "bin", correctScriptName("kotlin-debug-adapter")));
    
    // Ensure that start script can be executed
    if (isOSUnixoid()) {
        child_process.exec(`chmod +x ${startScriptPath}`);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };

    if (javaInstallation.javaHome) {
        env['JAVA_HOME'] = javaInstallation.javaHome;
    }

    if (javaOpts) {
        env['JAVA_OPTS'] = javaOpts;
    }
    
    vscode.debug.registerDebugAdapterDescriptorFactory("kotlin", new KotlinDebugAdapterDescriptorFactory(startScriptPath, env));
}

/**
 * A factory that creates descriptors which point
 * to the Kotlin debug adapter start script.
 */
export class KotlinDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    public constructor(
        private startScriptPath: string,
        private env?: NodeJS.ProcessEnv
    ) {}
    
    async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterExecutable(this.startScriptPath, null, {
            env: this.env
        });
    }
}
