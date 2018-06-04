/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import * as Proto from '../protocol';
import * as PConst from '../protocol.const';
import { ITypeScriptServiceClient } from '../typescriptService';
import * as typeConverters from '../utils/typeConverters';
import { CachedNavTreeResponse, ReferencesCodeLens, TypeScriptBaseCodeLensProvider } from './baseCodeLensProvider';
import { disposeAll } from '../utils/dispose';
import { VersionDependentRegistration } from '../utils/dependentRegistration';
import API from '../utils/api';

const localize = nls.loadMessageBundle();

class TypeScriptReferencesCodeLensProvider extends TypeScriptBaseCodeLensProvider {
	private readonly _disposables: vscode.Disposable[] = [];

	public constructor(
		client: ITypeScriptServiceClient,
		private readonly language: string,
		cachedResponse: CachedNavTreeResponse
	) {
		super(client, cachedResponse);

		this.updateConfiguration();
		vscode.workspace.onDidChangeConfiguration(() => this.updateConfiguration(), null, this._disposables);
	}

	public dispose() {
		disposeAll(this._disposables);
	}

	public resolveCodeLens(inputCodeLens: vscode.CodeLens, token: vscode.CancellationToken): Promise<vscode.CodeLens> {
		const codeLens = inputCodeLens as ReferencesCodeLens;
		const args = typeConverters.Position.toFileLocationRequestArgs(codeLens.file, codeLens.range.start);
		return this.client.execute('references', args, token).then(response => {
			if (!response || !response.body) {
				throw codeLens;
			}

			const locations = response.body.refs
				.map(reference =>
					typeConverters.Location.fromTextSpan(this.client.asUrl(reference.file), reference))
				.filter(location =>
					// Exclude original definition from references
					!(location.uri.toString() === codeLens.document.toString() &&
						location.range.start.isEqual(codeLens.range.start)));

			codeLens.command = {
				title: locations.length === 1
					? localize('oneReferenceLabel', '1 reference')
					: localize('manyReferenceLabel', '{0} references', locations.length),
				command: locations.length ? 'editor.action.showReferences' : '',
				arguments: [codeLens.document, codeLens.range.start, locations]
			};
			return codeLens;
		}).catch(() => {
			codeLens.command = {
				title: localize('referenceErrorLabel', 'Could not determine references'),
				command: ''
			};
			return codeLens;
		});
	}

	protected extractSymbol(
		document: vscode.TextDocument,
		item: Proto.NavigationTree,
		parent: Proto.NavigationTree | null
	): vscode.Range | null {
		if (parent && parent.kind === PConst.Kind.enum) {
			return super.getSymbolRange(document, item);
		}

		switch (item.kind) {
			case PConst.Kind.const:
			case PConst.Kind.let:
			case PConst.Kind.variable:
			case PConst.Kind.function:
				// Only show references for exported variables
				if (!item.kindModifiers.match(/\bexport\b/)) {
					break;
				}
			// fallthrough

			case PConst.Kind.class:
				if (item.text === '<class>') {
					break;
				}
			// fallthrough

			case PConst.Kind.memberFunction:
			case PConst.Kind.memberVariable:
			case PConst.Kind.memberGetAccessor:
			case PConst.Kind.memberSetAccessor:
			case PConst.Kind.constructorImplementation:
			case PConst.Kind.interface:
			case PConst.Kind.type:
			case PConst.Kind.enum:
				return super.getSymbolRange(document, item);
		}

		return null;
	}

	private updateConfiguration(): void {
		const config = vscode.workspace.getConfiguration(this.language);
		this.setEnabled(config.get('referencesCodeLens.enabled', false));
	}
}

export function register(
	selector: vscode.DocumentSelector,
	modeId: string,
	client: ITypeScriptServiceClient,
	cachedResponse: CachedNavTreeResponse,
) {
	return new VersionDependentRegistration(client, {
		isSupportedVersion(api) {
			return api.gte(API.v206);
		},
		register() {
			const referenceCodeLensProvider = new TypeScriptReferencesCodeLensProvider(client, modeId, cachedResponse);
			return vscode.Disposable.from(
				vscode.languages.registerCodeLensProvider(selector, referenceCodeLensProvider),
				referenceCodeLensProvider,
			);
		}
	});
}