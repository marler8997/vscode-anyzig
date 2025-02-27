const vscode = require('vscode');
const path = require('path');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

// TODO: how do I hook up a zls.exe which is a language server for
//       the zig programming language?

function activate(context) {
    console.log('anyzig extension: activating...');
    //let disposable = vscode.commands.registerCommand('hello.sayHello', function () {
    //    vscode.window.showInformationMessage('Hello from VSCode Extension!');
    //    console.log('hello');
    //});
    //context.subscriptions.push(disposable);
    setupZigLanguageServer(context);
    console.log('anyzig extension: activated');
}

function deactivate() {
    console.log('anyzig extension: deactivating...');
    if (!client) {
        return undefined;
    }
    console.log('anyzig extension: stopping language client...');
    return client.stop();
}

function setupZigLanguageServer(context) {
    // Get configuration for the ZLS executable path
    const config = vscode.workspace.getConfiguration('anyzig');
    const zlsPath = config.get('zlsPath') || 'zls'; // Default to 'zls' if not specified

    // Define server options
    const serverOptions = {
        run: {
            command: zlsPath,
            transport: TransportKind.stdio
        },
        debug: {
            command: zlsPath,
            transport: TransportKind.stdio,
            options: {
                env: {
                    ZLS_DEBUG: "true" // Enable debug logging in ZLS
                }
            }
        }
    };

    // Define client options
    const clientOptions = {
        // Register the server for Zig files
        documentSelector: [{ scheme: 'file', language: 'zig' }],
        synchronize: {
            // Notify the server about file changes to Zig files
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.zig')
        }
    };

    // Create the language client
    client = new LanguageClient(
        'zigLanguageServer',
        'Zig Language Server',
        serverOptions,
        clientOptions
    );

    // Start the client
    client.start();
    context.subscriptions.push(client);
}

module.exports = {
    activate,
    deactivate
}
