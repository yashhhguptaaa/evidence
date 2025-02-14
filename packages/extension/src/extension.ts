import {
	languages,
	window,
	workspace,
	ExtensionContext,
	ProgressLocation,
	TextEditor,
	DecorationOptions,
	Range,
	Position,
	commands,
	extensions,
	ConfigurationTarget
} from 'vscode';

import { TelemetryService } from './telemetryService';

import { Commands } from './commands/commands';

import { MarkdownSymbolProvider } from './providers/markdownSymbolProvider';
import { setExtensionContext } from './extensionContext';
import { registerCommands } from './commands/commands';
import {
	loadPackageJson,
	getPackageJsonFolder,
	hasDependency,
	dependencyVersion,
	getManifestUri,
	getManifest,
	isUSQL,
	hasManifest
} from './utils/jsonUtils';
import { Settings, getConfig, updateProjectContext } from './config';
import { startServer } from './commands/server';
import { openIndex, openWalkthrough } from './commands/project';
import { statusBar } from './statusBar';
import { closeTerminal } from './terminal';
import { isGitRepository } from './utils/gitCheck';
import { countFilesInDirectory, countTemplatedPages } from './utils/fsUtils';
import * as path from 'path';
import * as fs from 'fs';
import { SchemaViewProvider } from './providers/schemaViewProvider';
import { profile } from 'console';

export const enum Context {
	isNewLine = 'evidence.isNewLine',
	isPagesDirectory = 'evidence.isPagesDirectory',
	isNonLegacyProject = 'evidence.isNonLegacyProject',
	slashCommands = 'evidence.slashCommands'
}

export let telemetryService: TelemetryService; // Global instance

async function initializeTelemetryService() {
	try {
		const iK = '99ec224c-3fe8-4635-96ef-24c9aa5a354f'; // example key
		telemetryService = new TelemetryService(iK);
		telemetryService?.loadCommonProperties((await getPackageJsonFolder()) ?? '');
		// Any other telemetry initialization logic
	} catch (error) {
		console.error('Failed to initialize telemetry: ', error);
	}
}

const decorationType = window.createTextEditorDecorationType({
	after: {
		contentText: ' Press / for commands...',
		color: '#99999959'
	}
});

function decorate(editor: TextEditor) {
	let decorationsArray: DecorationOptions[] = [];
	const { text } = editor.document.lineAt(editor.selection.active.line);
	const position = editor.selection.active;

	let range = new Range(
		new Position(position.line, position.character),
		new Position(position.line, position.character)
	);

	let decoration = { range };

	// new lines are defined as empty (undefined) lines of code, plus any lines that are solely whitespace characters (spaces and tabs)
	if (text === undefined || /^\s*$/.test(text)) {
		decorationsArray.push(decoration);
		commands.executeCommand(Commands.SetContext, Context.isNewLine, true);
	} else {
		commands.executeCommand(Commands.SetContext, Context.isNewLine, false);
	}

	editor.setDecorations(decorationType, decorationsArray);
}

function isPagesDirectory() {
	const openEditor = window.activeTextEditor;
	let pageContext = false;
	// Set context for pages directory (only use Evidence markdown features within those files):
	if (openEditor && /\/pages\/|\\pages\\/.test(openEditor.document.uri.fsPath)) {
		commands.executeCommand(Commands.SetContext, Context.isPagesDirectory, true);
		pageContext = true;
	} else {
		commands.executeCommand(Commands.SetContext, Context.isPagesDirectory, false);
		pageContext = false;
	}
	return pageContext;
}

/**
 * Activates Evidence vscode extension.
 *
 * @param context Extension context.
 */
export async function activate(context: ExtensionContext) {
	setExtensionContext(context);
	registerCommands(context);

	await initializeTelemetryService();

	// Ensure it gets properly disposed. Upon disposal, the events will be flushed
	if (telemetryService) {
		context.subscriptions.push(telemetryService);
	}

	// register markdown symbol provider
	const markdownLanguage = { language: 'emd', scheme: 'file' };
	const provider = new MarkdownSymbolProvider();
	// languages.registerDocumentSymbolProvider(markdownLanguage, provider);

	// load package.json
	const workspacePackageJson = await loadPackageJson();

	// get all evidence files in workspace
	const evidenceFiles = await workspace.findFiles('**/.evidence/**/*.*', '**/node_modules/**');

	// check for evidence app files and dependencies in the loaded package.json
	if (
		workspace.workspaceFolders &&
		evidenceFiles.length > 0 &&
		workspacePackageJson &&
		hasDependency(workspacePackageJson, '@evidence-dev/evidence')
	) {
		try {
			telemetryService?.sendEvent('preActivate');

			// set up file watcher for .profile.json
			const workspaceFolder = workspace.workspaceFolders?.[0];

			// check if evidence project is in subdirectory:
			const packageJsonFolder = await getPackageJsonFolder();

			if (workspaceFolder) {
				const baseEvidencePath = path.join(
					workspaceFolder.uri.fsPath,
					packageJsonFolder ?? '',
					'.evidence'
				);
				const oldProfilePath = path.join(baseEvidencePath, 'template', '.profile.json');
				const newProfilePath = path.join(baseEvidencePath, 'customization', '.profile.json');

				const updateProfileDetails = (profilePath: string) => {
					console.log('updatedetails: ' + profilePath);
					try {
						if (!fs.existsSync(profilePath)) {
							throw new Error('Profile file does not exist');
						}

						const content = fs.readFileSync(profilePath, 'utf8');
						if (!content) {
							throw new Error('Profile file is empty');
						}

						const profile = JSON.parse(content);
						if (!profile || typeof profile !== 'object') {
							throw new Error('Invalid profile data');
						}

						if (!profile.anonymousId || !profile.traits || !profile.traits.projectCreated) {
							throw new Error('Required profile fields are missing');
						}
						telemetryService?.updateProfileDetails(
							profile.anonymousId,
							profile.traits.projectCreated
						);
					} catch (err) {
						if (err instanceof Error) {
							telemetryService?.clearProfileDetails();
							telemetryService?.sendEvent('telemetryError', {
								location: 'updateProfileDetailsFromJson',
								error: err.message
							});
						} else {
							telemetryService?.clearProfileDetails();
							// Send a generic error message if the error type is unknown
							telemetryService?.sendEvent('telemetryError', {
								location: 'updateProfileDetailsFromJson',
								error: 'Unknown error'
							});
						}
					}
				};

				const handleProfileChange = () => {
					if (fs.existsSync(newProfilePath)) {
						console.log('found new directory successfully');
						updateProfileDetails(newProfilePath);
					} else if (fs.existsSync(oldProfilePath)) {
						updateProfileDetails(oldProfilePath);
					} else {
						console.log('could not find directory');
						telemetryService?.clearProfileDetails();
					}
				};

				const oldProfileWatcher = workspace.createFileSystemWatcher(oldProfilePath);
				oldProfileWatcher.onDidChange(handleProfileChange);
				oldProfileWatcher.onDidCreate(() => {
					handleProfileChange();
					telemetryService?.sendEvent('profileCreated');
				});
				oldProfileWatcher.onDidDelete(handleProfileChange);
				context.subscriptions.push(oldProfileWatcher);

				const newProfileWatcher = workspace.createFileSystemWatcher(newProfilePath);
				newProfileWatcher.onDidChange(handleProfileChange);
				newProfileWatcher.onDidCreate(() => {
					console.log('create event fired');
					handleProfileChange();
					console.log('profile change done');
					telemetryService?.sendEvent('profileCreated');
					console.log('telem event post fire');
				});
				newProfileWatcher.onDidDelete(handleProfileChange);
				context.subscriptions.push(newProfileWatcher);

				// Initial check
				handleProfileChange();

				// Git watcher
				const gitPath = path.join(workspaceFolder.uri.fsPath, '.git');
				const gitWatcher = workspace.createFileSystemWatcher(gitPath);

				const updateGitCheck = () => {
					try {
						const gitCheck = isGitRepository(workspaceFolder.uri.fsPath).toString();
						telemetryService?.updateGitCheck(gitCheck);
					} catch (err) {
						telemetryService?.clearGitCheck();
					}
				};

				gitWatcher.onDidChange(updateGitCheck);
				gitWatcher.onDidCreate(updateGitCheck);
				gitWatcher.onDidDelete(() => telemetryService?.clearGitCheck());

				context.subscriptions.push(gitWatcher);

				// initial check
				updateGitCheck();
			}

			// get slashCommands setting from extension settings:
			const slashCommands: boolean = <boolean>getConfig(Settings.SlashCommands);

			// Set context for slashCommands setting
			commands.executeCommand(Commands.SetContext, Context.slashCommands, slashCommands);

			// decorate slash command on activation if the active file is a markdown file and slash commands are enabled
			const openEditor = window.activeTextEditor;
			if (
				openEditor &&
				openEditor.document.fileName.endsWith('.md') &&
				isPagesDirectory() &&
				slashCommands === true
			) {
				try {
					decorate(openEditor);
				} catch (e) {
					telemetryService?.sendEvent('decorationError');
				}
			}

			window.onDidChangeTextEditorSelection(() => {
				const openEditor = window.activeTextEditor;
				if (
					openEditor &&
					openEditor.document.fileName.endsWith('.md') &&
					isPagesDirectory() &&
					slashCommands === true
				) {
					try {
						decorate(openEditor);
					} catch (e) {
						telemetryService?.sendEvent('decorationError');
					}
				}
			});

			// Needed for delete key events which are not captured by the onDidChangeTextEditorSelection event
			workspace.onDidChangeTextDocument(() => {
				const openEditor = window.activeTextEditor;
				if (
					openEditor &&
					openEditor.document.fileName.endsWith('.md') &&
					isPagesDirectory() &&
					slashCommands === true
				) {
					try {
						decorate(openEditor);
					} catch (e) {
						telemetryService?.sendEvent('decorationError');
					}
				}
			});

			// When markdown file is saved:
			workspace.onDidSaveTextDocument((document) => {
				try {
					if (document.fileName.endsWith('.md') && isPagesDirectory()) {
						const isTemplated = /\[.+\]/.test(document.fileName);
						const text = document.getText();
						const codeBlockMatches = (text.match(/```/g) || []).length;
						const numberOfCodeBlocks = codeBlockMatches / 2; // Divide by 2 because each block has opening and closing backticks
						const eachBlocks = (text.match(/\{#each\s+[^}]+\}/g) || []).length;
						const ifBlocks = (text.match(/\{#if\s+[^}]+\}/g) || []).length;
						const svelteComponents = (
							text.match(/<\w+(\s+[^>]*)?\/>|<\w+(\s+[^>]*)?>[\s\S]*?<\/\w+>/g) || []
						).length;
						const expressions = (text.match(/\{[^}]+\}/g) || []).length;
						const dataTables = (text.match(/<DataTable[\s\S]*?(<\/DataTable>|\/>)/g) || []).length;
						const columns = (text.match(/<Column[\s\S]*?(<\/Column>|\/>)/g) || []).length;
						const values = (text.match(/<Value[\s\S]*?(<\/Value>|\/>)/g) || []).length;
						const bigValues = (text.match(/<BigValue[\s\S]*?(<\/BigValue>|\/>)/g) || []).length;
						const charts = (
							text.match(/<\w*(Chart|Plot)\w*[\s\S]*?(<\/\w*(Chart|Plot)\w*>|\/>)/g) || []
						).length;
						const annotations = (
							text.match(/<\w*Reference\w*[\s\S]*?(<\/\w*Reference\w*>|\/>)/g) || []
						).length;

						telemetryService?.sendEvent('saveMarkdown', {
							templated: isTemplated.toString(),
							linesInFile: document.lineCount.toString(),
							charactersInFile: text.length.toString(),
							codeBlocksInFile: numberOfCodeBlocks.toString(),
							ifBlocksInFile: ifBlocks.toString(),
							eachBlocksInFile: eachBlocks.toString(),
							componentsInFile: svelteComponents.toString(),
							expressionsInFile: expressions.toString(),
							dataTablesInFile: dataTables.toString(),
							columnsInFile: columns.toString(),
							valuesInFile: values.toString(),
							bigValuesInFile: bigValues.toString(),
							chartsInFile: charts.toString(),
							annotationsInFile: annotations.toString()
						});
					}
				} catch (e) {
					telemetryService?.sendEvent('telemetryError', { location: 'saveMarkdown' });
				}
			});

			// Track file changes in pages directory:
			workspace.onDidCreateFiles((event) => {
				event.files.forEach((file) => {
					if (file.path.endsWith('.md') && file.path.includes('/pages/')) {
						const isTemplated = /\[.+\]/.test(file.path);
						telemetryService?.sendEvent('createMarkdownFile', {
							templated: isTemplated.toString()
						});
					}
				});
			});

			workspace.onDidDeleteFiles((event) => {
				event.files.forEach((file) => {
					const isTemplated = /\[.+\]/.test(file.path);
					const isInPagesDirectory = file.path.includes('/pages/');

					if (file.path.endsWith('.md') && isInPagesDirectory) {
						telemetryService?.sendEvent('deleteMarkdownFile', {
							templated: isTemplated.toString()
						});
					} else if (isInPagesDirectory) {
						// Assuming it's a directory within 'pages'
						telemetryService?.sendEvent('deleteDirectory', { templated: isTemplated.toString() });
					}
				});
			});

			workspace.onDidCreateFiles((event) => {
				try {
					event.files.forEach((file) => {
						if (fs.lstatSync(file.path).isDirectory() && file.path.includes('/pages/')) {
							const isTemplated = /\[.+\]/.test(file.path);
							telemetryService?.sendEvent('createDirectory', { templated: isTemplated.toString() });
						}
					});
				} catch (e) {
					telemetryService?.sendEvent('telemetryError', { location: 'createDirectory' });
				}
			});

			// Disable auto save in Codespaces:
			if (process.env.CODESPACES === 'true') {
				// Access workspace configuration
				const config = workspace.getConfiguration();

				// Set autosave to 'on'
				await config.update('files.autoSave', 'off', ConfigurationTarget.Workspace);
			}

			// Activate Telemetry Event:

			// get evidence version
			const evidenceVersion = dependencyVersion(workspacePackageJson, '@evidence-dev/evidence');

			// get information about project
			let markdownFilesCount: number = 0;
			let templatedPagesCount: number = 0;
			let sourcesFilesCount: number = 0;
			let componentsFilesCount: number = 0;
			let evidenceFolderAtRoot: boolean = false;
			if (workspaceFolder) {
				markdownFilesCount = countFilesInDirectory(
					path.join(workspaceFolder?.uri.fsPath, packageJsonFolder ?? '', 'pages'),
					/\.md$/
				);
				templatedPagesCount = countTemplatedPages(
					path.join(workspaceFolder?.uri.fsPath, packageJsonFolder ?? '', 'pages')
				);
				sourcesFilesCount = countFilesInDirectory(
					path.join(workspaceFolder?.uri.fsPath, packageJsonFolder ?? '', 'sources'),
					/.*$/
				);
				componentsFilesCount = countFilesInDirectory(
					path.join(workspaceFolder?.uri.fsPath, packageJsonFolder ?? '', 'components'),
					/.*$/
				);
				evidenceFolderAtRoot = fs.existsSync(
					path.join(workspaceFolder?.uri.fsPath, packageJsonFolder ?? '', '.evidence')
				);
			}

			telemetryService?.sendEvent('activate', {
				evidenceVersion: evidenceVersion,
				markdownFiles: `${markdownFilesCount}`,
				templatedPages: `${templatedPagesCount}`,
				sourcesFiles: `${sourcesFilesCount}`,
				componentsFiles: `${componentsFilesCount}`,
				evidenceFolderAtRoot: `${evidenceFolderAtRoot}`
			});
		} catch (e) {
			telemetryService?.sendEvent('telemetryError', { location: 'activate' });
		}

		// set Evidence project context
		updateProjectContext();

		// get autoStart setting:
		const autoStart: boolean = <boolean>getConfig(Settings.AutoStart);

		// show start dev server status
		statusBar.showStart();

		// open index.md if no other files are open
		openIndex();

		try {
			if ((await isUSQL()) && (await hasManifest())) {
				const manifestUri = await getManifestUri();
				const manifest = await getManifest(manifestUri);
				const manifestWatcher = workspace.createFileSystemWatcher(manifestUri.fsPath);

				// if there's no manifest, either the project is unbuilt, or it's legacy - either way there's nothing to show
				if (manifest) {
					const schemaViewProvider = new SchemaViewProvider(manifestUri);
					window.registerTreeDataProvider('schemaView', schemaViewProvider);
					manifestWatcher.onDidChange(() => schemaViewProvider.refresh());
					manifestWatcher.onDidCreate(() => schemaViewProvider.refresh());
					manifestWatcher.onDidDelete(() => schemaViewProvider.refresh());
					context.subscriptions.push(manifestWatcher);
				}
				commands.executeCommand(Commands.SetContext, Context.isNonLegacyProject, !!manifest);
			}
		} catch (e) {
			console.log(e);
		}

		if (autoStart) {
			startServer();
		}
	}
}

/**
 * Deactivates Evidence extension
 * and disposes extension resources.
 */
export function deactivate() {
	statusBar?.dispose();
	closeTerminal();
}
