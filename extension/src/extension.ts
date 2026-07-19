import * as vscode from 'vscode';
import { FeedProvider } from './panel';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new FeedProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('issueRadar.feed', provider),
    vscode.commands.registerCommand('issueRadar.refresh', () => provider.refresh())
  );
}

export function deactivate(): void {
  // nothing to clean up
}
