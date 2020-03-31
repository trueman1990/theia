/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject } from 'inversify';
import { ProtocolToMonacoConverter } from 'monaco-languageclient/lib';
import { Position, Location } from '@theia/languages/lib/browser';
import { Command, CommandContribution, CommandRegistry } from '@theia/core';
import { NativeTextInputFocusContext } from '@theia/core/lib/browser/keybinding';
import { QuickOpenService } from '@theia/core/lib/browser/quick-open/quick-open-service';
import { QuickOpenItem, QuickOpenMode } from '@theia/core/lib/browser/quick-open/quick-open-model';
import { MonacoEditor } from './monaco-editor';
import { MonacoEditorCommandHandler, MonacoCommandRegistry } from './monaco-command-registry';
import MenuRegistry = monaco.actions.MenuRegistry;
import { MonacoEditorService } from './monaco-editor-service';
import { CommandHandler } from '@theia/core/src/common/command';
import { EditorCommands } from '@theia/editor/lib/browser/editor-command';

// vs code doesn't use iconClass anymore, but icon instead, so some adaptation is required to reuse it on theia side
export type MonacoIcon = { dark?: monaco.Uri; light?: monaco.Uri } | monaco.theme.ThemeIcon;
export type MonacoCommand = Command & { icon?: MonacoIcon };
export namespace MonacoCommands {

    export const FIND = 'actions.find';
    export const REPLACE = 'editor.action.startFindReplaceAction';
    export const GO_TO_DEFINITION = 'editor.action.revealDefinition';

    export const ACTIONS = new Map<string, MonacoCommand>();
    export const EXCLUDE_ACTIONS = new Set([
        'editor.action.quickCommand',
        'editor.action.clipboardCutAction',
        'editor.action.clipboardCopyAction',
        'editor.action.clipboardPasteAction'
    ]);
    const icons = new Map<string, MonacoIcon>();
    for (const menuItem of MenuRegistry.getMenuItems(7)) {
        const commandItem = menuItem.command;
        if (commandItem && commandItem.icon) {
            icons.set(commandItem.id, commandItem.icon);
        }
    }
    for (const action of monaco.editorExtensions.EditorExtensionsRegistry.getEditorActions()) {
        const id = action.id;
        if (!EXCLUDE_ACTIONS.has(id)) {
            const label = action.label;
            const icon = icons.get(id);
            ACTIONS.set(id, { id, label, icon });
        }
    }
    for (const keybinding of monaco.keybindings.KeybindingsRegistry.getDefaultKeybindings()) {
        const id = keybinding.command;
        if (!ACTIONS.has(id) && !EXCLUDE_ACTIONS.has(id)) {
            ACTIONS.set(id, { id });
        }
    }
}

@injectable()
export class MonacoEditorCommandHandlers implements CommandContribution {

    @inject(MonacoCommandRegistry)
    protected readonly monacoCommandRegistry: MonacoCommandRegistry;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(ProtocolToMonacoConverter)
    protected readonly p2m: ProtocolToMonacoConverter;

    @inject(QuickOpenService)
    protected readonly quickOpenService: QuickOpenService;

    @inject(MonacoEditorService)
    protected readonly editorService: MonacoEditorService;

    private readonly serviceAccessor: monaco.instantiation.ServicesAccessor = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        get: <T>(id: monaco.instantiation.ServiceIdentifier<T>) => {
            if (id !== monaco.services.ICodeEditorService) {
                throw new Error(`Unhandled service identified: ${id.type}.`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return this.editorService as any as T;
        }
    };

    registerCommands(): void {
        this.registerEditorCommandHandlers(); // Custom commands and handlers for setting the EOL or the indentation, for instance.
        this.registerBuiltinMonacoActions(); // All the `EditorCommand` and `EditorAction` instances we will register int the command registry.
        this.registerInternalLanguageServiceCommands(); // Very very internal, language service commands.
    }

    protected registerInternalLanguageServiceCommands(): void {
        const instantiationService = monaco.services.StaticServices.instantiationService.get();
        const monacoCommands = monaco.commands.CommandsRegistry.getCommands();
        for (const command of monacoCommands.keys()) {
            if (command.startsWith('_execute')) {
                this.commandRegistry.registerCommand(
                    {
                        id: command
                    },
                    {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        execute: (...args: any) => instantiationService.invokeFunction(
                            monacoCommands.get(command)!.handler,
                            ...args
                        )
                    }
                );
            }
        }
    }

    /**
     * This will register the available Monaco editor actions with their Monaco-specific IDs.
     * For instance, `editor.action.revealDefinition` which is `Go to Definition` on the UI.
     */
    protected registerBuiltinMonacoActions(): void {
        for (const action of MonacoCommands.ACTIONS.values()) {
            this.commandRegistry.registerCommand(action, this.newEditorCommandHandler(action.id));
        }
    }

    protected newEditorCommandHandler(id: string): CommandHandler {
        // First, try to get the editor scoped command.
        const editorCommand = monaco.editorExtensions.EditorExtensionsRegistry.getEditorCommand(id);
        if (editorCommand) {
            return {
                execute: (...args) => editorCommand.runCommand(this.serviceAccessor, args),
                isEnabled: () => !!this.editorService.getActiveCodeEditor() || this.editorService.hasFocusedCodeEditor()
            };
        }

        // Try to get the core command that does not require a focused or active editor. Such as: `Undo`, `Redo`, and `Select All`.
        const command = monaco.commands.CommandsRegistry.getCommand(id);
        if (command) {
            return {
                execute: (...args) => command.handler(this.serviceAccessor, args),
                isEnabled: () => {
                    if (!!this.editorService.getActiveCodeEditor() || this.editorService.hasFocusedCodeEditor()) {
                        return true;
                    }
                    // This is a hack for `EditorOrNativeTextInputCommand`. The target can be an `input` or `textArea`.
                    if (this.isNativeTextInputAware(command) && NativeTextInputFocusContext.is()) {
                        return true;
                    }
                    return false;
                }
            };
        }

        // Ouch :(
        throw new Error(`Could not find monaco command with ID: ${id}`);
    }

    private isNativeTextInputAware(command: object & { when?: { key?: string } }): boolean {
        return !!command.when && command.when.key === 'textInputFocus';
    }

    protected registerEditorCommandHandlers(): void {
        this.monacoCommandRegistry.registerHandler(EditorCommands.SHOW_REFERENCES.id, this.newShowReferenceHandler());
        this.monacoCommandRegistry.registerHandler(EditorCommands.CONFIG_INDENTATION.id, this.newConfigIndentationHandler());
        this.monacoCommandRegistry.registerHandler(EditorCommands.CONFIG_EOL.id, this.newConfigEolHandler());
        this.monacoCommandRegistry.registerHandler(EditorCommands.INDENT_USING_SPACES.id, this.newConfigTabSizeHandler(true));
        this.monacoCommandRegistry.registerHandler(EditorCommands.INDENT_USING_TABS.id, this.newConfigTabSizeHandler(false));
    }

    protected newShowReferenceHandler(): MonacoEditorCommandHandler {
        return {
            execute: (editor: MonacoEditor, uri: string, position: Position, locations: Location[]) => {
                editor.commandService.executeCommand(
                    'editor.action.showReferences',
                    monaco.Uri.parse(uri),
                    this.p2m.asPosition(position),
                    locations.map(l => this.p2m.asLocation(l))
                );
            }
        };
    }

    protected newConfigIndentationHandler(): MonacoEditorCommandHandler {
        return {
            execute: editor => this.configureIndentation(editor)
        };
    }
    protected configureIndentation(editor: MonacoEditor): void {
        const options = [true, false].map(useSpaces =>
            new QuickOpenItem({
                label: `Indent Using ${useSpaces ? 'Spaces' : 'Tabs'}`,
                run: (mode: QuickOpenMode) => {
                    if (mode === QuickOpenMode.OPEN) {
                        this.configureTabSize(editor, useSpaces);
                    }
                    return false;
                }
            })
        );
        this.quickOpenService.open({ onType: (_, acceptor) => acceptor(options) }, {
            placeholder: 'Select Action',
            fuzzyMatchLabel: true
        });
    }

    protected newConfigEolHandler(): MonacoEditorCommandHandler {
        return {
            execute: editor => this.configureEol(editor)
        };
    }
    protected configureEol(editor: MonacoEditor): void {
        const options = ['LF', 'CRLF'].map(lineEnding =>
            new QuickOpenItem({
                label: lineEnding,
                run: (mode: QuickOpenMode) => {
                    if (mode === QuickOpenMode.OPEN) {
                        this.setEol(editor, lineEnding);
                        return true;
                    }
                    return false;
                }
            })
        );
        this.quickOpenService.open({ onType: (_, acceptor) => acceptor(options) }, {
            placeholder: 'Select End of Line Sequence',
            fuzzyMatchLabel: true
        });
    }
    protected setEol(editor: MonacoEditor, lineEnding: string): void {
        const model = editor.document && editor.document.textEditorModel;
        if (model) {
            if (lineEnding === 'CRLF' || lineEnding === '\r\n') {
                model.pushEOL(monaco.editor.EndOfLineSequence.CRLF);
            } else {
                model.pushEOL(monaco.editor.EndOfLineSequence.LF);
            }
        }
    }

    protected newConfigTabSizeHandler(useSpaces: boolean): MonacoEditorCommandHandler {
        return {
            execute: editor => this.configureTabSize(editor, useSpaces)
        };
    }
    protected configureTabSize(editor: MonacoEditor, useSpaces: boolean): void {
        const model = editor.document && editor.document.textEditorModel;
        if (model) {
            const { tabSize } = model.getOptions();
            const sizes = Array.from(Array(8), (_, x) => x + 1);
            const tabSizeOptions = sizes.map(size =>
                new QuickOpenItem({
                    label: size === tabSize ? `${size}   Configured Tab Size` : size.toString(),
                    run: (mode: QuickOpenMode) => {
                        if (mode !== QuickOpenMode.OPEN) {
                            return false;
                        }
                        model.updateOptions({
                            tabSize: size || tabSize,
                            insertSpaces: useSpaces
                        });
                        return true;
                    }
                })
            );
            this.quickOpenService.open({ onType: (_, acceptor) => acceptor(tabSizeOptions) }, {
                placeholder: 'Select Tab Size for Current File',
                fuzzyMatchLabel: true,
                selectIndex: lookFor => {
                    if (!lookFor || lookFor === '') {
                        return tabSize - 1;
                    }
                    return 0;
                }
            });
        }
    }

}
