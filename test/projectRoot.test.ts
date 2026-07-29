import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveEffectiveProjectRoot } from "../src/projectRoot";

const temporaryRoots: string[] = [];

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe("resolveEffectiveProjectRoot", () => {
    test("uses the nested Android Gradle project in a Flutter workspace", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-kotlin-flutter-"));
        temporaryRoots.push(workspace);
        const androidRoot = path.join(workspace, "android");
        fs.mkdirSync(androidRoot);
        fs.writeFileSync(path.join(workspace, "pubspec.yaml"), "name: sample\n");
        fs.writeFileSync(path.join(androidRoot, "settings.gradle"), "include ':app'\n");
        fs.writeFileSync(path.join(androidRoot, "gradlew"), "#!/bin/sh\n");

        expect(resolveEffectiveProjectRoot(workspace)).toBe(androidRoot);
    });

    test("uses the nearest Gradle root for an open Kotlin document", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-kotlin-document-"));
        temporaryRoots.push(workspace);
        const androidRoot = path.join(workspace, "platforms", "android");
        const sourceRoot = path.join(androidRoot, "app", "src", "main", "kotlin");
        fs.mkdirSync(sourceRoot, { recursive: true });
        fs.writeFileSync(path.join(androidRoot, "settings.gradle.kts"), "rootProject.name = \"sample\"\n");
        const kotlinFile = path.join(sourceRoot, "MainActivity.kt");
        fs.writeFileSync(kotlinFile, "class MainActivity\n");

        expect(resolveEffectiveProjectRoot(workspace, kotlinFile)).toBe(androidRoot);
    });

    test("keeps a non-Flutter workspace unchanged", () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-kotlin-plain-"));
        temporaryRoots.push(workspace);

        expect(resolveEffectiveProjectRoot(workspace)).toBe(workspace);
    });
});
