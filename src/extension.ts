import vscode from "vscode";

import { activate as activateZls, deactivate as deactivateZls } from "./zls";
import ZigCompilerProvider from "./zigCompilerProvider";
import { ZigMainCodeLensProvider } from "./zigMainCodeLens";
import { registerDocumentFormatting } from "./zigFormat";
import { setupZig } from "./zigSetup";

export async function activate(context: vscode.ExtensionContext) {
    await setupZig(context).finally(() => {
        const compiler = new ZigCompilerProvider();
        compiler.activate(context.subscriptions);

        context.subscriptions.push(registerDocumentFormatting());

        ZigMainCodeLensProvider.registerCommands(context);
        context.subscriptions.push(
            vscode.languages.registerCodeLensProvider(
                { language: 'zig', scheme: 'file' },
                new ZigMainCodeLensProvider()
            )
        );

        void activateZls(context);
    });
}

export async function deactivate() {
    await deactivateZls();
}
