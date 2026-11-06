# OpenRouter Code Agent (VS Code Extension)

Use **OpenRouter Code Agent: Open Agent** from the Command Palette.

1. Paste an OpenRouter API key and select **Save key**. VS Code stores it in its encrypted Secret Storage; the extension does not put it in your project or source control.
2. Select **Load free models**, then choose a currently available free model that supports coding-agent tools.
3. Use **Upload files** to copy selected files into the workspace `uploads/` folder, then ask the agent to inspect them. Each uploaded file is limited to 25 MB.
4. Describe a task. The agent can inspect/search workspace files, make focused replacements, view VS Code diagnostics and Git diff, and run non-destructive build/test commands.

The extension restricts file operations and command working directories to the first opened VS Code workspace folder. It blocks a small set of destructive command patterns, but an AI coding agent can still modify files and run development commands. Review its activity before keeping changes.

## Local development

Open this folder in VS Code, press `F5`, and a new **Extension Development Host** opens. In that window, open a project folder and run the command above.

No npm dependencies are required. Validate the extension source with:

```bash
node --check extension.js
```
