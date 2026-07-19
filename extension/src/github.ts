import * as vscode from 'vscode';

/** Uses VS Code's built-in GitHub auth — no OAuth app to register. */
export async function getToken(createIfNone: boolean): Promise<string | undefined> {
  const session = await vscode.authentication.getSession(
    'github',
    ['read:user'],
    { createIfNone }
  );
  return session?.accessToken;
}
