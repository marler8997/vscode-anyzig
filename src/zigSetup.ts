import vscode from "vscode";

import path from "path";

import axios from "axios";
import semver from "semver";

import * as minisign from "./minisign";
import * as versionManager from "./versionManager";
import {
    VersionIndex,
    ZigVersion,
    asyncDebounce,
    getHostZigName,
    resolveExePathAndVersion,
    workspaceConfigUpdateNoThrow,
} from "./zigUtil";
import { ZigProvider } from "./zigProvider";

let statusItem: vscode.StatusBarItem;
let languageStatusItem: vscode.LanguageStatusItem;
let versionManagerConfig: versionManager.Config;
export let zigProvider: ZigProvider;

async function showUpdateWorkspaceVersionDialog(
    version: semver.SemVer,
    source?: WantedZigVersionSource,
): Promise<void> {
    const workspace = getWorkspaceFolder();

    if (workspace !== null) {
        let buttonName;
        switch (source) {
            case WantedZigVersionSource.workspaceZigVersionFile:
                buttonName = "update .zigversion";
                break;
            case WantedZigVersionSource.workspaceBuildZigZon:
                buttonName = "update build.zig.zon";
                break;
            case WantedZigVersionSource.zigVersionConfigOption:
                buttonName = "update workspace settings";
                break;
            case undefined:
                buttonName = "create .zigversion";
                break;
        }

        const response = await vscode.window.showInformationMessage(
            `Would you like to save Zig ${version.toString()} in this workspace?`,
            buttonName,
        );
        if (!response) return;
    }

    source ??= workspace
        ? WantedZigVersionSource.workspaceZigVersionFile
        : WantedZigVersionSource.zigVersionConfigOption;

    switch (source) {
        case WantedZigVersionSource.workspaceZigVersionFile: {
            if (!workspace) throw new Error("failed to resolve workspace folder");

            const edit = new vscode.WorkspaceEdit();
            edit.createFile(vscode.Uri.joinPath(workspace.uri, ".zigversion"), {
                overwrite: true,
                contents: new Uint8Array(Buffer.from(version.raw)),
            });
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.workspaceBuildZigZon: {
            const metadata = await parseBuildZigZon();
            if (!metadata) throw new Error("failed to parse build.zig.zon");

            const edit = new vscode.WorkspaceEdit();
            edit.replace(metadata.document.uri, metadata.minimumZigVersionSourceRange, version.raw);
            await vscode.workspace.applyEdit(edit);
            break;
        }
        case WantedZigVersionSource.zigVersionConfigOption: {
            await vscode.workspace.getConfiguration("zig").update("version", version.raw, !workspace);
            break;
        }
    }
}

interface BuildZigZonMetadata {
    /** The `build.zig.zon` document. */
    document: vscode.TextDocument;
    minimumZigVersion: semver.SemVer;
    /** `.minimum_zig_version = "<start>0.13.0<end>"` */
    minimumZigVersionSourceRange: vscode.Range;
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | null {
    // Supporting multiple workspaces is significantly more complex so we just look for the first workspace.
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        return vscode.workspace.workspaceFolders[0];
    }
    return null;
}

/**
 * Look for a `build.zig.zon` in the current workspace and return the `minimum_zig_version` in it.
 */
async function parseBuildZigZon(): Promise<BuildZigZonMetadata | null> {
    const workspace = getWorkspaceFolder();
    if (!workspace) return null;

    const manifestUri = vscode.Uri.joinPath(workspace.uri, "build.zig.zon");

    const manifest = await vscode.workspace.openTextDocument(manifestUri);
    // Not perfect, but good enough
    const regex = /\n\s*\.minimum_zig_version\s=\s\"(.*)\"/;
    const matches = regex.exec(manifest.getText());
    if (!matches) return null;

    const versionString = matches[1];
    const version = semver.parse(versionString);
    if (!version) return null;

    const startPosition = manifest.positionAt(matches.index + matches[0].length - versionString.length - 1);
    const endPosition = startPosition.translate(0, versionString.length);

    return {
        document: manifest,
        minimumZigVersion: version,
        minimumZigVersionSourceRange: new vscode.Range(startPosition, endPosition),
    };
}

function updateStatusItem(item: vscode.StatusBarItem, version: semver.SemVer | null) {
    item.name = "Zig Version";
    item.text = version?.toString() ?? "not installed";
    item.tooltip = "Select Zig Version";
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
    if (version) {
        item.backgroundColor = undefined;
    } else {
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
}

function updateLanguageStatusItem(item: vscode.LanguageStatusItem, version: semver.SemVer | null) {
    item.name = "Zig";
    if (version) {
        item.text = `Zig ${version.toString()}`;
        item.detail = "Zig Version";
        item.severity = vscode.LanguageStatusSeverity.Information;
    } else {
        item.text = "Zig not installed";
        item.severity = vscode.LanguageStatusSeverity.Error;
    }
    item.command = {
        title: "Select Version",
        command: "zig.install",
    };
}

function updateZigEnvironmentVariableCollection(context: vscode.ExtensionContext, zigExePath: string | null) {
    if (zigExePath) {
        const envValue = path.dirname(zigExePath) + path.delimiter;
        // This will take priority over a user-defined PATH values.
        context.environmentVariableCollection.prepend("PATH", envValue);
    } else {
        context.environmentVariableCollection.delete("PATH");
    }
}

/**
 * Should be called when one of the following events happen:
 * - The Zig executable has been modified
 * - A workspace configuration file has been modified (e.g. `.zigversion`, `build.zig.zon`)
 */
async function updateStatus(context: vscode.ExtensionContext): Promise<void> {
    const zigVersion = zigProvider.getZigVersion();
    const zigPath = zigProvider.getZigPath();

    updateStatusItem(statusItem, zigVersion);
    updateLanguageStatusItem(languageStatusItem, zigVersion);
    updateZigEnvironmentVariableCollection(context, zigPath);

    // Try to check whether the Zig version satifies the `minimum_zig_version` in `build.zig.zon`

    if (!zigVersion || !zigPath) return;
    const buildZigZonMetadata = await parseBuildZigZon();
    if (!buildZigZonMetadata) return;
    if (semver.gte(zigVersion, buildZigZonMetadata.minimumZigVersion)) return;

    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

    void vscode.window
        .showWarningMessage(
            `Your Zig version '${zigVersion.toString()}' does not satisfy the minimum Zig version '${buildZigZonMetadata.minimumZigVersion.toString()}' of your project.`,
            "update Zig",
            "open build.zig.zon",
        )
        .then(async (response) => {
            switch (response) {
                case undefined:
                    break;
                case "update Zig": {
                    // This will source the desired Zig version with `getWantedZigVersion` which may not satisfy the minimum Zig version.
                    // This could happen for example when the a `.zigversion` specifies `0.12.0` but `minimum_zig_version` is `0.13.0`.
                    // The extension would install `0.12.0` and then complain again.
                    await installZig(context);
                    break;
                }
                case "open build.zig.zon": {
                    void vscode.window.showTextDocument(buildZigZonMetadata.document, {
                        selection: buildZigZonMetadata.minimumZigVersionSourceRange,
                    });
                    break;
                }
            }
        });
}

export async function setupZig(context: vscode.ExtensionContext) {
    {
        // This check can be removed once enough time has passed so that most users switched to the new value

        // remove the `zig_install` directory from the global storage
        try {
            await vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, "zig_install"), {
                recursive: true,
                useTrash: false,
            });
        } catch {}

        // remove a `zig.path` that points to the global storage.
        const zigConfig = vscode.workspace.getConfiguration("zig");
        const zigPath = zigConfig.get<string>("path", "");
        if (zigPath.startsWith(context.globalStorageUri.fsPath)) {
            await workspaceConfigUpdateNoThrow(zigConfig, "path", undefined, true);
        }

        await workspaceConfigUpdateNoThrow(zigConfig, "initialSetupDone", undefined, true);

        await context.workspaceState.update("zig-version", undefined);
    }

    versionManagerConfig = {
        context: context,
        title: "Zig",
        exeName: "zig",
        extraTarArgs: ["--strip-components=1"],
        /** https://ziglang.org/download */
        minisignKey: minisign.parseKey("RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"),
        versionArg: "version",
        // taken from https://github.com/mlugg/setup-zig/blob/main/mirrors.json
        mirrorUrls: [
            vscode.Uri.parse("https://pkg.machengine.org/zig"),
            vscode.Uri.parse("https://zigmirror.hryx.net/zig"),
            vscode.Uri.parse("https://zig.linus.dev/zig"),
            vscode.Uri.parse("https://fs.liujiacai.net/zigbuilds"),
            vscode.Uri.parse("https://zigmirror.nesovic.dev/zig"),
        ],
        canonicalUrl: {
            release: vscode.Uri.parse("https://ziglang.org/download"),
            nightly: vscode.Uri.parse("https://ziglang.org/builds"),
        },
    };

    zigProvider = new ZigProvider();

    /** There two status items because there doesn't seem to be a way to pin a language status item by default. */
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, -1);
    languageStatusItem = vscode.languages.createLanguageStatusItem("zig.status", { language: "zig" });

    context.environmentVariableCollection.description = "Add Zig to PATH";

    const watcher1 = vscode.workspace.createFileSystemWatcher("**/.zigversion");
    const watcher2 = vscode.workspace.createFileSystemWatcher("**/build.zig.zon");

    const refreshZigInstallation = asyncDebounce(async () => {
        if (!vscode.workspace.getConfiguration("zig").get<string>("path")) {
            await installZig(context);
        } else {
            await updateStatus(context);
        }
    }, 200);

    const onDidChangeActiveTextEditor = (editor: vscode.TextEditor | undefined) => {
        if (editor?.document.languageId === "zig") {
            statusItem.show();
        } else {
            statusItem.hide();
        }
    };
    onDidChangeActiveTextEditor(vscode.window.activeTextEditor);

    context.subscriptions.push(
        statusItem,
        languageStatusItem,
        vscode.commands.registerCommand("zig.install", async () => {
            await selectVersionAndInstall(context);
        }),
        vscode.workspace.onDidChangeConfiguration((change) => {
            if (change.affectsConfiguration("zig.version")) {
                void refreshZigInstallation();
            }
            if (change.affectsConfiguration("zig.path")) {
                const result = zigProvider.resolveZigPathConfigOption();
                if (result === undefined) return; // error message already reported
                if (result !== null) {
                    zigProvider.set(result);
                }
                void refreshZigInstallation();
            }
        }),
        vscode.window.onDidChangeActiveTextEditor(onDidChangeActiveTextEditor),
        zigProvider.onChange.event(() => {
            void updateStatus(context);
        }),
        watcher1.onDidCreate(refreshZigInstallation),
        watcher1.onDidChange(refreshZigInstallation),
        watcher1.onDidDelete(refreshZigInstallation),
        watcher1,
        watcher2.onDidCreate(refreshZigInstallation),
        watcher2.onDidChange(refreshZigInstallation),
        watcher2.onDidDelete(refreshZigInstallation),
        watcher2,
    );

    await refreshZigInstallation();
}
