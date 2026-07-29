import * as fs from "fs";
import * as path from "path";

const gradleSettingsFiles = ["settings.gradle", "settings.gradle.kts"];
const gradleWrapperFiles = ["gradlew", "gradlew.bat"];

function containsAny(root: string, names: string[]): boolean {
    return names.some(name => fs.existsSync(path.join(root, name)));
}

function isWithin(candidate: string, root: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findNearestGradleRoot(documentPath: string, workspaceRoot: string): string | undefined {
    let current = fs.existsSync(documentPath) && fs.statSync(documentPath).isDirectory()
        ? documentPath
        : path.dirname(documentPath);

    while (isWithin(current, workspaceRoot)) {
        if (containsAny(current, gradleSettingsFiles)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return undefined;
}

/**
 * Resolves the project root that should be sent to the Kotlin language server.
 *
 * Flutter keeps its Android Gradle project below `<workspace>/android`. The
 * language server must use that nested directory as both its process working
 * directory and LSP workspace root, otherwise Gradle wrapper and classpath
 * discovery run against the Flutter root and Kotlin built-ins become missing.
 */
export function resolveEffectiveProjectRoot(workspaceRoot: string, documentPath?: string): string {
    if (documentPath) {
        const nearestGradleRoot = findNearestGradleRoot(documentPath, workspaceRoot);
        if (nearestGradleRoot) {
            return nearestGradleRoot;
        }
    }

    const androidRoot = path.join(workspaceRoot, "android");
    const isFlutterWorkspace = fs.existsSync(path.join(workspaceRoot, "pubspec.yaml"));
    const hasAndroidGradleProject = containsAny(androidRoot, gradleSettingsFiles);
    const hasAndroidGradleWrapper = containsAny(androidRoot, gradleWrapperFiles);

    if (isFlutterWorkspace && hasAndroidGradleProject && hasAndroidGradleWrapper) {
        return androidRoot;
    }

    return workspaceRoot;
}
