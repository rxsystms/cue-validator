# CUE Validator

Catch configuration mistakes before they reach production.

CUE Validator helps you validate the currently open YAML, JSON, or TOML file against the nearest local `.cue` schema in your workspace. It gives you instant feedback while you edit, so schema drift, missing fields, and invalid values are caught early instead of during deployment.

Validate against a local .cue schema with support for:
- YAML
- JSON
- TOML
- other related data files 

# Developers

## Quickstart

```bash
npm i

npm run compile

# run local development server with:
cd cue-validator
code --extensionDevelopmentPath="$PWD"






# publish with:
# registered at: https://marketplace.visualstudio.com/manage
# https://dev.azure.com/{username}/_usersSettings/tokens
# See: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace
npm install -g @vscode/vsce
# install az cli: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-linux?view=azure-cli-latest&pivots=apt
az login # follow instructions...
az account get-access-token

PUBLISHER_NAME=rxsystms
vsce login $PUBLISHER_NAME

vsce package
# upload the .vsix file to VS marketplace

vsce publish

# view at: https://marketplace.visualstudio.com/manage/publishers/rxsystms/extensions/cue-validator/hub

```

## Usage

1. Open a workspace that contains a `.cue` file in the same directory or a parent directory.
2. Open a YAML/JSON/TOML file to validate.
3. Run the command `CUE: Validate current file` or let the extension validate automatically on save.

The extension looks for the nearest `.cue` file and runs:

```bash
cue vet -c=false <schema>.cue <data-file>
```

It then highlights any matching problems directly in the active document.
