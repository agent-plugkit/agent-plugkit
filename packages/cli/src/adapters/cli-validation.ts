import type {
  WorkspaceHealthSnapshot,
  WorkspaceValidationDiagnostic,
} from '../application/workspace-health-contract.js';

export interface CliPluginValidationResult {
  readonly name: string;
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Converts the shared structured health result back into the legacy validate
 * command's ordered, line-oriented model. It deliberately has no chalk,
 * console, commander, or process dependency.
 */
export function adaptHealthToCliValidation(
  snapshot: WorkspaceHealthSnapshot,
  validationDiagnostics: readonly WorkspaceValidationDiagnostic[],
  orderedNames: readonly string[],
): readonly CliPluginValidationResult[] {
  const plugins = new Map(
    snapshot.plugins.map((plugin) => [plugin.directoryName, plugin]),
  );
  const diagnostics = new Map<string, string[]>();
  for (const diagnostic of validationDiagnostics) {
    const messages = diagnostics.get(diagnostic.pluginDirectoryName) ?? [];
    messages.push(diagnostic.message);
    diagnostics.set(diagnostic.pluginDirectoryName, messages);
  }

  return orderedNames.map((name) => {
    const plugin = plugins.get(name);
    if (plugin === undefined) {
      return {
        name,
        valid: false,
        errors: [`插件目录不存在: plugins/${name}`],
      };
    }
    const errors = diagnostics.get(name) ?? [];
    return {
      name,
      valid: errors.length === 0,
      errors,
    };
  });
}
