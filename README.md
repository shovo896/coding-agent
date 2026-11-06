# OpenRouter Code Agent (VS Code Extension)

Use **OpenRouter Code Agent: Open Agent** from the Command Palette.

1. Paste an OpenRouter API key and select **Save key**. VS Code stores it in its encrypted Secret Storage; the extension does not put it in your project or source control.
2. Select **Load free models**, then choose a currently available free model.
3. Describe a task. The agent can inspect workspace files, write targeted changes, and run non-destructive build/test commands.

The extension restricts file operations and command working directories to the first opened VS Code workspace folder. It blocks a small set of destructive command patterns, but an AI coding agent can still modify files and run development commands. Review its activity before keeping changes.

## Local development

Open this folder in VS Code, press `F5`, and a new **Extension Development Host** opens. In that window, open a project folder and run the command above.

No npm dependencies are required. Validate the extension source with:

```bash
node --check extension.js
```
