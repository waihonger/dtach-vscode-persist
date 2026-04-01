export const workspace = {
  workspaceFolders: [
    {
      uri: { fsPath: "/Users/test/my-project" },
      name: "my-project",
      index: 0,
    },
  ],
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    dispose: () => {},
  }),
  showErrorMessage: () => {},
  showWarningMessage: () => {},
  showInformationMessage: () => {},
  createTerminal: () => ({}),
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  onDidOpenTerminal: () => ({ dispose: () => {} }),
  registerTerminalProfileProvider: () => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
};

export class TerminalProfile {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
  }
}
