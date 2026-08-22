import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import * as vscode from 'vscode'

const SUPPORTED_LANGUAGES = new Set(['yaml', 'yml', 'json', 'toml', 'plaintext'])
const SUPPORTED_EXTENSIONS = new Set(['.yaml', '.yml', '.json', '.toml', '.repl'])
const EXCLUDED_FILENAMES = new Set(['package.json', 'tsconfig.json'])
const diagnosticCollection = vscode.languages.createDiagnosticCollection('cue-validator')

function detectCueBinary(): string {
  const explicit = process.env.CUE_BIN
  if (explicit && explicit.trim()) {
    return explicit.trim()
  }

  const homeCue = path.join(process.env.HOME ?? '', '.local', 'bin', 'cue')
  if (fs.existsSync(homeCue)) {
    return homeCue
  }

  return 'cue'
}

function supportsDocument(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false
  }

  if (EXCLUDED_FILENAMES.has(path.basename(document.fileName))) {
    return false
  }

  const ext = path.extname(document.fileName).toLowerCase()
  return SUPPORTED_LANGUAGES.has(document.languageId) || SUPPORTED_EXTENSIONS.has(ext)
}

function isInsideWorkspace(document: vscode.TextDocument): boolean {
  const resolvedPath = path.resolve(document.fileName)
  const folders = vscode.workspace.workspaceFolders ?? []

  if (folders.length === 0) {
    return true
  }

  return folders.some((folder) => {
    const root = path.resolve(folder.uri.fsPath)
    const relative = path.relative(root, resolvedPath)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

async function findCueSchema(document: vscode.TextDocument): Promise<string | undefined> {
  if (!isInsideWorkspace(document)) {
    return undefined
  }

  const currentDir = path.dirname(path.resolve(document.fileName))

  try {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
    const cues = (
      await Promise.all(
        entries
          .filter((entry) => entry.name.endsWith('.cue'))
          .map(async (entry) => {
            const cuePath = path.join(currentDir, entry.name)
            try {
              return (await fs.promises.stat(cuePath)).isFile() ? cuePath : undefined
            } catch {
              return undefined
            }
          }),
      )
    )
      .filter((cuePath): cuePath is string => cuePath !== undefined)
      .sort()

    if (cues.length > 0) {
      return cues[0]
    }
  } catch {
    // ignore unreadable directories
  }

  return undefined
}

function findCueDefinitionName(cueFile: string): string | undefined {
  try {
    const schemaContent = fs.readFileSync(cueFile, 'utf8')
    const definitions = [...schemaContent.matchAll(/^\s*#([A-Za-z0-9_]+)\s*:/gm)]
      .map((match) => `#${match[1]}`)

    // prefer a union entry point so a directory can mix document shapes (e.g. #BP | #Orchestrator)
    if (definitions.includes('#Document')) {
      return '#Document'
    }

    if (definitions.includes('#BP')) {
      return '#BP'
    }

    if (definitions.length === 1) {
      return definitions[0]
    }
  } catch {
    // ignore unreadable schema files
  }

  return undefined
}

function parseCueDiagnostics(output: string, targetPath: string): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  const target = path.resolve(targetPath)
  const lines = output.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const inlineMatch = line.match(/^\s*(.+?):(\d+):(\d+)\s*:\s*(.+)$/)
    if (inlineMatch) {
      const filePath = inlineMatch[1]
      const lineNumber = Number(inlineMatch[2])
      const columnNumber = Number(inlineMatch[3])
      const message = inlineMatch[4].trim()

      if (!message) {
        continue
      }

      const resolvedFile = path.resolve(filePath)
      if (resolvedFile !== target) {
        continue
      }

      const rangeStartLine = Math.max(0, lineNumber - 1)
      const rangeStartColumn = Math.max(0, columnNumber - 1)
      const range = new vscode.Range(
        rangeStartLine,
        rangeStartColumn,
        rangeStartLine,
        Math.max(rangeStartColumn + 1, rangeStartColumn + 2),
      )
      diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error))
      continue
    }

    const locationMatch = line.match(/^\s*(.+?):(\d+):(\d+)\s*$/)
    if (!locationMatch) {
      continue
    }

    const filePath = locationMatch[1]
    const resolvedFile = path.resolve(filePath)
    if (resolvedFile !== target) {
      continue
    }

    let message = 'CUE validation error'
    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const candidate = lines[previousIndex].trim()
      if (!candidate) {
        continue
      }

      if (/^\s*(.+?):(\d+):(\d+)\s*$/.test(lines[previousIndex])) {
        continue
      }

      message = candidate
      break
    }

    const lineNumber = Number(locationMatch[2])
    const columnNumber = Number(locationMatch[3])
    const rangeStartLine = Math.max(0, lineNumber - 1)
    const rangeStartColumn = Math.max(0, columnNumber - 1)
    const range = new vscode.Range(
      rangeStartLine,
      rangeStartColumn,
      rangeStartLine,
      Math.max(rangeStartColumn + 1, rangeStartColumn + 2),
    )
    diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error))
  }

  return diagnostics
}

async function validateDocument(document: vscode.TextDocument): Promise<void> {
  if (!supportsDocument(document) || !isInsideWorkspace(document)) {
    diagnosticCollection.delete(document.uri)
    return
  }

  const cueFile = await findCueSchema(document)
  if (!cueFile) {
    diagnosticCollection.delete(document.uri)
    return
  }

  const cueBinary = detectCueBinary()
  const env = { ...process.env, PATH: `${path.dirname(cueBinary)}:${process.env.PATH ?? ''}` }
  const cueArgs = ['vet', '-c=false']
  const definitionName = findCueDefinitionName(cueFile)
  if (definitionName) {
    cueArgs.push('-d', definitionName)
  }
  cueArgs.push(cueFile, document.fileName)

  const result = cp.spawnSync(cueBinary, cueArgs, {
    encoding: 'utf-8',
    env,
  })

  const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  const diagnostics = combinedOutput ? parseCueDiagnostics(combinedOutput, document.fileName) : []

  diagnosticCollection.set(document.uri, diagnostics)
}

let debounceTimer: NodeJS.Timeout | undefined
function queueValidation(document: vscode.TextDocument): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }

  debounceTimer = setTimeout(() => {
    void validateDocument(document)
  }, 250)
}

export function activate(context: vscode.ExtensionContext): void {
  const validateCommand = vscode.commands.registerCommand('cue-validator.validateCurrentFile', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      return
    }

    await validateDocument(editor.document)
  })

  const openListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      queueValidation(editor.document)
    }
  })

  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    if (supportsDocument(document)) {
      void validateDocument(document)
    }
  })

  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (supportsDocument(event.document)) {
      queueValidation(event.document)
    }
  })

  context.subscriptions.push(validateCommand, openListener, saveListener, changeListener, diagnosticCollection)

  const editor = vscode.window.activeTextEditor
  if (editor) {
    queueValidation(editor.document)
  }
}

export function deactivate(): void {
  diagnosticCollection.clear()
}
